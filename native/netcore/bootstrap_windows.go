//go:build windows

package netcore

import (
	"context"
	"errors"
	"math/bits"
	"net"
	"net/netip"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"tailscale.com/net/netmon"
	"tailscale.com/net/netns"
)

// ConfigureBootstrapNetwork is called only inside bridge-net, never inside the
// application/Claude process. Tailscale binds its sockets to the /0 underlay;
// the generated Clash profile installs /1 routes, preserving that /0 route.
// Resolve underlay names in this process, not through Windows Dnscache or TUN.
func ConfigureBootstrapNetwork() {
	netns.SetBindToInterfaceByRoute(func(string, ...any) {}, false)
	var sequence atomic.Uint32
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		iface, err := netmon.GetWindowsDefault(windows.AF_INET)
		if err != nil {
			return nil, err
		}
		if iface == nil || iface.FriendlyName() == "ClaudeBridgeTun" {
			return nil, errors.New("no physical default route available for network bootstrap")
		}
		var servers []string
		for dns := iface.FirstDNSServerAddress; dns != nil; dns = dns.Next {
			address, _ := netip.AddrFromSlice(dns.Address.IP())
			address = address.Unmap()
			if address.IsValid() && address.Is4() && !address.IsLoopback() && !netip.MustParsePrefix("198.18.0.0/15").Contains(address) {
				servers = append(servers, net.JoinHostPort(address.String(), "53"))
			}
		}
		if len(servers) == 0 {
			servers = []string{"1.1.1.1:53", "9.9.9.9:53"}
		}
		server := servers[int(sequence.Add(1)-1)%len(servers)]
		dialer := &net.Dialer{Timeout: 5 * time.Second, Control: func(_, _ string, raw syscall.RawConn) error {
			var socketErr error
			err := raw.Control(func(fd uintptr) {
				socketErr = windows.SetsockoptInt(windows.Handle(fd), windows.IPPROTO_IP, 31, int(bits.ReverseBytes32(iface.IfIndex)))
			})
			if err != nil {
				return err
			}
			return socketErr
		}}
		if network == "udp" || network == "udp4" {
			return dialer.DialContext(ctx, "udp4", server)
		}
		return dialer.DialContext(ctx, "tcp4", server)
	}}
}
