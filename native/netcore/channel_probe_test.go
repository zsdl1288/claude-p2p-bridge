package netcore

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/types/key"
)

const testProbeTarget = "100.95.24.20"

func TestChannelProbeLiteralTargetAndFixedSizes(t *testing.T) {
	for _, c := range []struct {
		host, kind string
		size       int
		valid      bool
	}{
		{testProbeTarget, "TSMP", 0, true}, {testProbeTarget, "disco", 128, true}, {testProbeTarget, "disco", 1200, true},
		{"100.122.138.42", "TSMP", 0, true}, {"100.64.0.1", "disco", 128, true},
		{"8.8.8.8", "TSMP", 0, false}, {"127.0.0.1", "TSMP", 0, false}, {"example.com", "TSMP", 0, false},
		{"100.63.255.255", "TSMP", 0, false}, {"100.128.0.1", "TSMP", 0, false}, {"100.095.24.20", "TSMP", 0, false},
		{"::ffff:100.95.24.20", "TSMP", 0, false}, {"100.95.24.20:3211", "TSMP", 0, false},
		{testProbeTarget, "TSMP", 1200, false}, {testProbeTarget, "ICMP", 0, false},
		{testProbeTarget, "disco", 0, false}, {testProbeTarget, "disco", 65535, false}, {testProbeTarget, "disco", -1, false},
	} {
		if validChannelProbe(c.host, c.kind, c.size) != c.valid {
			t.Fatalf("incorrect probe validation: %+v", c)
		}
	}
}

func TestChannelProbeIdleBusyAndClosedNeverStarts(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "node")
	m, err := New(Config{StateDir: directory, Hostname: "bridge-probe-test"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	server := m.server
	for _, closed := range []bool{false, true} {
		if closed {
			m.Close()
		}
		result, err := m.ChannelProbe(context.Background(), testProbeTarget, "TSMP", 0)
		if err != nil || result.Outcome != "unavailable" || m.started || m.server != server || server.Sys() != nil || len(m.resources) != 0 {
			t.Fatal(result, err)
		}
		entries, err := os.ReadDir(directory)
		if err != nil || len(entries) != 0 {
			t.Fatal("probe created identity/profile state", entries, err)
		}
	}
	m.startMu.Lock()
	result, err := m.ChannelProbe(context.Background(), testProbeTarget, "disco", 128)
	m.startMu.Unlock()
	if err != nil || result.Outcome != "busy" {
		t.Fatal(result, err)
	}
	m.channelProbeMu.Lock()
	result, err = m.ChannelProbe(context.Background(), testProbeTarget, "TSMP", 0)
	if err != nil || result.Outcome != "busy" {
		t.Fatal(result, err)
	}
	if !m.startMu.TryLock() {
		t.Fatal("probe lock blocked control")
	}
	m.startMu.Unlock()
	m.channelProbeMu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, err = m.ChannelProbe(ctx, testProbeTarget, "TSMP", 0)
	if err != nil || result.Outcome != "cancelled" {
		t.Fatal(result, err)
	}
}

func onlineProbeStatus() *ipnstate.Status {
	return &ipnstate.Status{BackendState: "Running", TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.122.138.42")},
		Peer: map[key.NodePublic]*ipnstate.PeerStatus{{}: {Online: true, TailscaleIPs: []netip.Addr{netip.MustParseAddr(testProbeTarget)}}}}
}

func TestChannelProbeRequiresExactOnlinePeerAndRejectsSelf(t *testing.T) {
	target := netip.MustParseAddr(testProbeTarget)
	if !channelProbePeerOnline(onlineProbeStatus(), target) {
		t.Fatal("online exact peer not accepted")
	}
	for _, change := range []func(*ipnstate.Status){
		func(s *ipnstate.Status) { s.BackendState = "Stopped" },
		func(s *ipnstate.Status) { s.Peer = nil },
		func(s *ipnstate.Status) {
			for _, p := range s.Peer {
				p.Online = false
			}
		},
		func(s *ipnstate.Status) {
			for _, p := range s.Peer {
				p.TailscaleIPs = []netip.Addr{netip.MustParseAddr("100.95.24.21")}
			}
		},
		func(s *ipnstate.Status) { s.TailscaleIPs = append(s.TailscaleIPs, target) },
		func(s *ipnstate.Status) { s.Self = &ipnstate.PeerStatus{TailscaleIPs: []netip.Addr{target}} },
	} {
		s := onlineProbeStatus()
		change(s)
		if channelProbePeerOnline(s, target) {
			t.Fatal("unavailable or self target was accepted")
		}
	}
	if channelProbePeerOnline(nil, target) {
		t.Fatal("nil status accepted")
	}
}

type fakeChannelProbeClient struct {
	status func(context.Context) (*ipnstate.Status, error)
	ping   channelProbeCall
}

func (c *fakeChannelProbeClient) Status(ctx context.Context) (*ipnstate.Status, error) {
	return c.status(ctx)
}
func (c *fakeChannelProbeClient) PingWithOpts(ctx context.Context, target netip.Addr, kind tailcfg.PingType, opts local.PingOpts) (*ipnstate.PingResult, error) {
	return c.ping(ctx, target, kind, opts)
}

func TestChannelProbeSingleFlightKeepsManagerLocksAndResourcesFree(t *testing.T) {
	server, resource := new(tsnet.Server), &proxy{}
	m := &Manager{started: true, server: server, resources: map[string]*proxy{"saved-listener": resource}}
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan ChannelProbeResult, 1)
	var statusDeadline time.Time
	client := &fakeChannelProbeClient{
		status: func(ctx context.Context) (*ipnstate.Status, error) {
			var ok bool
			statusDeadline, ok = ctx.Deadline()
			if !ok || time.Until(statusDeadline) > channelProbeTimeout {
				t.Error("status has no shared probe deadline")
			}
			return onlineProbeStatus(), nil
		},
		ping: func(ctx context.Context, target netip.Addr, kind tailcfg.PingType, opts local.PingOpts) (*ipnstate.PingResult, error) {
			if target.String() != testProbeTarget || kind != tailcfg.PingDisco || opts.Size != 1200 {
				t.Error("wrong target/type/size")
			}
			if deadline, _ := ctx.Deadline(); deadline != statusDeadline {
				t.Error("status and ping deadlines were stacked")
			}
			close(entered)
			<-release
			return &ipnstate.PingResult{LatencySeconds: 0.25, Endpoint: "203.0.113.1:45000"}, nil
		},
	}
	getClient := func(s *tsnet.Server) (channelProbeClient, error) {
		if s != server {
			t.Error("probe replaced running server")
		}
		if !m.startMu.TryLock() {
			t.Error("lifecycle lock held during LocalAPI")
		} else {
			m.startMu.Unlock()
		}
		if !m.mu.TryLock() {
			t.Error("manager lock held during LocalAPI")
		} else {
			m.mu.Unlock()
		}
		return client, nil
	}
	go func() {
		result, _ := m.channelProbe(context.Background(), testProbeTarget, "disco", 1200, getClient)
		done <- result
	}()
	<-entered
	result, err := m.channelProbe(context.Background(), testProbeTarget, "disco", 128, getClient)
	if err != nil || result.Outcome != "busy" {
		t.Fatal(result, err)
	}
	if !m.startMu.TryLock() {
		t.Fatal("pending probe blocked shutdown/control")
	}
	m.startMu.Unlock()
	close(release)
	if result := <-done; result.Outcome != "reply" || result.ActualVia != "direct" {
		t.Fatal(result)
	}
	if m.resources["saved-listener"] != resource || m.server != server || !m.started || m.closed {
		t.Fatal("probe changed resources or lifecycle")
	}
}

