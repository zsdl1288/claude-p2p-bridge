package netcore

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"sync/atomic"
	"time"
)

const nativeSpeedData = 2
const nativeSpeedJSON = 1
const nativeSpeedFrameBytes = 64 * 1024

func nativeSpeedWriteFrame(c net.Conn, kind byte, payload []byte) error {
	if len(payload) > nativeSpeedFrameBytes {
		return errors.New("speed frame too large")
	}
	var h [5]byte
	h[0] = kind
	binary.BigEndian.PutUint32(h[1:], uint32(len(payload)))
	c.SetWriteDeadline(time.Now().Add(15 * time.Second))
	if err := nativeWrite(c, h[:]); err != nil {
		return err
	}
	return nativeWrite(c, payload)
}
func nativeSpeedReadFrame(c net.Conn) (byte, []byte, error) {
	var h [5]byte
	if _, err := io.ReadFull(c, h[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(h[1:])
	if n > nativeSpeedFrameBytes || h[0] != nativeSpeedData && h[0] != nativeSpeedJSON {
		return 0, nil, errors.New("invalid speed frame")
	}
	payload := make([]byte, int(n))
	_, err := io.ReadFull(c, payload)
	return h[0], payload, err
}
func nativeSpeedWriteMessage(c net.Conn, msg nativeSpeedMessage) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	if len(payload) > 8192 {
		return errors.New("speed message too large")
	}
	return nativeSpeedWriteFrame(c, nativeSpeedJSON, payload)
}
func nativeSpeedReadMessage(c net.Conn) (nativeSpeedMessage, error) {
	return nativeSpeedReadMessageTimeout(c, 15*time.Second)
}
func nativeSpeedReadMessageTimeout(c net.Conn, timeout time.Duration) (nativeSpeedMessage, error) {
	var msg nativeSpeedMessage
	c.SetReadDeadline(time.Now().Add(timeout))
	kind, payload, err := nativeSpeedReadFrame(c)
	if err != nil {
		return msg, err
	}
	if kind != nativeSpeedJSON || len(payload) > 8192 {
		return msg, errors.New("invalid speed message")
	}
	err = json.Unmarshal(payload, &msg)
	return msg, err
}
func nativeSpeedTransfer(bytes uint64, start, last time.Time, completion string, limit bool) NativeSpeedTransfer {
	ms := float64(last.Sub(start)) / float64(time.Millisecond)
	if ms < 1 {
		ms = 1
	}
	return NativeSpeedTransfer{ReceivedBytes: bytes, DurationMs: ms, BytesPerSecond: float64(bytes) * 1000 / ms, Completion: completion, LimitReached: limit}
}
func nativeSpeedValidTransfer(v *NativeSpeedTransfer, sent uint64) bool {
	return v != nil && v.ReceivedBytes == sent && v.ReceivedBytes <= nativeSpeedTCPBytes && v.DurationMs > 0 && v.DurationMs <= 60000 && !math.IsNaN(v.DurationMs) && !math.IsInf(v.DurationMs, 0) && v.Completion == "complete"
}
func (j *nativeSpeedJob) sendTCP(c net.Conn, phase string) (uint64, error) {
	start := time.Now()
	payload := make([]byte, nativeSpeedFrameBytes)
	for i := range payload {
		payload[i] = byte(i)
	}
	var sent uint64
	for sent < j.opts.tcpBytes && time.Since(start) < j.opts.tcpDuration {
		select {
		case <-j.ctx.Done():
			return sent, j.ctx.Err()
		default:
		}
		n := len(payload)
		if uint64(n) > j.opts.tcpBytes-sent {
			n = int(j.opts.tcpBytes - sent)
		}
		if err := nativeSpeedWriteFrame(c, nativeSpeedData, payload[:n]); err != nil {
			return sent, err
		}
		sent += uint64(n)
	}
	err := nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "end", Phase: phase, SentBytes: sent, DurationMs: float64(time.Since(start)) / float64(time.Millisecond), LimitReached: sent == j.opts.tcpBytes})
	return sent, err
}
func (j *nativeSpeedJob) receiveTCP(c net.Conn, phase string) (NativeSpeedTransfer, error) {
	start := time.Now()
	last := start
	var received uint64
	for {
		c.SetReadDeadline(time.Now().Add(15 * time.Second))
		kind, payload, err := nativeSpeedReadFrame(c)
		if err != nil {
			v := nativeSpeedTransfer(received, start, last, "partial", false)
			j.tcpResult(phase, v)
			return v, err
		}
		if kind == nativeSpeedData {
			if len(payload) == 0 || received+uint64(len(payload)) > j.opts.tcpBytes {
				return NativeSpeedTransfer{}, errors.New("speed byte limit")
			}
			received += uint64(len(payload))
			last = time.Now()
			j.tcpResult(phase, nativeSpeedTransfer(received, start, last, "partial", received == j.opts.tcpBytes))
			continue
		}
		var msg nativeSpeedMessage
		if json.Unmarshal(payload, &msg) != nil || msg.Kind != "end" || msg.Phase != phase || msg.SentBytes != received || received > j.opts.tcpBytes {
			return NativeSpeedTransfer{}, errors.New("invalid speed sender report")
		}
		if received == 0 {
			last = time.Now()
		}
		v := nativeSpeedTransfer(received, start, last, "complete", msg.LimitReached)
		j.tcpResult(phase, v)
		return v, nil
	}
}
func (j *nativeSpeedJob) acceptMain(ln net.Listener) {
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
			return
		}
		go func() {
			defer pending.Add(-1)
			defer j.remove(c)
			hello, err := nativeSpeedReadMessageTimeout(c, 5*time.Second)
			if err != nil || hello.Kind != "hello" || hello.ID != j.request.ID || !nativeEqual(hello.Ticket, j.request.Ticket) || !j.mainAccepted.CompareAndSwap(false, true) {
				return
			}
			if err = j.runHost(c); err != nil {
				j.finish("transport-failed", false)
			} else {
				j.finish("", true)
			}
		}()
	}
}
func (j *nativeSpeedJob) runHost(c net.Conn) error {
	if err := nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "ready"}); err != nil {
		return err
	}
	for _, phase := range []string{"tcp-adaptive-download", "tcp-adaptive-upload", "udp-download", "udp-upload"} {
		msg, err := nativeSpeedReadMessage(c)
		if err != nil {
			return err
		}
		if msg.Kind != "phase" || msg.Phase != phase {
			return errors.New("unexpected speed phase")
		}
		j.phase(phase)
		if nativeSpeedTCPPhase(phase) {
			if err = j.hostTCPDirection(c, phase); err != nil {
				return err
			}
		} else {
			if err = j.hostUDPPhase(c, phase); err != nil {
				return err
			}
		}
	}
	last, err := nativeSpeedReadMessage(c)
	if err != nil {
		return err
	}
	if last.Kind != "done" || last.Latency == nil || !nativeSpeedValidLatency(*last.Latency) {
		return errors.New("invalid speed latency report")
	}
	j.mu.Lock()
	j.status.Metrics.Latency = *last.Latency
	j.mu.Unlock()
	if err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "completed"}); err != nil {
		return err
	}
	ack, err := nativeSpeedReadMessage(c)
	if err == io.EOF {
		return nil
	}
	if err != nil {
		return err
	}
	if ack.Kind != "ack" {
		return errors.New("speed completion unconfirmed")
	}
	return nil
}
func nativeSpeedValidLatency(v NativeSpeedLatency) bool {
	if len(v.Samples)+v.FailedSamples > 64 || v.FailedSamples < 0 {
		return false
	}
	for _, s := range v.Samples {
		if math.IsNaN(s) || math.IsInf(s, 0) || s < 0 || s > 60000 {
			return false
		}
	}
	return true
}
func (j *nativeSpeedJob) runClient() {
	err := j.clientPhases()
	if err != nil {
		j.finish("transport-failed", false)
	} else {
		j.finish("", true)
	}
}
func (j *nativeSpeedJob) clientPhases() error {
	c, err := j.dialSynthetic(1)
	if err != nil {
		return err
	}
	defer c.Close()
	if err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "hello", ID: j.request.ID, Ticket: j.request.Ticket}); err != nil {
		return err
	}
	ready, err := nativeSpeedReadMessage(c)
	if err != nil {
		return err
	}
	if ready.Kind != "ready" {
		return errors.New("invalid speed handshake")
	}
	go j.probeLoop()
	for _, phase := range []string{"tcp-adaptive-download", "tcp-adaptive-upload", "udp-download", "udp-upload"} {
		j.phase(phase)
		if err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "phase", Phase: phase}); err != nil {
			return err
		}
		if nativeSpeedTCPPhase(phase) {
			if err = j.clientTCPDirection(c, phase); err != nil {
				return err
			}
		} else {
			if err = j.clientUDPPhase(c, phase); err != nil {
				return err
			}
		}
	}
	latency := j.snapshot(false).Metrics.Latency
	if err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "done", Latency: &latency}); err != nil {
		return err
	}
	result, err := nativeSpeedReadMessage(c)
	if err != nil {
		return err
	}
	if result.Kind != "completed" {
		return errors.New("speed completion unconfirmed")
	}
	return nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "ack"})
}
