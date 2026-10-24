package tcp

import (
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
)

type auditRACKFailOnceLink struct {
	stack.LinkEndpoint
	fail *bool
}

func (l *auditRACKFailOnceLink) WritePackets(pkts stack.PacketBufferList) (int, tcpip.Error) {
	if *l.fail {
		*l.fail = false
		return 0, &tcpip.ErrClosedForSend{}
	}
	return l.LinkEndpoint.WritePackets(pkts)
}
func auditRACKRoute(t *testing.T, s *sender) *channel.Endpoint {
	return auditRACKRouteWithFailure(t, s, nil)
}
func auditRACKRouteWithFailure(t *testing.T, s *sender, fail *bool) *channel.Endpoint {
	t.Helper()
	st := s.ep.stack
	link := channel.New(1024, 1280, "")
	var wire stack.LinkEndpoint = link
	if fail != nil {
		wire = &auditRACKFailOnceLink{LinkEndpoint: link, fail: fail}
	}
	if err := st.CreateNIC(1, wire); err != nil {
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
	return link
}

func auditRACKLargeLostFlight(t *testing.T) *sender {
	t.Helper()
	sizes := make([]int, 202)
	for i := range sizes {
		sizes[i] = 1200
	}
	s, _ := auditSender(t, 1000, sizes...)
	s.FastRecovery.Active = true
	s.FastRecovery.HighRxt = s.SndUna - 1
	s.FastRecovery.Last = s.SndNxt - 1
	s.state = tcpip.SACKRecovery
	s.SndCwnd = 5
	s.Ssthresh = 2
	block := header.SACKBlock{Start: s.SndUna + 1200, End: s.SndUna + 33*1200}
	s.ep.scoreboard.Insert(block)
	s.rc.XmitTime = s.ep.stack.Clock().NowMonotonic().Add(250 * time.Millisecond)
	s.rc.RTT = 258 * time.Millisecond
	s.rc.ReoWnd = 122 * time.Millisecond
	lost := s.rc.detectLoss(s.ep.stack.Clock().NowMonotonic().Add(time.Second))
	if lost != 170 {
		t.Fatalf("fixture rack lost=%d,want170", lost)
	}
	return s
}

func TestAuditRACKPipeHonorsTimeBasedLoss(t *testing.T) {
	s := auditRACKLargeLostFlight(t)
	s.SetPipe()
	if s.Outstanding != 0 {
		t.Fatalf("RACK marked all 170 unsacked packets lost but SetPipe=%d, want0 (cwnd=%d)", s.Outstanding, s.SndCwnd)
	}
}
func TestAuditRACKPipeAllowsCwndBudgetRetransmissions(t *testing.T) {
	s := auditRACKLargeLostFlight(t)
	link := auditRACKRoute(t, s)
	s.Outstanding = 169 // cached before RACK updated loss marks on this ACK/timer
	s.rc.DoRecovery(nil, false)
	n := 0
	for seg := s.writeList.Front(); seg != nil; seg = seg.Next() {
		if seg.xmitCount > 1 {
			n++
		}
	}
	if n != 5 {
		t.Errorf("retransmitted=%d,want5;pipe=%d,cwnd=%d,wire=%d", n, s.Outstanding, s.SndCwnd, link.NumQueued())
	}
	s.SetPipe()
	if s.Outstanding != 5 {
		t.Errorf("post-retransmit pipe=%d,want5 (not duplicate HighRxt credit)", s.Outstanding)
	}
}
func TestAuditRACKPipeRetransmissionCountedOnceThenLostAgain(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200, 1200)
	s.FastRecovery.Active = true
	s.state = tcpip.SACKRecovery
	for seg := s.writeList.Front(); seg != nil; seg = seg.Next() {
		seg.lost = true
	}
	head := s.writeList.Front()
	head.lost = false
	head.xmitCount = 2
	s.FastRecovery.HighRxt = head.sequenceNumber + 1199
	s.SetPipe()
	if s.Outstanding != 1 {
		t.Errorf("retransmitted head plus two RACK losses pipe=%d,want1", s.Outstanding)
	}
	head.lost = true
	s.SetPipe()
	if s.Outstanding != 0 {
		t.Errorf("same retransmission subsequently lost pipe=%d,want0", s.Outstanding)
	}
}
func TestAuditRACKPipeGSOCountsOnlyUnSACKedNotLostMSS(t *testing.T) {
	s, _ := auditSender(t, 1000, 6000)
	s.FastRecovery.Active = true
	s.state = tcpip.SACKRecovery
	s.writeList.Front().xmitCount = 2
	s.FastRecovery.HighRxt = s.SndUna + 1199
	s.ep.scoreboard.Insert(header.SACKBlock{Start: s.SndUna + 1200, End: s.SndUna + 2400})
	s.SetPipe()
	if s.Outstanding != 4 {
		t.Errorf("five-MSS GSO with one SACKed pipe=%d,want4", s.Outstanding)
	}
	s.writeList.Front().lost = true
	s.SetPipe()
	if s.Outstanding != 0 {
		t.Errorf("RACK-lost GSO pipe=%d,want0", s.Outstanding)
	}
}
func TestAuditRACKPipeLegacyRFC6675Unchanged(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200, 1200)
	s.ep.tcpRecovery = 0
	s.FastRecovery.Active = true
	s.state = tcpip.SACKRecovery
	for seg := s.writeList.Front(); seg != nil; seg = seg.Next() {
		seg.lost = true
	}
	s.FastRecovery.HighRxt = s.SndUna + 1199
	s.SetPipe()
	if s.Outstanding != 4 {
		t.Errorf("legacy RFC6675 original+retransmitted pipe=%d,want4", s.Outstanding)
	}
}
func TestAuditRetransmissionTimerSuccessfulSACKSendRestarts(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200)
	auditRACKRoute(t, s)
	s.FastRecovery.Active = true
	s.state = tcpip.SACKRecovery
	s.RTO = time.Second
	s.resendTimer.enable(time.Second)
	old := s.resendTimer.target
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(500 * time.Millisecond)
	err := s.sendSegment(s.writeList.Front())
	if err != nil {
		t.Fatalf("send failed:%v", err)
	}
	want := s.ep.stack.Clock().NowMonotonic().Add(time.Second)
	if s.resendTimer.target != want {
		t.Fatalf("successful recovery retransmit deadline=%v,old=%v,want=%v", s.resendTimer.target, old, want)
	}
}
func TestAuditRetransmissionTimerFailedSendKeepsExistingDeadline(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200)
	link := auditRACKRoute(t, s)
	link.Close()
	s.FastRecovery.Active = true
	s.state = tcpip.SACKRecovery
	s.RTO = time.Second
	s.resendTimer.enable(time.Second)
	old := s.resendTimer.target
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(500 * time.Millisecond)
	if err := s.sendSegment(s.writeList.Front()); err == nil {
		t.Fatal("closed channel must reject send")
	}
	if s.resendTimer.target != old {
		t.Fatalf("failed write postponed existing retry:deadline=%v,want=%v", s.resendTimer.target, old)
	}
}
func TestAuditRetransmissionTimerFailedSendArmsMissingDeadline(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200)
	link := auditRACKRoute(t, s)
	link.Close()
	s.FastRecovery.Active = true
	s.state = tcpip.SACKRecovery
	s.RTO = time.Second
	if err := s.sendSegment(s.writeList.Front()); err == nil {
		t.Fatal("closed channel must reject send")
	}
	if !s.resendTimer.enabled() {
		t.Fatal("failed write must not leave outstanding data without a retry timer")
	}
}
func TestAuditRetransmissionTimerNormalSendKeepsExistingDeadline(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200)
	auditRACKRoute(t, s)
	s.FastRecovery.Active = false
	s.state = tcpip.Open
	s.RTO = time.Second
	s.resendTimer.enable(time.Second)
	old := s.resendTimer.target
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(500 * time.Millisecond)
	if err := s.sendSegment(s.writeList.Front()); err != nil {
		t.Fatal(err)
	}
	if s.resendTimer.target != old {
		t.Fatalf("ordinary send postponed existing timer:got=%v,want=%v", s.resendTimer.target, old)
	}
}
func TestAuditRetransmissionTimerLegacySACKSuccessRestarts(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200)
	auditRACKRoute(t, s)
	s.ep.tcpRecovery = 0
	s.FastRecovery.Active = true
	s.state = tcpip.SACKRecovery
	s.RTO = time.Second
	s.resendTimer.enable(time.Second)
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(500 * time.Millisecond)
	if err := s.sendSegment(s.writeList.Front()); err != nil {
		t.Fatal(err)
	}
	if s.resendTimer.target != s.ep.stack.Clock().NowMonotonic().Add(time.Second) {
		t.Fatal("legacy SACK recovery must preserve RFC6675 conservative restart")
	}
}

