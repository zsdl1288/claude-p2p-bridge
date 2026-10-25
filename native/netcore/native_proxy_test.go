package netcore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type nativeTestBackend struct{}

func (nativeTestBackend) Listen(network, address string) (net.Listener, error) {
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	return net.Listen("tcp4", net.JoinHostPort("127.0.0.1", port))
}
func (nativeTestBackend) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, network, address)
}
func (nativeTestBackend) ListenPacket(network, address string) (net.PacketConn, error) {
	return net.ListenPacket(network, address)
}
func (nativeTestBackend) TailscaleIPs() (netip.Addr, netip.Addr) {
	return netip.MustParseAddr("127.0.0.1"), netip.Addr{}
}

const nativeTestUser = "session-user-0123456789"
const nativeTestPassword = "session-password-0123456789abcdef"
const nativeTestLocalUser = "localhost-user-0123456789"
const nativeTestLocalPassword = "localhost-password-0123456789abcdef"

func nativeTestPair(t *testing.T, opts nativeProxyOptions) (*nativeProxy, *nativeProxy, NativeProxyConfig, NativeProxyConfig) {
	t.Helper()
	opts.allowLoopbackPeers = true
	opts.allowPrivateTargets = true
	b := newNativeProxy(nativeTestBackend{}, opts)
	a := newNativeProxy(nativeTestBackend{}, opts)
	t.Cleanup(a.close)
	t.Cleanup(b.close)
	bc := NativeProxyConfig{Epoch: 1, Role: "host", Enabled: true, Sessions: []NativeProxySession{{ID: "test-session", PeerIP: "127.0.0.1", Username: nativeTestUser, Password: nativeTestPassword}}}
	bs, err := b.configure(bc)
	if err != nil {
		t.Fatal(err)
	}
	ac := NativeProxyConfig{Epoch: 1, Role: "client", Enabled: true, Username: nativeTestLocalUser, Password: nativeTestLocalPassword, Remote: &NativeProxyRemote{Host: "127.0.0.1", Port: bs.Port, Username: nativeTestUser, Password: nativeTestPassword, Session: "test-session"}}
	if _, err = a.configure(ac); err != nil {
		t.Fatal(err)
	}
	return a, b, ac, bc
}
func nativeTestSOCKS(t *testing.T, port int, user, password string) net.Conn {
	t.Helper()
	c, err := net.DialTimeout("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	c.SetDeadline(time.Now().Add(3 * time.Second))
	t.Cleanup(func() { c.Close() })
	if err = nativeSendAuth(c, user, password); err != nil {
		t.Fatal(err)
	}
	return c
}
func nativeTestUDP(t *testing.T, address string) net.PacketConn {
	t.Helper()
	pc, err := net.ListenPacket("udp4", address)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	return pc
}
func nativeTestEchoUDP(t *testing.T) net.PacketConn {
	pc := nativeTestUDP(t, "127.0.0.1:0")
	go func() {
		buf := make([]byte, 65535)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			pc.WriteTo(buf[:n], addr)
		}
	}()
	return pc
}
func nativeTestConnect(t *testing.T, a *nativeProxy, target net.Addr) net.Conn {
	t.Helper()
	c := nativeTestSOCKS(t, a.status().Port, nativeTestLocalUser, nativeTestLocalPassword)
	host, port, _ := net.SplitHostPort(target.String())
	number, _ := strconv.Atoi(port)
	if err := nativeSendRequest(c, 1, host, number); err != nil {
		t.Fatal(err)
	}
	code, _, _, err := nativeReadReply(c)
	if err != nil || code != 0 {
		t.Fatalf("connect %d %v", code, err)
	}
	return c
}

