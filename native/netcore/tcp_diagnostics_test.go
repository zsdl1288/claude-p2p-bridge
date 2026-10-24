package netcore

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"weak"
)

type tcpFixtureEndpoint struct{ values map[string]uint64 }

func (e *tcpFixtureEndpoint) BridgeTCPDiagnostics() map[string]uint64 { return e.values }
func (e *tcpFixtureEndpoint) BridgeTCPIdentity() any                  { return weak.Make(e) }

type tcpFixtureProvider struct{ endpoints []any }

func (p tcpFixtureProvider) BridgeTCPEndpoints(limit int) []any {
	if len(p.endpoints) > limit {
		return p.endpoints[:limit]
	}
	return p.endpoints
}

func tcpActiveFixture() *tcpFixtureEndpoint {
	values := map[string]uint64{"available": 1}
	for index, name := range tcpDiagnosticMetricNames {
		values[name] = uint64(index)
	}
	for _, name := range []string{"zeroWindowProbing", "rttValid", "reorderSeen", "sackedOutNegative", "reorderPersistNegative"} {
		values[name] = 1
	}
	values["secret_tuple_100.64.0.1:3211"] = 123
	return &tcpFixtureEndpoint{values: values}
}

func TestTCPDiagnosticsAnonymousStableIDsAndPrunedIdentityMap(t *testing.T) {
	var ids tcpFlowIDs
	a, b, c := tcpActiveFixture(), tcpActiveFixture(), tcpActiveFixture()
	first, err := ids.snapshot(context.Background(), tcpFixtureProvider{[]any{a, b, a}})
	if err != nil || len(first.Flows) != 2 || first.Flows[0].FlowID != 1 || first.Flows[1].FlowID != 2 {
		t.Fatal(first, err)
	}
	second, err := ids.snapshot(context.Background(), tcpFixtureProvider{[]any{b, c}})
	if err != nil || second.Flows[0].FlowID != 2 || second.Flows[1].FlowID != 3 || len(ids.ids) != 2 {
		t.Fatal(second, err)
	}
	if _, present := ids.ids[a.BridgeTCPIdentity()]; present {
		t.Fatal("closed/unselected endpoint was retained")
	}
	encoded, _ := json.Marshal(second)
	for _, forbidden := range []string{"secret", "tuple", "100.64", "3211", "pointer", "address"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatal("snapshot exposed endpoint identity", string(encoded))
		}
	}
	if len(second.Flows[0].Metrics) != len(tcpDiagnosticMetricNames) {
		t.Fatal("snapshot did not project the numeric allowlist")
	}
}

func TestTCPDiagnosticsInactiveTruncatedAndUnsupported(t *testing.T) {
	var ids tcpFlowIDs
	inactive := &tcpFixtureEndpoint{map[string]uint64{"available": 0, "state": 10}}
	got, err := ids.snapshot(context.Background(), tcpFixtureProvider{[]any{inactive}})
	if err != nil || got.Flows[0].Available || len(got.Flows[0].Metrics) != 1 || got.Flows[0].Message == "" {
		t.Fatal("inactive flow fabricated sender measurements", got, err)
	}
	provider := tcpFixtureProvider{}
	for range 140 {
		provider.endpoints = append(provider.endpoints, tcpActiveFixture())
	}
	got, err = ids.snapshot(context.Background(), provider)
	if err != nil || !got.Truncated || len(got.Flows) != 128 || len(ids.ids) != 128 {
		t.Fatal("endpoint cap was not enforced", err)
	}
	got, err = ids.snapshot(context.Background(), struct{}{})
	if err != nil || got != nil || ids.ids != nil {
		t.Fatal("normal build unexpectedly exposed TCP diagnostics", got, err)
	}
	encoded, _ := json.Marshal(Diagnostics{})
	if strings.Contains(string(encoded), `"tcp"`) {
		t.Fatal("normal diagnostic response must omit tcp")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ids.snapshot(ctx, provider); err != context.Canceled {
		t.Fatal("canceled TCP snapshot was accepted", err)
	}
}

func TestTCPDiagnosticsFailsClosedOnInvalidExtension(t *testing.T) {
	for _, endpoint := range []any{
		[]int{1}, (*tcpFixtureEndpoint)(nil), &struct{}{},
		&tcpFixtureEndpoint{map[string]uint64{"available": 1, "state": 3}},
		&tcpFixtureEndpoint{map[string]uint64{"available": 2, "state": 3}},
	} {
		var ids tcpFlowIDs
		if got, err := ids.snapshot(context.Background(), tcpFixtureProvider{[]any{endpoint}}); err == nil || got != nil {
			t.Fatal("invalid extension was accepted", got, err)
		}
	}
	for _, identity := range []any{nil, []int{1}, (*int)(nil)} {
		var ids tcpFlowIDs
		endpoint := &tcpInvalidIdentity{tcpFixtureEndpoint: *tcpActiveFixture(), identity: identity}
		if _, err := ids.snapshot(context.Background(), tcpFixtureProvider{[]any{endpoint}}); err == nil {
			t.Fatal("invalid weak identity was accepted")
		}
	}
	m := &Manager{tcpFlowIDs: tcpFlowIDs{ids: map[any]uint64{tcpActiveFixture().BridgeTCPIdentity(): 1}}}
	m.Close()
	if m.tcpFlowIDs.ids != nil {
		t.Fatal("closing the manager retained endpoint references")
	}
}

func TestTCPDiagnosticsSignedAccountingAndReorderFields(t *testing.T) {
	endpoint := tcpActiveFixture()
	want := map[string]uint64{
		"sackedOutNegative": 1, "sackedOutAbsPackets": 7,
		"reorderWindowNs": 63_000_000, "reorderWindowMultiplier": 2,
		"reorderPersistNegative": 1, "reorderPersistAbs": 3,
	}
	for name, value := range want {
		endpoint.values[name] = value
	}
	var ids tcpFlowIDs
	got, err := ids.snapshot(context.Background(), tcpFixtureProvider{[]any{endpoint}})
	if err != nil || len(got.Flows) != 1 || !got.Flows[0].Available {
		t.Fatal("negative signed accounting suppressed a valid snapshot", got, err)
	}
	for name, value := range want {
		if got.Flows[0].Metrics[name] != value {
			t.Errorf("%s=%d, want %d", name, got.Flows[0].Metrics[name], value)
		}
	}
	for name := range want {
		delete(endpoint.values, name)
		if _, err := ids.snapshot(context.Background(), tcpFixtureProvider{[]any{endpoint}}); err == nil {
			t.Errorf("missing metric %s was accepted", name)
		}
		endpoint.values[name] = want[name]
	}
	for _, name := range []string{"sackedOutNegative", "reorderPersistNegative"} {
		endpoint.values[name] = 2
		if _, err := ids.snapshot(context.Background(), tcpFixtureProvider{[]any{endpoint}}); err == nil {
			t.Errorf("invalid flag %s was accepted", name)
		}
		endpoint.values[name] = want[name]
	}
}

type tcpInvalidIdentity struct {
	tcpFixtureEndpoint
	identity any
}

func (e *tcpInvalidIdentity) BridgeTCPIdentity() any { return e.identity }
