//go:build windows

package netcore

import (
	"net"
	"testing"

	"tailscale.com/net/dnscache"
)

func TestBootstrapControlDNSUsesPhysicalResolver(t *testing.T) {
	cache := dnscache.Get()
	originalDefault, originalForward := net.DefaultResolver, cache.Forward
	t.Cleanup(func() {
		net.DefaultResolver, cache.Forward = originalDefault, originalForward
	})
	// Before configuration these are independent resolvers. Leaving Forward
	// unchanged would let control DNS retain Windows/TUN fake-IP resolution.
	oldWindowsResolver := &net.Resolver{}
	net.DefaultResolver = &net.Resolver{}
	cache.Forward = oldWindowsResolver
	ConfigureBootstrapNetwork()
	if net.DefaultResolver.Dial == nil || !net.DefaultResolver.PreferGo {
		t.Fatal("bootstrap resolver must use its interface-bound Go DNS dialer")
	}
	if cache.Forward != net.DefaultResolver || cache.Forward == oldWindowsResolver {
		t.Fatal("Tailscale DNS retained a separate Windows resolver")
	}
	// control/controlhttp.Dialer.resolver copies this singleton Forward.
	// It must inherit the exact configured resolver, not construct a new one.
	control := &dnscache.Resolver{Forward: dnscache.Get().Forward}
	if control.Forward != net.DefaultResolver {
		t.Fatal("control HTTP DNS did not inherit the physical bootstrap resolver")
	}
}