func TestNativeProxyTCPHalfCloseEarlyDataAndCounters(t *testing.T) {
	a, b, _, _ := nativeTestPair(t, nativeProxyOptions{})
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	payload := bytes.Repeat([]byte("native-stream"), 20000)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		nativeWrite(c, []byte("hello"))
		received, _ := io.ReadAll(c)
		nativeWrite(c, received)
	}()
	c := nativeTestConnect(t, a, ln.Addr())
	greeting := make([]byte, 5)
	if _, err = io.ReadFull(c, greeting); err != nil || string(greeting) != "hello" {
		t.Fatal("early response", string(greeting), err)
	}
	if err = nativeWrite(c, payload); err != nil {
		t.Fatal(err)
	}
	if err = c.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	reply, err := io.ReadAll(c)
	if err != nil || !bytes.Equal(reply, payload) {
		t.Fatalf("half-close payload=%d err=%v", len(reply), err)
	}
	for _, p := range []*nativeProxy{a, b} {
		s := p.status()
		if s.UploadBytes != uint64(len(payload)) || s.DownloadBytes != uint64(len(payload)+5) {
			t.Fatalf("directional counters %+v", s)
		}
	}
}
func TestNativeProxyUDPRoundTripAndRevoke(t *testing.T) {
	a, b, _, bc := nativeTestPair(t, nativeProxyOptions{})
	echo := nativeTestEchoUDP(t)
	c := nativeTestSOCKS(t, a.status().Port, nativeTestLocalUser, nativeTestLocalPassword)
	if err := nativeSendRequest(c, 3, "0.0.0.0", 0); err != nil {
		t.Fatal(err)
	}
	code, host, port, err := nativeReadReply(c)
	if err != nil || code != 0 {
		t.Fatal(code, err)
	}
	pc := nativeTestUDP(t, "127.0.0.1:0")
	target, _ := nativeAddrPort(echo.LocalAddr())
	frame := nativeUDPFrame(target.Addr().String(), int(target.Port()), []byte("native datagram"))
	pc.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err = pc.WriteTo(frame, &net.UDPAddr{IP: net.ParseIP(host), Port: port}); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4096)
	n, _, err := pc.ReadFrom(buf)
	if err != nil {
		t.Fatal(err)
	}
	_, _, payload, ok := nativeDatagram(buf[:n])
	if !ok || string(payload) != "native datagram" {
		t.Fatal("UDP reply", payload)
	}
	bc.Epoch++
	bc.Sessions = nil
	if _, err = b.configure(bc); err != nil {
		t.Fatal(err)
	}
	c.SetReadDeadline(time.Now().Add(time.Second))
	if _, err = c.Read(buf); err == nil {
		t.Fatal("revoke left UDP control open")
	}
	if b.status().Connections != 0 {
		t.Fatal("revoked native flows remain active")
	}
	serialized, _ := json.Marshal(a.status())
	if strings.Contains(string(serialized), nativeTestPassword) || strings.Contains(string(serialized), nativeTestLocalPassword) {
		t.Fatal("status leaks credential")
	}
}
func TestNativeProxyRenewalKeepsTCPAndLeaseExpires(t *testing.T) {
	a, b, ac, bc := nativeTestPair(t, nativeProxyOptions{lease: 500 * time.Millisecond})
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		io.Copy(c, c)
	}()
	c := nativeTestConnect(t, a, ln.Addr())
	ac.Epoch++
	bc.Epoch++
	if _, err = a.configure(ac); err != nil {
		t.Fatal(err)
	}
	if _, err = b.configure(bc); err != nil {
		t.Fatal(err)
	}
	if err = nativeWrite(c, []byte("kept")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err = io.ReadFull(c, buf); err != nil || string(buf) != "kept" {
		t.Fatal("renewal closed flow", err)
	}
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err = c.Read(buf); err == nil {
		t.Fatal("expired lease left flow open")
	}
	if a.status().Enabled && b.status().Enabled {
		t.Fatal("lease still enabled")
	}
}
func TestNativeProxyNativeTicketAndSourceBinding(t *testing.T) {
	_, b, _, _ := nativeTestPair(t, nativeProxyOptions{})
	echo := nativeTestEchoUDP(t)
	source := nativeTestUDP(t, "127.0.0.1:0")
	sourceAP, _ := nativeAddrPort(source.LocalAddr())
	c := nativeTestSOCKS(t, b.status().Port, nativeTestUser, nativeTestPassword)
	nativeSendRequest(c, 3, "127.0.0.1", int(sourceAP.Port()))
	code, host, port, err := nativeReadReply(c)
	if err != nil || code != 0 {
		t.Fatal(code, err)
	}
	ticket := make([]byte, nativeTicketBytes)
	if _, err = io.ReadFull(c, ticket); err != nil {
		t.Fatal(err)
	}
	dest := &net.UDPAddr{IP: net.ParseIP(host), Port: port}
	target, _ := nativeAddrPort(echo.LocalAddr())
	frame := nativeUDPFrame(target.Addr().String(), int(target.Port()), []byte("allowed"))
	packet := append(append([]byte(nil), ticket...), frame...)
	bad := append([]byte(nil), packet...)
	bad[0] ^= 1
	source.WriteTo(bad, dest)
	source.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	buf := make([]byte, 4096)
	if _, _, err = source.ReadFrom(buf); err == nil {
		t.Fatal("bad ticket forwarded")
	}
	other := nativeTestUDP(t, "127.0.0.1:0")
	other.WriteTo(packet, dest)
	other.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	if _, _, err = other.ReadFrom(buf); err == nil {
		t.Fatal("wrong source forwarded")
	}
	fragment := append([]byte(nil), packet...)
	fragment[nativeTicketBytes+2] = 1
	source.WriteTo(fragment, dest)
	source.WriteTo(packet, dest)
	source.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _, err := source.ReadFrom(buf)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf[:nativeTicketBytes], ticket) {
		t.Fatal("response ticket")
	}
	_, _, payload, ok := nativeDatagram(buf[nativeTicketBytes:n])
	if !ok || string(payload) != "allowed" {
		t.Fatal("native response", string(payload))
	}
}
func TestNativeProxyPublicAddressAndDNSRebindingPolicy(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.0.0.1", "100.64.0.1", "192.168.1.1", "169.254.169.254", "198.18.0.1", "::1", "::ffff:8.8.8.8", "2001:db8::1", "2002:0808:0808::1", "2001::1"} {
		if nativePublicAddress(netip.MustParseAddr(ip)) {
			t.Fatal("special address accepted", ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if !nativePublicAddress(netip.MustParseAddr(ip)) {
			t.Fatal("public address denied", ip)
		}
	}
	p := newNativeProxy(nativeTestBackend{}, nativeProxyOptions{lookup: func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("127.0.0.1")}, nil
	}})
	defer p.close()
	if _, err := p.destination(context.Background(), "mixed.example", 443); err == nil {
		t.Fatal("mixed DNS answer accepted")
	}
}
func TestNativeProxyManagerEpochAndOfflineListener(t *testing.T) {
	m := &Manager{nativeBackend: nativeTestBackend{}, nativeOptions: nativeProxyOptions{allowLoopbackPeers: true}, resources: map[string]*proxy{}}
	defer m.Close()
	c := NativeProxyConfig{Epoch: 1, Role: "client", Username: nativeTestLocalUser, Password: nativeTestLocalPassword}
	s, err := m.NativeProxyConfigure(context.Background(), c)
	if err != nil || !s.Listening || s.Enabled || m.started {
		t.Fatal("offline bind", s, err)
	}
	if _, err = m.NativeProxyClose(3); err != nil {
		t.Fatal(err)
	}
	c.Epoch = 2
	if _, err = m.NativeProxyConfigure(context.Background(), c); err == nil {
		t.Fatal("stale configure reopened closed proxy")
	}
	if m.NativeProxyStatus().Listening {
		t.Fatal("closed listener revived")
	}
	c.Epoch = 4
	if _, err = m.NativeProxyConfigure(context.Background(), c); err != nil {
		t.Fatal(err)
	}
}
func TestNativeProxyRevokeCancelsDestinationDial(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	var once atomic.Bool
	a, b, _, bc := nativeTestPair(t, nativeProxyOptions{dial: func(ctx context.Context, network, address string) (net.Conn, error) {
		if once.CompareAndSwap(false, true) {
			close(started)
		}
		<-ctx.Done()
		close(cancelled)
		return nil, ctx.Err()
	}})
	c := nativeTestSOCKS(t, a.status().Port, nativeTestLocalUser, nativeTestLocalPassword)
	nativeSendRequest(c, 1, "127.0.0.1", 12345)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("dial not started")
	}
	bc.Epoch++
	bc.Enabled = false
	b.configure(bc)
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("revoke did not cancel pending dial")
	}
}
func TestNativeProxySlowUDPDNSDoesNotBlockEstablishedTarget(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var entered atomic.Bool
	a, _, _, _ := nativeTestPair(t, nativeProxyOptions{lookup: func(ctx context.Context, host string) ([]netip.Addr, error) {
		if entered.CompareAndSwap(false, true) {
			close(started)
		}
		select {
		case <-release:
			return nil, errors.New("test failure")
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}})
	defer close(release)
	echo := nativeTestEchoUDP(t)
	c := nativeTestSOCKS(t, a.status().Port, nativeTestLocalUser, nativeTestLocalPassword)
	nativeSendRequest(c, 3, "0.0.0.0", 0)
	code, host, port, err := nativeReadReply(c)
	if err != nil || code != 0 {
		t.Fatal(code, err)
	}
	pc := nativeTestUDP(t, "127.0.0.1:0")
	relay := &net.UDPAddr{IP: net.ParseIP(host), Port: port}
	target, _ := nativeAddrPort(echo.LocalAddr())
	good := nativeUDPFrame(target.Addr().String(), int(target.Port()), []byte("fast"))
	buf := make([]byte, 1000)
	pc.SetDeadline(time.Now().Add(2 * time.Second))
	pc.WriteTo(good, relay)
	if _, _, err = pc.ReadFrom(buf); err != nil {
		t.Fatal(err)
	}
	pc.WriteTo(nativeUDPFrame("slow.example", 12345, []byte("slow")), relay)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("DNS not started")
	}
	pc.SetDeadline(time.Now().Add(500 * time.Millisecond))
	pc.WriteTo(good, relay)
	if _, _, err = pc.ReadFrom(buf); err != nil {
		t.Fatal("slow DNS blocked established UDP", err)
	}
}

