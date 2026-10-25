package netcore

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"io"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

const nativeTicketBytes = 32
const nativeMaxDatagram = 65507

func nativeDatagram(packet []byte) (string, int, []byte, bool) {
	if len(packet) < 4 || packet[0] != 0 || packet[1] != 0 || packet[2] != 0 {
		return "", 0, nil, false
	}
	r := bytes.NewReader(packet[3:])
	host, port, err := nativeReadAddress(r)
	if err != nil || port == 0 {
		return "", 0, nil, false
	}
	return host, port, packet[len(packet)-r.Len():], true
}
func nativeUDPFrame(host string, port int, payload []byte) []byte {
	address, err := nativeAddress(host, port)
	if err != nil || 3+len(address)+len(payload)+nativeTicketBytes > nativeMaxDatagram {
		return nil
	}
	packet := make([]byte, 0, 3+len(address)+len(payload))
	packet = append(packet, 0, 0, 0)
	packet = append(packet, address...)
	return append(packet, payload...)
}
func nativeAddrPort(address net.Addr) (netip.AddrPort, bool) {
	host, port, err := net.SplitHostPort(address.String())
	if err != nil {
		return netip.AddrPort{}, false
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.AddrPort{}, false
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return netip.AddrPort{}, false
	}
	return netip.AddrPortFrom(a.Unmap(), uint16(p)), true
}
func nativeUDPAddr(ap netip.AddrPort) *net.UDPAddr { return net.UDPAddrFromAddrPort(ap) }
func nativeWatchControl(f *nativeFlow, c net.Conn) { var b [1]byte; c.Read(b[:]); f.close() }
func nativeActive(last *atomic.Int64, idle time.Duration) bool {
	return time.Since(time.Unix(0, last.Load())) < idle
}

