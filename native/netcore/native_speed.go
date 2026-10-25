package netcore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

const nativeSpeedName = "benchmark.invalid"
const nativeSpeedPacketBytes = 1100
const nativeSpeedOffered = 125000
const nativeSpeedTCPBytes = 192 * 1024 * 1024
const nativeSpeedMultiBytes = 192 * 1024 * 1024
const nativeSpeedUDPBytes = 512 * 1024 * 1024
const nativeSpeedLease = 5 * time.Second

type NativeSpeedRequest struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Epoch           uint64 `json:"epoch"`
	ID              string `json:"id"`
	Session         string `json:"session"`
	Ticket          string `json:"ticket"`
	PeerIP          string `json:"peerIP"`
	Host            string `json:"host"`
	Port            int    `json:"port"`
}
type NativeSpeedTransfer struct {
	ReceivedBytes  uint64  `json:"receivedBytes"`
	DurationMs     float64 `json:"durationMs"`
	BytesPerSecond float64 `json:"bytesPerSecond"`
	Completion     string  `json:"completion"`
	LimitReached   bool    `json:"limitReached"`
}
type NativeSpeedUDPTransfer struct {
	NativeSpeedTransfer
	SentBytes             *uint64  `json:"sentBytes"`
	SentPackets           *uint64  `json:"sentPackets"`
	ReceivedPackets       uint64   `json:"receivedPackets"`
	LostPackets           *uint64  `json:"lostPackets"`
	LossPercent           *float64 `json:"lossPercent"`
	DuplicatePackets      uint64   `json:"duplicatePackets"`
	OutOfOrderPackets     uint64   `json:"outOfOrderPackets"`
	OfferedBytesPerSecond uint64   `json:"offeredBytesPerSecond"`
	PacketBytes           int      `json:"packetBytes"`
}
type NativeSpeedLatency struct {
	Samples       []float64 `json:"samples"`
	MinMs         *float64  `json:"minMs"`
	MedianMs      *float64  `json:"medianMs"`
	MaxMs         *float64  `json:"maxMs"`
	FailedSamples int       `json:"failedSamples"`
}
type NativeSpeedMetrics struct {
	Completed bool                `json:"completed"`
	Latency   NativeSpeedLatency  `json:"latency"`
	Download  NativeSpeedTransfer `json:"download"`
	Upload    NativeSpeedTransfer `json:"upload"`
	TCPMulti  NativeSpeedTCPMulti `json:"tcpMulti"`
	UDP       struct {
		Download NativeSpeedUDPResult `json:"download"`
		Upload   NativeSpeedUDPResult `json:"upload"`
	} `json:"udp"`
	StopReason *string `json:"stopReason"`
}
type NativeSpeedStatus struct {
	ProtocolVersion int                `json:"protocolVersion"`
	ID              string             `json:"id"`
	Port            int                `json:"port"`
	Phase           string             `json:"phase"`
	Finished        bool               `json:"finished"`
	Metrics         NativeSpeedMetrics `json:"metrics"`
}
type nativeSpeedOptions struct {
	tcpDuration      time.Duration
	multiDuration    time.Duration
	multiBytes       uint64
	udpDuration      time.Duration // budget for starting stages; reliable finalization shares the job's hard deadline
	drain            time.Duration
	deadline         time.Duration
	lease            time.Duration
	cooldown         time.Duration
	tcpBytes         uint64
	udpBytes         uint64
	udpRate          uint64
	udpRates         []uint64
	udpStageDuration time.Duration
}

func nativeSpeedDefaults(o nativeSpeedOptions) nativeSpeedOptions {
	if o.multiDuration <= 0 {
		o.multiDuration = 10 * time.Second
	}
	if o.multiBytes == 0 {
		o.multiBytes = nativeSpeedMultiBytes
	}
	if len(o.udpRates) == 0 {
		if o.udpRate != 0 {
			o.udpRates = []uint64{o.udpRate}
		} else {
			o.udpRates = append([]uint64(nil), nativeSpeedRates...)
		}
	}
	if o.udpStageDuration <= 0 {
		o.udpStageDuration = 1500 * time.Millisecond
	}
	if o.tcpDuration <= 0 {
		o.tcpDuration = 10 * time.Second
	}
	if o.udpDuration <= 0 {
		o.udpDuration = 30 * time.Second
	}
	if o.drain <= 0 {
		o.drain = 500 * time.Millisecond
	}
	if o.deadline <= 0 {
		o.deadline = 210 * time.Second
	}
	if o.lease <= 0 {
		o.lease = nativeSpeedLease
	}
	if o.cooldown <= 0 {
		o.cooldown = 15 * time.Second
	}
	if o.tcpBytes == 0 {
		o.tcpBytes = nativeSpeedTCPBytes
	}
	if o.udpBytes == 0 {
		o.udpBytes = nativeSpeedUDPBytes
	}
	if o.udpRate == 0 {
		o.udpRate = nativeSpeedOffered
	}
	return o
}

