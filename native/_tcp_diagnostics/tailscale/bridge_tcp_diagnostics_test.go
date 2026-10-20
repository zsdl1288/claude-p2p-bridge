package netstack

import (
	"testing"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/waiter"
)

func TestBridgeTCPEndpointsBoundedInMemoryListeners(t *testing.T) {
	s := stack.New(stack.Options{NetworkProtocols: []stack.NetworkProtocolFactory{ipv4.NewProtocol}, TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol}})
	t.Cleanup(s.Destroy)
	ns := &Impl{ipstack: s}
	for port := 1000; port < 1003; port++ {
		var q waiter.Queue
		ep, err := s.NewEndpoint(tcp.ProtocolNumber, ipv4.ProtocolNumber, &q)
		if err != nil {
			t.Fatal(err)
		}
		if err := ep.Bind(tcpip.FullAddress{Port: uint16(port)}); err != nil {
			t.Fatal(err)
		}
		if err := ep.Listen(1); err != nil {
			t.Fatal(err)
		}
	}
	if got := ns.BridgeTCPEndpoints(2); len(got) != 2 {
		t.Fatalf("got %d endpoints, want cap 2", len(got))
	}
	if got := ns.BridgeTCPEndpoints(1000); len(got) != 3 {
		t.Fatalf("got %d endpoints, want 3", len(got))
	}
	if len(ns.BridgeTCPEndpoints(0)) != 0 || len((*Impl)(nil).BridgeTCPEndpoints(2)) != 0 {
		t.Fatal("inactive/disabled snapshot returned endpoints")
	}
}
