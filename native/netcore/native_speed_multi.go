package netcore

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

type NativeSpeedTCPStream struct {
	Index         int     `json:"index"`
	ReceivedBytes uint64  `json:"receivedBytes"`
	DurationMs    float64 `json:"durationMs"`
	Completion    string  `json:"completion"`
	LimitReached  bool    `json:"limitReached"`
}
type NativeSpeedMultiTransfer struct {
	NativeSpeedTransfer
	Streams []NativeSpeedTCPStream `json:"streams"`
}
type NativeSpeedTCPMulti struct {
	Mode             string                  `json:"mode"`
	ConnectionCounts []int                   `json:"connectionCounts"`
	EarlyStop        NativeSpeedTCPEarlyStop `json:"earlyStop"`
	Download         NativeSpeedTCPDirection `json:"download"`
	Upload           NativeSpeedTCPDirection `json:"upload"`
}

func nativeSpeedEmptyMulti(count int) NativeSpeedMultiTransfer {
	v := NativeSpeedMultiTransfer{NativeSpeedTransfer: NativeSpeedTransfer{Completion: "failed"}, Streams: make([]NativeSpeedTCPStream, count)}
	for i := range v.Streams {
		v.Streams[i] = NativeSpeedTCPStream{Index: i, Completion: "failed"}
	}
	return v
}

type nativeSpeedMultiPhase struct {
	mu                sync.Mutex
	job               *nativeSpeedJob
	name, nonce       string
	stageIndex, count int
	ctx               context.Context
	cancel            context.CancelFunc
	conns             []net.Conn
	readyCount        int
	ready             chan struct{}
	closed            bool
	receiver          bool
	started, frozenAt time.Time
	streams           []NativeSpeedTCPStream
	senderMs          []float64
	received          uint64
	reserved          atomic.Uint64
}

