package netcore

// Native proxy data plane. Configuration and per-session authorization arrive
// exclusively over the owner's private stdio RPC. TCP remains a byte stream;
// UDP travels as datagrams on tsnet, never inside the control WebSocket.

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"io"
	"net"
	"net/netip"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const nativeLease = 30 * time.Second
const nativeHandshake = 10 * time.Second
const nativeUDPIdle = 60 * time.Second
const nativeWriteTimeout = 120 * time.Second

type NativeProxySession struct {
	ID       string `json:"id"`
	PeerIP   string `json:"peerIP"`
	Username string `json:"username"`
	Password string `json:"password"`
}
type NativeProxyRemote struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	Session  string `json:"session"`
}
type NativeProxyConfig struct {
	Epoch    uint64               `json:"epoch"`
	Role     string               `json:"role"`
	Enabled  bool                 `json:"enabled"`
	Port     int                  `json:"port"`
	Username string               `json:"username"`
	Password string               `json:"password"`
	Sessions []NativeProxySession `json:"sessions"`
	Remote   *NativeProxyRemote   `json:"remote,omitempty"`
}
type NativeProxySessionStatus struct {
	ID            string `json:"id"`
	Connections   int    `json:"connections"`
	UploadBytes   uint64 `json:"uploadBytes"`
	DownloadBytes uint64 `json:"downloadBytes"`
}
type NativeProxyStatus struct {
	Epoch         uint64                     `json:"epoch"`
	Role          string                     `json:"role"`
	Enabled       bool                       `json:"enabled"`
	Listening     bool                       `json:"listening"`
	Port          int                        `json:"port"`
	Connections   int                        `json:"connections"`
	UploadBytes   uint64                     `json:"uploadBytes"`
	DownloadBytes uint64                     `json:"downloadBytes"`
	Sessions      []NativeProxySessionStatus `json:"sessions"`
}

type nativeProxyBackend interface {
	networkBackend
	ListenPacket(string, string) (net.PacketConn, error)
	TailscaleIPs() (netip.Addr, netip.Addr)
}

// Injection points have no RPC representation. Production never enables the
// loopback/private exceptions used by the local integration tests.
type nativeProxyOptions struct {
	// Only internal synthetic speed instances set this. It has no RPC field.
	destination         func(context.Context, string, int) (netip.AddrPort, error)
	maxFlows            int // internal synthetic tests only; zero keeps normal unlimited active streams
	allowLoopbackPeers  bool
	allowPrivateTargets bool
	lookup              func(context.Context, string) ([]netip.Addr, error)
	dial                func(context.Context, string, string) (net.Conn, error)
	packet              func(string, string) (net.PacketConn, error)
	lease               time.Duration
	udpIdle             time.Duration
}
type nativeSession struct {
	auth NativeProxySession
	up   atomic.Uint64
	down atomic.Uint64
}
type nativeProxy struct {
	mu         sync.Mutex
	backend    nativeProxyBackend
	opts       nativeProxyOptions
	config     NativeProxyConfig
	enabled    bool
	listener   net.Listener
	port       int
	sessions   map[string]*nativeSession
	flows      map[*nativeFlow]bool
	pending    int
	closed     bool
	leaseUntil time.Time
	done       chan struct{}
	up         atomic.Uint64
	down       atomic.Uint64
}
type nativeFlow struct {
	p         *nativeProxy
	ctx       context.Context
	cancel    context.CancelFunc
	mu        sync.Mutex
	resources map[io.Closer]bool
	dead      atomic.Bool
	once      sync.Once
	session   *nativeSession // assigned under p.mu, immutable after authentication
	pending   bool           // guarded by p.mu
}

