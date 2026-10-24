// Regression tests for the pinned, reviewed TCP recovery source copy.
package tcp

import (
	"fmt"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/faketime"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/seqnum"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/waiter"
)

type auditCC struct{ updates []int }

func (*auditCC) HandleLossDetected() {}
func (*auditCC) HandleRTOExpired()   {}
func (c *auditCC) Update(n int, _ time.Duration, _ tcpip.MonotonicTime) {
	c.updates = append(c.updates, n)
}
func (*auditCC) PostRecovery() {}

type auditRecovery struct{}

func (auditRecovery) DoRecovery(*segment, bool) {}

// Construct real sender/scoreboard/packet objects without a wire or background
// time advancing. Every queued segment was transmitted once; writeNext is nil.
func auditSender(t *testing.T, first seqnum.Value, sizes ...int) (*sender, *auditCC) {
	t.Helper()
	clock := faketime.NewManualClock()
	st := stack.New(stack.Options{NetworkProtocols: []stack.NetworkProtocolFactory{ipv4.NewProtocol}, TransportProtocols: []stack.TransportProtocolFactory{NewProtocol}, Clock: clock, ClockResolution: time.Microsecond})
	ep := newEndpoint(st, st.TransportProtocolInstance(ProtocolNumber).(*protocol), header.IPv4ProtocolNumber, &waiter.Queue{})
	ep.setEndpointState(StateEstablished)
	ep.SACKPermitted = true
	ep.tcpRecovery = tcpip.TCPRACKLossDetection
	ep.scoreboard = NewSACKScoreboard(1200, first-1)
	cc := &auditCC{}
	s := &sender{ep: ep, cc: cc, lr: auditRecovery{}, state: tcpip.Open,
		writeList: protectedWriteList{set: make(map[*segment]struct{})},
		TCPSenderState: TCPSenderState{SndUna: first, SndNxt: first, SndWnd: 1 << 20, SndCwnd: 100,
			Ssthresh: 100, MaxPayloadSize: 1200, RTO: time.Second, LastSendTime: clock.NowMonotonic()},
	}
	ep.snd = s
	s.rc.init(s, first-1)
	s.rc.Reord = true
	s.rc.minRTT = 250 * time.Millisecond
	s.rtt.SRTTInited = true
	s.rtt.SRTT = 250 * time.Millisecond
	s.FastRecovery.Last, s.FastRecovery.HighRxt = first-1, first-1
	for _, timer := range []*timer{&s.resendTimer, &s.reorderTimer, &s.probeTimer, &s.corkTimer} {
		timer.init(clock, func() {})
	}
	for _, size := range sizes {
		seg := newOutgoingSegment(stack.TransportEndpointID{}, clock, buffer.MakeWithData(make([]byte, size)), 0)
		seg.sequenceNumber = s.SndNxt
		seg.flags = header.TCPFlagAck | header.TCPFlagPsh
		seg.xmitCount = 1
		seg.xmitTime = clock.NowMonotonic()
		s.writeList.PushBack(seg)
		s.SndNxt = s.SndNxt.Add(seqnum.Size(size))
		s.Outstanding += s.pCount(seg, s.MaxPayloadSize)
		ep.sndQueueInfo.SndBufUsed += size
	}
	s.RTTMeasureSeqNum = s.SndNxt
	t.Cleanup(func() {
		for _, timer := range []*timer{&s.resendTimer, &s.reorderTimer, &s.probeTimer, &s.corkTimer, &ep.keepalive.timer} {
			timer.cleanup()
		}
		for seg := s.writeList.Front(); seg != nil; seg = s.writeList.Front() {
			s.writeList.Remove(seg)
			seg.DecRef()
		}
		st.Close()
	})
	return s, cc
}
func auditAck(s *sender, ack seqnum.Value, blocks ...header.SACKBlock) {
	seg := newSegment()
	defer seg.DecRef()
	// newSegment has no packet, while DecRef requires one.
	seg.pkt = stack.NewPacketBuffer(stack.PacketBufferOptions{})
	seg.ackNumber, seg.window, seg.flags = ack, 1<<20, header.TCPFlagAck
	seg.rcvdTime = s.ep.stack.Clock().NowMonotonic().Add(250 * time.Millisecond)
	seg.parsedOptions.SACKBlocks = blocks
	s.ep.mu.Lock()
	defer s.ep.mu.Unlock()
	s.handleRcvdSegment(seg)
}
func auditSACK(s *sender, blocks ...header.SACKBlock) {
	seg := &segment{rcvdTime: s.ep.stack.Clock().NowMonotonic().Add(250 * time.Millisecond), ackNumber: s.SndUna}
	seg.parsedOptions.SACKBlocks = blocks
	s.ep.mu.Lock()
	defer s.ep.mu.Unlock()
	for _, block := range blocks {
		if seg.ackNumber.LessThan(block.Start) && s.SndUna.LessThan(block.Start) && block.End.LessThanEq(s.SndNxt) {
			s.ep.scoreboard.Insert(block)
		}
	}
	s.walkSACK(seg)
}

