package tcp

import (
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/faketime"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

// A reverse-direction application progress frame whose ACK does not advance
// SndUna. This enters the real sender ACK path, not just the timer helper.
func auditReverseProgress(s *sender) {
	seg := newOutgoingSegment(stack.TransportEndpointID{}, s.ep.stack.Clock(), buffer.MakeWithData(make([]byte, 200)), 0)
	defer seg.DecRef()
	seg.ackNumber = s.SndUna
	seg.sequenceNumber = 5001
	seg.flags = header.TCPFlagAck | header.TCPFlagPsh
	seg.window = 1 << 20
	seg.rcvdTime = s.ep.stack.Clock().NowMonotonic()
	s.ep.mu.Lock()
	defer s.ep.mu.Unlock()
	s.handleRcvdSegment(seg)
}
func TestAuditPTOReverseProgressDoesNotPostponeExistingProbe(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200, 1200)
	s.postXmit(true, true)
	deadline := s.probeTimer.target
	una := s.SndUna
	for i := 0; i < 4; i++ {
		s.ep.stack.Clock().(*faketime.ManualClock).Advance(100 * time.Millisecond)
		auditReverseProgress(s)
		if !s.probeTimer.enabled() || s.probeTimer.target != deadline {
			t.Fatalf("reverse progress %d postponed/canceled PTO:got=%v,want=%v", i+1, s.probeTimer.target, deadline)
		}
	}
	if s.SndUna != una {
		t.Fatal("fixture accidentally acknowledged new upload data")
	}
}
func TestAuditPTONoDataKeepsExistingRTO(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200, 1200)
	s.resendTimer.enable(time.Second)
	deadline := s.resendTimer.target
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(100 * time.Millisecond)
	auditReverseProgress(s)
	if !s.resendTimer.enabled() || s.resendTimer.target != deadline || s.probeTimer.enabled() {
		t.Fatalf("reverse progress changed fallback RTO: RTO=%v,target=%v,want=%v,PTO=%v", s.resendTimer.enabled(), s.resendTimer.target, deadline, s.probeTimer.enabled())
	}
}
func TestAuditPTOArmsWhenBothTimersMissing(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200)
	s.postXmit(false, true)
	if !s.probeTimer.enabled() || s.resendTimer.enabled() {
		t.Fatalf("missing-timer startup: PTO=%v RTO=%v", s.probeTimer.enabled(), s.resendTimer.enabled())
	}
}
func TestAuditPTONewDataCanRestartProbe(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200)
	s.postXmit(true, true)
	old := s.probeTimer.target
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(100 * time.Millisecond)
	s.postXmit(true, true)
	if !s.probeTimer.enabled() || !old.Before(s.probeTimer.target) || s.resendTimer.enabled() {
		t.Fatal("new upload data must still restart PTO")
	}
}
func TestAuditPTOCumulativeACKCanRestartProbe(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200, 1200)
	s.postXmit(true, true)
	old := s.probeTimer.target
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(100 * time.Millisecond)
	auditAck(s, 2200)
	if s.SndUna != 2200 || !s.probeTimer.enabled() || !old.Before(s.probeTimer.target) || s.resendTimer.enabled() {
		t.Fatal("new cumulative ACK must still restart PTO")
	}
}
func TestAuditPTORecoveryRetransmissionCancelsOldProbe(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200)
	auditRACKRoute(t, s)
	s.probeTimer.enable(500 * time.Millisecond)
	s.FastRecovery.Active = true
	s.state = tcpip.SACKRecovery
	if err := s.sendSegment(s.writeList.Front()); err != nil {
		t.Fatal(err)
	}
	if !s.resendTimer.enabled() {
		t.Fatal("successful recovery retransmit must arm RTO")
	}
	deadline := s.resendTimer.target
	s.postXmit(false, true)
	if s.probeTimer.enabled() || !s.resendTimer.enabled() || s.resendTimer.target != deadline {
		t.Fatal("recovery retained PTO together with armed retransmission timer")
	}
}
func TestAuditPTOProbeThenReverseProgressKeepsRTO(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200)
	link := auditRACKRoute(t, s)
	s.postXmit(true, true)
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(500 * time.Millisecond)
	s.ep.mu.Lock()
	err := s.probeTimerExpired()
	s.ep.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if link.NumQueued() != 1 || s.probeTimer.enabled() || !s.resendTimer.enabled() {
		t.Fatal("loss probe must transmit once then switch to RTO")
	}
	deadline := s.resendTimer.target
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(100 * time.Millisecond)
	auditReverseProgress(s)
	if s.probeTimer.enabled() || !s.resendTimer.enabled() || s.resendTimer.target != deadline {
		t.Fatal("reverse progress replaced post-probe RTO with another PTO")
	}
}
func TestAuditPTOZeroWindowUsesOnlyRTO(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200)
	s.SndWnd = 0
	s.updateWriteNext(s.writeList.Front())
	s.postXmit(false, true)
	if !s.zeroWindowProbing || !s.resendTimer.enabled() || s.probeTimer.enabled() {
		t.Fatal("zero-window probing lost its retransmission timer to PTO")
	}
}
func TestAuditPTOLegacySACKUsesOnlyRTO(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200)
	s.ep.tcpRecovery = 0
	s.probeTimer.enable(500 * time.Millisecond)
	s.resendTimer.enable(time.Second)
	deadline := s.resendTimer.target
	s.postXmit(false, true)
	if s.probeTimer.enabled() || !s.resendTimer.enabled() || s.resendTimer.target != deadline {
		t.Fatal("non-RACK path must retain only its existing RTO")
	}
}
func TestAuditPTOReverseProgressStillAllowsProbeExpiration(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200, 1200)
	link := auditRACKRoute(t, s)
	s.postXmit(true, true)
	for i := 0; i < 4; i++ {
		s.ep.stack.Clock().(*faketime.ManualClock).Advance(100 * time.Millisecond)
		auditReverseProgress(s)
	}
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(100 * time.Millisecond)
	s.ep.mu.Lock()
	err := s.probeTimerExpired()
	s.ep.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if link.NumQueued() != 1 || s.probeTimer.enabled() || !s.resendTimer.enabled() {
		t.Fatalf("reverse-progress stream starved probe:wire=%d,PTO=%v,RTO=%v", link.NumQueued(), s.probeTimer.enabled(), s.resendTimer.enabled())
	}
}
