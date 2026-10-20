package netcore

import (
	"bytes"
	"context"
	"encoding/json"
	"expvar"
	"io"
	"math"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tailscale.com/metrics"
	"tailscale.com/net/tsdial"
	"tailscale.com/net/tstun"
	"tailscale.com/proxymap"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
	"tailscale.com/util/usermetric"
	"tailscale.com/wgengine"
	"tailscale.com/wgengine/magicsock"
	"tailscale.com/wgengine/netstack"
)

// Create needs an engine handle but does not call it before Start. A nil
// embedded interface makes any accidental engine operation fail the test.
type diagnosticUnusedEngine struct{ wgengine.Engine }

func TestDiagnosticsReadsRealNetstackExpVarWithoutStartingNetwork(t *testing.T) {
	// Only build an in-memory gVisor stack. Do not create a userspace engine,
	// actual TUN, socket, LocalBackend, or call netstack.Start.
	ns, err := netstack.Create(logger.Discard, new(tstun.Wrapper), diagnosticUnusedEngine{},
		new(magicsock.Conn), new(tsdial.Dialer), nil, new(proxymap.Mapper))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ns.Close() })
	values, err := readDiagnosticNetstack(ns.ExpVar())
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != len(diagnosticNetstackNames) {
		t.Fatalf("got %d selected counters, want %d", len(values), len(diagnosticNetstackNames))
	}
	for name, value := range values {
		if value != 0 {
			t.Fatalf("unstarted in-memory stack has nonzero %s: %d", name, value)
		}
	}
	var ids tcpFlowIDs
	tcp, err := ids.snapshot(context.Background(), ns)
	if err != nil {
		t.Fatal(err)
	}
	if _, extended := any(ns).(interface{ BridgeTCPEndpoints(int) []any }); extended {
		if tcp == nil || !tcp.Available || len(tcp.Flows) != 0 {
			t.Fatal("diagnostic shadow must expose an empty passive TCP snapshot", tcp)
		}
	} else if tcp != nil {
		t.Fatal("normal dependency must not expose a TCP snapshot", tcp)
	}
}

func diagnosticExpVarFixture() *metrics.Set {
	set := new(metrics.Set)
	for index, name := range diagnosticNetstackNames {
		value := int64(index + 1)
		set.Set(name, expvar.Func(func() any { return value }))
	}
	return set
}

func TestDiagnosticsNetstackAllowlistNeverReadsOtherVariables(t *testing.T) {
	set := diagnosticExpVarFixture()
	set.Set("private_identity", expvar.Func(func() any {
		t.Fatal("an unlisted ExpVar was evaluated")
		return nil
	}))
	integer := new(expvar.Int)
	integer.Set(123)
	set.Set("counter_tcp_retransmits", integer)
	values, err := readDiagnosticNetstack(set)
	if err != nil || values["counter_tcp_retransmits"] != 123 || len(values) != len(diagnosticNetstackNames) {
		t.Fatalf("unexpected selected counter values: %v, %v", values, err)
	}
	if _, present := values["private_identity"]; present {
		t.Fatal("unlisted ExpVar was returned")
	}
}

func TestDiagnosticsRejectsMissingOrInvalidNetstackCounters(t *testing.T) {
	for _, test := range []struct {
		name  string
		value expvar.Var
	}{
		{"missing", nil},
		{"negative", expvar.Func(func() any { return int64(-1) })},
		{"nan", expvar.Func(func() any { return math.NaN() })},
		{"float", expvar.Func(func() any { return float64(1) })},
		{"text", expvar.Func(func() any { return "fixture-sensitive-value" })},
		{"object", new(expvar.Map)},
	} {
		t.Run(test.name, func(t *testing.T) {
			set := diagnosticExpVarFixture()
			set.Set("counter_tcp_retransmits", test.value)
			values, err := readDiagnosticNetstack(set)
			if err == nil || values != nil || strings.Contains(err.Error(), "fixture-sensitive-value") {
				t.Fatal("invalid counter must fail without exposing its value", values, err)
			}
		})
	}
	if values, err := readDiagnosticNetstack(expvar.Func(func() any {
		t.Fatal("unexpected ExpVar container must not be evaluated")
		return nil
	})); err == nil || values != nil {
		t.Fatal("unsupported ExpVar container was accepted")
	}
}

