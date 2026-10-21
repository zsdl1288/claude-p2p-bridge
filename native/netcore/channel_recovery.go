package netcore

import (
	"context"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

const (
	transportRefreshCooldown = 2 * time.Minute
	transportRefreshTimeout  = 4 * time.Second
)

// TransportRefresh only reports whether the embedded node accepted a refresh.
// It deliberately exposes no endpoint, identity, or raw LocalAPI error.
type TransportRefresh struct {
	Refreshed    bool   `json:"refreshed"`
	Reason       string `json:"reason"`
	RetryAfterMS int64  `json:"retryAfterMs,omitempty"`
}

type transportRecovery struct {
	mu     sync.Mutex
	active bool
	next   time.Time
}

// RefreshTransport refreshes only this already-running tsnet node's UDP and
// endpoint discovery. It does not edit preferences, replace the node, release
// forwarding resources, or touch a system proxy, route, or TUN device.
func (m *Manager) RefreshTransport(ctx context.Context) TransportRefresh {
	return m.refreshTransport(ctx, time.Now(), func(ctx context.Context, server *tsnet.Server) error {
		// LocalClient may call Start itself, so the started snapshot below must
		// precede this call. No idle manager reaches LocalClient.
		client, err := server.LocalClient()
		if err != nil {
			return err
		}
		return runTransportRefresh(ctx, client)
	})
}

func (m *Manager) refreshTransport(ctx context.Context, now time.Time, run func(context.Context, *tsnet.Server) error) TransportRefresh {
	unavailable := TransportRefresh{Reason: "unavailable"}
	if ctx.Err() != nil {
		return unavailable
	}
	// Take only a lifecycle snapshot. Never wait behind login/shutdown or hold
	// either manager mutex while calling the embedded LocalAPI.
	if !m.startMu.TryLock() {
		return TransportRefresh{Reason: "busy"}
	}
	m.mu.Lock()
	started, closed, server := m.started, m.closed, m.server
	m.mu.Unlock()
	m.startMu.Unlock()
	if !started || closed || server == nil {
		return unavailable
	}

	r := &m.transportRecovery
	r.mu.Lock()
	if r.active {
		r.mu.Unlock()
		return TransportRefresh{Reason: "busy"}
	}
	if now.Before(r.next) {
		remaining := r.next.Sub(now).Milliseconds()
		if remaining < 1 {
			remaining = 1
		}
		r.mu.Unlock()
		return TransportRefresh{Reason: "cooldown", RetryAfterMS: remaining}
	}
	r.active = true
	// Failed attempts also cool down: an unsupported/unresponsive LocalAPI
	// must never cause a refresh storm during a bad connection.
	r.next = now.Add(transportRefreshCooldown)
	r.mu.Unlock()
	defer func() { r.mu.Lock(); r.active = false; r.mu.Unlock() }()

	refreshCtx, cancel := context.WithTimeout(ctx, transportRefreshTimeout)
	defer cancel()
	if refreshCtx.Err() != nil || run(refreshCtx, server) != nil || refreshCtx.Err() != nil {
		return unavailable
	}
	return TransportRefresh{Refreshed: true, Reason: "refreshed"}
}

type transportDebugClient interface {
	DebugAction(context.Context, string) error
}

func runTransportRefresh(ctx context.Context, client transportDebugClient) error {
	// These fixed, pinned Tailscale actions affect only MagicConn sockets and
	// endpoint probes. Never accept an arbitrary debug action from RPC input.
	for _, action := range []string{"rebind", "restun"} {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := client.DebugAction(ctx, action); err != nil {
			return err
		}
	}
	return ctx.Err()
}