func TestNativeProxyInvalidDatagramsCannotKeepAssociationAlive(t *testing.T) {
	_, b, _, _ := nativeTestPair(t, nativeProxyOptions{udpIdle: 150 * time.Millisecond})
	source := nativeTestUDP(t, "127.0.0.1:0")
	sourceAP, _ := nativeAddrPort(source.LocalAddr())
	c := nativeTestSOCKS(t, b.status().Port, nativeTestUser, nativeTestPassword)
	nativeSendRequest(c, 3, "127.0.0.1", int(sourceAP.Port()))
	code, host, port, err := nativeReadReply(c)
	if err != nil || code != 0 {
		t.Fatal(code, err)
	}
	ticket := make([]byte, nativeTicketBytes)
	if _, err = io.ReadFull(c, ticket); err != nil {
		t.Fatal(err)
	}
	packet := append(ticket, nativeUDPFrame("127.0.0.1", 12345, []byte("invalid"))...)
	packet[0] ^= 1
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				source.WriteTo(packet, &net.UDPAddr{IP: net.ParseIP(host), Port: port})
			}
		}
	}()
	c.SetReadDeadline(time.Now().Add(time.Second))
	var buf [1]byte
	if _, err = c.Read(buf[:]); err == nil {
		t.Fatal("invalid datagrams kept association alive")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("invalid traffic prevented idle expiry")
	}
}

