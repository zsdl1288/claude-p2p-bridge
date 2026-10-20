package netcore

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"expvar"
	"strconv"
	"strings"
	"time"
)

// Diagnostics is a passive, node-wide snapshot. Its counters are cumulative
// since this embedded node started, and are not per-peer delivery statistics.
type Diagnostics struct {
	Available  bool                   `json:"available"`
	Source     string                 `json:"source"`
	Scope      string                 `json:"scope"`
	CapturedAt string                 `json:"capturedAt"`
	Netstack   map[string]uint64      `json:"netstack"`
	Transport  []TransportDiagnostics `json:"transport"`
	Message    string                 `json:"message,omitempty"`
}

type TransportDiagnostics struct {
	Direction string `json:"direction"`
	Path      string `json:"path"`
	Bytes     uint64 `json:"bytes"`
	Packets   uint64 `json:"packets"`
}

// Keep these original ExpVar names explicit. Never enumerate or serialize the
// whole subsystem: other variables can contain identities or network details.
var diagnosticNetstackNames = [...]string{
	"counter_dropped_packets",
	"counter_ip_disabled_packets_received",
	"counter_ip_invalid_destination_addresses_received",
	"counter_ip_invalid_source_addresses_received",
	"counter_ip_outgoing_packet_errors",
	"counter_ip_malformed_packets_received",
	"counter_ip_malformed_fragments_received",
	"counter_ip_iptables_prerouting_dropped",
	"counter_ip_iptables_input_dropped",
	"counter_ip_iptables_forward_dropped",
	"counter_ip_iptables_output_dropped",
	"counter_ip_iptables_postrouting_dropped",
	"counter_ip_forward_packet_too_big",
	"counter_ip_forward_host_unreachable",
	"counter_ip_forward_errors",
	"counter_tcp_established_resets",
	"counter_tcp_established_timeout",
	"counter_tcp_listen_overflow_syn_drop",
	"counter_tcp_listen_overflow_ack_drop",
	"counter_tcp_failed_connection_attempts",
	"counter_tcp_valid_segments_received",
	"counter_tcp_invalid_segments_received",
	"counter_tcp_segments_sent",
	"counter_tcp_segment_send_errors",
	"counter_tcp_resets_sent",
	"counter_tcp_resets_received",
	"counter_tcp_retransmits",
	"counter_tcp_fast_recovery",
	"counter_tcp_sack_recovery",
	"counter_tcp_tlp_recovery",
	"counter_tcp_slow_start_retransmits",
	"counter_tcp_fast_retransmit",
	"counter_tcp_timeouts",
	"counter_tcp_checksum_errors",
	"counter_tcp_segments_acked_with_dsack",
	"counter_tcp_spurious_recovery",
	"counter_tcp_spurious_rto_recovery",
	"counter_tcp_forward_max_in_flight_drop",
	"gauge_tcp_current_established",
	"gauge_tcp_current_connected",
}

var diagnosticTransportPaths = [...]string{
	"direct_ipv4", "direct_ipv6", "derp", "peer_relay_ipv4", "peer_relay_ipv6",
}

const (
	diagnosticMetricsMaxBytes = 256 * 1024
	diagnosticMetricsMaxLines = 4096
	diagnosticMetricsMaxLine  = 4096
)

