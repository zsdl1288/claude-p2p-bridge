package netcore

// This process fixture exists only in the Go test binary. It exercises the
// production RPC and native proxy with OS loopback sockets, without logging in
// to Tailscale, changing routes, or weakening the shipping helper's policy.
import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"os"
	"testing"
)

type smokeNativeBackend struct{}

func (smokeNativeBackend) Listen(network, address string) (net.Listener, error) {
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	return net.Listen(network, net.JoinHostPort("127.0.0.1", port))
}
func (smokeNativeBackend) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil || host != "127.0.0.1" {
		return nil, fmt.Errorf("fixture rejects non-loopback dial")
	}
	return (&net.Dialer{}).DialContext(ctx, network, address)
}
func (smokeNativeBackend) ListenPacket(network, address string) (net.PacketConn, error) {
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	return net.ListenPacket(network, net.JoinHostPort("127.0.0.1", port))
}
func (smokeNativeBackend) TailscaleIPs() (netip.Addr, netip.Addr) {
	return netip.MustParseAddr("127.0.0.1"), netip.Addr{}
}

func TestNativeProxyRPCFixture(t *testing.T) {
	if os.Getenv("BRIDGE_NATIVE_RPC_FIXTURE") != "1" {
		t.Skip("private subprocess fixture")
	}
	err := runWithManagerFactory(os.Stdin, os.Stdout, func(config Config) (*Manager, error) {
		return &Manager{config: config, resources: make(map[string]*proxy),
			nativeBackend: smokeNativeBackend{}, nativeReady: true,
			nativeOptions: nativeProxyOptions{allowLoopbackPeers: true, allowPrivateTargets: true}}, nil
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// Keep test runner status text out of the private JSON-lines protocol.
	os.Exit(0)
}