type nativeSpeedJob struct {
	mu            sync.Mutex
	request       NativeSpeedRequest
	role          string
	backend       nativeProxyBackend
	proxy         *nativeProxy
	opts          nativeSpeedOptions
	ctx           context.Context
	cancel        context.CancelFunc
	cleanupDone   chan struct{}
	resources     map[io.Closer]bool
	status        NativeSpeedStatus
	leaseUntil    time.Time
	mainAccepted  atomic.Bool
	probeAccepted atomic.Bool
	udpMu         sync.Mutex
	udpPhase      *nativeSpeedUDPPhase
	udp           net.PacketConn
	multi         *nativeSpeedMultiPhase // guarded by mu
}

func newNativeSpeedJob(r NativeSpeedRequest, role string, b nativeProxyBackend, o nativeSpeedOptions) *nativeSpeedJob {
	o = nativeSpeedDefaults(o)
	ctx, cancel := context.WithTimeout(context.Background(), o.deadline)
	j := &nativeSpeedJob{request: r, role: role, backend: b, opts: o, ctx: ctx, cancel: cancel, cleanupDone: make(chan struct{}), resources: map[io.Closer]bool{}, leaseUntil: time.Now().Add(o.lease), status: NativeSpeedStatus{ProtocolVersion: 5, ID: r.ID, Phase: "waiting"}}
	j.status.Metrics = nativeSpeedEmptyMetrics()
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				if errors.Is(ctx.Err(), context.DeadlineExceeded) {
					j.finish("deadline", false)
				}
				return
			case now := <-ticker.C:
				j.mu.Lock()
				expired := !j.status.Finished && now.After(j.leaseUntil)
				j.mu.Unlock()
				if expired {
					j.finish("control-unavailable", false)
					return
				}
			}
		}
	}()
	return j
}
func (j *nativeSpeedJob) add(c io.Closer) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.status.Finished {
		c.Close()
		return false
	}
	j.resources[c] = true
	return true
}
func (j *nativeSpeedJob) remove(c io.Closer) {
	j.mu.Lock()
	delete(j.resources, c)
	j.mu.Unlock()
	c.Close()
}
func (j *nativeSpeedJob) finish(reason string, completed bool) {
	j.mu.Lock()
	if j.status.Finished {
		j.mu.Unlock()
		<-j.cleanupDone
		return
	}
	if j.multi != nil {
		j.multi.freeze()
		j.putMultiResultLocked(j.multi, j.multi.result(false))
	}
	// Polling progress is sampled, but a cancellation receipt includes every
	// unique datagram the active receiver has already observed.
	j.udpMu.Lock()
	active := j.udpPhase
	j.udpMu.Unlock()
	if active != nil && (j.role == "host" && active.name == "udp-upload" || j.role == "client" && active.name == "udp-download") {
		active.mu.Lock()
		active.frozen = true
		active.mu.Unlock()
		target := &j.status.Metrics.UDP.Upload
		if active.name == "udp-download" {
			target = &j.status.Metrics.UDP.Download
		}
		nativeSpeedPutUDPStage(target, nativeSpeedStage(active.index, active.rate, active.result(nil, active.rate, false), nil))
	}
	if !completed {
		stop := "cancelled"
		if reason == "transport-failed" {
			stop = "failed"
		}
		for _, r := range []*NativeSpeedUDPResult{&j.status.Metrics.UDP.Download, &j.status.Metrics.UDP.Upload} {
			if r.StopReason == nil {
				nativeSpeedFinishUDP(r, stop)
			}
		}
		for _, r := range []*NativeSpeedTCPDirection{&j.status.Metrics.TCPMulti.Download, &j.status.Metrics.TCPMulti.Upload} {
			if r.StopReason == nil {
				nativeSpeedFinishTCP(r, stop)
			}
		}
	}
	j.status.Finished = true
	j.status.Metrics.Completed = completed
	if completed {
		j.status.Phase = "completed"
	} else {
		j.status.Metrics.StopReason = &reason
	}
	resources := j.resources
	j.resources = nil
	p := j.proxy
	j.mu.Unlock()
	j.cancel()
	if p != nil {
		p.close()
	}
	for r := range resources {
		r.Close()
	}
	close(j.cleanupDone)
}
func (j *nativeSpeedJob) snapshot(renew bool) NativeSpeedStatus {
	j.mu.Lock()
	expired := !j.status.Finished && time.Now().After(j.leaseUntil)
	if renew && !expired && !j.status.Finished {
		j.leaseUntil = time.Now().Add(j.opts.lease)
	}
	j.mu.Unlock()
	if expired {
		j.finish("control-unavailable", false)
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	out := j.status
	out.Metrics.Latency.Samples = append([]float64{}, out.Metrics.Latency.Samples...)
	out.Metrics.UDP.Download.Stages = append([]NativeSpeedUDPStage{}, out.Metrics.UDP.Download.Stages...)
	out.Metrics.UDP.Upload.Stages = append([]NativeSpeedUDPStage{}, out.Metrics.UDP.Upload.Stages...)
	out.Metrics.TCPMulti.ConnectionCounts = append([]int{}, out.Metrics.TCPMulti.ConnectionCounts...)
	out.Metrics.TCPMulti.Download = cloneNativeTCPDirection(out.Metrics.TCPMulti.Download)
	out.Metrics.TCPMulti.Upload = cloneNativeTCPDirection(out.Metrics.TCPMulti.Upload)
	return out
}
func (j *nativeSpeedJob) phase(name string) {
	j.mu.Lock()
	if !j.status.Finished {
		j.status.Phase = name
	}
	j.mu.Unlock()
}
func (j *nativeSpeedJob) tcpResult(phase string, v NativeSpeedTransfer) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.status.Finished {
		return
	}
	if phase == "tcp-download" {
		j.status.Metrics.Download = v
	} else {
		j.status.Metrics.Upload = v
	}
}
func nativeSpeedAuth(r NativeSpeedRequest) (string, string) {
	sum := sha256.Sum256([]byte(r.ID + ":" + r.Session))
	return hex.EncodeToString(sum[:])[:24], r.Ticket
}
func nativeSpeedLocalAuth(r NativeSpeedRequest) (string, string) {
	sum := sha256.Sum256([]byte("local:" + r.Ticket))
	return hex.EncodeToString(sum[:])[:24], hex.EncodeToString(sum[:])
}
func nativeSpeedDestination(_ context.Context, host string, port int) (netip.AddrPort, error) {
	if host != nativeSpeedName || (port != 1 && port != 2 && port != 3 && port != 4) {
		return netip.AddrPort{}, errors.New("speed target denied")
	}
	return netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), uint16(port)), nil
}