func TestAuditRACKRewoundWriteNextDoesNotResendFastHeadTwice(t *testing.T) {
	s := auditRACKLargeLostFlight(t)
	auditRACKRoute(t, s)
	head := s.writeList.Front()
	s.updateWriteNext(head)
	s.Outstanding = 169
	s.rc.DoRecovery(nil, true)
	s.sendData()
	if head.xmitCount != 2 {
		t.Errorf("fast-retransmitted rewound head xmitCount=%d,want2; writeNext must advance", head.xmitCount)
	}
	n := 0
	for seg := s.writeList.Front(); seg != nil; seg = seg.Next() {
		if seg.xmitCount > 1 {
			n++
		}
	}
	if n != 5 {
		t.Errorf("unique retransmissions=%d,want full cwnd5;pipe=%d", n, s.Outstanding)
	}
}
func TestAuditRACKActualRTOThenACKCanDrainLargeOldFlight(t *testing.T) {
	sizes := make([]int, 202)
	for i := range sizes {
		sizes[i] = 1200
	}
	s, _ := auditSender(t, 1000, sizes...)
	auditRACKRoute(t, s)
	s.cc = newRenoCC(s)
	s.SndCwnd = 500
	s.Ssthresh = 500
	s.resendTimer.enable(time.Second)
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(time.Second)
	s.ep.mu.Lock()
	err := s.retransmitTimerExpired()
	s.ep.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if s.state != tcpip.RTORecovery || s.Outstanding != 1 || s.SndCwnd != 1 {
		t.Fatalf("RTO fixture state=%v out=%d cwnd=%d", s.state, s.Outstanding, s.SndCwnd)
	}
	oldHead := s.writeList.Front().Next()
	sack := header.SACKBlock{Start: 1000 + 64*1200, End: 1000 + 96*1200}
	auditAck(s, 2200, sack)
	if s.FastRecovery.Active || s.state != tcpip.RTORecovery || s.SndCwnd != 2 || s.Outstanding != 2 {
		t.Fatalf("first ACK must retain RTO slow start:active=%v,state=%v,cwnd=%d,pipe=%d", s.FastRecovery.Active, s.state, s.SndCwnd, s.Outstanding)
	}
	if oldHead.xmitCount != 2 {
		t.Errorf("old RTO writeNext head xmit=%d,want2 exactly", oldHead.xmitCount)
	}
	auditAck(s, 4600, sack)
	if s.FastRecovery.Active || s.state != tcpip.RTORecovery || s.SndCwnd != 4 || s.Outstanding != 4 {
		t.Errorf("second ACK must grow RTO slow start to4:active=%v,state=%v,cwnd=%d,pipe=%d", s.FastRecovery.Active, s.state, s.SndCwnd, s.Outstanding)
	}
}
func TestAuditRACKFailedFastHeadRetainsRTORecovery(t *testing.T) {
	s := auditRACKLargeLostFlight(t)
	fail := true
	link := auditRACKRouteWithFailure(t, s, &fail)
	s.cc = newRenoCC(s)
	s.RTO = time.Second
	head := s.writeList.Front()
	s.updateWriteNext(head)
	s.rc.DoRecovery(nil, true)
	s.sendData()
	if fail {
		t.Fatal("fixture never attempted the rejected fast retransmit")
	}
	if head.xmitCount != 2 || s.writeList.Front() != head {
		t.Fatalf("failed fast head must remain queued:xmit=%d", head.xmitCount)
	}
	if !s.resendTimer.enabled() {
		t.Fatal("failed head must retain a retry timer")
	}
	wireBefore := link.NumQueued()
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(time.Second)
	s.ep.mu.Lock()
	err := s.retransmitTimerExpired()
	s.ep.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if head.xmitCount != 3 || link.NumQueued() != wireBefore+1 {
		t.Fatalf("RTO did not retry retained failed head:xmit=%d,before=%d,after=%d", head.xmitCount, wireBefore, link.NumQueued())
	}
}
func TestAuditRACKPipeKeepsLivePacketsDespiteSACKLossThreshold(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200, 1200, 1200, 1200)
	s.FastRecovery.Active = true
	s.state = tcpip.SACKRecovery
	s.FastRecovery.HighRxt = s.SndUna - 1
	s.ep.scoreboard.Insert(header.SACKBlock{Start: s.SndUna + 2400, End: s.SndNxt})
	if !s.ep.scoreboard.IsRangeLost(s.writeList.Front().sackBlock()) {
		t.Fatal("fixture must meet legacy packet-count loss threshold")
	}
	s.SetPipe()
	if s.Outstanding != 2 {
		t.Fatalf("RACK has not marked two originals lost; pipe=%d,want2 despite SACK threshold", s.Outstanding)
	}
}

