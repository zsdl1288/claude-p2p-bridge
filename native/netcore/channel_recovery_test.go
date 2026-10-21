package netcore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"tailscale.com/tsnet"
)

func TestTransportRefreshIdlePreservesIdentityAndResources(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "node")
	m, err := New(Config{StateDir: directory, Hostname: "bridge-recovery-test"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	server := m.server
	resource := &proxy{}
	m.resources["existing"] = resource
	called := false
	run := func(context.Context, *tsnet.Server) error { called = true; return nil }
	for _, closed := range []bool{false, true} {
		m.closed = closed
		result := m.refreshTransport(context.Background(), time.Now(), run)
		if result.Refreshed || result.Reason != "unavailable" || called {
			t.Fatal(result, called)
		}
		if m.server != server || m.started || m.resources["existing"] != resource {
			t.Fatal("idle refresh changed node/resources")
		}
	}
	// No actual proxy was created; don't close an artificial fixture.
	delete(m.resources, "existing")
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatal("idle refresh created node state", entries, err)
	}
}

func TestTransportRefreshSingleFlightCooldownAndUnheldManagerLocks(t *testing.T) {
	server := new(tsnet.Server)
	resource := &proxy{}
	m := &Manager{started: true, server: server, resources: map[string]*proxy{"existing": resource}}
	now := time.Now()
	entered, release := make(chan struct{}), make(chan struct{})
	finished := make(chan TransportRefresh, 1)
	run := func(ctx context.Context, actual *tsnet.Server) error {
		if actual != server {
			t.Error("server replaced")
		}
		if !m.startMu.TryLock() {
			t.Error("lifecycle lock held during refresh")
		} else {
			m.startMu.Unlock()
		}
		if !m.mu.TryLock() {
			t.Error("manager lock held during refresh")
		} else {
			m.mu.Unlock()
		}
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > transportRefreshTimeout {
			t.Error("refresh did not receive bounded context")
		}
		close(entered)
		<-release
		return nil
	}
	go func() { finished <- m.refreshTransport(context.Background(), now, run) }()
	<-entered
	if result := m.refreshTransport(context.Background(), now, run); result.Reason != "busy" {
		t.Fatal(result)
	}
	close(release)
	if result := <-finished; !result.Refreshed || result.Reason != "refreshed" {
		t.Fatal(result)
	}
	if m.resources["existing"] != resource || m.server != server || !m.started || m.closed {
		t.Fatal("refresh changed lifecycle/resources")
	}
	if result := m.refreshTransport(context.Background(), now.Add(time.Second), run); result.Reason != "cooldown" || result.RetryAfterMS != 119000 {
		t.Fatal(result)
	}
	calls := 0
	if result := m.refreshTransport(context.Background(), now.Add(transportRefreshCooldown), func(context.Context, *tsnet.Server) error { calls++; return nil }); !result.Refreshed || calls != 1 {
		t.Fatal(result, calls)
	}
}

func TestTransportRefreshCancellationFailureAndLifecycleBusy(t *testing.T) {
	m := &Manager{started: true, server: new(tsnet.Server)}
	now := time.Now()
	calls := 0
	run := func(ctx context.Context, _ *tsnet.Server) error { calls++; <-ctx.Done(); return ctx.Err() }
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if result := m.refreshTransport(ctx, now, run); result.Reason != "unavailable" || calls != 0 {
		t.Fatal(result, calls)
	}
	m.startMu.Lock()
	if result := m.refreshTransport(context.Background(), now, run); result.Reason != "busy" || calls != 0 {
		t.Fatal(result, calls)
	}
	m.startMu.Unlock()
	ctx, cancel = context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	if result := m.refreshTransport(ctx, now, run); result.Reason != "unavailable" || calls != 1 {
		t.Fatal(result, calls)
	}
	if time.Since(started) > time.Second {
		t.Fatal("refresh ignored caller cancellation")
	}
	if result := m.refreshTransport(context.Background(), now.Add(time.Second), run); result.Reason != "cooldown" || calls != 1 {
		t.Fatal(result, calls)
	}
	result := m.refreshTransport(context.Background(), now.Add(transportRefreshCooldown), func(context.Context, *tsnet.Server) error {
		return errors.New("private endpoint and identity must not escape")
	})
	encoded, _ := json.Marshal(result)
	if result.Reason != "unavailable" || bytes.Contains(encoded, []byte("private")) {
		t.Fatal(string(encoded))
	}
}

type fakeTransportDebugClient struct {
	actions []string
	fail    string
	cancel  context.CancelFunc
}

func (c *fakeTransportDebugClient) DebugAction(ctx context.Context, action string) error {
	c.actions = append(c.actions, action)
	if c.cancel != nil {
		c.cancel()
	}
	if action == c.fail {
		return errors.New("synthetic action failure")
	}
	return nil
}

func TestTransportRefreshOnlyUsesFixedEmbeddedActions(t *testing.T) {
	client := &fakeTransportDebugClient{}
	if err := runTransportRefresh(context.Background(), client); err != nil || !reflect.DeepEqual(client.actions, []string{"rebind", "restun"}) {
		t.Fatal(client.actions, err)
	}
	client = &fakeTransportDebugClient{fail: "rebind"}
	if err := runTransportRefresh(context.Background(), client); err == nil || !reflect.DeepEqual(client.actions, []string{"rebind"}) {
		t.Fatal(client.actions, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client = &fakeTransportDebugClient{cancel: cancel}
	if err := runTransportRefresh(ctx, client); !errors.Is(err, context.Canceled) || !reflect.DeepEqual(client.actions, []string{"rebind"}) {
		t.Fatal(client.actions, err)
	}
}

func TestTransportRefreshRPCRejectsOptionsAndDoesNotStartIdleNode(t *testing.T) {
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
	requests := []request{{ID: 1, Method: "init", Params: mustRecoveryJSON(t, Config{StateDir: directory, Hostname: "bridge-recovery-rpc"})},
		{ID: 2, Method: "refresh-transport", Params: json.RawMessage(`{}`)},
		{ID: 3, Method: "refresh-transport", Params: json.RawMessage(`{"action":"disconnect"}`)},
		{ID: 4, Method: "refresh-transport", Params: json.RawMessage(`null`)},
		{ID: 5, Method: "status", Params: json.RawMessage(`{}`)}}
	encoder := json.NewEncoder(inputWriter)
	decoder := json.NewDecoder(output)
	seen := map[uint64]bool{}
	for _, req := range requests {
		if err := encoder.Encode(req); err != nil {
			t.Fatal(err)
		}
		var reply struct {
			ID     uint64
			Result json.RawMessage
			Error  string
		}
		if err := decoder.Decode(&reply); err != nil {
			t.Fatal(err)
		}
		seen[reply.ID] = true
		switch reply.ID {
		case 2:
			var result TransportRefresh
			if err := json.Unmarshal(reply.Result, &result); err != nil || result.Reason != "unavailable" || result.Refreshed || reply.Error != "" {
				t.Fatal(string(reply.Result), reply.Error, err)
			}
		case 3, 4:
			if !strings.Contains(reply.Error, "requires an empty object") {
				t.Fatal(reply.Error)
			}
		case 5:
			var result Status
			if err := json.Unmarshal(reply.Result, &result); err != nil || result.BackendState != "NotStarted" || result.Running {
				t.Fatal(string(reply.Result), err)
			}
		}
	}
	if len(seen) != len(requests) {
		t.Fatal(seen)
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatal("RPC refresh created node state", entries, err)
	}
}

func mustRecoveryJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