func nativeCredential(value string) bool {
	return len(value) >= 16 && len(value) <= 255 && !strings.ContainsRune(value, 0)
}
func nativeID(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}
func nativePeer(value string, allowLoopback bool) bool {
	a, err := netip.ParseAddr(value)
	return err == nil && a.Is4() && (tailnetRange.Contains(a) || allowLoopback && a.IsLoopback())
}
func validateNativeConfig(c NativeProxyConfig, allowLoopback bool) error {
	if c.Epoch == 0 || c.Epoch > 9007199254740991 || (c.Role != "host" && c.Role != "client") || c.Port < 0 || c.Port > 65535 {
		return errors.New("invalid native proxy configuration")
	}
	if c.Role == "host" {
		if c.Remote != nil || len(c.Sessions) > 16 {
			return errors.New("invalid native proxy sessions")
		}
		ids, users := map[string]bool{}, map[string]bool{}
		for _, s := range c.Sessions {
			if !nativeID(s.ID) || ids[s.ID] || users[s.Username] || !nativePeer(s.PeerIP, allowLoopback) || !nativeCredential(s.Username) || !nativeCredential(s.Password) {
				return errors.New("invalid native proxy authorization")
			}
			ids[s.ID], users[s.Username] = true, true
		}
	} else {
		if len(c.Sessions) != 0 || !nativeCredential(c.Username) || !nativeCredential(c.Password) {
			return errors.New("invalid localhost proxy credentials")
		}
		if r := c.Remote; r != nil && (!nativePeer(r.Host, allowLoopback) || r.Port < 1 || r.Port > 65535 || !nativeID(r.Session) || !nativeCredential(r.Username) || !nativeCredential(r.Password)) {
			return errors.New("invalid native proxy remote")
		}
	}
	return nil
}

func newNativeProxy(backend nativeProxyBackend, opts nativeProxyOptions) *nativeProxy {
	if opts.lookup == nil {
		opts.lookup = func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		}
	}
	if opts.dial == nil {
		opts.dial = (&net.Dialer{KeepAlive: 30 * time.Second}).DialContext
	}
	if opts.packet == nil {
		opts.packet = net.ListenPacket
	}
	if opts.lease == 0 {
		opts.lease = nativeLease
	}
	if opts.udpIdle == 0 {
		opts.udpIdle = nativeUDPIdle
	}
	p := &nativeProxy{backend: backend, opts: opts, sessions: map[string]*nativeSession{}, flows: map[*nativeFlow]bool{}, done: make(chan struct{})}
	go func() {
		timer := time.NewTicker(250 * time.Millisecond)
		defer timer.Stop()
		for {
			select {
			case <-p.done:
				return
			case now := <-timer.C:
				p.mu.Lock()
				var expired []*nativeFlow
				if p.enabled && now.After(p.leaseUntil) {
					p.enabled = false
					for f := range p.flows {
						expired = append(expired, f)
					}
				}
				p.mu.Unlock()
				for _, f := range expired {
					f.close()
				}
			}
		}
	}()
	return p
}