func (j *nativeSpeedJob) prepareHost(allowLoopback bool) error {
	main, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	if !j.add(main) {
		return context.Canceled
	}
	probe, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	if !j.add(probe) {
		return context.Canceled
	}
	multi, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	if !j.add(multi) {
		return context.Canceled
	}
	udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	if !j.add(udp) {
		return context.Canceled
	}
	j.udp = udp
	options := nativeProxyOptions{maxFlows: nativeSpeedMaxFlows, allowLoopbackPeers: allowLoopback, lease: j.opts.deadline + time.Second, destination: nativeSpeedDestination, dial: func(ctx context.Context, network, address string) (net.Conn, error) {
		var target string
		switch {
		case network == "tcp" && address == "127.0.0.1:1":
			target = main.Addr().String()
		case network == "tcp" && address == "127.0.0.1:3":
			target = probe.Addr().String()
		case network == "tcp" && address == "127.0.0.1:4":
			target = multi.Addr().String()
		case network == "udp" && address == "127.0.0.1:2":
			target = udp.LocalAddr().String()
		default:
			return nil, errors.New("speed target denied")
		}
		return (&net.Dialer{}).DialContext(ctx, network, target)
	}}
	p := newNativeProxy(j.backend, options)
	j.mu.Lock()
	if j.status.Finished {
		j.mu.Unlock()
		p.close()
		return context.Canceled
	}
	j.proxy = p
	j.mu.Unlock()
	user, password := nativeSpeedAuth(j.request)
	s, err := p.configure(NativeProxyConfig{Epoch: 1, Role: "host", Enabled: true, Sessions: []NativeProxySession{{ID: j.request.Session, PeerIP: j.request.PeerIP, Username: user, Password: password}}})
	if err != nil {
		return err
	}
	j.mu.Lock()
	j.status.Port = s.Port
	j.mu.Unlock()
	go j.acceptMain(main)
	go j.acceptProbe(probe)
	go j.acceptMulti(multi)
	go j.receiveSyntheticUDP(udp)
	return nil
}
func (j *nativeSpeedJob) prepareClient(allowLoopback bool) error {
	p := newNativeProxy(j.backend, nativeProxyOptions{maxFlows: nativeSpeedMaxFlows, allowLoopbackPeers: allowLoopback, lease: j.opts.deadline + time.Second})
	j.mu.Lock()
	if j.status.Finished {
		j.mu.Unlock()
		p.close()
		return context.Canceled
	}
	j.proxy = p
	j.mu.Unlock()
	user, password := nativeSpeedAuth(j.request)
	localUser, localPassword := nativeSpeedLocalAuth(j.request)
	s, err := p.configure(NativeProxyConfig{Epoch: 1, Role: "client", Enabled: true, Username: localUser, Password: localPassword, Remote: &NativeProxyRemote{Host: j.request.Host, Port: j.request.Port, Session: j.request.Session, Username: user, Password: password}})
	if err != nil {
		return err
	}
	j.mu.Lock()
	j.status.Port = s.Port
	j.status.Phase = "connecting"
	j.mu.Unlock()
	go j.runClient()
	return nil
}
func (j *nativeSpeedJob) dialSynthetic(port int) (net.Conn, error) {
	j.mu.Lock()
	p := j.status.Port
	j.mu.Unlock()
	ctx, cancel := context.WithTimeout(j.ctx, 5*time.Second)
	defer cancel()
	c, err := (&net.Dialer{}).DialContext(ctx, "tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(p)))
	if err != nil {
		return nil, err
	}
	if !j.add(c) {
		return nil, context.Canceled
	}
	c.SetDeadline(time.Now().Add(5 * time.Second))
	u, pw := nativeSpeedLocalAuth(j.request)
	if err = nativeSendAuth(c, u, pw); err == nil {
		err = nativeSendRequest(c, 1, nativeSpeedName, port)
	}
	if err == nil {
		var code byte
		code, _, _, err = nativeReadReply(c)
		if err == nil && code != 0 {
			err = errors.New("speed connection denied")
		}
	}
	if err != nil {
		c.Close()
		return nil, err
	}
	c.SetDeadline(time.Time{})
	return c, nil
}
func (j *nativeSpeedJob) acceptProbe(ln net.Listener) {
	var pending atomic.Int32
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		if pending.Add(1) > 4 {
			pending.Add(-1)
			c.Close()
			continue
		}
		if !j.add(c) {
			pending.Add(-1)
			return
		}
		go func() {
			defer pending.Add(-1)
			defer j.remove(c)
			hello, err := nativeSpeedReadMessageTimeout(c, 5*time.Second)
			if err != nil || hello.Kind != "probe" || hello.ID != j.request.ID || !nativeEqual(hello.Ticket, j.request.Ticket) || !j.probeAccepted.CompareAndSwap(false, true) {
				return
			}
			if nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "ready"}) != nil {
				return
			}
			var b [8]byte
			for i := 0; i < 64; i++ {
				c.SetDeadline(time.Now().Add(3 * time.Second))
				if _, err = io.ReadFull(c, b[:]); err != nil {
					return
				}
				if nativeWrite(c, b[:]) != nil {
					return
				}
			}
		}()
	}
}
func (j *nativeSpeedJob) probeLoop() {
	c, err := j.dialSynthetic(3)
	if err == nil {
		err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "probe", ID: j.request.ID, Ticket: j.request.Ticket})
	}
	if err == nil {
		_, err = nativeSpeedReadMessage(c)
	}
	if err != nil {
		j.recordLatency(0, false)
		return
	}
	defer c.Close()
	for i := 0; i < 64; i++ {
		j.mu.Lock()
		phase := j.status.Phase
		j.mu.Unlock()
		if !nativeSpeedTCPPhase(phase) {
			return
		}
		select {
		case <-j.ctx.Done():
			return
		default:
		}
		var b [8]byte
		for k := range b {
			b[k] = byte(i + k)
		}
		start := time.Now()
		c.SetDeadline(start.Add(2500 * time.Millisecond))
		err = nativeWrite(c, b[:])
		var echoed [8]byte
		if err == nil {
			_, err = io.ReadFull(c, echoed[:])
		}
		j.recordLatency(float64(time.Since(start))/float64(time.Millisecond), err == nil && echoed == b)
		if err != nil {
			return
		}
		select {
		case <-j.ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}
func (j *nativeSpeedJob) recordLatency(ms float64, ok bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.status.Finished || !nativeSpeedTCPPhase(j.status.Phase) {
		return
	}
	v := &j.status.Metrics.Latency
	if len(v.Samples)+v.FailedSamples >= 64 {
		return
	}
	if !ok {
		v.FailedSamples++
		return
	}
	v.Samples = append(v.Samples, ms)
	sorted := append([]float64(nil), v.Samples...)
	sort.Float64s(sorted)
	min, max := sorted[0], sorted[len(sorted)-1]
	median := sorted[len(sorted)/2]
	if len(sorted)%2 == 0 {
		median = (median + sorted[len(sorted)/2-1]) / 2
	}
	v.MinMs = &min
	v.MaxMs = &max
	v.MedianMs = &median
}

func validateNativeSpeedRequest(r NativeSpeedRequest, host bool, allowLoopback bool) error {
	if r.ProtocolVersion != 5 || r.Epoch == 0 || r.Epoch > 9007199254740991 || len(r.ID) != 36 || !nativeID(r.ID) || !nativeID(r.Session) || len(r.Ticket) != 43 || !nativeID(r.Ticket) {
		return errors.New("invalid native speed reservation")
	}
	if host {
		if !nativePeer(r.PeerIP, allowLoopback) {
			return errors.New("invalid speed peer")
		}
	} else if !nativePeer(r.Host, allowLoopback) || r.Port < 1 || r.Port > 65535 {
		return errors.New("invalid speed endpoint")
	}
	return nil
}
func (m *Manager) nativeSpeedBegin(ctx context.Context, r NativeSpeedRequest, host bool) (NativeSpeedStatus, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	m.startMu.Lock()
	m.speedMu.Lock()
	locked := true
	defer func() {
		if locked {
			m.speedMu.Unlock()
			m.startMu.Unlock()
		}
	}()
	if err := validateNativeSpeedRequest(r, host, m.nativeOptions.allowLoopbackPeers); err != nil {
		return NativeSpeedStatus{}, err
	}
	if r.Epoch <= m.speedEpoch {
		return NativeSpeedStatus{}, errors.New("stale speed epoch")
	}
	m.speedEpoch = r.Epoch
	if m.speedJob != nil && !m.speedJob.snapshot(false).Finished {
		return NativeSpeedStatus{}, errors.New("speed test busy")
	}
	opts := nativeSpeedDefaults(m.speedOptions)
	if !m.speedLastStart.IsZero() && time.Since(m.speedLastStart) < opts.cooldown {
		return NativeSpeedStatus{}, errors.New("speed test cooldown")
	}
	m.mu.Lock()
	closed := m.closed
	m.mu.Unlock()
	if closed {
		return NativeSpeedStatus{}, errors.New("network core closed")
	}
	if err := ctx.Err(); err != nil {
		return NativeSpeedStatus{}, err
	}
	if !m.nativeReady {
		status, err := m.Status(ctx)
		if err != nil || !status.Running {
			return NativeSpeedStatus{}, errors.New("private network is not connected")
		}
	}
	if err := ctx.Err(); err != nil {
		return NativeSpeedStatus{}, err
	}
	backend := m.nativeBackend
	if backend == nil {
		backend = m.server
	}
	role := "client"
	if host {
		role = "host"
	}
	j := newNativeSpeedJob(r, role, backend, opts)
	m.speedJob = j
	m.speedLastStart = time.Now()
	locked = false
	m.speedMu.Unlock()
	m.startMu.Unlock()
	var err error
	if host {
		err = j.prepareHost(m.nativeOptions.allowLoopbackPeers)
	} else {
		err = j.prepareClient(m.nativeOptions.allowLoopbackPeers)
	}
	if err != nil {
		j.finish("transport-failed", false)
		return j.snapshot(false), err
	}
	state := j.snapshot(false)
	if state.Finished {
		return state, context.Canceled
	}
	return state, nil
}
func (m *Manager) NativeSpeedPrepare(ctx context.Context, r NativeSpeedRequest) (NativeSpeedStatus, error) {
	return m.nativeSpeedBegin(ctx, r, true)
}
func (m *Manager) NativeSpeedStart(ctx context.Context, r NativeSpeedRequest) (NativeSpeedStatus, error) {
	return m.nativeSpeedBegin(ctx, r, false)
}
func (m *Manager) NativeSpeedStatus(id string, renew bool) (NativeSpeedStatus, error) {
	m.speedMu.Lock()
	defer m.speedMu.Unlock()
	if m.speedJob == nil || m.speedJob.request.ID != id {
		return NativeSpeedStatus{}, errors.New("speed test unavailable")
	}
	return m.speedJob.snapshot(renew), nil
}
func (m *Manager) NativeSpeedCancel(epoch uint64, id, reason string) (NativeSpeedStatus, error) {
	m.speedMu.Lock()
	defer m.speedMu.Unlock()
	if epoch == 0 || epoch > 9007199254740991 || epoch <= m.speedEpoch {
		return NativeSpeedStatus{}, errors.New("stale speed epoch")
	}
	if len(id) != 36 || !nativeID(id) {
		return NativeSpeedStatus{}, errors.New("invalid speed test id")
	}
	if m.speedJob != nil && m.speedJob.request.ID != id && !m.speedJob.snapshot(false).Finished {
		return NativeSpeedStatus{}, errors.New("speed target changed")
	}
	m.speedEpoch = epoch
	if reason != "user-cancelled" && reason != "target-changed" && reason != "helper-changed" && reason != "network-stopped" && reason != "closed" && reason != "deadline" && reason != "control-unavailable" {
		reason = "user-cancelled"
	}
	if m.speedJob != nil && m.speedJob.request.ID == id {
		m.speedJob.finish(reason, false)
		return m.speedJob.snapshot(false), nil
	}
	metrics := nativeSpeedEmptyMetrics()
	metrics.StopReason = &reason
	return NativeSpeedStatus{ProtocolVersion: 5, ID: id, Phase: "waiting", Finished: true, Metrics: metrics}, nil
}
func (m *Manager) closeNativeSpeed(reason string) {
	m.speedMu.Lock()
	defer m.speedMu.Unlock()
	if m.speedJob != nil {
		m.speedJob.finish(reason, false)
	}
}

// The message representation is shared by the bounded, private synthetic
// endpoint; no endpoint/address may be supplied in its protocol.
type nativeSpeedMessage struct {
	StageCount           int                       `json:"stageCount,omitempty"`
	Connections          int                       `json:"connections,omitempty"`
	StreamIndex          int                       `json:"streamIndex,omitempty"`
	Multi                *NativeSpeedMultiTransfer `json:"multi,omitempty"`
	StageIndex           int                       `json:"stageIndex,omitempty"`
	TargetBytesPerSecond uint64                    `json:"targetBytesPerSecond,omitempty"`
	StopReason           string                    `json:"stopReason,omitempty"`
	Kind                 string                    `json:"kind"`
	Phase                string                    `json:"phase,omitempty"`
	ID                   string                    `json:"id,omitempty"`
	Ticket               string                    `json:"ticket,omitempty"`
	Nonce                string                    `json:"nonce,omitempty"`
	SentBytes            uint64                    `json:"sentBytes,omitempty"`
	SentPackets          uint64                    `json:"sentPackets,omitempty"`
	DurationMs           float64                   `json:"durationMs,omitempty"`
	LimitReached         bool                      `json:"limitReached,omitempty"`
	Transfer             *NativeSpeedTransfer      `json:"transfer,omitempty"`
	UDP                  *NativeSpeedUDPTransfer   `json:"udp,omitempty"`
	Latency              *NativeSpeedLatency       `json:"latency,omitempty"`
}

func nativeSpeedTCPPhase(phase string) bool {
	return phase == "tcp-adaptive-download" || phase == "tcp-adaptive-upload"
}
