package netcore

import (
	"context"
	"math"
	"testing"
	"time"
)

func nativeSpeedTestStage(index int, target, actual uint64, loss float64) NativeSpeedUDPStage {
	duration := 1500.0
	sent := uint64(float64(actual) * 1.5 / nativeSpeedPacketBytes)
	lost := uint64(math.Round(float64(sent) * loss / 100))
	received := sent - lost
	bytes := sent * nativeSpeedPacketBytes
	actualLoss := 100 * float64(lost) / float64(sent)
	v := NativeSpeedUDPTransfer{NativeSpeedTransfer: NativeSpeedTransfer{ReceivedBytes: received * nativeSpeedPacketBytes, DurationMs: duration, BytesPerSecond: float64(received*nativeSpeedPacketBytes) * 1000 / duration, Completion: "complete"}, SentBytes: &bytes, SentPackets: &sent, ReceivedPackets: received, LostPackets: &lost, LossPercent: &actualLoss, PacketBytes: nativeSpeedPacketBytes}
	return nativeSpeedStage(index, target, v, &duration)
}
func TestNativeSpeedAdaptiveCeilingAndBudget(t *testing.T) {
	opts := nativeSpeedDefaults(nativeSpeedOptions{})
	p := newNativeSpeedUDPPlan(opts)
	r := nativeSpeedEmptyUDP()
	for index, target := range nativeSpeedRates {
		rate, reason := p.next()
		if rate != target || reason != "" {
			t.Fatalf("stage %d: %d %s", index, rate, reason)
		}
		s := nativeSpeedTestStage(index, rate, rate, 0)
		p.record(s)
		nativeSpeedPutUDPStage(&r, s)
	}
	_, reason := p.next()
	if reason != "rate-ceiling" || p.sent > nativeSpeedUDPBytes {
		t.Fatalf("ceiling unreachable or over budget: %s %d", reason, p.sent)
	}
	p.started = time.Now().Add(-opts.udpDuration)
	if _, reason = p.next(); reason != "rate-ceiling" {
		t.Fatal("clock budget hid an already confirmed ceiling")
	}
	nativeSpeedFinishUDP(&r, reason)
	if !r.LowerBound || r.Completion != "complete" || *r.LowLossStageIndex != 10 || *r.PeakStageIndex != 10 {
		t.Fatalf("invalid ceiling summary: %+v", r)
	}
	opts.udpBytes = 100
	p = newNativeSpeedUDPPlan(opts)
	if _, reason = p.next(); reason != "byte-budget" {
		t.Fatalf("shortened a stage to fit: %s", reason)
	}
	opts = nativeSpeedDefaults(nativeSpeedOptions{})
	opts.udpDuration = time.Second
	p = newNativeSpeedUDPPlan(opts)
	if _, reason = p.next(); reason != "time-budget" {
		t.Fatalf("ignored direction time budget: %s", reason)
	}
}
func TestNativeSpeedAdaptiveLossRefinementAndSenderLimit(t *testing.T) {
	p := newNativeSpeedUDPPlan(nativeSpeedDefaults(nativeSpeedOptions{}))
	var actual []uint64
	for index := 0; index < 13; index++ {
		rate, reason := p.next()
		if reason != "" {
			if reason != "loss-limited" {
				t.Fatal(reason)
			}
			break
		}
		actual = append(actual, rate)
		loss := 0.0
		if rate > 37500000 {
			loss = 10
		}
		p.record(nativeSpeedTestStage(index, rate, rate, loss))
	}
	if len(actual) != 11 || actual[8] != 50000000 || actual[9] != 37500000 || actual[10] != 43750000 {
		t.Fatalf("unexpected bounded refinement %v", actual)
	}
	r := nativeSpeedEmptyUDP()
	s := nativeSpeedTestStage(0, 1250000, 1000000, 0)
	if s.TargetReached || s.Assessment != "sender-limited" {
		t.Fatalf("sender limitation hidden %+v", s)
	}
	nativeSpeedPutUDPStage(&r, s)
	nativeSpeedFinishUDP(&r, "sender-limited")
	if r.LowLossStageIndex == nil || *r.LowLossStageIndex != 0 || !r.LowerBound {
		t.Fatal("actual low-loss value was discarded")
	}
	s = nativeSpeedTestStage(0, 1250000, 1000000, 20)
	if s.Assessment != "sender-limited" || *s.LossPercent < 19 {
		t.Fatal("sender-limited hid actual packet loss")
	}
}
func TestNativeSpeedAdaptiveBudgetStopsRefinementWithoutTruncation(t *testing.T) {
	p := newNativeSpeedUDPPlan(nativeSpeedDefaults(nativeSpeedOptions{}))
	for index, rate := range nativeSpeedRates {
		loss := 0.0
		if index == 10 {
			loss = 10
		}
		p.record(nativeSpeedTestStage(index, rate, rate, loss))
	}
	rate, reason := p.next()
	if rate != 0 || reason != "byte-budget" {
		t.Fatalf("insufficient high-rate refinement silently shortened: %d %s", rate, reason)
	}
}
func TestNativeSpeedAdaptivePacerAndNonceIsolation(t *testing.T) {
	if nativeSpeedUDPBurst(nativeSpeedRateCeiling) <= 64 {
		t.Fatal("high rate still capped at 64 packets")
	}
	if burst := nativeSpeedUDPBurst(nativeSpeedRateCeiling); burst > 228 || burst < 227 {
		t.Fatalf("unbounded scheduler catch-up: %f", burst)
	}
	packet := nativeSpeedUDPPacket([16]byte{1}, 1, 2)
	if _, _, ok := nativeSpeedParseUDP(packet, [16]byte{2}); ok {
		t.Fatal("late prior-stage datagram accepted")
	}
	if _, _, ok := nativeSpeedParseUDP(packet[:100], [16]byte{1}); ok {
		t.Fatal("short datagram accepted")
	}
}