func diagnosticTransportFixture(t *testing.T) []byte {
	t.Helper()
	registry := new(usermetric.Registry)
	type pathLabel struct{ Path string }
	for index, name := range []string{
		"tailscaled_inbound_bytes_total", "tailscaled_inbound_packets_total",
		"tailscaled_outbound_bytes_total", "tailscaled_outbound_packets_total",
	} {
		metric := usermetric.NewMultiLabelMapWithRegistry[pathLabel](registry, name, "counter", "fixture metric")
		for pathIndex, path := range diagnosticTransportPaths {
			value := new(expvar.Int)
			value.Set(int64(100*index + 11*pathIndex + 7))
			metric.Set(pathLabel{Path: path}, value)
		}
	}
	// Exercise the actual Tailscale Prometheus formatter without a listener.
	response := httptest.NewRecorder()
	registry.Handler(response, httptest.NewRequest("GET", "http://localapi.invalid/usermetrics", nil))
	return append(response.Body.Bytes(), []byte("unrelated_private_metric{identity=\"fixture-sensitive-value\"} NaN\n")...)
}

func TestDiagnosticsParsesActualUserMetricsFormat(t *testing.T) {
	values, err := parseDiagnosticTransport(diagnosticTransportFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 10 {
		t.Fatalf("got %d transport rows, want 10", len(values))
	}
	for directionIndex, direction := range []string{"inbound", "outbound"} {
		for pathIndex, path := range diagnosticTransportPaths {
			value := values[directionIndex*len(diagnosticTransportPaths)+pathIndex]
			if value.Direction != direction || value.Path != path ||
				value.Bytes != uint64(200*directionIndex+11*pathIndex+7) ||
				value.Packets != uint64(200*directionIndex+100+11*pathIndex+7) {
				t.Fatalf("series assigned to the wrong direction or path: %+v", value)
			}
		}
	}
	data, err := json.Marshal(values)
	if err != nil || bytes.Contains(data, []byte("fixture-sensitive-value")) || bytes.Contains(data, []byte("identity")) {
		t.Fatal("transport snapshot exposed an unrelated metric", err)
	}
}

func TestDiagnosticsRejectsUnsafeOrIncompleteTransportMetrics(t *testing.T) {
	fixture := string(diagnosticTransportFixture(t))
	selected := `tailscaled_inbound_bytes_total{path="direct_ipv4"} 7`
	if !strings.Contains(fixture, selected) {
		t.Fatal("actual metric format changed")
	}
	for _, test := range []struct{ name, replacement string }{
		{"nan", `tailscaled_inbound_bytes_total{path="direct_ipv4"} NaN`},
		{"infinity", `tailscaled_inbound_bytes_total{path="direct_ipv4"} +Inf`},
		{"negative", `tailscaled_inbound_bytes_total{path="direct_ipv4"} -1`},
		{"fraction", `tailscaled_inbound_bytes_total{path="direct_ipv4"} 1.5`},
		{"exponent", `tailscaled_inbound_bytes_total{path="direct_ipv4"} 1e3`},
		{"plus", `tailscaled_inbound_bytes_total{path="direct_ipv4"} +1`},
		{"overflow", `tailscaled_inbound_bytes_total{path="direct_ipv4"} 18446744073709551616`},
		{"extra label", `tailscaled_inbound_bytes_total{path="direct_ipv4",identity="fixture-sensitive-value"} 7`},
		{"wrong label", `tailscaled_inbound_bytes_total{identity="fixture-sensitive-value"} 7`},
		{"duplicate label", `tailscaled_inbound_bytes_total{path="direct_ipv4",path="direct_ipv4"} 7`},
		{"unknown path", `tailscaled_inbound_bytes_total{path="fixture-sensitive-value"} 7`},
		{"missing labels", `tailscaled_inbound_bytes_total 7`},
		{"timestamp", `tailscaled_inbound_bytes_total{path="direct_ipv4"} 7 1234`},
		{"missing series", ""},
		{"duplicate series", selected + "\n" + selected},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := strings.Replace(fixture, selected, test.replacement, 1)
			values, err := parseDiagnosticTransport([]byte(input))
			if err == nil || values != nil || strings.Contains(err.Error(), "fixture-sensitive-value") {
				t.Fatal("invalid metrics must fail without exposing labels", values, err)
			}
		})
	}
	for _, test := range []struct{ name, input string }{
		{"empty", ""},
		{"oversized body", strings.Repeat(" ", diagnosticMetricsMaxBytes+1)},
		{"oversized line", strings.Repeat("#", diagnosticMetricsMaxLine+1)},
		{"too many lines", strings.Repeat("#\n", diagnosticMetricsMaxLines+1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if values, err := parseDiagnosticTransport([]byte(test.input)); err == nil || values != nil {
				t.Fatal("unbounded or incomplete metrics were accepted", err)
			}
		})
	}
}