// Caller serializes configure/close. Replacing authorization synchronously
// closes affected sockets before acknowledging; unchanged sessions keep flows.
func (p *nativeProxy) configure(c NativeProxyConfig) (NativeProxyStatus, error) {
	if err := validateNativeConfig(c, p.opts.allowLoopbackPeers); err != nil {
		return NativeProxyStatus{}, err
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return NativeProxyStatus{}, errors.New("native proxy closed")
	}
	old := p.config
	rebind := p.listener == nil || old.Role != c.Role || c.Port != 0 && c.Port != p.port
	oldListener := p.listener
	var retire []*nativeFlow
	if rebind {
		p.listener = nil
		p.port = 0
		for f := range p.flows {
			retire = append(retire, f)
		}
	}
	p.mu.Unlock()
	if rebind && oldListener != nil {
		oldListener.Close()
	}
	for _, f := range retire {
		f.close()
	}
	var listener net.Listener
	var err error
	if rebind {
		if c.Role == "client" {
			listener, err = net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port)))
		} else {
			if c.Port != 0 {
				listener, err = p.backend.Listen("tcp4", ":"+strconv.Itoa(c.Port))
			} else {
				// tsnet's virtual TCP listener does not allocate port zero.
				for i := 0; i < 32; i++ {
					var b [2]byte
					if _, err = rand.Read(b[:]); err != nil {
						break
					}
					port := 20000 + (int(b[0])<<8|int(b[1]))%40000
					listener, err = p.backend.Listen("tcp4", ":"+strconv.Itoa(port))
					if err == nil {
						break
					}
				}
			}
		}
		if err != nil {
			return NativeProxyStatus{}, errors.New("native proxy listener unavailable")
		}
	}
	c.Sessions = append([]NativeProxySession(nil), c.Sessions...)
	if c.Remote != nil {
		copy := *c.Remote
		c.Remote = &copy
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		if listener != nil {
			listener.Close()
		}
		return NativeProxyStatus{}, errors.New("native proxy closed")
	}
	sessions := map[string]*nativeSession{}
	if c.Role == "host" {
		for _, auth := range c.Sessions {
			s := p.sessions[auth.ID]
			if s == nil || s.auth != auth {
				s = &nativeSession{auth: auth}
			}
			sessions[auth.ID] = s
		}
	} else if r := c.Remote; r != nil {
		auth := NativeProxySession{ID: r.Session, PeerIP: r.Host, Username: r.Username, Password: r.Password}
		s := p.sessions[auth.ID]
		if s == nil || s.auth != auth || old.Username != c.Username || old.Password != c.Password || !reflect.DeepEqual(old.Remote, c.Remote) {
			s = &nativeSession{auth: auth}
		}
		sessions[auth.ID] = s
	}
	p.config = c
	p.sessions = sessions
	p.enabled = c.Enabled
	p.leaseUntil = time.Now().Add(p.opts.lease)
	if rebind {
		p.listener = listener
		_, port, _ := net.SplitHostPort(listener.Addr().String())
		p.port, _ = strconv.Atoi(port)
	}
	retire = nil
	for f := range p.flows {
		if !p.enabled || rebind || f.session != nil && sessions[f.session.auth.ID] != f.session {
			retire = append(retire, f)
		}
	}
	p.mu.Unlock()
	for _, f := range retire {
		f.close()
	}
	if rebind {
		go p.accept(listener, c.Role)
	}
	return p.status(), nil
}

