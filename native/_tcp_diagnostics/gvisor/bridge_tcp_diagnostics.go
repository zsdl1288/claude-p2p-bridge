// Copyright (c) Claude Bridge contributors.
// SPDX-License-Identifier: MIT

package tcp

import "weak"

// BridgeTCPIdentity is comparable and distinguishes allocations even if their
// addresses are reused. Holding this value does not keep the endpoint alive.
func (e *Endpoint) BridgeTCPIdentity() any { return weak.Make(e) }

// BridgeTCPDiagnostics is an on-demand read, added only to a verified shadow
// module. It does not install probes, change options, or retain packet data.
// Callers must not hold any endpoint or observer lock when calling it.
func (e *Endpoint) BridgeTCPDiagnostics() map[string]uint64 {
	result := make(map[string]uint64, 32)
	e.LockUser()
	defer e.UnlockUser()
	state := e.EndpointState()
	result["available"], result["state"] = 0, uint64(state)
	snd := e.snd
	if snd == nil || !state.connected() || state == StateTimeWait {
		return result
	}
	// Select the sender while holding e.mu, matching getTCPInfo. RTTState in
	// TCPSenderState is a probe copy, not the current synchronized RTT state.
	snd.rtt.Lock()
	rttState := snd.rtt.TCPRTTState
	snd.rtt.Unlock()
	// Each child lock is released before taking the next one. This is the
	// same e.mu -> child-lock ordering used by completeStateLocked.
	sendSize := e.getSendBufferSize()
	e.sndQueueInfo.sndQueueMu.Lock()
	sendUsed := e.sndQueueInfo.SndBufUsed
	e.sndQueueInfo.sndQueueMu.Unlock()
	e.rcvQueueMu.Lock()
	receiveUsed := e.RcvBufUsed
	e.rcvQueueMu.Unlock()
	if snd.SndCwnd < 0 || snd.Outstanding < 0 ||
		sendSize < 0 || sendUsed < 0 || receiveUsed < 0 || rttState.SRTT < 0 || rttState.RTTVar < 0 || snd.RTO < 0 {
		return result
	}
	result["available"] = 1
	result["ccState"] = uint64(snd.state)
	// SndWnd is the accepted, scaled REMOTE receive window in bytes. For B
	// sending a download over the tunnel, this is A's advertised window.
	result["sendWindowBytes"] = uint64(snd.SndWnd)
	result["zeroWindowProbing"] = bridgeBool(snd.zeroWindowProbing)
	result["sendBufferUsedBytes"] = uint64(sendUsed)
	result["sendBufferSizeBytes"] = uint64(sendSize)
	result["receiveBufferUsedBytes"] = uint64(receiveUsed)
	// Outstanding is gVisor's recovery packet estimate (reset on RTO), not
	// an exact count of packets currently on the wire.
	result["outstandingPackets"] = uint64(snd.Outstanding)
	// Subtract in the wrapping sequence-number domain. This span includes
	// SYN/FIN and SACKed bytes not cumulatively ACKed; it is not payload size.
	result["inFlightSequenceBytes"] = uint64(uint32(snd.SndNxt - snd.SndUna))
	result["cwndPackets"] = uint64(snd.SndCwnd)
	result["srttNs"] = uint64(rttState.SRTT)
	result["rttVarNs"] = uint64(rttState.RTTVar)
	result["rttValid"] = bridgeBool(rttState.SRTTInited)
	result["rtoNs"] = uint64(snd.RTO)
	result["reorderSeen"] = bridgeBool(snd.rc.Reord)
	result["segmentsSent"] = e.stats.SegmentsSent.Value()
	result["segmentsReceived"] = e.stats.SegmentsReceived.Value()
	result["retransmits"] = e.stats.SendErrors.Retransmits.Value()
	result["fastRetransmits"] = e.stats.SendErrors.FastRetransmit.Value()
	// RTO expirations also include the zero-window probing timer; this is
	// not a count of confirmed packet losses.
	result["timeouts"] = e.stats.SendErrors.Timeouts.Value()
	// These describe THIS endpoint's receiver, not the remote send window.
	result["localZeroWindowAdvertisements"] = e.stats.ReceiveErrors.ZeroRcvWindowState.Value()
	result["localReceiveBufferOverflows"] = e.stats.ReceiveErrors.ReceiveBufferOverflow.Value()
	result["localSegmentQueueDrops"] = e.stats.ReceiveErrors.SegmentQueueDropped.Value()
	return result
}

func bridgeBool(value bool) uint64 {
	if value {
		return 1
	}
	return 0
}
