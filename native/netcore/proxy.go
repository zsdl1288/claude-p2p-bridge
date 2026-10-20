package netcore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"time"
)

var tailnetRange = netip.MustParsePrefix("100.64.0.0/10")

func ValidPeer(host string, port int) bool {
	address, err := netip.ParseAddr(host)
	return err == nil && tailnetRange.Contains(address) && port > 0 && port <= 65535
}

type networkBackend interface {
	Listen(string, string) (net.Listener, error)
	Dial(context.Context, string, string) (net.Conn, error)
}

type proxy struct {
	listener    net.Listener
	ctx         context.Context
	cancel      context.CancelFunc
	mu          sync.Mutex
	connections map[net.Conn]bool
	clients     int
	closed      bool
}

func newProxy(listener net.Listener, dial func(context.Context) (net.Conn, error), limits ...int) *proxy {
	limit := 16
	// Only an explicit zero opts a data transport out of admission limits.
	// Omitted or invalid limits retain the default for other callers.
	if len(limits) > 0 && limits[0] >= 0 && limits[0] <= 4096 {
		limit = limits[0]
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &proxy{listener: listener, ctx: ctx, cancel: cancel, connections: make(map[net.Conn]bool)}
	go func() {
		for {
			incoming, err := listener.Accept()
			if err != nil {
				return
			}
			p.mu.Lock()
			// Each client owns two sockets after dialing. Count accepted clients,
			// while keeping both sockets in connections so revocation closes both.
			if p.closed || (limit > 0 && p.clients >= limit) {
				p.mu.Unlock()
				incoming.Close()
				continue
			}
			p.connections[incoming] = true
			p.clients++
			p.mu.Unlock()
			go p.pipe(incoming, dial)
		}
	}()
	return p
}

func (p *proxy) pipe(incoming net.Conn, dial func(context.Context) (net.Conn, error)) {
	defer func() {
		incoming.Close()
		p.mu.Lock()
		delete(p.connections, incoming)
		p.clients--
		p.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(p.ctx, 12*time.Second)
	defer cancel()
	outgoing, err := dial(ctx)
	if err != nil {
		return
	}
	defer outgoing.Close()
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.connections[outgoing] = true
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.connections, outgoing); p.mu.Unlock() }()
	// EOF only ends one direction. In particular, a peer may wait for the
	// request's FIN before it sends a response, so keep the return path alive.
	done := make(chan error, 2)
	copyDirection := func(dst, src net.Conn) {
		_, err := io.Copy(dst, src)
		if err == nil {
			if half, ok := dst.(interface{ CloseWrite() error }); ok {
				err = half.CloseWrite()
			} else {
				// A full close is the only way to propagate EOF on this backend.
				err = dst.Close()
			}
		}
		done <- err
	}
	go copyDirection(outgoing, incoming)
	go copyDirection(incoming, outgoing)
	if err := <-done; err != nil {
		incoming.Close()
		outgoing.Close()
	}
	<-done
}

func (p *proxy) Close() {
	p.cancel()
	p.mu.Lock()
	p.closed = true
	for connection := range p.connections {
		connection.Close()
	}
	p.mu.Unlock()
	p.listener.Close()
}

func resourceID() string {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(data[:])
}

func listenProxy(backend networkBackend, port, targetPort int, limits ...int) (*proxy, error) {
	if port < 1 || port > 65535 || targetPort < 1 || targetPort > 65535 {
		return nil, errors.New("invalid bridge port")
	}
	listener, err := backend.Listen("tcp", ":"+strconv.Itoa(port))
	if err != nil {
		return nil, err
	}
	return newProxy(listener, func(ctx context.Context) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(targetPort)))
	}, limits...), nil
}

func dialProxy(backend networkBackend, host string, port int, limits ...int) (*proxy, error) {
	if !ValidPeer(host, port) {
		return nil, errors.New("only literal Tailscale IPv4 peers are allowed")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	return newProxy(listener, func(ctx context.Context) (net.Conn, error) {
		return backend.Dial(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	}, limits...), nil
}