func TestChannelProbeStatusFailureOfflineAndCancellationNeverPings(t *testing.T) {
	for _, mode := range []string{"error", "offline", "cancel"} {
		m := &Manager{started: true, server: new(tsnet.Server)}
		calls := 0
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Millisecond)
		client := &fakeChannelProbeClient{status: func(ctx context.Context) (*ipnstate.Status, error) {
			switch mode {
			case "error":
				return nil, errors.New("private status error")
			case "cancel":
				<-ctx.Done()
				return nil, ctx.Err()
			default:
				status := onlineProbeStatus()
				status.Peer = nil
				return status, nil
			}
		}, ping: func(context.Context, netip.Addr, tailcfg.PingType, local.PingOpts) (*ipnstate.PingResult, error) {
			calls++
			return nil, nil
		}}
		result, err := m.channelProbe(ctx, testProbeTarget, "TSMP", 0, func(*tsnet.Server) (channelProbeClient, error) { return client, nil })
		cancel()
		if err != nil || calls != 0 || (result.Outcome != "unavailable" && result.Outcome != "timeout") {
			t.Fatal(mode, result, err, calls)
		}
	}
}

func TestChannelProbeBoundedInvocationAndPrivateReplyWhitelist(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Millisecond)
	defer cancel()
	result := invokeChannelProbe(ctx, testProbeTarget, "TSMP", 0, func(ctx context.Context, target netip.Addr, kind tailcfg.PingType, opts local.PingOpts) (*ipnstate.PingResult, error) {
		if target.String() != testProbeTarget || kind != tailcfg.PingTSMP || opts.Size != 0 {
			t.Fatal("wrong invocation")
		}
		<-ctx.Done()
		return nil, ctx.Err()
	})
	if result.Outcome != "timeout" {
		t.Fatal(result)
	}
	result = invokeChannelProbe(context.Background(), testProbeTarget, "disco", 128, func(context.Context, netip.Addr, tailcfg.PingType, local.PingOpts) (*ipnstate.PingResult, error) {
		return nil, errors.New("private error key")
	})
	if result.Outcome != "probe-error" {
		t.Fatal(result)
	}
	value := &ipnstate.PingResult{IP: "private-ip", NodeName: "private-name-key", PeerAPIURL: "private-url", LatencySeconds: 0.26,
		Endpoint: "203.0.113.10:50000", DERPRegionID: 3, DERPRegionCode: "tok"}
	result = sanitizeChannelProbe("disco", 1200, value)
	if result.ActualVia != "derp" || result.DERPRegionID != 3 || result.DERPRegionCode != "tok" {
		t.Fatal(result)
	}
	data, _ := json.Marshal(result)
	for _, forbidden := range []string{"private", "203.0.113", "endpoint", "NodeName", "PeerAPI"} {
		if strings.Contains(string(data), forbidden) {
			t.Fatal("private field escaped", string(data))
		}
	}
	result = sanitizeChannelProbe("TSMP", 0, value)
	if result.ActualVia != "unknown" || result.DERPRegionID != 0 || result.InnerIPv4Bytes != 29 {
		t.Fatal("TSMP invented path/size", result)
	}
	value.DERPRegionID = 0
	if result = sanitizeChannelProbe("disco", 128, value); result.ActualVia != "direct" {
		t.Fatal(result)
	}
	value.Endpoint = "private-invalid-endpoint"
	value.PeerRelay = "203.0.113.11:50001:vni:7"
	if result = sanitizeChannelProbe("disco", 128, value); result.ActualVia != "peer-relay" {
		t.Fatal(result)
	}
	value.PeerRelay = "malformed"
	if result = sanitizeChannelProbe("disco", 128, value); result.ActualVia != "unknown" {
		t.Fatal(result)
	}
	for _, bad := range []float64{-1, math.Inf(1), math.NaN()} {
		value.LatencySeconds = bad
		if sanitizeChannelProbe("disco", 128, value).Outcome != "probe-error" {
			t.Fatal("invalid latency accepted")
		}
	}
}