func TestNativeProxyRenewalPreservesPendingAuthentication(t *testing.T) {
	a, _, ac, _ := nativeTestPair(t, nativeProxyOptions{})
	c, err := net.DialTimeout("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(a.status().Port)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(time.Second))
	nativeWrite(c, []byte{5, 1, 2})
	var selected [2]byte
	if _, err = io.ReadFull(c, selected[:]); err != nil {
		t.Fatal(err)
	}
	ac.Epoch++
	if _, err = a.configure(ac); err != nil {
		t.Fatal(err)
	}
	packet := append([]byte{1, byte(len(nativeTestLocalUser))}, []byte(nativeTestLocalUser)...)
	packet = append(packet, byte(len(nativeTestLocalPassword)))
	packet = append(packet, []byte(nativeTestLocalPassword)...)
	if err = nativeWrite(c, packet); err != nil {
		t.Fatal(err)
	}
	if _, err = io.ReadFull(c, selected[:]); err != nil || selected != [2]byte{1, 0} {
		t.Fatal("renewal killed pending auth", selected, err)
	}
}

func TestNativeProxyHostRejectsWrongCredentialsAndPeer(t *testing.T) {
	_, b, _, bc := nativeTestPair(t, nativeProxyOptions{})
	for _, mode := range []string{"password", "peer"} {
		t.Run(mode, func(t *testing.T) {
			password := nativeTestPassword
			if mode == "password" {
				password += "wrong"
			} else {
				bc.Epoch++
				bc.Sessions[0].PeerIP = "127.0.0.2"
				if _, err := b.configure(bc); err != nil {
					t.Fatal(err)
				}
			}
			c, err := net.DialTimeout("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(b.status().Port)), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			c.SetDeadline(time.Now().Add(time.Second))
			if nativeSendAuth(c, nativeTestUser, password) == nil {
				t.Fatal("unauthorized source authenticated")
			}
		})
	}
}