// Diagnostics only inspects an already-started server. In particular, opening
// this view on an idle or closed manager must never start or enroll a node.
func (m *Manager) Diagnostics(ctx context.Context) (Diagnostics, error) {
	result := Diagnostics{
		Source: "embedded", Scope: "node",
		CapturedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Netstack:   map[string]uint64{}, Transport: []TransportDiagnostics{},
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	// Do not queue a passive read behind login/shutdown or hold up another
	// control operation for the RPC's full timeout.
	if !m.startMu.TryLock() {
		result.Message = "embedded network core is busy"
		return result, nil
	}
	defer m.startMu.Unlock()
	m.mu.Lock()
	started, closed, server := m.started, m.closed, m.server
	m.mu.Unlock()
	if closed {
		result.Message = "embedded network core is closed"
		return result, nil
	}
	if !started {
		result.Message = "embedded network core has not started"
		return result, nil
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if server == nil || server.Sys() == nil {
		return result, errors.New("embedded netstack diagnostics unavailable")
	}
	ns, ok := server.Sys().Netstack.GetOK()
	if !ok {
		return result, errors.New("embedded netstack diagnostics unavailable")
	}
	exporter, ok := ns.(interface{ ExpVar() expvar.Var })
	if !ok {
		return result, errors.New("embedded netstack diagnostics unsupported")
	}
	netstack, err := readDiagnosticNetstack(exporter.ExpVar())
	if err != nil {
		return result, err
	}
	// LocalClient uses tsnet's in-memory LocalAPI; the started check above is
	// essential because LocalClient itself would otherwise call Start.
	client, err := server.LocalClient()
	if err != nil {
		return result, errors.New("embedded transport diagnostics unavailable")
	}
	metricsCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	metrics, err := client.UserMetrics(metricsCtx)
	if err != nil {
		if metricsCtx.Err() != nil {
			return result, metricsCtx.Err()
		}
		return result, errors.New("embedded transport diagnostics unavailable")
	}
	transport, err := parseDiagnosticTransport(metrics)
	if err != nil {
		return result, err
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	result.Available = true
	result.CapturedAt = time.Now().UTC().Format(time.RFC3339Nano)
	result.Netstack = netstack
	result.Transport = transport
	return result, nil
}

func readDiagnosticNetstack(variable expvar.Var) (map[string]uint64, error) {
	values, ok := variable.(interface{ Get(string) expvar.Var })
	if !ok {
		return nil, errors.New("embedded netstack diagnostics unsupported")
	}
	result := make(map[string]uint64, len(diagnosticNetstackNames))
	for _, name := range diagnosticNetstackNames {
		var value int64
		switch metric := values.Get(name).(type) {
		case *expvar.Int:
			if metric == nil {
				return nil, errors.New("embedded netstack counter unavailable")
			}
			value = metric.Value()
		case expvar.Func:
			// The pinned netstack returns int64 StatCounter values. Do not
			// stringify an unexpected object or accept floating-point values.
			if metric == nil {
				return nil, errors.New("embedded netstack counter unavailable")
			}
			var valid bool
			value, valid = metric().(int64)
			if !valid {
				return nil, errors.New("embedded netstack counter is not an integer")
			}
		default:
			return nil, errors.New("embedded netstack counter unavailable")
		}
		if value < 0 {
			return nil, errors.New("embedded netstack counter is negative")
		}
		result[name] = uint64(value)
	}
	return result, nil
}

// Tailscale 1.104.1 registers these four MultiLabelMaps, each with exactly one
// path label and all five paths, including zero counters. Ignore unrelated
// metrics, but reject changes to the selected series instead of inventing zeros.
func parseDiagnosticTransport(data []byte) ([]TransportDiagnostics, error) {
	if len(data) > diagnosticMetricsMaxBytes {
		return nil, errors.New("embedded transport metrics exceed size limit")
	}
	type seriesKey struct{ name, path string }
	values := make(map[seriesKey]uint64, 4*len(diagnosticTransportPaths))
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 1024), diagnosticMetricsMaxLine)
	lines := 0
	for scanner.Scan() {
		lines++
		if lines > diagnosticMetricsMaxLines {
			return nil, errors.New("embedded transport metrics exceed line limit")
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name := line
		if end := strings.IndexAny(name, "{ \t"); end >= 0 {
			name = name[:end]
		}
		switch name {
		case "tailscaled_inbound_bytes_total", "tailscaled_inbound_packets_total",
			"tailscaled_outbound_bytes_total", "tailscaled_outbound_packets_total":
		default:
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			return nil, errors.New("embedded transport metric format unsupported")
		}
		path, ok := strings.CutPrefix(fields[0], name+`{path="`)
		if !ok || !strings.HasSuffix(path, `"}`) {
			return nil, errors.New("embedded transport metric labels unsupported")
		}
		path = strings.TrimSuffix(path, `"}`)
		knownPath := false
		for _, allowed := range diagnosticTransportPaths {
			if path == allowed {
				knownPath = true
				break
			}
		}
		if !knownPath {
			return nil, errors.New("embedded transport metric path unsupported")
		}
		key := seriesKey{name, path}
		if _, duplicate := values[key]; duplicate {
			return nil, errors.New("embedded transport metric is duplicated")
		}
		value, err := parseDiagnosticInteger(fields[1])
		if err != nil {
			return nil, err
		}
		values[key] = value
	}
	if scanner.Err() != nil {
		return nil, errors.New("embedded transport metric line exceeds size limit")
	}
	if len(values) != 4*len(diagnosticTransportPaths) {
		return nil, errors.New("embedded transport metrics are incomplete")
	}
	result := make([]TransportDiagnostics, 0, 2*len(diagnosticTransportPaths))
	for _, direction := range [...]string{"inbound", "outbound"} {
		for _, path := range diagnosticTransportPaths {
			result = append(result, TransportDiagnostics{
				Direction: direction, Path: path,
				Bytes:   values[seriesKey{"tailscaled_" + direction + "_bytes_total", path}],
				Packets: values[seriesKey{"tailscaled_" + direction + "_packets_total", path}],
			})
		}
	}
	return result, nil
}

func parseDiagnosticInteger(text string) (uint64, error) {
	if len(text) == 0 || len(text) > 20 {
		return 0, errors.New("embedded transport metric is not a nonnegative integer")
	}
	for _, digit := range text {
		if digit < '0' || digit > '9' {
			return 0, errors.New("embedded transport metric is not a nonnegative integer")
		}
	}
	value, err := strconv.ParseUint(text, 10, 64)
	if err != nil {
		return 0, errors.New("embedded transport metric integer is out of range")
	}
	return value, nil
}
