package netcore

import (
	"context"
	"math"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
)

const channelProbeTimeout = 2500 * time.Millisecond

var channelProbeRegion = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,16}$`)

// ChannelProbeResult is deliberately independent of PingResult: a diagnostic
// reply must never publish endpoint addresses, node names, keys or raw errors.
type ChannelProbeResult struct {
	Type              string   `json:"type,omitempty"`
	Size              int      `json:"size"`
	Outcome           string   `json:"outcome"`
	LatencySeconds    *float64 `json:"latencySeconds,omitempty"`
	ActualVia         string   `json:"actualVia"`
	DERPRegionID      int      `json:"derpRegionId,omitempty"`
	DERPRegionCode    string   `json:"derpRegionCode,omitempty"`
	InnerIPv4Bytes    int      `json:"innerIPv4Bytes,omitempty"`
	DiscoPayloadBytes int      `json:"discoPayloadBytes,omitempty"`
}

func validChannelProbe(host, kind string, size int) bool {
	ip, err := netip.ParseAddr(host)
	return err == nil && ip.Is4() && ip.String() == host && tailnetRange.Contains(ip) &&
		((kind == string(tailcfg.PingTSMP) && size == 0) ||
			(kind == string(tailcfg.PingDisco) && (size == 128 || size == 1200)))
}

func channelProbeBase(kind string, size int) ChannelProbeResult {
	r := ChannelProbeResult{Type: kind, Size: size, Outcome: "unavailable", ActualVia: "unknown"}
	if kind == string(tailcfg.PingTSMP) {
		r.InnerIPv4Bytes = 29 // The pinned engine ignores TSMP Size (20-byte IP + 9-byte TSMP).
	} else {
		r.DiscoPayloadBytes = size
	}
	return r
}

func validChannelProbeEndpoint(raw string) bool {
	ip, err := netip.ParseAddrPort(raw)
	return err == nil && ip.IsValid() && ip.Port() > 0 && ip.Addr().Zone() == "" &&
		!ip.Addr().IsUnspecified() && !ip.Addr().IsMulticast() && !ip.Addr().IsLoopback()
}

func validChannelProbeRelay(raw string) bool {
	parts := strings.Split(raw, ":vni:")
	if len(parts) != 2 || !validChannelProbeEndpoint(parts[0]) {
		return false
	}
	_, err := strconv.ParseUint(parts[1], 10, 32)
	return err == nil
}

func sanitizeChannelProbe(kind string, size int, value *ipnstate.PingResult) ChannelProbeResult {
	r := channelProbeBase(kind, size)
	if value == nil || value.Err != "" || math.IsNaN(value.LatencySeconds) || math.IsInf(value.LatencySeconds, 0) || value.LatencySeconds < 0 {
		r.Outcome = "probe-error"
		return r
	}
	r.Outcome = "reply"
	latency := value.LatencySeconds
	r.LatencySeconds = &latency
	// TSMP results do not carry the actual path in this pinned version.
	if kind == string(tailcfg.PingTSMP) {
		return r
	}
	if value.DERPRegionID > 0 && value.DERPRegionID <= 65535 {
		r.DERPRegionID = int(value.DERPRegionID)
		if channelProbeRegion.MatchString(value.DERPRegionCode) {
			r.DERPRegionCode = value.DERPRegionCode
		}
		r.ActualVia = "derp"
	} else if validChannelProbeRelay(value.PeerRelay) {
		r.ActualVia = "peer-relay"
	} else if validChannelProbeEndpoint(value.Endpoint) {
		r.ActualVia = "direct"
	}
	return r
}

func channelProbeContextOutcome(ctx context.Context, fallback string) string {
	if ctx.Err() == context.Canceled {
		return "cancelled"
	}
	if ctx.Err() == context.DeadlineExceeded {
		return "timeout"
	}
	return fallback
}

type channelProbeCall func(context.Context, netip.Addr, tailcfg.PingType, local.PingOpts) (*ipnstate.PingResult, error)

func invokeChannelProbe(ctx context.Context, host, kind string, size int, call channelProbeCall) ChannelProbeResult {
	r := channelProbeBase(kind, size)
	probeCtx, cancel := context.WithTimeout(ctx, channelProbeTimeout)
	defer cancel()
	if probeCtx.Err() != nil {
		r.Outcome = channelProbeContextOutcome(probeCtx, "unavailable")
		return r
	}
	value, err := call(probeCtx, netip.MustParseAddr(host), tailcfg.PingType(kind), local.PingOpts{Size: size})
	if probeCtx.Err() != nil {
		r.Outcome = channelProbeContextOutcome(probeCtx, "unavailable")
		return r
	}
	if err != nil {
		r.Outcome = "probe-error"
		return r
	}
	return sanitizeChannelProbe(kind, size, value)
}

func channelProbePeerOnline(status *ipnstate.Status, target netip.Addr) bool {
	if status == nil || status.BackendState != "Running" {
		return false
	}
	for _, ip := range status.TailscaleIPs {
		if ip == target {
			return false
		}
	}
	if status.Self != nil {
		for _, ip := range status.Self.TailscaleIPs {
			if ip == target {
				return false
			}
		}
	}
	for _, peer := range status.Peer {
		if peer == nil || !peer.Online {
			continue
		}
		for _, ip := range peer.TailscaleIPs {
			if ip == target {
				return true
			}
		}
	}
	return false
}

type channelProbeClient interface {
	Status(context.Context) (*ipnstate.Status, error)
	PingWithOpts(context.Context, netip.Addr, tailcfg.PingType, local.PingOpts) (*ipnstate.PingResult, error)
}

// ChannelProbe runs only on the captured, already-started node and a currently
// online tailnet peer. The service additionally authorizes the selected pairing.
// Disco is an active discovery probe and may refresh this node's preferred peer
// path; it never edits preferences, identity, OS routes, system proxy or TUN.
func (m *Manager) ChannelProbe(ctx context.Context, host, kind string, size int) (ChannelProbeResult, error) {
	return m.channelProbe(ctx, host, kind, size, func(server *tsnet.Server) (channelProbeClient, error) {
		return server.LocalClient()
	})
}

func (m *Manager) channelProbe(ctx context.Context, host, kind string, size int, getClient func(*tsnet.Server) (channelProbeClient, error)) (ChannelProbeResult, error) {
	if !validChannelProbe(host, kind, size) {
		return ChannelProbeResult{Outcome: "invalid-request", ActualVia: "unknown"}, nil
	}
	r := channelProbeBase(kind, size)
	if ctx.Err() != nil {
		r.Outcome = channelProbeContextOutcome(ctx, "unavailable")
		return r, nil
	}
	// This independent lock prevents overlap after an HTTP caller aborts. It
	// never serializes shutdown, normal control operations or forwarded data.
	if !m.channelProbeMu.TryLock() {
		r.Outcome = "busy"
		return r, nil
	}
	defer m.channelProbeMu.Unlock()
	if !m.startMu.TryLock() {
		r.Outcome = "busy"
		return r, nil
	}
	m.mu.Lock()
	started, closed, server := m.started, m.closed, m.server
	m.mu.Unlock()
	m.startMu.Unlock()
	if !started || closed || server == nil {
		return r, nil
	}
	// LocalClient itself calls Start, so it must only see this already-started
	// server. A concurrent Close can fail this operation, never replace the node.
	probeCtx, cancel := context.WithTimeout(ctx, channelProbeTimeout)
	defer cancel()
	client, err := getClient(server)
	if err != nil {
		return r, nil
	}
	status, err := client.Status(probeCtx)
	if err != nil || probeCtx.Err() != nil {
		r.Outcome = channelProbeContextOutcome(probeCtx, "unavailable")
		return r, nil
	}
	if !channelProbePeerOnline(status, netip.MustParseAddr(host)) {
		return r, nil
	}
	return invokeChannelProbe(probeCtx, host, kind, size, client.PingWithOpts), nil
}