func (p *nativeProxy) status() NativeProxyStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := NativeProxyStatus{Epoch: p.config.Epoch, Role: p.config.Role, Enabled: p.enabled, Listening: p.listener != nil && !p.closed, Port: p.port, UploadBytes: p.up.Load(), DownloadBytes: p.down.Load(), Sessions: []NativeProxySessionStatus{}}
	counts := map[*nativeSession]int{}
	for f := range p.flows {
		if !f.dead.Load() && f.session != nil {
			s.Connections++
			counts[f.session]++
		}
	}
	for _, session := range p.sessions {
		s.Sessions = append(s.Sessions, NativeProxySessionStatus{ID: session.auth.ID, Connections: counts[session], UploadBytes: session.up.Load(), DownloadBytes: session.down.Load()})
	}
	sort.Slice(s.Sessions, func(i, j int) bool { return s.Sessions[i].ID < s.Sessions[j].ID })
	return s
}
func (p *nativeProxy) close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	p.enabled = false
	close(p.done)
	ln := p.listener
	p.listener = nil
	flows := make([]*nativeFlow, 0, len(p.flows))
	for f := range p.flows {
		flows = append(flows, f)
	}
	p.mu.Unlock()
	if ln != nil {
		ln.Close()
	}
	for _, f := range flows {
		f.close()
	}
}
func (f *nativeFlow) add(resource io.Closer) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dead.Load() {
		resource.Close()
		return false
	}
	if f.resources == nil {
		f.resources = map[io.Closer]bool{}
	}
	f.resources[resource] = true
	return true
}
func (f *nativeFlow) remove(resource io.Closer) {
	f.mu.Lock()
	delete(f.resources, resource)
	f.mu.Unlock()
	resource.Close()
}
func (f *nativeFlow) close() {
	f.once.Do(func() {
		f.dead.Store(true)
		f.cancel()
		f.mu.Lock()
		resources := f.resources
		f.resources = nil
		f.mu.Unlock()
		for r := range resources {
			r.Close()
		}
	})
}
func (f *nativeFlow) count(n int, upload bool) {
	if n <= 0 {
		return
	}
	if upload {
		f.p.up.Add(uint64(n))
		f.session.up.Add(uint64(n))
	} else {
		f.p.down.Add(uint64(n))
		f.session.down.Add(uint64(n))
	}
}
func (p *nativeProxy) accept(ln net.Listener, role string) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		p.mu.Lock()
		if p.closed || p.listener != ln || !p.enabled || p.pending >= 128 || p.opts.maxFlows > 0 && len(p.flows) >= p.opts.maxFlows {
			p.mu.Unlock()
			c.Close()
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		f := &nativeFlow{p: p, ctx: ctx, cancel: cancel, pending: true}
		f.add(c)
		p.flows[f] = true
		p.pending++
		p.mu.Unlock()
		go func() {
			defer f.close()
			defer func() {
				p.mu.Lock()
				if f.pending {
					p.pending--
				}
				delete(p.flows, f)
				p.mu.Unlock()
			}()
			c.SetDeadline(time.Now().Add(nativeHandshake))
			if role == "host" {
				p.host(f, c)
			} else {
				p.client(f, c)
			}
		}()
	}
}
func (p *nativeProxy) authorize(f *nativeFlow, c net.Conn, username, password string, role string) *nativeSession {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || !p.enabled || f.dead.Load() || time.Now().After(p.leaseUntil) {
		return nil
	}
	var found *nativeSession
	if role == "host" {
		host, _, err := net.SplitHostPort(c.RemoteAddr().String())
		if err != nil {
			return nil
		}
		a, err := netip.ParseAddr(host)
		if err != nil {
			return nil
		}
		a = a.Unmap()
		for _, s := range p.sessions {
			if s.auth.PeerIP == a.String() && nativeEqual(s.auth.Username, username) && nativeEqual(s.auth.Password, password) {
				found = s
				break
			}
		}
	} else if nativeEqual(p.config.Username, username) && nativeEqual(p.config.Password, password) && p.config.Remote != nil {
		found = p.sessions[p.config.Remote.Session]
	}
	if found != nil {
		f.session = found
		if f.pending {
			p.pending--
			f.pending = false
		}
	}
	return found
}
func nativeEqual(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func nativePublicAddress(a netip.Addr) bool {
	if !a.IsValid() || a.Zone() != "" || a.Is4In6() {
		return false
	}
	if a.Is4() {
		b := a.As4()
		x, y, z := b[0], b[1], b[2]
		return !(x == 0 || x == 10 || x == 127 || x >= 224 || (x == 100 && y >= 64 && y <= 127) || (x == 169 && y == 254) || (x == 172 && y >= 16 && y <= 31) || (x == 192 && (y == 168 || (y == 0 && (z == 0 || z == 2)) || (y == 88 && z == 99))) || (x == 198 && (y == 18 || y == 19 || (y == 51 && z == 100))) || (x == 203 && y == 0 && z == 113))
	}
	b := a.As16()
	return b[0]&0xe0 == 0x20 && !(b[0] == 0x20 && ((b[1] == 1 && b[2] <= 1) || (b[1] == 1 && b[2] == 0x0d && b[3] == 0xb8) || b[1] == 2))
}
func (p *nativeProxy) destination(ctx context.Context, host string, port int) (netip.AddrPort, error) {
	if p.opts.destination != nil {
		return p.opts.destination(ctx, host, port)
	}
	if port < 1 || port > 65535 {
		return netip.AddrPort{}, errors.New("invalid destination")
	}
	if a, err := netip.ParseAddr(host); err == nil {
		if !p.opts.allowPrivateTargets && !nativePublicAddress(a) {
			return netip.AddrPort{}, errors.New("destination denied")
		}
		return netip.AddrPortFrom(a, uint16(port)), nil
	}
	if len(host) == 0 || len(host) > 253 || strings.ContainsAny(host, "\x00%/\\ \r\n\t") {
		return netip.AddrPort{}, errors.New("invalid destination")
	}
	addresses, err := p.opts.lookup(ctx, host)
	if err != nil || len(addresses) == 0 || len(addresses) > 64 {
		return netip.AddrPort{}, errors.New("destination unavailable")
	}
	for _, a := range addresses {
		if !a.IsValid() || !p.opts.allowPrivateTargets && !nativePublicAddress(a) {
			return netip.AddrPort{}, errors.New("destination denied")
		}
	}
	return netip.AddrPortFrom(addresses[0], uint16(port)), nil
}

func nativeWrite(w io.Writer, b []byte) error {
	for len(b) > 0 {
		n, err := w.Write(b)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}
func (p *nativeProxy) host(f *nativeFlow, c net.Conn) {
	u, pw, err := nativeReadAuth(c)
	if err != nil {
		return
	}
	if p.authorize(f, c, u, pw, "host") == nil {
		nativeWrite(c, []byte{1, 1})
		return
	}
	if nativeWrite(c, []byte{1, 0}) != nil {
		return
	}
	command, host, port, err := nativeReadRequest(c)
	if err != nil {
		return
	}
	if command == 3 {
		p.hostUDP(f, c, host, port)
		return
	}
	if command != 1 {
		nativeReply(c, 7, "0.0.0.0", 0)
		return
	}
	ctx, cancel := context.WithTimeout(f.ctx, nativeHandshake)
	defer cancel()
	destination, err := p.destination(ctx, host, port)
	if err != nil {
		nativeReply(c, 2, "0.0.0.0", 0)
		return
	}
	out, err := p.opts.dial(ctx, "tcp", destination.String())
	if err != nil {
		nativeReply(c, 5, "0.0.0.0", 0)
		return
	}
	if !f.add(out) {
		return
	}
	if nativeReply(c, 0, "0.0.0.0", 0) != nil {
		return
	}
	c.SetDeadline(time.Time{})
	p.pipe(f, c, out)
}
func (p *nativeProxy) client(f *nativeFlow, c net.Conn) {
	u, pw, err := nativeReadAuth(c)
	if err != nil {
		return
	}
	if p.authorize(f, c, u, pw, "client") == nil {
		nativeWrite(c, []byte{1, 1})
		return
	}
	if nativeWrite(c, []byte{1, 0}) != nil {
		return
	}
	command, host, port, err := nativeReadRequest(c)
	if err != nil {
		return
	}
	if command != 1 && command != 3 {
		nativeReply(c, 7, "0.0.0.0", 0)
		return
	}
	p.mu.Lock()
	r := p.config.Remote
	var remote NativeProxyRemote
	if r != nil {
		remote = *r
	}
	valid := r != nil && p.sessions[remote.Session] == f.session && p.enabled
	p.mu.Unlock()
	if !valid {
		return
	}
	ctx, cancel := context.WithTimeout(f.ctx, nativeHandshake)
	defer cancel()
	out, err := p.backend.Dial(ctx, "tcp", net.JoinHostPort(remote.Host, strconv.Itoa(remote.Port)))
	if err != nil {
		nativeReply(c, 5, "0.0.0.0", 0)
		return
	}
	if !f.add(out) {
		return
	}
	out.SetDeadline(time.Now().Add(nativeHandshake))
	if nativeSendAuth(out, remote.Username, remote.Password) != nil {
		nativeReply(c, 2, "0.0.0.0", 0)
		return
	}
	if command == 3 {
		p.clientUDP(f, c, out, host, port, remote)
		return
	}
	if nativeSendRequest(out, 1, host, port) != nil {
		nativeReply(c, 1, "0.0.0.0", 0)
		return
	}
	code, _, _, err := nativeReadReply(out)
	if err != nil {
		nativeReply(c, 1, "0.0.0.0", 0)
		return
	}
	if nativeReply(c, code, "0.0.0.0", 0) != nil || code != 0 {
		return
	}
	c.SetDeadline(time.Time{})
	out.SetDeadline(time.Time{})
	p.pipe(f, c, out)
}
func (p *nativeProxy) pipe(f *nativeFlow, a, b net.Conn) {
	done := make(chan error, 2)
	copyDirection := func(dst, src net.Conn, upload bool) {
		buf := make([]byte, 64*1024)
		var result error
		for {
			n, readErr := src.Read(buf)
			if n > 0 {
				dst.SetWriteDeadline(time.Now().Add(nativeWriteTimeout))
				written := 0
				for written < n {
					m, err := dst.Write(buf[written:n])
					f.count(m, upload)
					written += m
					if err != nil {
						result = err
						break
					}
					if m == 0 {
						result = io.ErrShortWrite
						break
					}
				}
				if result != nil {
					break
				}
			}
			if readErr != nil {
				if readErr != io.EOF {
					result = readErr
				} else if half, ok := dst.(interface{ CloseWrite() error }); ok {
					result = half.CloseWrite()
				} else {
					result = dst.Close()
				}
				break
			}
		}
		done <- result
	}
	go copyDirection(b, a, true)
	go copyDirection(a, b, false)
	if err := <-done; err != nil {
		f.close()
	}
	<-done
}

// Manager integration uses startMu for the same lifecycle ordering as network
// disconnect. The epoch watermark is retained after explicit close/disconnect.
func (m *Manager) NativeProxyConfigure(ctx context.Context, c NativeProxyConfig) (NativeProxyStatus, error) {
	m.startMu.Lock()
	defer m.startMu.Unlock()
	if err := validateNativeConfig(c, m.nativeOptions.allowLoopbackPeers); err != nil {
		return NativeProxyStatus{}, err
	}
	if c.Epoch <= m.nativeEpoch {
		return NativeProxyStatus{}, errors.New("stale native proxy epoch")
	}
	m.nativeEpoch = c.Epoch
	m.mu.Lock()
	closed := m.closed
	m.mu.Unlock()
	if closed {
		return NativeProxyStatus{}, errors.New("network core closed")
	}
	if c.Role == "host" || c.Enabled && c.Remote != nil {
		if !m.nativeReady {
			status, err := m.Status(ctx)
			if err != nil || !status.Running {
				if m.nativeProxy != nil {
					m.nativeProxy.close()
					m.nativeProxy = nil
				}
				return NativeProxyStatus{}, errors.New("private network is not connected")
			}
		}
	}
	if m.nativeProxy == nil {
		backend := m.nativeBackend
		if backend == nil {
			backend = m.server
		}
		m.nativeProxy = newNativeProxy(backend, m.nativeOptions)
	}
	status, err := m.nativeProxy.configure(c)
	if err != nil {
		m.nativeProxy.close()
		m.nativeProxy = nil
	}
	return status, err
}
func (m *Manager) NativeProxyStatus() NativeProxyStatus {
	m.startMu.Lock()
	defer m.startMu.Unlock()
	if m.nativeProxy == nil {
		return NativeProxyStatus{Epoch: m.nativeEpoch, Sessions: []NativeProxySessionStatus{}}
	}
	return m.nativeProxy.status()
}
func (m *Manager) NativeProxyClose(epoch uint64) (NativeProxyStatus, error) {
	m.startMu.Lock()
	defer m.startMu.Unlock()
	if epoch == 0 || epoch > 9007199254740991 || epoch <= m.nativeEpoch {
		return NativeProxyStatus{}, errors.New("stale native proxy epoch")
	}
	m.nativeEpoch = epoch
	if m.nativeProxy != nil {
		m.nativeProxy.close()
		m.nativeProxy = nil
	}
	return NativeProxyStatus{Epoch: epoch, Sessions: []NativeProxySessionStatus{}}, nil
}