func TestAuditOpenSACKCumulativeACKKeepsLaterFlight(t *testing.T) {
	const first seqnum.Value = 1000
	s, cc := auditSender(t, first, 1200, 1200, 1200, 1200, 1200)
	auditAck(s, first, header.SACKBlock{Start: first + 2400, End: first + 3600})
	if s.FastRecovery.Active {
		t.Fatal("single SACK unexpectedly entered recovery")
	}
	auditAck(s, first+3600)
	if s.SndUna == s.SndNxt {
		t.Fatal("fixture must retain two in-flight packets; full-ACK reset would mask the bug")
	}
	if s.Outstanding != 2 {
		t.Errorf("outstanding=%d, want two actual packets after cumulative ACK", s.Outstanding)
	}
	if s.SackedOut != 0 {
		t.Errorf("sackedOut=%d, want zero after SACKed packet cumulatively acknowledged", s.SackedOut)
	}
	if len(cc.updates) == 0 || cc.updates[len(cc.updates)-1] != 3 {
		t.Errorf("congestion ACK updates=%v, want newest credit 3", cc.updates)
	}
}

func TestAuditPartialACKAcrossSACKedGSOSegment(t *testing.T) {
	const first seqnum.Value = 1000
	s, _ := auditSender(t, first, 1200, 3600, 1200)
	sack := header.SACKBlock{Start: first + 1200, End: first + 4800}
	auditAck(s, first, sack)
	auditAck(s, first+2400)
	if s.Outstanding != 3 {
		t.Errorf("partial ACK outstanding=%d, want 3", s.Outstanding)
	}
	if s.SackedOut != 2 {
		t.Errorf("partial ACK sackedOut=%d, want 2 remaining SACKed MSS units", s.SackedOut)
	}
	auditAck(s, first+4800)
	if s.Outstanding != 1 || s.SackedOut != 0 {
		t.Errorf("final partial outstanding=%d sacked=%d, want 1/0", s.Outstanding, s.SackedOut)
	}
}

func TestAuditWalkSACKBlockOrder(t *testing.T) {
	const first seqnum.Value = 1000
	lower, upper := header.SACKBlock{Start: first + 1200, End: first + 2400}, header.SACKBlock{Start: first + 3600, End: first + 4800}
	for name, blocks := range map[string][]header.SACKBlock{"ascending": {lower, upper}, "descending": {upper, lower}} {
		t.Run(name, func(t *testing.T) {
			s, _ := auditSender(t, first, 1200, 1200, 1200, 1200, 1200)
			auditSACK(s, blocks...)
			if !s.writeList.Front().Next().acked || !s.writeList.Front().Next().Next().Next().acked || s.SackedOut != 2 {
				t.Errorf("SACK order lost a block: lower=%v upper=%v sacked=%d", s.writeList.Front().Next().acked, s.writeList.Front().Next().Next().Next().acked, s.SackedOut)
			}
		})
	}
}