func TestDiagnosticsIdleAndClosedNeverStartOrEnroll(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "state")
	m, err := New(Config{StateDir: directory, Hostname: "bridge-diagnostics"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	server := m.server
	for _, closed := range []bool{false, true} {
		if closed {
			m.Close()
		}
		before := time.Now().UTC()
		result, err := m.Diagnostics(context.Background())
		if err != nil || result.Available || result.Source != "embedded" || result.Scope != "node" ||
			result.Netstack == nil || len(result.Netstack) != 0 || result.Transport == nil || len(result.Transport) != 0 || result.Message == "" {
			t.Fatalf("unexpected idle/closed snapshot: %+v, %v", result, err)
		}
		captured, err := time.Parse(time.RFC3339Nano, result.CapturedAt)
		if err != nil || captured.Before(before) || !strings.HasSuffix(result.CapturedAt, "Z") {
			t.Fatal("snapshot timestamp is not a current UTC timestamp", result.CapturedAt, err)
		}
		if m.started || m.server != server || server.Sys() != nil || len(m.resources) != 0 {
			t.Fatal("diagnostics started, replaced, or allocated resources on the node")
		}
		entries, err := os.ReadDir(directory)
		if err != nil || len(entries) != 0 {
			t.Fatal("diagnostics created state or login files", err)
		}
		data, err := json.Marshal(result)
		if err != nil || !bytes.Contains(data, []byte(`"netstack":{}`)) || !bytes.Contains(data, []byte(`"transport":[]`)) {
			t.Fatal("unavailable collections must stay empty JSON collections", string(data), err)
		}
	}
}

func TestDiagnosticsUnavailableStartedNodeReturnsError(t *testing.T) {
	// An inconsistent/missing subsystem must be an error, not a valid snapshot
	// of zero counters, and must not call LocalClient (which would start tsnet).
	for _, server := range []*tsnet.Server{nil, {}} {
		m := &Manager{server: server, started: true}
		result, err := m.Diagnostics(context.Background())
		if err == nil || result.Available || len(result.Netstack) != 0 || len(result.Transport) != 0 {
			t.Fatal("missing live subsystem was reported as zero statistics", result, err)
		}
		if server != nil && server.Sys() != nil {
			t.Fatal("missing subsystem caused tsnet startup")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (&Manager{started: true}).Diagnostics(ctx); err != context.Canceled {
		t.Fatal("diagnostics ignored cancellation", err)
	}
}

func TestDiagnosticsDoesNotWaitForControlOperations(t *testing.T) {
	m := new(Manager)
	m.startMu.Lock()
	defer m.startMu.Unlock()
	result, err := m.Diagnostics(context.Background())
	if err != nil || result.Available || result.Message != "embedded network core is busy" ||
		len(result.Netstack) != 0 || len(result.Transport) != 0 {
		t.Fatal("diagnostics did not return a passive busy result", result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.Diagnostics(ctx); err != context.Canceled {
		t.Fatal("busy diagnostics ignored cancellation", err)
	}
}

func TestDiagnosticsStdioMethodIsReadOnlyWhenIdle(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "state")
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
	encoder := json.NewEncoder(inputWriter)
	decoder := json.NewDecoder(output)
	for index, method := range []string{"init", "diagnostics", "status"} {
		params := any(map[string]string{})
		if method == "init" {
			params = Config{StateDir: directory, Hostname: "bridge-rpc-diagnostics"}
		}
		if err := encoder.Encode(map[string]any{"id": index + 1, "method": method, "params": params}); err != nil {
			t.Fatal(err)
		}
		var reply struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  string          `json:"error"`
		}
		if err := decoder.Decode(&reply); err != nil || reply.Error != "" || reply.ID != index+1 {
			t.Fatal("RPC diagnostics failed", reply, err)
		}
		if method == "diagnostics" {
			var snapshot Diagnostics
			if err := json.Unmarshal(reply.Result, &snapshot); err != nil || snapshot.Available || snapshot.Message != "embedded network core has not started" {
				t.Fatal("RPC diagnostics did not preserve idle state", snapshot, err)
			}
		}
		if method == "status" && !bytes.Contains(reply.Result, []byte(`"backendState":"NotStarted"`)) {
			t.Fatal("diagnostics RPC started the network core", string(reply.Result))
		}
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("diagnostics RPC created %d state files: %v", len(entries), err)
	}
}