// The authenticated TCP request declares the already-bound A native UDP port.
// The random ticket and exact source endpoint are both checked before parsing
// a destination, doing DNS, or allocating any outgoing socket.
func (p *nativeProxy) hostUDP(f *nativeFlow, c net.Conn, sourceHost string, sourcePort int) {
	peer, ok := nativeAddrPort(c.RemoteAddr())
	declared, err := netip.ParseAddr(sourceHost)
	if !ok || err != nil || declared != peer.Addr() || sourcePort < 1 || sourcePort > 65535 {
		nativeReply(c, 2, "0.0.0.0", 0)
		return
	}
	expected := netip.AddrPortFrom(declared, uint16(sourcePort))
	ip, _ := p.backend.TailscaleIPs()
	if !ip.Is4() {
		nativeReply(c, 1, "0.0.0.0", 0)
		return
	}
	packets, err := p.backend.ListenPacket("udp4", net.JoinHostPort(ip.String(), "0"))
	if err != nil {
		nativeReply(c, 1, "0.0.0.0", 0)
		return
	}
	if !f.add(packets) {
		return
	}
	bound, ok := nativeAddrPort(packets.LocalAddr())
	if !ok {
		return
	}
	var ticket [nativeTicketBytes]byte
	if _, err = rand.Read(ticket[:]); err != nil {
		return
	}
	if nativeReply(c, 0, ip.String(), int(bound.Port())) != nil || nativeWrite(c, ticket[:]) != nil {
		return
	}
	c.SetDeadline(time.Time{})
	go nativeWatchControl(f, c)
	var last atomic.Int64
	last.Store(time.Now().UnixNano())
	type target struct {
		connection net.Conn
		address    netip.AddrPort
		last       atomic.Int64
	}
	var mu sync.Mutex
	targets := map[string]*target{}
	pending := map[string]bool{}
	var writers sync.Mutex // packet writes must not share borrowed receive buffers
	send := func(t *target, payload []byte) {
		if f.dead.Load() {
			return
		}
		t.connection.SetWriteDeadline(time.Now().Add(nativeHandshake))
		written, err := t.connection.Write(payload)
		if err != nil {
			t.connection.Close()
			return
		}
		f.count(written, true)
		now := time.Now().UnixNano()
		t.last.Store(now)
		last.Store(now)
	}
	create := func(key, host string, port int, payload []byte) {
		defer func() { mu.Lock(); delete(pending, key); mu.Unlock() }()
		ctx, cancel := context.WithTimeout(f.ctx, nativeHandshake)
		address, resolveErr := p.destination(ctx, host, port)
		if resolveErr != nil {
			cancel()
			return
		}
		out, dialErr := p.opts.dial(ctx, "udp", address.String())
		cancel()
		if dialErr != nil {
			return
		}
		if !f.add(out) {
			return
		}
		t := &target{connection: out, address: address}
		t.last.Store(time.Now().UnixNano())
		mu.Lock()
		if len(targets) >= 128 || f.dead.Load() {
			mu.Unlock()
			f.remove(out)
			return
		}
		targets[key] = t
		mu.Unlock()
		go func(key string, t *target) {
			defer f.remove(t.connection)
			defer func() {
				mu.Lock()
				if targets[key] == t {
					delete(targets, key)
				}
				mu.Unlock()
			}()
			response := make([]byte, nativeMaxDatagram+1)
			for !f.dead.Load() && nativeActive(&t.last, p.opts.udpIdle) {
				t.connection.SetReadDeadline(time.Now().Add(time.Second))
				n, err := t.connection.Read(response)
				if err != nil {
					if timeout, ok := err.(net.Error); ok && timeout.Timeout() && nativeActive(&t.last, p.opts.udpIdle) {
						continue
					}
					return
				}
				frame := nativeUDPFrame(t.address.Addr().String(), int(t.address.Port()), response[:n])
				if frame == nil {
					continue
				}
				packet := append(append([]byte(nil), ticket[:]...), frame...)
				writers.Lock()
				packets.SetWriteDeadline(time.Now().Add(nativeHandshake))
				_, err = packets.WriteTo(packet, nativeUDPAddr(expected))
				writers.Unlock()
				if err != nil {
					return
				}
				f.count(n, false)
				now := time.Now().UnixNano()
				last.Store(now)
				t.last.Store(now)
			}
		}(key, t)
		send(t, payload)
	}
	buffer := make([]byte, nativeMaxDatagram+1)
	for !f.dead.Load() && nativeActive(&last, p.opts.udpIdle) {
		packets.SetReadDeadline(time.Now().Add(time.Second))
		n, from, readErr := packets.ReadFrom(buffer)
		if readErr != nil {
			if timeout, ok := readErr.(net.Error); ok && timeout.Timeout() && nativeActive(&last, p.opts.udpIdle) {
				continue
			}
			return
		}
		if !nativeActive(&last, p.opts.udpIdle) {
			return
		}
		actual, ok := nativeAddrPort(from)
		if !ok || actual != expected || n > nativeMaxDatagram || n < nativeTicketBytes+4 || subtle.ConstantTimeCompare(buffer[:nativeTicketBytes], ticket[:]) != 1 {
			continue
		}
		host, port, payload, ok := nativeDatagram(buffer[nativeTicketBytes:n])
		if !ok {
			continue
		}
		key := net.JoinHostPort(host, strconv.Itoa(port))
		mu.Lock()
		t := targets[key]
		if t != nil {
			mu.Unlock()
			send(t, payload)
			continue
		}
		// Bound asynchronous DNS/dial work and drop duplicate first packets.
		// Established targets remain usable while a new destination is slow.
		if pending[key] || len(pending) >= 32 || len(targets) >= 128 {
			mu.Unlock()
			continue
		}
		pending[key] = true
		mu.Unlock()
		go create(key, host, port, append([]byte(nil), payload...))
	}
}