func TestNativeSpeedAdaptiveSenderWindowDoesNotRoundDown(t *testing.T) {
	p := newNativeSpeedUDPPhase("udp-upload", [16]byte{1}, nativeSpeedUDPBytes)
	p.add(0)
	p.last = p.started
	sent := uint64(1)
	duration := 2.022823
	v := p.result(&sent, 125000, true, duration)
	if v.DurationMs < duration || v.BytesPerSecond != float64(nativeSpeedPacketBytes)*1000/v.DurationMs {
		t.Fatalf("sender window truncated: %.12f < %.12f", v.DurationMs, duration)
	}
}
func TestNativeSpeedAdaptiveProtocolVersionRequired(t *testing.T) {
	for _, version := range []int{0, 1, 2, 3, 4, 6} {
		m := nativeSpeedTestManager(t)
		r := nativeSpeedTestRequest()
		r.ProtocolVersion = version
		if _, err := m.NativeSpeedPrepare(context.Background(), r); err == nil || m.speedJob != nil {
			t.Fatalf("old/new incompatible helper protocol accepted: %d", version)
		}
	}
}
func TestNativeSpeedAdaptiveCancellationKeepsEarlierStage(t *testing.T) {
	j := newNativeSpeedJob(nativeSpeedTestRequest(), "client", nativeTestBackend{}, nativeSpeedOptions{})
	complete := nativeSpeedTestStage(0, 125000, 125000, 0)
	j.udpStageResult("udp-download", complete)
	p := newNativeSpeedUDPPhase("udp-download", [16]byte{2}, nativeSpeedUDPBytes)
	p.index = 1
	p.rate = 250000
	j.udpMu.Lock()
	j.udpPhase = p
	j.udpMu.Unlock()
	for seq := uint32(0); seq < 17; seq++ {
		p.add(seq)
	}
	j.finish("user-cancelled", false)
	r := j.snapshot(false).Metrics.UDP.Download
	if r.Completion != "partial" || len(r.Stages) != 2 || r.Stages[0].Completion != "complete" || r.Stages[1].ReceivedPackets != 17 || r.Stages[1].LossPercent != nil || *r.LowLossStageIndex != 0 {
		t.Fatalf("cancelled stage erased confirmed history %+v", r)
	}
}
