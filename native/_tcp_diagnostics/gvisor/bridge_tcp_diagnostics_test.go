package tcp

import (
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip/seqnum"
)

func TestBridgeTCPDiagnosticsInactiveHasNoInventedSender(t *testing.T) {
	for _, state := range []EndpointState{StateInitial, StateListen, StateClose, StateTimeWait} {
		e := new(Endpoint)
		e.state.Store(uint32(state))
		if got := e.BridgeTCPDiagnostics(); got["available"] != 0 || got["state"] != uint64(state) || len(got) != 2 {
			t.Fatalf("inactive endpoint returned sender measurements: %v", got)
		}
	}
}

func TestBridgeTCPDiagnosticsRemoteWindowAndCurrentRTTAreReadOnly(t *testing.T) {
	e := new(Endpoint)
	e.state.Store(uint32(StateEstablished))
	e.snd = &sender{TCPSenderState: TCPSenderState{
		SndCwnd: 12, Ssthresh: 20, Outstanding: 3, SndWnd: 0, SackedOut: -7,
		SndUna: seqnum.Value(0xffffff00), SndNxt: seqnum.Value(0x100), RTO: time.Second,
		RTTState: TCPRTTState{SRTT: time.Nanosecond}, // stale probe copy
	}, zeroWindowProbing: true}
	e.snd.rc.TCPRACKState = TCPRACKState{Reord: true, ReoWnd: 63 * time.Millisecond, ReoWndIncr: 2, ReoWndPersist: -3}
	e.snd.rtt.TCPRTTState = TCPRTTState{SRTT: 57 * time.Millisecond, RTTVar: 3 * time.Millisecond, SRTTInited: true}
	e.ops.SetSendBufferSize(4096, false)
	e.sndQueueInfo.SndBufUsed = 222
	e.RcvBufUsed = 17
	e.stats.SendErrors.Retransmits.IncrementBy(8)
	e.stats.SendErrors.Timeouts.IncrementBy(2)
	e.stats.ReceiveErrors.ZeroRcvWindowState.IncrementBy(19)
	got := e.BridgeTCPDiagnostics()
	for name, want := range map[string]uint64{
		"available": 1, "sendWindowBytes": 0, "zeroWindowProbing": 1,
		"sendBufferUsedBytes": 222, "sendBufferSizeBytes": 4096, "receiveBufferUsedBytes": 17,
		"outstandingPackets": 3, "inFlightSequenceBytes": 512, "cwndPackets": 12,
		"sackedOutNegative": 1, "sackedOutAbsPackets": 7,
		"srttNs": uint64(57 * time.Millisecond), "rttVarNs": uint64(3 * time.Millisecond),
		"rttValid": 1, "rtoNs": uint64(time.Second), "retransmits": 8, "timeouts": 2,
		"reorderSeen": 1, "reorderWindowNs": uint64(63 * time.Millisecond), "reorderWindowMultiplier": 2,
		"reorderPersistNegative": 1, "reorderPersistAbs": 3,
		"localZeroWindowAdvertisements": 19,
	} {
		if got[name] != want {
			t.Errorf("%s=%d, want %d", name, got[name], want)
		}
	}
	if got["available"] != 1 || e.snd.SndUna != seqnum.Value(0xffffff00) || !e.snd.zeroWindowProbing || e.snd.SndCwnd != 12 ||
		e.snd.SackedOut != -7 || e.snd.rc.ReoWnd != 63*time.Millisecond || e.snd.rc.ReoWndIncr != 2 || e.snd.rc.ReoWndPersist != -3 {
		t.Fatal("snapshot changed sender state")
	}
	// A zero advertised window without queued work need not be probing, and
	// B's local receiver's zero-window count is independent of A's window.
	e.snd.zeroWindowProbing = false
	e.snd.SndWnd = 65536
	e.snd.SackedOut = 4
	e.snd.rc.ReoWndPersist = 16
	got = e.BridgeTCPDiagnostics()
	if got["sendWindowBytes"] != 65536 || got["zeroWindowProbing"] != 0 || got["localZeroWindowAdvertisements"] != 19 ||
		got["sackedOutNegative"] != 0 || got["sackedOutAbsPackets"] != 4 || got["reorderPersistNegative"] != 0 || got["reorderPersistAbs"] != 16 {
		t.Fatal("local and remote window observations were conflated", got)
	}
	if !e.TryLock() {
		t.Fatal("snapshot retained the endpoint lock")
	}
	e.mu.Unlock()
}

func TestBridgeSignedMagnitudeIncludesMinimumSignedValue(t *testing.T) {
	for _, test := range []struct {
		value               int64
		negative, magnitude uint64
	}{
		{0, 0, 0}, {7, 0, 7}, {-7, 1, 7},
		{-1 << 63, 1, 1 << 63}, {1<<63 - 1, 0, 1<<63 - 1},
	} {
		negative, magnitude := bridgeSignedMagnitude(test.value)
		if negative != test.negative || magnitude != test.magnitude {
			t.Fatalf("signed magnitude of %d = (%d,%d), want (%d,%d)", test.value, negative, magnitude, test.negative, test.magnitude)
		}
	}
}

func TestBridgeTCPIdentityIsStableAndAllocationSpecific(t *testing.T) {
	a, b := new(Endpoint), new(Endpoint)
	if a.BridgeTCPIdentity() != a.BridgeTCPIdentity() || a.BridgeTCPIdentity() == b.BridgeTCPIdentity() {
		t.Fatal("weak identity conflated endpoints or changed within their lifetime")
	}
}