func (p *nativeProxy) clientUDP(f *nativeFlow, local, remote net.Conn, sourceHost string, sourcePort int, server NativeProxyRemote) {
	controlSource, ok := nativeAddrPort(local.RemoteAddr())
	requested, err := netip.ParseAddr(sourceHost)
	if !ok || err != nil || !(requested.IsUnspecified() || requested.Unmap() == controlSource.Addr()) || sourcePort < 0 || sourcePort > 65535 {
		nativeReply(local, 2, "0.0.0.0", 0)
		return
	}
	localPackets, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		nativeReply(local, 1, "0.0.0.0", 0)
		return
	}
	if !f.add(localPackets) {
		return
	}
	ip, _ := p.backend.TailscaleIPs()
	if !ip.Is4() {
		nativeReply(local, 1, "0.0.0.0", 0)
		return
	}
	privatePackets, err := p.backend.ListenPacket("udp4", net.JoinHostPort(ip.String(), "0"))
	if err != nil {
		nativeReply(local, 1, "0.0.0.0", 0)
		return
	}
	if !f.add(privatePackets) {
		return
	}
	privateSource, ok := nativeAddrPort(privatePackets.LocalAddr())
	if !ok {
		return
	}
	if nativeSendRequest(remote, 3, ip.String(), int(privateSource.Port())) != nil {
		nativeReply(local, 1, "0.0.0.0", 0)
		return
	}
	code, remoteHost, remotePort, err := nativeReadReply(remote)
	if err != nil || code != 0 {
		nativeReply(local, 1, "0.0.0.0", 0)
		return
	}
	remoteIP, err := netip.ParseAddr(remoteHost)
	expectedIP, _ := netip.ParseAddr(server.Host)
	if err != nil || remoteIP != expectedIP || remotePort < 1 || remotePort > 65535 {
		nativeReply(local, 1, "0.0.0.0", 0)
		return
	}
	expected := netip.AddrPortFrom(remoteIP, uint16(remotePort))
	var ticket [nativeTicketBytes]byte
	if _, err = io.ReadFull(remote, ticket[:]); err != nil {
		nativeReply(local, 1, "0.0.0.0", 0)
		return
	}
	bound, ok := nativeAddrPort(localPackets.LocalAddr())
	if !ok {
		return
	}
	if nativeReply(local, 0, "127.0.0.1", int(bound.Port())) != nil {
		return
	}
	local.SetDeadline(time.Time{})
	remote.SetDeadline(time.Time{})
	go nativeWatchControl(f, local)
	go nativeWatchControl(f, remote)
	var last atomic.Int64
	last.Store(time.Now().UnixNano())
	var sourceMu sync.Mutex
	var source netip.AddrPort
	if sourcePort != 0 {
		source = netip.AddrPortFrom(controlSource.Addr(), uint16(sourcePort))
	}
	go func() {
		defer f.close()
		buf := make([]byte, nativeMaxDatagram+1)
		for !f.dead.Load() && nativeActive(&last, p.opts.udpIdle) {
			privatePackets.SetReadDeadline(time.Now().Add(time.Second))
			n, from, err := privatePackets.ReadFrom(buf)
			if err != nil {
				if timeout, ok := err.(net.Error); ok && timeout.Timeout() && nativeActive(&last, p.opts.udpIdle) {
					continue
				}
				return
			}
			actual, ok := nativeAddrPort(from)
			if !nativeActive(&last, p.opts.udpIdle) {
				return
			}
			if !ok || actual != expected || n > nativeMaxDatagram || n < nativeTicketBytes+4 || subtle.ConstantTimeCompare(buf[:nativeTicketBytes], ticket[:]) != 1 {
				continue
			}
			_, _, payload, ok := nativeDatagram(buf[nativeTicketBytes:n])
			if !ok {
				continue
			}
			sourceMu.Lock()
			destination := source
			sourceMu.Unlock()
			if !destination.IsValid() {
				continue
			}
			localPackets.SetWriteDeadline(time.Now().Add(nativeHandshake))
			if _, err = localPackets.WriteTo(buf[nativeTicketBytes:n], nativeUDPAddr(destination)); err != nil {
				return
			}
			f.count(len(payload), false)
			last.Store(time.Now().UnixNano())
		}
	}()
	buf := make([]byte, nativeMaxDatagram+1)
	for !f.dead.Load() && nativeActive(&last, p.opts.udpIdle) {
		localPackets.SetReadDeadline(time.Now().Add(time.Second))
		n, from, err := localPackets.ReadFrom(buf)
		if err != nil {
			if timeout, ok := err.(net.Error); ok && timeout.Timeout() && nativeActive(&last, p.opts.udpIdle) {
				continue
			}
			return
		}
		actual, ok := nativeAddrPort(from)
		if !nativeActive(&last, p.opts.udpIdle) {
			return
		}
		if !ok || actual.Addr() != controlSource.Addr() || n+nativeTicketBytes > nativeMaxDatagram {
			continue
		}
		_, _, payload, ok := nativeDatagram(buf[:n])
		if !ok {
			continue
		}
		sourceMu.Lock()
		if !source.IsValid() {
			source = actual
		}
		allowed := source == actual
		sourceMu.Unlock()
		if !allowed {
			continue
		}
		packet := append(append([]byte(nil), ticket[:]...), buf[:n]...)
		privatePackets.SetWriteDeadline(time.Now().Add(nativeHandshake))
		if _, err = privatePackets.WriteTo(packet, nativeUDPAddr(expected)); err != nil {
			return
		}
		f.count(len(payload), true)
		last.Store(time.Now().UnixNano())
	}
}
