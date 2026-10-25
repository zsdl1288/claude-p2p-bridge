package netcore

import (
	"context"
	"errors"
	"net"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func nativeSpeedTestRequest() NativeSpeedRequest {
	return NativeSpeedRequest{ProtocolVersion: 5, Epoch: 2, ID: "11111111-2222-4333-8444-555555555555", Session: "speed-session-test", Ticket: strings.Repeat("x", 43), PeerIP: "127.0.0.1", Host: "127.0.0.1"}
}
func nativeSpeedTestManager(t *testing.T) *Manager {
	t.Helper()
	m := &Manager{resources: make(map[string]*proxy), nativeBackend: nativeTestBackend{}, nativeReady: true, nativeOptions: nativeProxyOptions{allowLoopbackPeers: true}, speedOptions: nativeSpeedOptions{tcpDuration: 100 * time.Millisecond, multiDuration: 100 * time.Millisecond, multiBytes: 2 * 1024 * 1024, udpDuration: 2 * time.Second, udpStageDuration: 100 * time.Millisecond, drain: 30 * time.Millisecond, deadline: 10 * time.Second, lease: time.Second, cooldown: time.Nanosecond, tcpBytes: 4 * 1024 * 1024, udpBytes: 128 * nativeSpeedPacketBytes, udpRate: 1100000}}
	t.Cleanup(m.Close)
	return m
}
func nativeSpeedWait(t *testing.T, m *Manager, id string) NativeSpeedStatus {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		s, err := m.NativeSpeedStatus(id, true)
		if err != nil {
			t.Fatal(err)
		}
		if s.Finished {
			return s
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("speed test did not finish")
	return NativeSpeedStatus{}
}

func TestNativeSpeedActualProxyTCPUDP(t *testing.T) {
	b, a := nativeSpeedTestManager(t), nativeSpeedTestManager(t)
	for _, m := range []*Manager{a, b} {
		m.speedOptions.udpRates = []uint64{125000, 250000, 625000}
		m.speedOptions.udpBytes = 512 * 1024
	}
	r := nativeSpeedTestRequest()
	host, err := b.NativeSpeedPrepare(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	r.Port = host.Port
	if _, err = a.NativeSpeedStart(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(50 * time.Millisecond):
				b.NativeSpeedStatus(r.ID, true)
			}
		}
	}()
	as := nativeSpeedWait(t, a, r.ID)
	bs := nativeSpeedWait(t, b, r.ID)
	for _, s := range []NativeSpeedStatus{as, bs} {
		if !s.Metrics.Completed {
			t.Fatalf("incomplete: %+v", s)
		}
		for _, v := range []NativeSpeedTransfer{s.Metrics.Download, s.Metrics.Upload} {
			if v.Completion != "complete" || v.ReceivedBytes == 0 || v.BytesPerSecond <= 0 {
				t.Fatalf("TCP: %+v", v)
			}
		}
		for directionIndex, r := range []NativeSpeedTCPDirection{s.Metrics.TCPMulti.Download, s.Metrics.TCPMulti.Upload} {
			if r.Completion != "complete" || len(r.Stages) < 3 || len(r.Stages) > 5 || r.BestStageIndex == nil {
				t.Fatalf("incomplete TCP sweep: %+v", r)
			}
			_, reason, err := nativeSpeedTCPDecision(r.Stages)
			if err != nil || r.StopReason == nil || *r.StopReason != reason {
				t.Fatalf("unconfirmed TCP stop: %s %v", reason, err)
			}
			for stageIndex, v := range r.Stages {
				count := nativeSpeedConnectionCounts[stageIndex]
				if v.Index != stageIndex || v.Connections != count || len(v.Streams) != count || v.Completion != "complete" || v.ReceivedBytes > a.speedOptions.multiBytes {
					t.Fatalf("TCP stage: %+v", v)
				}
				var total uint64
				for i, stream := range v.Streams {
					if stream.Index != i || stream.Completion != "complete" || stream.ReceivedBytes == 0 || stream.DurationMs > v.DurationMs {
						t.Fatalf("TCP stream: %+v", stream)
					}
					total += stream.ReceivedBytes
				}
				if total != v.ReceivedBytes || v.BytesPerSecond != float64(total)*1000/v.DurationMs {
					t.Fatal("TCP rate not common-window aggregate")
				}
			}
			baseline := s.Metrics.Download
			if directionIndex == 1 {
				baseline = s.Metrics.Upload
			}
			if !reflect.DeepEqual(baseline, r.Stages[0].NativeSpeedTransfer) {
				t.Fatal("single-connection alias diverged from first stage")
			}
		}
		for _, r := range []NativeSpeedUDPResult{s.Metrics.UDP.Download, s.Metrics.UDP.Upload} {
			if r.Completion != "complete" || len(r.Stages) == 0 || r.StopReason == nil {
				t.Fatalf("UDP direction: %+v", r)
			}
			for _, v := range r.Stages {
				if v.SentPackets == nil || !nativeSpeedValidUDP(&v.NativeSpeedUDPTransfer, *v.SentPackets, a.speedOptions.udpBytes) || v.ReceivedPackets == 0 {
					t.Fatalf("UDP stage: %+v", v)
				}
			}
		}
	}
	if as.Metrics.Download.ReceivedBytes != bs.Metrics.Download.ReceivedBytes || as.Metrics.Upload.ReceivedBytes != bs.Metrics.Upload.ReceivedBytes {
		t.Fatal("receiver counts disagree")
	}
	if !reflect.DeepEqual(as.Metrics.TCPMulti, bs.Metrics.TCPMulti) {
		t.Fatalf("multi receiver reports diverged: A=%+v B=%+v", as.Metrics.TCPMulti, bs.Metrics.TCPMulti)
	}
	for _, m := range []*Manager{a, b} {
		p := m.speedJob.proxy
		s := p.status()
		if s.UploadBytes <= as.Metrics.Upload.ReceivedBytes || s.DownloadBytes <= as.Metrics.Download.ReceivedBytes {
			t.Fatalf("test bypassed proxy counters: %+v", s)
		}
		if s.Listening {
			t.Fatal("finished speed proxy remains live")
		}
	}
}

func TestNativeSpeedTargetAndAuthIsolation(t *testing.T) {
	b := nativeSpeedTestManager(t)
	r := nativeSpeedTestRequest()
	s, err := b.NativeSpeedPrepare(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	u, pw := nativeSpeedAuth(r)
	for _, host := range []string{"8.8.8.8", "127.0.0.1", "100.64.1.1", "example.com", "benchmark.invalid.evil"} {
		c := nativeTestSOCKS(t, s.Port, u, pw)
		if err = nativeSendRequest(c, 1, host, 1); err != nil {
			t.Fatal(err)
		}
		code, _, _, err := nativeReadReply(c)
		c.Close()
		if err != nil || code == 0 {
			t.Fatalf("allowed %s: %d %v", host, code, err)
		}
	}
	for _, port := range []int{0, 5, 443} {
		if _, err = nativeSpeedDestination(context.Background(), nativeSpeedName, port); err == nil {
			t.Fatalf("allowed synthetic port %d", port)
		}
	}
	c, err := net.Dial("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(s.Port)))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(time.Second))
	if nativeSendAuth(c, u, strings.Repeat("y", 43)) == nil {
		t.Fatal("wrong ticket authenticated")
	}
	// A different actual source IP cannot use the valid one-time credential.
	d := net.Dialer{LocalAddr: &net.TCPAddr{IP: net.ParseIP("127.0.0.2")}, Timeout: time.Second}
	c2, err := d.Dial("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(s.Port)))
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	c2.SetDeadline(time.Now().Add(time.Second))
	if nativeSendAuth(c2, u, pw) == nil {
		t.Fatal("wrong source authenticated")
	}
}

func TestNativeSpeedUDPUniqueLossAndFullWindow(t *testing.T) {
	p := newNativeSpeedUDPPhase("udp-download", [16]byte{1}, 100*nativeSpeedPacketBytes)
	p.started = time.Now().Add(-8 * time.Second)
	for _, seq := range []uint32{0, 2, 1, 2, 4} {
		p.add(seq)
	}
	p.last = p.started.Add(800 * time.Millisecond)
	partial := p.result(nil, nativeSpeedOffered, false)
	if partial.ReceivedPackets != 4 || partial.SentPackets != nil || partial.LossPercent != nil || partial.LostPackets != nil {
		t.Fatalf("unconfirmed loss fabricated: %+v", partial)
	}
	sent := uint64(10)
	v := p.result(&sent, nativeSpeedOffered, true, 8000)
	if *v.LostPackets != 6 || *v.LossPercent != 60 || v.DuplicatePackets != 1 || v.OutOfOrderPackets != 1 || v.DurationMs != 8000 || v.BytesPerSecond != 550 {
		t.Fatalf("bad full-window measurement %+v", v)
	}
	if p.add(8) {
		t.Fatal("finalized receiver changed")
	}
	j := newNativeSpeedJob(nativeSpeedTestRequest(), "host", nativeTestBackend{}, nativeSpeedOptions{})
	defer j.finish("closed", false)
	j.udpStageResult("udp-download", nativeSpeedStage(0, nativeSpeedOffered, v, nil))
	j.udpStageResult("udp-download", nativeSpeedStage(0, nativeSpeedOffered, partial, nil))
	if j.snapshot(false).Metrics.UDP.Download.Stages[0].Completion != "complete" {
		t.Fatal("late progress overwrote final")
	}
}

func TestNativeSpeedCancellationKeepsUnconfirmedUDPReceiveCount(t *testing.T) {
	j := newNativeSpeedJob(nativeSpeedTestRequest(), "client", nativeTestBackend{}, nativeSpeedOptions{})
	p := newNativeSpeedUDPPhase("udp-download", [16]byte{1}, 1024*nativeSpeedPacketBytes)
	j.udpMu.Lock()
	j.udpPhase = p
	j.udpMu.Unlock()
	for seq := uint32(0); seq < 127; seq++ {
		p.add(seq)
	}
	j.finish("user-cancelled", false)
	v := j.snapshot(false).Metrics.UDP.Download.Stages[0]
	if v.ReceivedPackets != 127 || v.ReceivedBytes != 127*nativeSpeedPacketBytes || v.SentPackets != nil || v.LostPackets != nil || v.LossPercent != nil || v.Completion != "partial" {
		t.Fatalf("cancellation lost observed receives or fabricated loss: %+v", v)
	}
}

func TestNativeSpeedMissingUDPReportPreservesActualReceiveCount(t *testing.T) {
	j := newNativeSpeedJob(nativeSpeedTestRequest(), "host", nativeTestBackend{}, nativeSpeedOptions{})
	defer j.finish("closed", false)
	p := newNativeSpeedUDPPhase("udp-upload", [16]byte{1}, 1024*nativeSpeedPacketBytes)
	j.udpPhase = p
	for seq := uint32(0); seq < 17; seq++ {
		p.add(seq)
	}
	j.releaseUDPPhase(p)
	v := j.snapshot(false).Metrics.UDP.Upload.Stages[0]
	if v.ReceivedPackets != 17 || v.SentPackets != nil || v.LostPackets != nil || v.LossPercent != nil || v.Completion != "partial" {
		t.Fatalf("missing report discarded real receives or fabricated confirmation: %+v", v)
	}
}

func TestNativeSpeedLeaseEpochAndNormalProxyPreserved(t *testing.T) {
	m := nativeSpeedTestManager(t)
	m.speedOptions.lease = 80 * time.Millisecond
	normal, err := m.NativeProxyConfigure(context.Background(), NativeProxyConfig{Epoch: 1, Role: "client", Enabled: false, Username: nativeTestLocalUser, Password: nativeTestLocalPassword})
	if err != nil {
		t.Fatal(err)
	}
	r := nativeSpeedTestRequest()
	if _, err = m.NativeSpeedPrepare(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	time.Sleep(120 * time.Millisecond)
	s, err := m.NativeSpeedStatus(r.ID, true)
	if err != nil || !s.Finished || s.Metrics.StopReason == nil || *s.Metrics.StopReason != "control-unavailable" {
		t.Fatalf("expired renew revived: %+v %v", s, err)
	}
	if _, err = m.NativeSpeedCancel(4, r.ID, "user-cancelled"); err != nil {
		t.Fatal(err)
	}
	r.Epoch = 3
	if _, err = m.NativeSpeedPrepare(context.Background(), r); err == nil {
		t.Fatal("stale prepare resurrected")
	}
	after := m.NativeProxyStatus()
	if !after.Listening || after.Port != normal.Port || after.Epoch != normal.Epoch {
		t.Fatal("speed cancellation changed regular proxy")
	}
	r.Epoch = 6
	if _, err = m.NativeSpeedPrepare(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if _, err = m.NativeSpeedCancel(8, r.ID, "user-cancelled"); err != nil {
		t.Fatal(err)
	}
	if _, err = m.NativeSpeedStatus("00000000-2222-4333-8444-555555555555", true); err == nil {
		t.Fatal("wrong id refreshed job")
	}
}

type nativeSpeedBlockingBackend struct {
	nativeTestBackend
	entered  chan struct{}
	release  chan struct{}
	listener net.Listener
	once     sync.Once
}

func (b *nativeSpeedBlockingBackend) Listen(network, address string) (net.Listener, error) {
	b.once.Do(func() { close(b.entered) })
	<-b.release
	ln, err := b.nativeTestBackend.Listen(network, address)
	b.listener = ln
	return ln, err
}
func TestNativeSpeedCancelDuringPrepareClosesLateListener(t *testing.T) {
	m := nativeSpeedTestManager(t)
	b := &nativeSpeedBlockingBackend{entered: make(chan struct{}), release: make(chan struct{})}
	m.nativeBackend = b
	r := nativeSpeedTestRequest()
	prepared := make(chan error, 1)
	go func() { _, err := m.NativeSpeedPrepare(context.Background(), r); prepared <- err }()
	<-b.entered
	cancelled, err := m.NativeSpeedCancel(4, r.ID, "user-cancelled")
	if err != nil || !cancelled.Finished {
		t.Fatalf("cancel blocked by prepare: %+v %v", cancelled, err)
	}
	close(b.release)
	if err = <-prepared; err == nil {
		t.Fatal("cancelled preparation succeeded")
	}
	if b.listener == nil {
		t.Fatal("fixture did not create late listener")
	}
	c, err := net.DialTimeout("tcp4", b.listener.Addr().String(), 100*time.Millisecond)
	if err == nil {
		c.Close()
		t.Fatal("late listener leaked")
	}
}

type nativeSpeedBlockingCloser struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (c *nativeSpeedBlockingCloser) Close() error {
	c.once.Do(func() { close(c.entered) })
	<-c.release
	return nil
}
func TestNativeSpeedCancelWaitsForResourceClosure(t *testing.T) {
	m := nativeSpeedTestManager(t)
	r := nativeSpeedTestRequest()
	j := newNativeSpeedJob(r, "host", nativeTestBackend{}, m.speedOptions)
	m.speedJob = j
	m.speedEpoch = r.Epoch
	c := &nativeSpeedBlockingCloser{entered: make(chan struct{}), release: make(chan struct{})}
	j.add(c)
	go j.finish("control-unavailable", false)
	<-c.entered
	done := make(chan error, 1)
	go func() {
		s, err := m.NativeSpeedCancel(4, r.ID, "user-cancelled")
		if err == nil && !s.Finished {
			err = errors.New("cancel unfinished")
		}
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("early cancel acknowledgment %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(c.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestNativeSpeedConcurrentReservationAndCancelledContext(t *testing.T) {
	m := nativeSpeedTestManager(t)
	r := nativeSpeedTestRequest()
	var successes atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := m.NativeSpeedPrepare(context.Background(), r); err == nil {
				successes.Add(1)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatalf("accepted %d reservations", successes.Load())
	}
	m.NativeSpeedCancel(10, r.ID, "user-cancelled")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// Check context rejection independently of the earlier reservation's
	// cooldown; Windows clock granularity can otherwise select that error first.
	fresh := nativeSpeedTestManager(t)
	if _, err := fresh.NativeSpeedPrepare(ctx, r); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled request accepted %v", err)
	}
	if fresh.speedJob != nil {
		t.Fatal("cancelled request allocated a speed job")
	}
}