func TestAuditRACKRTOOldSACKCannotRetransmitLiveHead(t *testing.T) {
	sizes := make([]int, 202)
	for i := range sizes {
		sizes[i] = 1200
	}
	s, _ := auditSender(t, 1000, sizes...)
	auditRACKRoute(t, s)
	index := 0
	for seg := s.writeList.Front(); seg != nil; seg = seg.Next() {
		seg.xmitTime = s.ep.stack.Clock().NowMonotonic().Add(time.Duration(index) * time.Millisecond)
		index++
	}
	s.cc = newRenoCC(s)
	s.SndCwnd = 500
	s.Ssthresh = 500
	s.resendTimer.enable(time.Second)
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(time.Second)
	s.ep.mu.Lock()
	err := s.retransmitTimerExpired()
	s.ep.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	head := s.writeList.Front()
	xmit := head.xmitTime
	auditAck(s, 1000, header.SACKBlock{Start: 1000 + 64*1200, End: 1000 + 96*1200})
	if s.FastRecovery.Active || s.state != tcpip.RTORecovery || head.xmitCount != 2 || head.xmitTime != xmit {
		t.Fatalf("old SACK restarted fast recovery/retransmitted live RTO head:active=%v,state=%v,xmitCount=%d", s.FastRecovery.Active, s.state, head.xmitCount)
	}
	auditAck(s, 2200)
	if s.rc.XmitTime != xmit || s.rc.RTT != 250*time.Millisecond {
		t.Errorf("first RTO ACK did not advance valid RACK anchor:time=%v,want=%v,rtt=%v", s.rc.XmitTime, xmit, s.rc.RTT)
	}
}
func TestAuditRACKRTOStaleReorderTimerCannotEnterFast(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200, 1200)
	auditRACKRoute(t, s)
	s.state = tcpip.RTORecovery
	s.SndCwnd = 1
	s.Outstanding = 1
	s.FastRecovery.Last = s.SndNxt - 1
	s.writeList.Front().Next().lost = true
	s.reorderTimer.enable(time.Millisecond)
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(time.Millisecond)
	s.ep.mu.Lock()
	err := s.rc.reorderTimerExpired()
	s.ep.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if s.FastRecovery.Active || s.state != tcpip.RTORecovery || s.SndCwnd != 1 {
		t.Fatalf("stale reorder timer reentered fast recovery:active=%v,state=%v,cwnd=%d", s.FastRecovery.Active, s.state, s.SndCwnd)
	}
}
func TestAuditRACKRecoveryPermittedAfterRTORecoverPoint(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200, 1200)
	auditRACKRoute(t, s)
	s.state = tcpip.RTORecovery
	s.FastRecovery.Last = s.SndNxt - 1
	auditAck(s, s.SndNxt)
	if s.state != tcpip.Open || s.FastRecovery.Active {
		t.Fatal("cumulative ACK crossing RTO recover point must return Open")
	}
	for i := 0; i < 2; i++ {
		seg := newOutgoingSegment(stack.TransportEndpointID{}, s.ep.stack.Clock(), buffer.MakeWithData(make([]byte, 1200)), 0)
		seg.sequenceNumber = s.SndNxt
		seg.flags = header.TCPFlagAck | header.TCPFlagPsh
		seg.xmitCount = 1
		s.writeList.PushBack(seg)
		s.SndNxt += 1200
		s.Outstanding++
		s.ep.sndQueueInfo.SndBufUsed += 1200
	}
	s.writeList.Front().lost = true
	auditAck(s, s.SndUna)
	if !s.FastRecovery.Active || s.state != tcpip.SACKRecovery {
		t.Fatal("RACK must still enter normal fast recovery after old recover point is passed")
	}
}
func TestAuditRACKRepeatedOldSACKKeepsDeliveryHistory(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200, 1200, 1200, 1200)
	lower := header.SACKBlock{Start: 2200, End: 3400}
	upper := header.SACKBlock{Start: 4600, End: 5800}
	auditSACK(s, lower, upper)
	oldRTT := s.rc.RTT
	oldXmit := s.rc.XmitTime
	s.ep.scoreboard.Reset()
	s.SackedOut = 0
	for seg := s.writeList.Front(); seg != nil; seg = seg.Next() {
		seg.acked = false
	}
	s.rc.Reord = false
	s.ep.stack.Clock().(*faketime.ManualClock).Advance(10 * time.Second)
	auditSACK(s, lower)
	if s.SackedOut != 1 || !s.writeList.Front().Next().acked {
		t.Fatal("fresh post-RTO SACK ledger must still be rebuilt")
	}
	if s.rc.RTT != oldRTT || s.rc.XmitTime != oldXmit || s.rc.Reord {
		t.Fatalf("repeated old SACK polluted RACK delivery:RTT=%v,want=%v,reordered=%v", s.rc.RTT, oldRTT, s.rc.Reord)
	}
}
func TestAuditRACKRetransmittedCopyCanUpdateDelivery(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200)
	seg := s.writeList.Front().Next()
	auditSACK(s, header.SACKBlock{Start: 2200, End: 3400})
	seg.xmitCount++
	seg.xmitTime = s.ep.stack.Clock().NowMonotonic().Add(time.Second)
	ack := &segment{rcvdTime: seg.xmitTime.Add(300 * time.Millisecond)}
	s.rc.update(seg, ack)
	if s.rc.RTT != 300*time.Millisecond || s.rc.XmitTime != seg.xmitTime {
		t.Fatal("new retransmission must remain eligible for a fresh RACK RTT")
	}
}
func TestAuditRACKInvalidACKDoesNotConsumeDelivery(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200)
	seg := s.writeList.Front()
	seg.xmitCount = 2
	seg.xmitTime = s.ep.stack.Clock().NowMonotonic().Add(time.Second)
	old := s.rc.RTT
	ack := &segment{rcvdTime: seg.xmitTime.Add(300 * time.Millisecond)}
	ack.parsedOptions.TS = true
	ack.parsedOptions.TSEcr = s.ep.tsVal(seg.xmitTime) - 1
	s.rc.update(seg, ack)
	if s.rc.RTT != old {
		t.Fatal("ambiguous earlier timestamp must not update RACK")
	}
	ack.parsedOptions.TSEcr = s.ep.tsVal(seg.xmitTime)
	s.rc.update(seg, ack)
	if s.rc.RTT != 300*time.Millisecond {
		t.Fatal("invalid earlier ACK must not consume the later valid delivery sample")
	}
}
func TestAuditRACKSplitCloneKeepsDeliveryHistory(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 3600, 1200)
	auditSACK(s, header.SACKBlock{Start: 2200, End: 5800})
	oldRTT := s.rc.RTT
	gso := s.writeList.Front().Next()
	s.splitSeg(gso, 1200)
	remainder := gso.Next()
	s.rc.update(remainder, &segment{rcvdTime: s.ep.stack.Clock().NowMonotonic().Add(10 * time.Second)})
	if s.rc.RTT != oldRTT {
		t.Fatalf("GSO split forgot prior RACK delivery:RTT=%v,want=%v", s.rc.RTT, oldRTT)
	}
}
func TestAuditRACKNewSegmentDeliveryHistoryStartsEmpty(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200)
	old := newOutgoingSegment(stack.TransportEndpointID{}, s.ep.stack.Clock(), buffer.MakeWithData(make([]byte, 1200)), 0)
	old.xmitCount = 1
	s.rc.update(old, &segment{rcvdTime: s.ep.stack.Clock().NowMonotonic().Add(300 * time.Millisecond)})
	old.DecRef()
	fresh := newOutgoingSegment(stack.TransportEndpointID{}, s.ep.stack.Clock(), buffer.MakeWithData(make([]byte, 1200)), 0)
	defer fresh.DecRef()
	fresh.xmitCount = 1
	fresh.xmitTime = s.ep.stack.Clock().NowMonotonic().Add(time.Second)
	s.rc.update(fresh, &segment{rcvdTime: fresh.xmitTime.Add(400 * time.Millisecond)})
	if s.rc.RTT != 400*time.Millisecond {
		t.Fatal("new pooled segment retained an old delivery marker")
	}
}

func TestAuditRACKRTOFreshSACKDupACKKeepsRecoveryState(t *testing.T) {
	s, _ := auditSender(t, 1000, 1200, 1200, 1200, 1200, 1200)
	s.state = tcpip.RTORecovery
	s.rc.Reord = false
	s.FastRecovery.Last = s.SndNxt - 1
	s.SndCwnd = 1
	s.Outstanding = 1
	for i := 0; i < 3; i++ {
		auditAck(s, s.SndUna, header.SACKBlock{Start: s.SndUna + 1200 + seqnum.Value(i)*1200, End: s.SndUna + 2400 + seqnum.Value(i)*1200})
		if s.state != tcpip.RTORecovery || s.FastRecovery.Active || s.SndCwnd != 1 {
			t.Fatalf("fresh-SACK duplicate ACK %d escaped RTO slow start:state=%v,active=%v,cwnd=%d", i+1, s.state, s.FastRecovery.Active, s.SndCwnd)
		}
	}
}