func TestAuditEnteringRecoveryPreservesSACKLedger(t *testing.T) {
	const first seqnum.Value = 1000
	s, _ := auditSender(t, first, 1200, 1200, 1200, 1200)
	block := header.SACKBlock{Start: first + 1200, End: first + 2400}
	s.ep.scoreboard.Insert(block)
	auditSACK(s, block)
	s.ep.mu.Lock()
	s.enterRecovery()
	s.ep.mu.Unlock()
	if s.SackedOut != 1 || !s.writeList.Front().Next().acked {
		t.Errorf("entry discarded one ledger but retained another: sacked=%d acked=%v", s.SackedOut, s.writeList.Front().Next().acked)
	}
}

func TestAuditACKLeavingRecoveryDoesNotDoubleSubtract(t *testing.T) {
	const first seqnum.Value = 1000
	s, _ := auditSender(t, first, 1200, 1200, 1200, 1200)
	block := header.SACKBlock{Start: first + 1200, End: first + 2400}
	s.ep.scoreboard.Insert(block)
	auditSACK(s, block)
	s.FastRecovery.Active = true
	s.FastRecovery.Last = first + 2400 - 1
	s.state = tcpip.SACKRecovery
	auditAck(s, first+2400)
	if s.FastRecovery.Active {
		t.Fatal("cumulative ACK did not exit recovery")
	}
	if s.Outstanding != 2 {
		t.Errorf("exit ACK outstanding=%d, want 2; SetPipe ran before leaveRecovery", s.Outstanding)
	}
	if s.SackedOut != 0 {
		t.Errorf("exit ACK sacked=%d,want 0", s.SackedOut)
	}
}

func TestAuditOpenACKDoesNotPretendToExitRecovery(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200, 1200)
	s.rc.ReoWndIncr = 2
	s.rc.ReoWndPersist = 16
	auditAck(s, 2200)
	if s.rc.ReoWndPersist != 16 || s.rc.ReoWndIncr != 2 {
		t.Errorf("ordinary ACK consumed recovery persistence: persist=%d multiplier=%d", s.rc.ReoWndPersist, s.rc.ReoWndIncr)
	}
}

func TestAuditInitialRACKDSACKIsISNIndependent(t *testing.T) {
	for _, first := range []seqnum.Value{1000, 0x80001000, 0xfffff000} {
		t.Run(fmt.Sprintf("%08x", uint32(first)), func(t *testing.T) {
			s, _ := auditSender(t, first, 1200, 1200)
			s.rc.setDSACKSeen(true)
			s.ep.mu.Lock()
			s.rc.updateRACKReorderWindow()
			s.ep.mu.Unlock()
			if s.rc.ReoWndIncr != 2 {
				t.Errorf("first DSACK ignored at ISN=%#x: RTTSeq=%#x multiplier=%d", uint32(first), uint32(s.rc.RTTSeq), s.rc.ReoWndIncr)
			}
		})
	}
}

