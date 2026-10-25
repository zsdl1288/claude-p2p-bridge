package netcore

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math"
	"net"
	"strconv"
	"sync"
	"time"
)

type nativeSpeedUDPPhase struct {
	mu           sync.Mutex
	name         string
	index        int
	rate         uint64
	nonce        [16]byte
	started      time.Time
	last         time.Time
	seen         []uint64
	received     uint64
	duplicate    uint64
	outOfOrder   uint64
	highest      uint32
	hasHighest   bool
	maximum      uint64
	frozen       bool
	source       net.Addr
	registered   chan struct{}
	registerOnce sync.Once
}

func newNativeSpeedUDPPhase(name string, nonce [16]byte, maxBytes uint64) *nativeSpeedUDPPhase {
	maximum := maxBytes / nativeSpeedPacketBytes
	now := time.Now()
	return &nativeSpeedUDPPhase{name: name, nonce: nonce, started: now, last: now, maximum: maximum, seen: make([]uint64, (maximum+63)/64), registered: make(chan struct{})}
}
func (p *nativeSpeedUDPPhase) add(sequence uint32) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.frozen || uint64(sequence) >= p.maximum {
		return false
	}
	index, mask := sequence/64, uint64(1)<<(sequence%64)
	if p.seen[index]&mask != 0 {
		if p.duplicate < p.maximum {
			p.duplicate++
		}
		return false
	}
	p.seen[index] |= mask
	p.received++
	p.last = time.Now()
	if p.hasHighest && sequence < p.highest {
		p.outOfOrder++
	}
	if !p.hasHighest || sequence > p.highest {
		p.highest = sequence
		p.hasHighest = true
	}
	return true
}
func (p *nativeSpeedUDPPhase) result(sent *uint64, offered uint64, confirmed bool, duration ...float64) NativeSpeedUDPTransfer {
	p.mu.Lock()
	defer p.mu.Unlock()
	if confirmed {
		p.frozen = true
	}
	received := p.received
	if sent != nil {
		received = 0
		for seq := uint64(0); seq < *sent && seq < p.maximum; seq++ {
			if p.seen[seq/64]&(uint64(1)<<(seq%64)) != 0 {
				received++
			}
		}
	}
	last := time.Now()
	if confirmed && len(duration) > 0 {
		last = p.started.Add(time.Duration(duration[0] * float64(time.Millisecond)))
		if p.last.After(last) {
			last = p.last
		}
	}
	v := NativeSpeedUDPTransfer{NativeSpeedTransfer: nativeSpeedTransfer(received*nativeSpeedPacketBytes, p.started, last, "partial", false), ReceivedPackets: received, DuplicatePackets: p.duplicate, OutOfOrderPackets: p.outOfOrder, OfferedBytesPerSecond: offered, PacketBytes: nativeSpeedPacketBytes}
	// Preserve the exact transmitted measurement window: converting a float
	// through integer nanoseconds can otherwise shorten it by one nanosecond.
	if confirmed && len(duration) > 0 && v.DurationMs < duration[0] {
		v.DurationMs = duration[0]
		v.BytesPerSecond = float64(v.ReceivedBytes) * 1000 / v.DurationMs
	}
	if sent != nil {
		packets := *sent
		bytes := packets * nativeSpeedPacketBytes
		v.SentPackets = &packets
		v.SentBytes = &bytes
		if confirmed && packets > 0 && packets <= p.maximum {
			lost := packets - received
			loss := float64(lost) * 100 / float64(packets)
			v.LostPackets = &lost
			v.LossPercent = &loss
			v.Completion = "complete"
			v.LimitReached = packets == p.maximum
		}
	}
	return v
}
func nativeSpeedUDPPacket(nonce [16]byte, kind byte, seq uint32) []byte {
	b := make([]byte, nativeSpeedPacketBytes)
	copy(b, nonce[:])
	b[16] = kind
	binary.BigEndian.PutUint32(b[17:21], seq)
	for i := 21; i < len(b); i++ {
		b[i] = byte(i)
	}
	return b
}
func nativeSpeedParseUDP(packet []byte, nonce [16]byte) (byte, uint32, bool) {
	if len(packet) != nativeSpeedPacketBytes || !bytes.Equal(packet[:16], nonce[:]) {
		return 0, 0, false
	}
	return packet[16], binary.BigEndian.Uint32(packet[17:21]), true
}
func (j *nativeSpeedJob) receiveSyntheticUDP(pc net.PacketConn) {
	buf := make([]byte, nativeSpeedPacketBytes+1)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		j.udpMu.Lock()
		phase := j.udpPhase
		j.udpMu.Unlock()
		if phase == nil {
			continue
		}
		kind, seq, ok := nativeSpeedParseUDP(buf[:n], phase.nonce)
		if !ok {
			continue
		}
		phase.mu.Lock()
		if kind == 2 && phase.source == nil {
			phase.source = from
			phase.registerOnce.Do(func() { close(phase.registered) })
		}
		allowed := phase.source != nil && phase.source.String() == from.String()
		phase.mu.Unlock()
		if allowed && kind == 1 && phase.name == "udp-upload" && phase.add(seq) {
			if seq%128 == 0 {
				j.udpStageResult(phase.name, nativeSpeedStage(phase.index, phase.rate, phase.result(nil, phase.rate, false), nil))
			}
		}
	}
}
func (j *nativeSpeedJob) wait(duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-j.ctx.Done():
		return j.ctx.Err()
	case <-timer.C:
		return nil
	}
}
func nativeSpeedUDPBurst(rate uint64) float64 {
	return math.Max(4, math.Min(1024, float64(rate)*0.002/nativeSpeedPacketBytes))
}
func (j *nativeSpeedJob) sendUDP(rate, maxBytes uint64, nonce [16]byte, write func([]byte) error) (uint64, float64, error) {
	start := time.Now()
	last := start
	timer := time.NewTicker(time.Millisecond)
	defer timer.Stop()
	var sent uint64
	var credit float64
	maximum := maxBytes / nativeSpeedPacketBytes
	// At most 2ms of catch-up, bounded even if the scheduler stalls. Unlike
	// a fixed packet cap this permits high rates without manufacturing bursts.
	burst := nativeSpeedUDPBurst(rate)
	packet := nativeSpeedUDPPacket(nonce, 1, 0)
	for sent < maximum && time.Since(start) < j.opts.udpStageDuration {
		select {
		case <-j.ctx.Done():
			return sent, float64(time.Since(start)) / float64(time.Millisecond), j.ctx.Err()
		case <-timer.C:
			now := time.Now()
			credit += now.Sub(last).Seconds() * float64(rate) / nativeSpeedPacketBytes
			last = now
			if credit > burst {
				credit = burst
			}
			for credit >= 1 && sent < maximum && time.Since(start) < j.opts.udpStageDuration {
				binary.BigEndian.PutUint32(packet[17:21], uint32(sent))
				if err := write(packet); err != nil {
					return sent, float64(time.Since(start)) / float64(time.Millisecond), err
				}
				sent++
				credit--
			}
		}
	}
	return sent, float64(time.Since(start)) / float64(time.Millisecond), nil
}
func nativeSpeedValidUDP(v *NativeSpeedUDPTransfer, sent, maxBytes uint64) bool {
	if v == nil || v.SentPackets == nil || v.SentBytes == nil || *v.SentPackets != sent || *v.SentBytes != sent*nativeSpeedPacketBytes || sent > maxBytes/nativeSpeedPacketBytes || v.ReceivedPackets > sent || v.ReceivedBytes != v.ReceivedPackets*nativeSpeedPacketBytes || v.PacketBytes != nativeSpeedPacketBytes || v.LostPackets == nil || v.LossPercent == nil || *v.LostPackets != sent-v.ReceivedPackets || v.Completion != "complete" || v.DurationMs <= 0 || v.DurationMs > 60000 || math.IsNaN(v.DurationMs) || math.IsInf(v.DurationMs, 0) {
		return false
	}
	return true
}
func nativeSpeedValidUDPEnd(end nativeSpeedMessage, name string, maxBytes uint64) bool {
	return end.Kind == "end" && end.Phase == name && end.SentPackets > 0 && end.SentPackets <= maxBytes/nativeSpeedPacketBytes && end.SentBytes == end.SentPackets*nativeSpeedPacketBytes && end.DurationMs > 0 && end.DurationMs <= 60000 && !math.IsNaN(end.DurationMs) && !math.IsInf(end.DurationMs, 0)
}
func (j *nativeSpeedJob) releaseUDPPhase(p *nativeSpeedUDPPhase) {
	if j.role == "host" && p.name == "udp-upload" || j.role == "client" && p.name == "udp-download" {
		p.mu.Lock()
		p.frozen = true
		p.mu.Unlock()
		j.udpStageResult(p.name, nativeSpeedStage(p.index, p.rate, p.result(nil, p.rate, false), nil))
	}
	j.udpMu.Lock()
	if j.udpPhase == p {
		j.udpPhase = nil
	}
	j.udpMu.Unlock()
}
func (j *nativeSpeedJob) hostUDPStage(c net.Conn, name string, index int, rate, maxBytes uint64) (NativeSpeedUDPStage, error) {
	var empty NativeSpeedUDPStage
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return empty, err
	}
	phase := newNativeSpeedUDPPhase(name, nonce, maxBytes)
	phase.index = index
	phase.rate = rate
	j.udpMu.Lock()
	j.udpPhase = phase
	j.udpMu.Unlock()
	defer j.releaseUDPPhase(phase)
	if err := nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "ready", Phase: name, Nonce: hex.EncodeToString(nonce[:])}); err != nil {
		return empty, err
	}
	select {
	case <-j.ctx.Done():
		return empty, j.ctx.Err()
	case <-phase.registered:
	case <-time.After(5 * time.Second):
		return empty, errors.New("UDP registration timeout")
	}
	phase.mu.Lock()
	phase.started = time.Now()
	source := phase.source
	phase.mu.Unlock()
	if err := nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "started", Phase: name}); err != nil {
		return empty, err
	}
	if name == "udp-download" {
		sent, duration, err := j.sendUDP(rate, maxBytes, nonce, func(packet []byte) error {
			j.udp.SetWriteDeadline(time.Now().Add(time.Second))
			_, err := j.udp.WriteTo(packet, source)
			return err
		})
		if err != nil {
			return empty, err
		}
		if err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "end", Phase: name, SentPackets: sent, SentBytes: sent * nativeSpeedPacketBytes, DurationMs: duration}); err != nil {
			return empty, err
		}
		report, err := nativeSpeedReadMessage(c)
		if err != nil {
			return empty, err
		}
		if report.Kind != "received" || report.Phase != name || !nativeSpeedValidUDP(report.UDP, sent, maxBytes) {
			return empty, errors.New("invalid UDP receiver report")
		}
		if report.UDP.DurationMs < duration {
			report.UDP.DurationMs = duration
		}
		report.UDP.BytesPerSecond = float64(report.UDP.ReceivedBytes) * 1000 / report.UDP.DurationMs
		loss := float64(*report.UDP.LostPackets) * 100 / float64(sent)
		report.UDP.LossPercent = &loss
		stage := nativeSpeedStage(index, rate, *report.UDP, &duration)
		j.udpStageResult(name, stage)
		return stage, nil
	}
	end, err := nativeSpeedReadMessage(c)
	if err != nil {
		return empty, err
	}
	if !nativeSpeedValidUDPEnd(end, name, maxBytes) {
		return empty, errors.New("invalid UDP sender report")
	}
	if err = j.wait(j.opts.drain); err != nil {
		return empty, err
	}
	v := phase.result(&end.SentPackets, rate, true, end.DurationMs)
	stage := nativeSpeedStage(index, rate, v, &end.DurationMs)
	j.udpStageResult(name, stage)
	return stage, nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "received", Phase: name, UDP: &v})
}
func (j *nativeSpeedJob) openLocalUDP() (net.Conn, net.PacketConn, *net.UDPAddr, error) {
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		return nil, nil, nil, err
	}
	if !j.add(pc) {
		return nil, nil, nil, errors.New("speed closed")
	}
	j.mu.Lock()
	port := j.status.Port
	j.mu.Unlock()
	c, err := net.DialTimeout("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 5*time.Second)
	if err != nil {
		pc.Close()
		return nil, nil, nil, err
	}
	if !j.add(c) {
		return nil, nil, nil, errors.New("speed closed")
	}
	c.SetDeadline(time.Now().Add(5 * time.Second))
	u, pw := nativeSpeedLocalAuth(j.request)
	if err = nativeSendAuth(c, u, pw); err != nil {
		return c, pc, nil, err
	}
	source, _ := nativeAddrPort(pc.LocalAddr())
	if err = nativeSendRequest(c, 3, "127.0.0.1", int(source.Port())); err != nil {
		return c, pc, nil, err
	}
	code, host, relayPort, err := nativeReadReply(c)
	if err != nil {
		return c, pc, nil, err
	}
	if code != 0 || host != "127.0.0.1" || relayPort < 1 {
		return c, pc, nil, errors.New("speed UDP denied")
	}
	c.SetDeadline(time.Time{})
	return c, pc, &net.UDPAddr{IP: net.ParseIP(host), Port: relayPort}, nil
}
func (j *nativeSpeedJob) clientUDPStage(c net.Conn, name string, index int, rate, maxBytes uint64) (NativeSpeedUDPStage, error) {
	var empty NativeSpeedUDPStage
	ready, err := nativeSpeedReadMessage(c)
	if err != nil {
		return empty, err
	}
	nonceBytes, err := hex.DecodeString(ready.Nonce)
	if err != nil || len(nonceBytes) != 16 || ready.Kind != "ready" || ready.Phase != name {
		return empty, errors.New("invalid UDP phase")
	}
	var nonce [16]byte
	copy(nonce[:], nonceBytes)
	control, pc, relay, err := j.openLocalUDP()
	if control != nil {
		defer j.remove(control)
	}
	if pc != nil {
		defer j.remove(pc)
	}
	if err != nil {
		return empty, err
	}
	phase := newNativeSpeedUDPPhase(name, nonce, maxBytes)
	phase.index = index
	phase.rate = rate
	j.udpMu.Lock()
	j.udpPhase = phase
	j.udpMu.Unlock()
	defer j.releaseUDPPhase(phase)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		buf := make([]byte, 2048)
		for {
			select {
			case <-stop:
				return
			case <-j.ctx.Done():
				return
			default:
			}
			pc.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
					continue
				}
				return
			}
			if from.String() != relay.String() {
				continue
			}
			host, port, payload, ok := nativeDatagram(buf[:n])
			if !ok || host != "127.0.0.1" || port != 2 {
				continue
			}
			kind, seq, ok := nativeSpeedParseUDP(payload, nonce)
			if ok && kind == 1 && name == "udp-download" && phase.add(seq) && seq%128 == 0 {
				j.udpStageResult(name, nativeSpeedStage(index, rate, phase.result(nil, rate, false), nil))
			}
		}
	}()
	write := func(payload []byte) error {
		frame := nativeUDPFrame(nativeSpeedName, 2, payload)
		pc.SetWriteDeadline(time.Now().Add(time.Second))
		_, err := pc.WriteTo(frame, relay)
		return err
	}
	registration := nativeSpeedUDPPacket(nonce, 2, 0)
	type acknowledgment struct {
		msg nativeSpeedMessage
		err error
	}
	ack := make(chan acknowledgment, 1)
	go func() { msg, err := nativeSpeedReadMessage(c); ack <- acknowledgment{msg, err} }()
	if err = write(registration); err != nil {
		return empty, err
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	waiting := true
	for waiting {
		select {
		case <-j.ctx.Done():
			return empty, j.ctx.Err()
		case <-deadline.C:
			return empty, errors.New("UDP registration timeout")
		case <-ticker.C:
			if err = write(registration); err != nil {
				return empty, err
			}
		case result := <-ack:
			if result.err != nil {
				return empty, result.err
			}
			if result.msg.Kind != "started" || result.msg.Phase != name {
				return empty, errors.New("invalid UDP start")
			}
			waiting = false
		}
	}
	if name == "udp-download" {
		end, err := nativeSpeedReadMessage(c)
		if err != nil {
			return empty, err
		}
		if !nativeSpeedValidUDPEnd(end, name, maxBytes) {
			return empty, errors.New("invalid UDP sender report")
		}
		if err = j.wait(j.opts.drain); err != nil {
			return empty, err
		}
		v := phase.result(&end.SentPackets, rate, true, end.DurationMs)
		stage := nativeSpeedStage(index, rate, v, &end.DurationMs)
		j.udpStageResult(name, stage)
		return stage, nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "received", Phase: name, UDP: &v})
	}
	sent, duration, err := j.sendUDP(rate, maxBytes, nonce, write)
	if err != nil {
		return empty, err
	}
	if err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "end", Phase: name, SentPackets: sent, SentBytes: sent * nativeSpeedPacketBytes, DurationMs: duration}); err != nil {
		return empty, err
	}
	report, err := nativeSpeedReadMessage(c)
	if err != nil {
		return empty, err
	}
	if report.Kind != "received" || report.Phase != name || !nativeSpeedValidUDP(report.UDP, sent, maxBytes) {
		return empty, errors.New("invalid UDP receiver report")
	}
	if report.UDP.DurationMs < duration {
		report.UDP.DurationMs = duration
	}
	report.UDP.BytesPerSecond = float64(report.UDP.ReceivedBytes) * 1000 / report.UDP.DurationMs
	loss := float64(*report.UDP.LostPackets) * 100 / float64(sent)
	report.UDP.LossPercent = &loss
	stage := nativeSpeedStage(index, rate, *report.UDP, &duration)
	j.udpStageResult(name, stage)
	return stage, nil
}