func (j *nativeSpeedJob) newMulti(name, nonce string, stageIndex, count int) *nativeSpeedMultiPhase {
	if !nativeSpeedTCPConnections(count) || stageIndex < 0 || stageIndex >= len(nativeSpeedConnectionCounts) || nativeSpeedConnectionCounts[stageIndex] != count {
		return nil
	}
	ctx, cancel := context.WithCancel(j.ctx)
	p := &nativeSpeedMultiPhase{job: j, name: name, nonce: nonce, stageIndex: stageIndex, count: count, conns: make([]net.Conn, count), streams: make([]NativeSpeedTCPStream, count), senderMs: make([]float64, count), ctx: ctx, cancel: cancel, ready: make(chan struct{}), receiver: j.role == "client" && name == "tcp-adaptive-download" || j.role == "host" && name == "tcp-adaptive-upload"}
	for i := range p.streams {
		p.streams[i] = NativeSpeedTCPStream{Index: i, Completion: "partial"}
	}
	return p
}
func (p *nativeSpeedMultiPhase) freeze() {
	p.mu.Lock()
	if p.frozenAt.IsZero() {
		p.frozenAt = time.Now()
	}
	p.closed = true
	p.mu.Unlock()
	p.cancel()
}
func (p *nativeSpeedMultiPhase) Close() error {
	p.freeze()
	p.mu.Lock()
	conns := p.conns
	p.mu.Unlock()
	for _, c := range conns {
		if c != nil {
			c.Close()
		}
	}
	return nil
}
func (p *nativeSpeedMultiPhase) claim(index int, c net.Conn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || index < 0 || index >= p.count || p.conns[index] != nil {
		return false
	}
	p.conns[index] = c
	return true
}
func (p *nativeSpeedMultiPhase) markReady() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.readyCount++
	if p.readyCount == p.count {
		close(p.ready)
	}
}
func (p *nativeSpeedMultiPhase) start() { p.mu.Lock(); p.started = time.Now(); p.mu.Unlock() }
func (p *nativeSpeedMultiPhase) result(complete bool) NativeSpeedMultiTransfer {
	p.mu.Lock()
	defer p.mu.Unlock()
	v := nativeSpeedEmptyMulti(p.count)
	v.Completion = "partial"
	v.ReceivedBytes = p.received
	v.LimitReached = p.received == p.job.opts.multiBytes
	if p.started.IsZero() || !p.receiver {
		return v
	}
	end := time.Now()
	if !p.frozenAt.IsZero() {
		end = p.frozenAt
	}
	v.DurationMs = math.Max(1, float64(end.Sub(p.started))/float64(time.Millisecond))
	for _, minimum := range p.senderMs {
		v.DurationMs = math.Max(v.DurationMs, minimum)
	}
	all := true
	for i, s := range p.streams {
		duration := 0.0
		if s.ReceivedBytes > 0 || s.Completion == "complete" {
			duration = v.DurationMs
		}
		s.DurationMs = duration
		s.LimitReached = v.LimitReached
		v.Streams[i] = s
		v.DurationMs = math.Max(v.DurationMs, duration)
		if s.Completion != "complete" {
			all = false
		}
	}
	if complete && all {
		v.Completion = "complete"
	}
	v.BytesPerSecond = float64(v.ReceivedBytes) * 1000 / v.DurationMs
	return v
}
func (j *nativeSpeedJob) multiResult(p *nativeSpeedMultiPhase, v NativeSpeedMultiTransfer) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.status.Finished {
		return
	}
	j.putMultiResultLocked(p, v)
}
func nativeSpeedMergeMulti(target *NativeSpeedMultiTransfer, v NativeSpeedMultiTransfer) {
	if target.Completion == "complete" && v.Completion != "complete" || !nativeSpeedTCPConnections(len(v.Streams)) || v.ReceivedBytes < target.ReceivedBytes {
		return
	}
	for i := range v.Streams {
		if len(target.Streams) == len(v.Streams) && v.Streams[i].ReceivedBytes < target.Streams[i].ReceivedBytes {
			return
		}
	}
	// Concurrent receiver goroutines may publish snapshots out of order. Preserve
	// counts, elapsed windows and per-stream completion when an older snapshot
	// arrives after cancellation has frozen and released the group.
	v.DurationMs = math.Max(v.DurationMs, target.DurationMs)
	for i := range v.Streams {
		if len(target.Streams) == len(v.Streams) {
			v.Streams[i].DurationMs = math.Max(v.Streams[i].DurationMs, target.Streams[i].DurationMs)
			if target.Streams[i].Completion == "complete" {
				v.Streams[i].Completion = "complete"
			}
		}
		v.DurationMs = math.Max(v.DurationMs, v.Streams[i].DurationMs)
	}
	if v.DurationMs > 0 {
		v.BytesPerSecond = float64(v.ReceivedBytes) * 1000 / v.DurationMs
	}
	*target = v
}
func (j *nativeSpeedJob) activateMulti(p *nativeSpeedMultiPhase) bool {
	if !j.add(p) {
		return false
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.status.Finished {
		return false
	}
	j.multi = p
	j.putMultiResultLocked(p, p.result(false))
	return true
}
func (j *nativeSpeedJob) releaseMulti(p *nativeSpeedMultiPhase, complete bool) {
	p.Close()
	if !complete {
		j.multiResult(p, p.result(false))
	}
	j.mu.Lock()
	if j.multi == p {
		j.multi = nil
	}
	j.mu.Unlock()
	j.remove(p)
	p.mu.Lock()
	conns := p.conns
	p.mu.Unlock()
	for _, c := range conns {
		if c != nil {
			j.remove(c)
		}
	}
}
func (j *nativeSpeedJob) acceptMulti(ln net.Listener) {
	var pending atomic.Int32
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		if pending.Add(1) > 16 {
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
			claimed := false
			defer func() {
				if !claimed {
					j.remove(c)
				}
			}()
			hello, err := nativeSpeedReadMessageTimeout(c, 5*time.Second)
			if err != nil || hello.Kind != "multi" || hello.ID != j.request.ID || !nativeEqual(hello.Ticket, j.request.Ticket) {
				return
			}
			j.mu.Lock()
			p := j.multi
			j.mu.Unlock()
			if p == nil || hello.StageIndex != p.stageIndex || hello.Connections != p.count || hello.Phase != p.name || !nativeEqual(hello.Nonce, p.nonce) || !p.claim(hello.StreamIndex, c) {
				return
			}
			claimed = true
			if err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "ready", Phase: p.name, StageIndex: p.stageIndex, Connections: p.count, StreamIndex: hello.StreamIndex}); err != nil {
				p.Close()
				return
			}
			p.markReady()
		}()
	}
}
func (p *nativeSpeedMultiPhase) reserve() uint64 {
	for {
		used := p.reserved.Load()
		if used >= p.job.opts.multiBytes {
			return 0
		}
		n := uint64(nativeSpeedFrameBytes)
		if n > p.job.opts.multiBytes-used {
			n = p.job.opts.multiBytes - used
		}
		if p.reserved.CompareAndSwap(used, used+n) {
			return n
		}
	}
}
func (p *nativeSpeedMultiPhase) send(index int, first uint64) (uint64, error) {
	c := p.conns[index]
	payload := make([]byte, nativeSpeedFrameBytes)
	for i := range payload {
		payload[i] = byte(i)
	}
	var sent uint64
	n := first
	for n > 0 {
		select {
		case <-p.ctx.Done():
			return sent, p.ctx.Err()
		default:
		}
		if time.Since(p.started) >= p.job.opts.multiDuration {
			break
		}
		if err := nativeSpeedWriteFrame(c, nativeSpeedData, payload[:n]); err != nil {
			return sent, err
		}
		sent += n
		n = p.reserve()
	}
	duration := math.Max(1, float64(time.Since(p.started))/float64(time.Millisecond))
	p.mu.Lock()
	p.senderMs[index] = duration
	p.mu.Unlock()
	return sent, nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "end", Phase: p.name, StageIndex: p.stageIndex, Connections: p.count, StreamIndex: index, SentBytes: sent, DurationMs: duration})
}
func (p *nativeSpeedMultiPhase) runSend() ([]uint64, error) {
	counts := make([]uint64, p.count)
	type outcome struct {
		index int
		sent  uint64
		err   error
	}
	done := make(chan outcome, p.count)
	gate := make(chan struct{})
	first := make([]uint64, p.count)
	for i := range first {
		first[i] = p.reserve()
	}
	for i := 0; i < p.count; i++ {
		go func(index int) { <-gate; sent, err := p.send(index, first[index]); done <- outcome{index, sent, err} }(i)
	}
	p.start()
	close(gate)
	var failure error
	for i := 0; i < p.count; i++ {
		r := <-done
		counts[r.index] = r.sent
		if r.err != nil && failure == nil {
			failure = r.err
			p.Close()
		}
	}
	return counts, failure
}
func nativeSpeedReadPartialFrame(c net.Conn) (byte, []byte, error) {
	var h [5]byte
	if _, err := io.ReadFull(c, h[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(h[1:])
	if n > nativeSpeedFrameBytes || (h[0] != nativeSpeedData && h[0] != nativeSpeedJSON) {
		return 0, nil, errors.New("invalid multi frame")
	}
	b := make([]byte, n)
	count, err := io.ReadFull(c, b)
	return h[0], b[:count], err
}
func (p *nativeSpeedMultiPhase) receive(index int) error {
	c := p.conns[index]
	for {
		c.SetReadDeadline(time.Now().Add(15 * time.Second))
		kind, payload, err := nativeSpeedReadPartialFrame(c)
		if kind == nativeSpeedData && len(payload) > 0 {
			p.mu.Lock()
			if p.closed {
				p.mu.Unlock()
				return context.Canceled
			}
			if p.received+uint64(len(payload)) > p.job.opts.multiBytes {
				p.mu.Unlock()
				return errors.New("multi receive byte limit")
			}
			p.received += uint64(len(payload))
			p.streams[index].ReceivedBytes += uint64(len(payload))
			p.mu.Unlock()
			p.job.multiResult(p, p.result(false))
		}
		if err != nil {
			return err
		}
		if kind == nativeSpeedData {
			if len(payload) == 0 {
				return errors.New("empty multi data")
			}
			continue
		}
		var end nativeSpeedMessage
		if len(payload) > 8192 || json.Unmarshal(payload, &end) != nil || end.Kind != "end" || end.Phase != p.name || end.StageIndex != p.stageIndex || end.Connections != p.count || end.StreamIndex != index || end.DurationMs <= 0 || end.DurationMs > 210000 || math.IsNaN(end.DurationMs) || math.IsInf(end.DurationMs, 0) {
			return errors.New("invalid multi sender report")
		}
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			return context.Canceled
		}
		if end.SentBytes != p.streams[index].ReceivedBytes {
			p.mu.Unlock()
			return errors.New("multi sender byte mismatch")
		}
		p.streams[index].Completion = "complete"
		p.senderMs[index] = end.DurationMs
		p.mu.Unlock()
		return nil
	}
}
func (p *nativeSpeedMultiPhase) runReceive() (NativeSpeedMultiTransfer, error) {
	done := make(chan error, p.count)
	for i := 0; i < p.count; i++ {
		go func(index int) { done <- p.receive(index) }(i)
	}
	var failure error
	for i := 0; i < p.count; i++ {
		err := <-done
		if err != nil && failure == nil {
			failure = err
			p.Close()
		}
	}
	// Every receive goroutine (and its synchronous progress publication) has
	// finished. This shared frozen window is the canonical report sent to the
	// sender; it cannot be shorter than an earlier progress snapshot.
	if failure == nil {
		p.mu.Lock()
		p.frozenAt = time.Now()
		p.mu.Unlock()
	}
	return p.result(failure == nil), failure
}
func (p *nativeSpeedMultiPhase) senderWindows() []float64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]float64(nil), p.senderMs...)
}
func nativeSpeedValidMulti(v *NativeSpeedMultiTransfer, sent []uint64, maximum uint64, minimum []float64) bool {
	if v == nil || !nativeSpeedTCPConnections(len(v.Streams)) || len(v.Streams) != len(sent) || len(minimum) != len(sent) || v.Completion != "complete" || v.DurationMs <= 0 || v.DurationMs > 210000 || math.IsNaN(v.DurationMs) || math.IsInf(v.DurationMs, 0) {
		return false
	}
	var total uint64
	for i, s := range v.Streams {
		if s.Index != i || s.Completion != "complete" || s.ReceivedBytes != sent[i] || s.DurationMs <= 0 || s.DurationMs > v.DurationMs || math.IsNaN(s.DurationMs) || math.IsInf(s.DurationMs, 0) {
			return false
		}
		total += s.ReceivedBytes
		v.Streams[i].DurationMs = math.Max(s.DurationMs, minimum[i])
		v.DurationMs = math.Max(v.DurationMs, v.Streams[i].DurationMs)
	}
	if total != v.ReceivedBytes || total > maximum {
		return false
	}
	v.BytesPerSecond = float64(total) * 1000 / v.DurationMs
	return true
}
func (j *nativeSpeedJob) waitMultiSlots(count int) error {
	// Closing a local SOCKS connection propagates asynchronously through both
	// relay copies. Wait for the next group's free slots before opening the next group.
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		j.mu.Lock()
		proxy := j.proxy
		j.mu.Unlock()
		if proxy == nil {
			return context.Canceled
		}
		proxy.mu.Lock()
		ready := !proxy.closed && len(proxy.flows) <= nativeSpeedMaxFlows-count
		proxy.mu.Unlock()
		if ready {
			return nil
		}
		select {
		case <-j.ctx.Done():
			return j.ctx.Err()
		case <-deadline.C:
			return errors.New("previous multi streams still closing")
		case <-tick.C:
		}
	}
}
func (j *nativeSpeedJob) hostMultiPhase(c net.Conn, name string, stageIndex, count int) error {
	if err := j.waitMultiSlots(count); err != nil {
		return err
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return err
	}
	p := j.newMulti(name, hex.EncodeToString(raw[:]), stageIndex, count)
	if !j.activateMulti(p) {
		return context.Canceled
	}
	complete := false
	defer func() { j.releaseMulti(p, complete) }()
	if err := nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "ready", Phase: name, StageIndex: stageIndex, Connections: count, Nonce: p.nonce}); err != nil {
		return err
	}
	start, err := nativeSpeedReadMessage(c)
	if err != nil {
		return err
	}
	if start.Kind != "multi-start" || start.Phase != name || start.StageIndex != stageIndex || start.Connections != count || !nativeEqual(start.Nonce, p.nonce) {
		return errors.New("invalid multi start")
	}
	select {
	case <-p.ctx.Done():
		return p.ctx.Err()
	case <-p.ready:
	case <-time.After(5 * time.Second):
		return errors.New("multi connections not ready")
	}
	if name == "tcp-adaptive-upload" {
		p.start()
	}
	if err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "started", Phase: name, StageIndex: stageIndex, Connections: count}); err != nil {
		return err
	}
	if name == "tcp-adaptive-download" {
		sent, err := p.runSend()
		if err != nil {
			return err
		}
		report, err := nativeSpeedReadMessage(c)
		if err != nil {
			return err
		}
		if report.Kind != "received" || report.Phase != name || report.StageIndex != stageIndex || report.Connections != count || !nativeSpeedValidMulti(report.Multi, sent, j.opts.multiBytes, p.senderWindows()) {
			return errors.New("invalid multi receiver report")
		}
		if err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "multi-confirmed", Phase: name, StageIndex: stageIndex, Connections: count}); err != nil {
			return err
		}
		j.multiResult(p, *report.Multi)
	} else {
		v, err := p.runReceive()
		if err != nil {
			return err
		}
		if err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "received", Phase: name, StageIndex: stageIndex, Connections: count, Multi: &v}); err != nil {
			return err
		}
		ack, err := nativeSpeedReadMessage(c)
		if err != nil {
			return err
		}
		if ack.Kind != "multi-confirmed" || ack.Phase != name || ack.StageIndex != stageIndex || ack.Connections != count {
			return errors.New("multi receipt unconfirmed")
		}
		j.multiResult(p, v)
	}
	complete = true
	return nil
}
func (j *nativeSpeedJob) clientMultiPhase(c net.Conn, name string, stageIndex, count int) error {
	ready, err := nativeSpeedReadMessage(c)
	if err != nil {
		return err
	}
	nonce, err := hex.DecodeString(ready.Nonce)
	if err != nil || len(nonce) != 16 || ready.Kind != "ready" || ready.Phase != name || ready.StageIndex != stageIndex || ready.Connections != count {
		return errors.New("invalid multi phase")
	}
	if err := j.waitMultiSlots(count); err != nil {
		return err
	}
	p := j.newMulti(name, ready.Nonce, stageIndex, count)
	if !j.activateMulti(p) {
		return context.Canceled
	}
	complete := false
	defer func() { j.releaseMulti(p, complete) }()
	done := make(chan error, p.count)
	for i := 0; i < p.count; i++ {
		go func(index int) {
			data, err := j.dialSynthetic(4)
			if err == nil {
				if !p.claim(index, data) {
					j.remove(data)
					err = context.Canceled
				} else {
					err = nativeSpeedWriteMessage(data, nativeSpeedMessage{Kind: "multi", ID: j.request.ID, Ticket: j.request.Ticket, Phase: name, StageIndex: stageIndex, Connections: count, Nonce: p.nonce, StreamIndex: index})
					if err == nil {
						var ack nativeSpeedMessage
						ack, err = nativeSpeedReadMessage(data)
						if err == nil && (ack.Kind != "ready" || ack.Phase != name || ack.StageIndex != stageIndex || ack.Connections != count || ack.StreamIndex != index) {
							err = errors.New("invalid multi connection acknowledgment")
						}
					}
					if err == nil {
						p.markReady()
					}
				}
			}
			done <- err
		}(i)
	}
	var failure error
	for i := 0; i < p.count; i++ {
		if err = <-done; err != nil && failure == nil {
			failure = err
			p.Close()
		}
	}
	if failure != nil {
		return failure
	}
	if name == "tcp-adaptive-download" {
		p.start()
	}
	if err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "multi-start", Phase: name, StageIndex: stageIndex, Connections: count, Nonce: p.nonce}); err != nil {
		return err
	}
	started, err := nativeSpeedReadMessage(c)
	if err != nil {
		return err
	}
	if started.Kind != "started" || started.Phase != name || started.StageIndex != stageIndex || started.Connections != count {
		return errors.New("invalid multi start acknowledgment")
	}
	if name == "tcp-adaptive-download" {
		v, err := p.runReceive()
		if err != nil {
			return err
		}
		if err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "received", Phase: name, StageIndex: stageIndex, Connections: count, Multi: &v}); err != nil {
			return err
		}
		ack, err := nativeSpeedReadMessage(c)
		if err != nil {
			return err
		}
		if ack.Kind != "multi-confirmed" || ack.Phase != name || ack.StageIndex != stageIndex || ack.Connections != count {
			return errors.New("multi receipt unconfirmed")
		}
		j.multiResult(p, v)
	} else {
		sent, err := p.runSend()
		if err != nil {
			return err
		}
		report, err := nativeSpeedReadMessage(c)
		if err != nil {
			return err
		}
		if report.Kind != "received" || report.Phase != name || report.StageIndex != stageIndex || report.Connections != count || !nativeSpeedValidMulti(report.Multi, sent, j.opts.multiBytes, p.senderWindows()) {
			return errors.New("invalid multi receiver report")
		}
		if err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "multi-confirmed", Phase: name, StageIndex: stageIndex, Connections: count}); err != nil {
			return err
		}
		j.multiResult(p, *report.Multi)
	}
	complete = true
	return nil
}