func TestChannelProbeRPCIsIdleAndPreservesRefreshTransportMethod(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "node")
	input, inputWriter := io.Pipe()
	output, outputWriter := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- Run(input, outputWriter); outputWriter.Close() }()
	t.Cleanup(func() {
		inputWriter.Close()
		output.Close()
		if err := <-done; err != nil {
			t.Error(err)
		}
	})
	encoder, decoder := json.NewEncoder(inputWriter), json.NewDecoder(output)
	requests := []request{
		{ID: 1, Method: "init", Params: mustRecoveryJSON(t, Config{StateDir: directory, Hostname: "bridge-probe-rpc"})},
		{ID: 2, Method: "channel-probe", Params: json.RawMessage(`{"host":"100.95.24.20","type":"TSMP","size":0}`)},
		{ID: 3, Method: "channel-probe", Params: json.RawMessage(`{"host":"8.8.8.8","type":"disco","size":128}`)},
		{ID: 4, Method: "refresh-transport", Params: json.RawMessage(`{}`)},
		{ID: 5, Method: "status", Params: json.RawMessage(`{}`)},
	}
	for _, req := range requests {
		if err := encoder.Encode(req); err != nil {
			t.Fatal(err)
		}
		var reply struct {
			ID     uint64
			Result json.RawMessage
			Error  string
		}
		if err := decoder.Decode(&reply); err != nil || reply.ID != req.ID || reply.Error != "" {
			t.Fatal(reply, err)
		}
		if req.ID == 2 || req.ID == 3 {
			var result ChannelProbeResult
			if err := json.Unmarshal(reply.Result, &result); err != nil {
				t.Fatal(err)
			}
			want := "unavailable"
			if req.ID == 3 {
				want = "invalid-request"
			}
			if result.Outcome != want {
				t.Fatal(result)
			}
		}
		if req.ID == 4 && !strings.Contains(string(reply.Result), `"reason":"unavailable"`) {
			t.Fatal(string(reply.Result))
		}
		if req.ID == 5 && !strings.Contains(string(reply.Result), `"backendState":"NotStarted"`) {
			t.Fatal(string(reply.Result))
		}
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatal("RPC probe created identity", entries, err)
	}
}
