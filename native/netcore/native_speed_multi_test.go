package netcore

import (
	"context"
	"encoding/binary"
	"net"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func nativeSpeedTestMultiJob(t *testing.T, role, name string) (*nativeSpeedJob, *nativeSpeedMultiPhase) {
	t.Helper()
	j := newNativeSpeedJob(nativeSpeedTestRequest(), role, nativeTestBackend{}, nativeSpeedOptions{multiBytes: 1024 * 1024, multiDuration: 100 * time.Millisecond})
	for index, count := range nativeSpeedConnectionCounts[:2] {
		r := &j.status.Metrics.TCPMulti.Upload
		if name == "tcp-adaptive-download" {
			r = &j.status.Metrics.TCPMulti.Download
		}
		nativeSpeedPutTCPStage(r, NativeSpeedTCPStage{NativeSpeedMultiTransfer: nativeSpeedEmptyMulti(count), Index: index, Connections: count})
	}
	p := j.newMulti(name, strings.Repeat("a", 32), 2, 4)
	if !j.activateMulti(p) {
		t.Fatal("activate")
	}
	t.Cleanup(func() { j.finish("closed", false) })
	return j, p
}

func TestNativeSpeedMultiUsesSharedWallWindow(t *testing.T) {
	_, p := nativeSpeedTestMultiJob(t, "client", "tcp-adaptive-download")
	p.started = time.Now().Add(-5 * time.Second)
	p.frozenAt = p.started.Add(4 * time.Second)
	p.senderMs[3] = 5000
	for i := range p.streams {
		p.streams[i].ReceivedBytes = uint64(100 * (i + 1))
		p.streams[i].Completion = "complete"
		p.received += p.streams[i].ReceivedBytes
	}
	v := p.result(true)
	if v.ReceivedBytes != 1000 || v.DurationMs != 5000 || v.BytesPerSecond != 200 {
		t.Fatalf("aggregate did not divide total bytes by shared wall time: %+v", v)
	}
	for _, s := range v.Streams {
		if s.DurationMs != v.DurationMs {
			t.Fatal("stream did not retain common window")
		}
	}
}
func TestNativeSpeedMultiSharedByteBudget(t *testing.T) {
	_, p := nativeSpeedTestMultiJob(t, "host", "tcp-adaptive-download")
	p.job.opts.multiBytes = 4*nativeSpeedFrameBytes + 1234
	var sum atomic.Uint64
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				n := p.reserve()
				if n == 0 {
					return
				}
				if n > nativeSpeedFrameBytes {
					t.Error("oversize reservation")
				}
				sum.Add(n)
			}
		}()
	}
	wg.Wait()
	if sum.Load() != p.job.opts.multiBytes || p.reserved.Load() != sum.Load() {
		t.Fatalf("budget multiplied across streams: %d", sum.Load())
	}
}
func TestNativeSpeedMultiReadyBarrierAndNonceBinding(t *testing.T) {
	m := nativeSpeedTestManager(t)
	r := nativeSpeedTestRequest()
	s, err := m.NativeSpeedPrepare(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	j := m.speedJob
	p := j.newMulti("tcp-adaptive-download", strings.Repeat("a", 32), 4, 16)
	if !j.activateMulti(p) {
		t.Fatal("activate")
	}
	user, password := nativeSpeedAuth(r)
	open := func(index int, phase, nonce string, valid bool, binding ...int) {
		stage, count := p.stageIndex, p.count
		if len(binding) == 2 {
			stage, count = binding[0], binding[1]
		}
		c := nativeTestSOCKS(t, s.Port, user, password)
		if err := nativeSendRequest(c, 1, nativeSpeedName, 4); err != nil {
			t.Fatal(err)
		}
		code, _, _, err := nativeReadReply(c)
		if err != nil || code != 0 {
			t.Fatalf("synthetic port: %d %v", code, err)
		}
		err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "multi", ID: r.ID, Ticket: r.Ticket, Phase: phase, Nonce: nonce, StageIndex: stage, Connections: count, StreamIndex: index})
		if err != nil {
			t.Fatal(err)
		}
		ack, err := nativeSpeedReadMessageTimeout(c, time.Second)
		if valid {
			if err != nil || ack.Kind != "ready" || ack.StreamIndex != index {
				t.Fatalf("valid lane rejected: %+v %v", ack, err)
			}
		} else {
			c.Close()
			if err == nil {
				t.Fatal("duplicate/stale lane accepted")
			}
		}
	}
	for i := 0; i < p.count-1; i++ {
		open(i, p.name, p.nonce, true)
	}
	select {
	case <-p.ready:
		t.Fatal("start gate opened with only three lanes")
	default:
	}
	open(0, p.name, p.nonce, false)
	open(p.count-1, "tcp-adaptive-upload", p.nonce, false)
	open(p.count-1, p.name, strings.Repeat("b", 32), false)
	open(p.count-1, p.name, p.nonce, false, 3, 16)
	open(p.count-1, p.name, p.nonce, false, 4, 8)
	open(p.count-1, p.name, p.nonce, true)
	select {
	case <-p.ready:
	case <-time.After(time.Second):
		t.Fatal("fourth lane could not join")
	}
}
func TestNativeSpeedMultiStreamFailureKeepsPartialAndClosesGroup(t *testing.T) {
	_, p := nativeSpeedTestMultiJob(t, "host", "tcp-adaptive-upload")
	var peers [4]net.Conn
	for i := 0; i < 4; i++ {
		a, b := net.Pipe()
		p.claim(i, a)
		peers[i] = b
		t.Cleanup(func() { b.Close() })
	}
	p.start()
	type outcome struct {
		v   NativeSpeedMultiTransfer
		err error
	}
	done := make(chan outcome, 1)
	go func() { v, err := p.runReceive(); done <- outcome{v, err} }()
	for i := 0; i < 3; i++ {
		if err := nativeSpeedWriteFrame(peers[i], nativeSpeedData, make([]byte, 1024)); err != nil {
			t.Fatal(err)
		}
	}
	// A successful net.Pipe write does not mean the reader goroutine has
	// published its count yet. Establish that receiver evidence before failing
	// a different stream; otherwise the test races the intentional freeze.
	observed := time.Now().Add(time.Second)
	for {
		p.mu.Lock()
		received := p.received
		p.mu.Unlock()
		if received == 3072 {
			break
		}
		if time.Now().After(observed) {
			t.Fatal("receiver did not publish completed frames")
		}
		time.Sleep(time.Millisecond)
	}
	var header [5]byte
	header[0] = nativeSpeedData
	binary.BigEndian.PutUint32(header[1:], 1024)
	if _, err := peers[3].Write(header[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := peers[3].Write(make([]byte, 512)); err != nil {
		t.Fatal(err)
	}
	peers[3].Close()
	select {
	case result := <-done:
		if result.err == nil || result.v.Completion != "partial" || result.v.ReceivedBytes != 3584 {
			t.Fatalf("lost partial frame or treated send failure as success: %+v %v", result.v, result.err)
		}
	case <-time.After(time.Second):
		p.Close()
		t.Fatal("failed stream did not stop its group")
	}
	for i := 0; i < 3; i++ {
		peers[i].SetWriteDeadline(time.Now().Add(100 * time.Millisecond))
		if _, err := peers[i].Write([]byte{1}); err == nil {
			t.Fatal("sibling stream remains open")
		}
	}
}
func TestNativeSpeedMultiCancellationAndLateProgress(t *testing.T) {
	j, p := nativeSpeedTestMultiJob(t, "client", "tcp-adaptive-download")
	p.start()
	p.mu.Lock()
	p.received = 100
	p.streams[0].ReceivedBytes = 100
	p.mu.Unlock()
	old := p.result(false)
	j.multiResult(p, old)
	p.mu.Lock()
	p.received = 200
	p.streams[0].ReceivedBytes = 200
	p.mu.Unlock()
	j.releaseMulti(p, false)
	frozen := j.snapshot(false).Metrics.TCPMulti.Download
	j.multiResult(p, old)
	if !reflect.DeepEqual(frozen, j.snapshot(false).Metrics.TCPMulti.Download) {
		t.Fatal("late progress overwrote frozen partial")
	}
	j.finish("user-cancelled", false)
	j.multiResult(p, old)
	if j.snapshot(false).Metrics.TCPMulti.Download.Stages[2].ReceivedBytes != 200 {
		t.Fatal("cancel dropped observed bytes")
	}
	sender, phase := nativeSpeedTestMultiJob(t, "client", "tcp-adaptive-upload")
	phase.start()
	sender.finish("user-cancelled", false)
	v := sender.snapshot(false).Metrics.TCPMulti.Upload.Stages[2]
	if v.DurationMs != 0 || v.ReceivedBytes != 0 {
		t.Fatalf("unknown receiver was turned into zero throughput: %+v", v)
	}
}
func TestNativeSpeedMultiReceiptValidation(t *testing.T) {
	v := nativeSpeedEmptyMulti(4)
	v.Completion = "complete"
	v.DurationMs = 1
	v.ReceivedBytes = 400
	sent := make([]uint64, 4)
	minimum := make([]float64, 4)
	for i := range sent {
		sent[i] = 100
		minimum[i] = 2
		v.Streams[i] = NativeSpeedTCPStream{Index: i, ReceivedBytes: 100, DurationMs: 1, Completion: "complete"}
	}
	if !nativeSpeedValidMulti(&v, sent, 400, minimum) || v.DurationMs < 2 || v.BytesPerSecond != 200000 {
		t.Fatal("local sender window not enforced")
	}
	if nativeSpeedValidMulti(&v, sent[:1], 400, minimum[:1]) {
		t.Fatal("mismatched dynamic receipt size accepted")
	}
	v.Streams[3].ReceivedBytes = 99
	if nativeSpeedValidMulti(&v, sent, 400, minimum) {
		t.Fatal("sender bytes accepted without matching receiver receipt")
	}
}
