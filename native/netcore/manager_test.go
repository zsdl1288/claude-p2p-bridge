package netcore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestIdleDoesNotEnrollOrRequireSystemClient(t *testing.T) {
	m, err := New(Config{StateDir: t.TempDir(), Hostname: "bridge-test"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	status, err := m.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.Running || !status.Installed || !status.Embedded || status.BackendState != "NotStarted" || len(status.Peers) != 0 {
		t.Fatalf("unexpected idle status: %+v", status)
	}
	if _, err := m.Listen(context.Background(), 3211, 12345); err == nil {
		t.Fatal("unauthenticated node must not listen")
	}
}

func TestDisconnectIdleDoesNotEnrollOrDeleteIdentity(t *testing.T) {
	directory := t.TempDir()
	identity := filepath.Join(directory, "existing-profile")
	if err := os.WriteFile(identity, []byte("saved node"), 0600); err != nil {
		t.Fatal(err)
	}
	m, err := New(Config{StateDir: directory, Hostname: "bridge-down"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	server := m.server
	status, err := m.Disconnect(context.Background())
	if err != nil || status.Running || m.started || m.server != server {
		t.Fatal("idle disconnect started or replaced the node", status, err)
	}
	if data, err := os.ReadFile(identity); err != nil || string(data) != "saved node" {
		t.Fatal("disconnect removed saved identity", err)
	}
}

func TestLoginResumesSavedIdentityWithoutInteractiveReauthentication(t *testing.T) {
	for _, test := range []struct {
		name        string
		states      []Status
		interactive int
	}{
		{"saved node starting", []Status{{BackendState: "Stopped"}, {BackendState: "Starting"}, {BackendState: "Running", Running: true}}, 0},
		{"machine approval pending", []Status{{BackendState: "NeedsMachineAuth"}, {BackendState: "Running", Running: true}}, 0},
		{"new login required", []Status{{BackendState: "Starting"}, {BackendState: "NeedsLogin"}, {BackendState: "NeedsLogin"}, {BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/fixture"}}, 1},
		{"existing login flow", []Status{{BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/fixture"}}, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			reads, interactive := 0, 0
			status, err := waitForLogin(context.Background(), func(context.Context) (Status, error) {
				if reads >= len(test.states) {
					t.Fatal("login polling did not stop at the completed state")
				}
				state := test.states[reads]
				reads++
				return state, nil
			}, func(context.Context) error { interactive++; return nil })
			if err != nil || interactive != test.interactive || reads != len(test.states) || !reflect.DeepEqual(status, test.states[len(test.states)-1]) {
				t.Fatalf("unexpected login flow: status=%+v err=%v reads=%d interactive=%d", status, err, reads, interactive)
			}
		})
	}
}

func TestLoginPollingPropagatesCancellationAndBackendErrors(t *testing.T) {
	want := errors.New("fixture login failure")
	if _, err := waitForLogin(context.Background(), func(context.Context) (Status, error) {
		return Status{}, want
	}, func(context.Context) error { t.Fatal("failed status read must not start login"); return nil }); !errors.Is(err, want) {
		t.Fatal("status error was not preserved", err)
	}
	if _, err := waitForLogin(context.Background(), func(context.Context) (Status, error) {
		return Status{BackendState: "NeedsLogin"}, nil
	}, func(context.Context) error { return want }); !errors.Is(err, want) {
		t.Fatal("interactive login error was not preserved", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	_, err := waitForLogin(ctx, func(context.Context) (Status, error) {
		cancel()
		return Status{BackendState: "Starting"}, nil
	}, func(context.Context) error { t.Fatal("cancelled saved-node resume must not start login"); return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled login polling kept waiting", err)
	}
}

func TestPeerRestrictions(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "8.8.8.8", "0.0.0.0", "example.com", "192.168.1.1", "100.128.0.1"} {
		if ValidPeer(host, 3211) {
			t.Fatal(host)
		}
	}
	if !ValidPeer("100.101.102.103", 3211) || ValidPeer("100.101.102.103", 0) || ValidPeer("100.101.102.103", 65536) {
		t.Fatal("bad Tailscale validation")
	}
}

func TestFailedStartDoesNotLatchADeadServer(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "state")
	m, err := New(Config{StateDir: directory, Hostname: "bridge-start-retry"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	// Fail before tsnet can initialize or contact the network.
	if err := os.Remove(directory); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(directory, []byte("temporarily blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	first := m.server
	if err := m.start(); err == nil {
		t.Fatal("a file cannot be used as a network state directory")
	}
	if m.server == first || m.started {
		t.Fatal("failed tsnet instance would cache its error on every retry")
	}
	second := m.server
	if err := m.start(); err == nil || m.server == second {
		t.Fatal("retry did not attempt and retire another failed instance")
	}
	status, err := m.Status(context.Background())
	if err != nil || status.BackendState != "NotStarted" {
		t.Fatal("failed startup left a misleading network state", status, err)
	}
}

type localBackend struct{ target string }

func (b localBackend) Listen(_, _ string) (net.Listener, error) {
	return net.Listen("tcp4", "127.0.0.1:0")
}
func (b localBackend) Dial(ctx context.Context, _, _ string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "tcp4", b.target)
}

func TestOpaqueProxyRoundTripAndRevocation(t *testing.T) {
	echo, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	backend := localBackend{target: echo.Addr().String()}
	port := echo.Addr().(*net.TCPAddr).Port
	for _, create := range []func() (*proxy, error){
		func() (*proxy, error) { return dialProxy(backend, "100.100.1.2", 3211) },
		func() (*proxy, error) { return listenProxy(backend, 3211, port) },
	} {
		p, err := create()
		if err != nil {
			t.Fatal(err)
		}
		connection, err := net.DialTimeout("tcp4", p.listener.Addr().String(), time.Second)
		if err != nil {
			p.Close()
			t.Fatal(err)
		}
		connection.SetDeadline(time.Now().Add(5 * time.Second))
		payload := bytes.Repeat([]byte("opaque encrypted frames\x00"), 500)
		if _, err := connection.Write(payload); err != nil {
			t.Fatal(err)
		}
		result := make([]byte, len(payload))
		if _, err := io.ReadFull(connection, result); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(payload, result) {
			t.Fatal("proxy changed data")
		}
		address := p.listener.Addr().String()
		p.Close()
		connection.Close()
		if c, err := net.DialTimeout("tcp4", address, time.Second); err == nil {
			c.Close()
			t.Fatal("revoked listener still open")
		}
	}
	if _, err := dialProxy(backend, "8.8.8.8", 443); err == nil {
		t.Fatal("public proxy target accepted")
	}
}

func TestStdioRPCIdleAndUnknownMethod(t *testing.T) {
	input, inputWriter := io.Pipe()
	output, outputWriter := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- Run(input, outputWriter); outputWriter.Close() }()
	encoder := json.NewEncoder(inputWriter)
	decoder := json.NewDecoder(output)
	for index, method := range []string{"init", "status", "invalid"} {
		params := any(map[string]string{})
		if method == "init" {
			params = Config{StateDir: t.TempDir(), Hostname: "bridge-rpc"}
		}
		if err := encoder.Encode(map[string]any{"id": index + 1, "method": method, "params": params}); err != nil {
			t.Fatal(err)
		}
		var response map[string]any
		if err := decoder.Decode(&response); err != nil {
			t.Fatal(err)
		}
		if method == "status" {
			state := response["result"].(map[string]any)
			if state["backendState"] != "NotStarted" {
				t.Fatal(state)
			}
		}
		if method == "invalid" && response["error"] == nil {
			t.Fatal("unknown method accepted")
		}
	}
	inputWriter.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
