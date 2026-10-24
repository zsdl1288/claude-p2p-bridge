package tcp

import (
	"container/heap"
	"testing"

	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/seqnum"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

func auditDSACKReceiver(t *testing.T) (*Endpoint, *channel.Endpoint) {
	t.Helper()
	s, _ := auditSender(t, 40000)
	ep, st := s.ep, s.ep.stack
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
	ep.route = route
	ep.TransportEndpointInfo.ID = stack.TransportEndpointID{LocalPort: 12345, RemotePort: 443, LocalAddress: local, RemoteAddress: remote}
	ep.rcv = newReceiver(ep, 999, 65535, 0)
	s.MaxSentAck = 1000
	t.Cleanup(func() {
		for ep.rcv.pendingRcvdSegments.Len() > 0 {
			heap.Pop(&ep.rcv.pendingRcvdSegments).(*segment).DecRef()
		}
		for seg := ep.rcvQueue.Front(); seg != nil; seg = ep.rcvQueue.Front() {
			ep.rcvQueue.Remove(seg)
			seg.DecRef()
		}
		route.Release()
		link.Close()
	})
	return ep, link
}
func auditReceiverData(t *testing.T, ep *Endpoint, start seqnum.Value, length int) {
	t.Helper()
	seg := newOutgoingSegment(stack.TransportEndpointID{}, ep.stack.Clock(), buffer.MakeWithData(make([]byte, length)), 0)
	defer seg.DecRef()
	seg.sequenceNumber = start
	seg.flags = header.TCPFlagAck
	ep.mu.Lock()
	_, err := ep.rcv.handleRcvdSegment(seg)
	ep.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
}

type auditWireACK struct {
	ack         seqnum.Value
	blocks      []header.SACKBlock
	ts          bool
	headerBytes int
}

func auditTakeACK(t *testing.T, link *channel.Endpoint) auditWireACK {
	t.Helper()
	pkt := link.Read()
	if pkt == nil {
		t.Fatal("no ACK emitted")
	}
	defer pkt.DecRef()
	hdr := header.TCP(pkt.TransportHeader().Slice())
	parsed := header.ParseTCPOptions(hdr[header.TCPMinimumSize:hdr.DataOffset()])
	return auditWireACK{ack: seqnum.Value(hdr.AckNumber()), blocks: append([]header.SACKBlock(nil), parsed.SACKBlocks...), ts: parsed.TS, headerBytes: int(hdr.DataOffset())}
}
func auditSendReceiverACK(ep *Endpoint) { ep.mu.Lock(); ep.snd.sendAck(); ep.mu.Unlock() }
func auditWantBlock(t *testing.T, row auditWireACK, index int, start, end seqnum.Value) {
	t.Helper()
	if len(row.blocks) <= index || row.blocks[index] != (header.SACKBlock{Start: start, End: end}) {
		t.Fatalf("SACK[%d]=%v, want [%d,%d)", index, row.blocks, start, end)
	}
}

func TestAuditDSACKOldDataBeforeWindowCheck(t *testing.T) {
	ep, link := auditDSACKReceiver(t)
	auditReceiverData(t, ep, 800, 100)
	row := auditTakeACK(t, link)
	if row.ack != 1000 || ep.rcv.pendingRcvdSegments.Len() != 0 {
		t.Fatalf("old duplicate changed ACK or heap: %+v", row)
	}
	auditWantBlock(t, row, 0, 800, 900)
	if ep.dsackPending {
		t.Fatal("successful ACK did not consume DSACK")
	}
}
func TestAuditDSACKPartialOldPrefix(t *testing.T) {
	ep, link := auditDSACKReceiver(t)
	auditReceiverData(t, ep, 900, 200)
	if ep.rcv.RcvNxt != 1100 {
		t.Fatalf("new suffix was not accepted: %d", ep.rcv.RcvNxt)
	}
	auditSendReceiverACK(ep)
	row := auditTakeACK(t, link)
	if row.ack != 1100 {
		t.Fatal(row.ack)
	}
	auditWantBlock(t, row, 0, 900, 1000)
}
func TestAuditDSACKOOODuplicateUsesContainingSecondBlock(t *testing.T) {
	ep, link := auditDSACKReceiver(t)
	auditReceiverData(t, ep, 1500, 100)
	auditTakeACK(t, link)
	auditReceiverData(t, ep, 1450, 200)
	row := auditTakeACK(t, link)
	auditWantBlock(t, row, 0, 1500, 1600)
	auditWantBlock(t, row, 1, 1450, 1650)
	if row.ack != 1000 {
		t.Fatal(row.ack)
	}
}
func TestAuditDSACKFirstContiguousOverlapIgnoresHeapArrayOrder(t *testing.T) {
	ep, link := auditDSACKReceiver(t)
	for _, start := range []seqnum.Value{1200, 1800, 1400} {
		auditReceiverData(t, ep, start, 100)
		auditTakeACK(t, link)
	}
	auditReceiverData(t, ep, 1350, 600)
	row := auditTakeACK(t, link)
	auditWantBlock(t, row, 0, 1400, 1500)
	auditWantBlock(t, row, 1, 1350, 1950)
}
func TestAuditDSACKAdjacentDuplicateSubrangesAreContiguous(t *testing.T) {
	ep, link := auditDSACKReceiver(t)
	for _, start := range []seqnum.Value{1400, 1500} {
		auditReceiverData(t, ep, start, 100)
		auditTakeACK(t, link)
	}
	auditReceiverData(t, ep, 1450, 100)
	row := auditTakeACK(t, link)
	auditWantBlock(t, row, 0, 1450, 1550)
	auditWantBlock(t, row, 1, 1400, 1600)
}
func TestAuditDSACKTimestampOptionsFitThreeBlocks(t *testing.T) {
	ep, link := auditDSACKReceiver(t)
	ep.SendTSOk = true
	for _, start := range []seqnum.Value{1200, 1500, 1800, 2100} {
		auditReceiverData(t, ep, start, 200)
		auditTakeACK(t, link)
	}
	auditReceiverData(t, ep, 1550, 100)
	row := auditTakeACK(t, link)
	auditWantBlock(t, row, 0, 1550, 1650)
	auditWantBlock(t, row, 1, 1500, 1700)
	if !row.ts || len(row.blocks) != 3 || row.headerBytes > 60 {
		t.Fatalf("invalid TCP options: %+v", row)
	}
}
func TestAuditDSACKRequiresNegotiatedSACK(t *testing.T) {
	ep, link := auditDSACKReceiver(t)
	ep.SACKPermitted = false
	auditReceiverData(t, ep, 800, 100)
	row := auditTakeACK(t, link)
	if len(row.blocks) != 0 || ep.dsackPending {
		t.Fatalf("DSACK without SACK permission: %+v", row)
	}
}
func TestAuditDSACKOneShotAndOptionSizingAreIndependent(t *testing.T) {
	ep, link := auditDSACKReceiver(t)
	ep.mu.Lock()
	ep.rcv.noteDuplicateSegment(800, 100)
	opts := ep.makeOptions(nil)
	putOptions(opts)
	ep.maxOptionSize()
	stillPending := ep.dsackPending
	ep.mu.Unlock()
	if !stillPending {
		t.Fatal("MSS/option sizing consumed DSACK")
	}
	auditSendReceiverACK(ep)
	auditWantBlock(t, auditTakeACK(t, link), 0, 800, 900)
	auditSendReceiverACK(ep)
	if row := auditTakeACK(t, link); len(row.blocks) != 0 {
		t.Fatalf("DSACK repeated without new duplicate: %+v", row)
	}
}
func TestAuditDSACKSendFailureDoesNotConsume(t *testing.T) {
	ep, _ := auditDSACKReceiver(t)
	ep.mu.Lock()
	ep.rcv.noteDuplicateSegment(800, 100)
	ep.mu.Unlock()
	if err := ep.stack.DisableNIC(1); err != nil {
		t.Fatal(err)
	}
	ep.mu.Lock()
	err := ep.sendEmptyRaw(header.TCPFlagAck, ep.snd.SndNxt, ep.rcv.RcvNxt, 65535)
	pending := ep.dsackPending
	ep.mu.Unlock()
	if err == nil {
		t.Fatal("fixture did not fail send")
	}
	if !pending {
		t.Fatal("failed local send consumed DSACK")
	}
}
func TestAuditDSACKSequenceWrap(t *testing.T) {
	ep, link := auditDSACKReceiver(t)
	ep.rcv.RcvNxt = 0x20
	ep.rcv.RcvAcc = 0x20 + 65535
	ep.rcv.rcvWUP = 0x20
	ep.snd.MaxSentAck = 0x20
	auditReceiverData(t, ep, 0xfffffff0, 64)
	auditSendReceiverACK(ep)
	row := auditTakeACK(t, link)
	auditWantBlock(t, row, 0, 0xfffffff0, 0x20)
	if row.ack != 0x30 {
		t.Fatalf("wrapped ACK=%#x,want0x30", uint32(row.ack))
	}
}
func TestAuditDSACKPendingHeapReplayDoesNotInventDuplicates(t *testing.T) {
	ep, link := auditDSACKReceiver(t)
	auditReceiverData(t, ep, 1100, 200)
	auditTakeACK(t, link)
	auditReceiverData(t, ep, 1200, 200)
	row := auditTakeACK(t, link)
	auditWantBlock(t, row, 0, 1200, 1300)
	auditReceiverData(t, ep, 1000, 100)
	if ep.rcv.RcvNxt != 1400 || ep.dsackPending {
		t.Fatalf("internal replay produced duplicate report, nxt=%d,pending=%v", ep.rcv.RcvNxt, ep.dsackPending)
	}
	auditSendReceiverACK(ep)
	if row := auditTakeACK(t, link); len(row.blocks) != 0 {
		t.Fatalf("internal replay generated DSACK: %+v", row)
	}
}