func TestAuditRTOClearsSACKLedgerBeforeRetransmitting(t *testing.T) {
	const first seqnum.Value = 1000
	s, _ := auditSender(t, first, 1200, 1200, 1200, 1200)
	st := s.ep.stack
	link := channel.New(64, 1280, "")
	if err := st.CreateNIC(1, link); err != nil {
		t.Fatal(err)
	}
	local, remote := tcpip.AddrFrom4([4]byte{10, 0, 0, 1}), tcpip.AddrFrom4([4]byte{10, 0, 0, 2})
	if err := st.AddProtocolAddress(1, tcpip.ProtocolAddress{Protocol: ipv4.ProtocolNumber, AddressWithPrefix: local.WithPrefix()}, stack.AddressProperties{}); err != nil {
		t.Fatal(err)
	}
	st.SetRouteTable([]tcpip.Route{{Destination: header.IPv4EmptySubnet, NIC: 1}})
	route, err := st.FindRoute(1, local, remote, ipv4.ProtocolNumber, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { route.Release(); link.Close() })
	s.ep.route = route
	s.ep.TransportEndpointInfo.ID = stack.TransportEndpointID{LocalPort: 12345, RemotePort: 443, LocalAddress: local, RemoteAddress: remote}
	s.ep.rcv = newReceiver(s.ep, 5000, 65535, 0)
	s.MaxSentAck = 5001
	s.maxRetries = MaxRetries
	s.maxRTO = MaxRTO
	s.minRTO = MinRTO
	block := header.SACKBlock{Start: first + 1200, End: first + 2400}
	auditAck(s, first, block)
	if s.SackedOut != 1 {
		t.Fatalf("fixture missing initial SACK count: %d", s.SackedOut)
	}
	s.resendTimer.enable(time.Second)
	st.Clock().(*faketime.ManualClock).Advance(time.Second)
	s.ep.mu.Lock()
	rtoErr := s.retransmitTimerExpired()
	s.ep.mu.Unlock()
	if rtoErr != nil {
		t.Fatalf("RTO must successfully retry, got %v", rtoErr)
	}
	if !s.ep.scoreboard.Empty() {
		t.Fatal("RTO did not discard scoreboard")
	}
	if st.Stats().TCP.Retransmits.Value() == 0 {
		t.Fatal("fixture did not actually retransmit")
	}
	if s.SackedOut != 0 {
		t.Errorf("RTO reset scoreboard but retained sackedOut=%d", s.SackedOut)
	}
	for seg := s.writeList.Front(); seg != nil; seg = seg.Next() {
		if seg.acked {
			t.Errorf("RTO retained stale acked flag at %#x", uint32(seg.sequenceNumber))
		}
	}
	auditAck(s, first, block)
	if s.SackedOut != 1 {
		t.Errorf("fresh post-RTO SACK count=%d,want1", s.SackedOut)
	}
}

func TestAuditRACKReoWndPersistenceSaturatesAtZero(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200)
	s.rc.ReoWndPersist = 0
	for i := 0; i < 256; i++ {
		s.rc.exitRecovery()
		s.ep.mu.Lock()
		s.rc.updateRACKReorderWindow()
		s.ep.mu.Unlock()
		if s.rc.ReoWndPersist != 0 {
			t.Fatalf("genuine recovery exit %d made persistence=%d; want saturation at0", i+1, s.rc.ReoWndPersist)
		}
	}
	s.rc.ReoWndPersist = 16
	s.rc.ReoWndIncr = 2
	for i := 0; i < 16; i++ {
		s.rc.exitRecovery()
		s.ep.mu.Lock()
		s.rc.updateRACKReorderWindow()
		s.ep.mu.Unlock()
	}
	if s.rc.ReoWndPersist != 0 || s.rc.ReoWndIncr != 1 {
		t.Errorf("16 genuine exits changed policy: persist=%d multiplier=%d", s.rc.ReoWndPersist, s.rc.ReoWndIncr)
	}
}

func TestAuditPartialSACKCannotAcknowledgeWholeGSOSegment(t *testing.T) {
	const first seqnum.Value = 1000
	s, _ := auditSender(t, first, 1200, 6000, 1200)
	gso := s.writeList.Front().Next()
	block := header.SACKBlock{Start: first + 1200, End: first + 2400}
	s.ep.scoreboard.Insert(block)
	auditSACK(s, block)
	if gso.acked {
		t.Error("one-MSS SACK marked the entire five-MSS GSO segment acknowledged")
	}
	if s.SackedOut > 1 {
		t.Errorf("partial SACK counted %d packets, at most1 was reported received", s.SackedOut)
	}
	if block.End.LessThan(s.rc.FACK) || block.End.LessThan(s.rc.EndSequence) {
		t.Errorf("RACK advanced beyond received prefix: FACK=%d end=%d prefixEnd=%d", s.rc.FACK, s.rc.EndSequence, block.End)
	}
}
