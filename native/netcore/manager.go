package netcore

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

type Config struct {
	StateDir string `json:"stateDir"`
	Hostname string `json:"hostname"`
}
type Status struct {
	Installed    bool     `json:"installed"`
	Embedded     bool     `json:"embedded"`
	Running      bool     `json:"running"`
	Addresses    []string `json:"addresses"`
	BackendState string   `json:"backendState"`
	Source       string   `json:"source"`
	Message      string   `json:"message"`
	AuthURL      string   `json:"authUrl,omitempty"`
	Peers        []Peer   `json:"peers"`
}
type Peer struct {
	Name    string `json:"name"`
	Address string `json:"address"`
	Online  bool   `json:"online"`
	Path    string `json:"path"`
}
type Resource struct {
	ID   string `json:"id"`
	Port int    `json:"port"`
}
type Manager struct {
	mu                sync.Mutex
	startMu           sync.Mutex
	config            Config
	server            *tsnet.Server
	started           bool
	closed            bool
	authURL           string
	resources         map[string]*proxy
	tcpFlowIDs        tcpFlowIDs // guarded by startMu; diagnostics-only anonymous identities
	transportRecovery transportRecovery
	channelProbeMu    sync.Mutex // probe-only; normal control and Close never acquire it
}

func New(config Config) (*Manager, error) {
	if !filepath.IsAbs(config.StateDir) {
		return nil, errors.New("stateDir must be absolute")
	}
	if err := prepareStateDir(config.StateDir); err != nil {
		return nil, err
	}
	hostname := regexp.MustCompile(`[^a-zA-Z0-9-]+`).ReplaceAllString(config.Hostname, "-")
	hostname = strings.Trim(hostname, "-")
	if hostname == "" {
		hostname = "claude-bridge"
	}
	if len(hostname) > 60 {
		hostname = hostname[:60]
	}
	config.Hostname = hostname
	m := &Manager{config: config, resources: make(map[string]*proxy)}
	m.server = m.newServer()
	return m, nil
}

func (m *Manager) newServer() *tsnet.Server {
	return &tsnet.Server{Dir: m.config.StateDir, Hostname: m.config.Hostname, Logf: func(string, ...any) {}, UserLogf: func(format string, args ...any) {
		for _, field := range strings.Fields(fmt.Sprintf(format, args...)) {
			if validAuthURL(field) {
				m.mu.Lock()
				m.authURL = field
				m.mu.Unlock()
			}
		}
	}}
}

func validAuthURL(value string) bool {
	u, err := url.Parse(value)
	return err == nil && u.Scheme == "https" && u.Hostname() == "login.tailscale.com" && u.User == nil
}

func (m *Manager) start() error {
	m.startMu.Lock()
	defer m.startMu.Unlock()
	return m.startLocked()
}

func (m *Manager) startLocked() error {
	m.mu.Lock()
	started, closed := m.started, m.closed
	m.mu.Unlock()
	if closed {
		return errors.New("network core closed")
	}
	if started {
		return nil
	}
	if err := m.server.Start(); err != nil {
		// tsnet caches its first Start error. Retire that instance so a
		// temporary filesystem/port error can recover on a later attempt.
		m.server.Close()
		m.server = m.newServer()
		return err
	}
	m.mu.Lock()
	m.started = true
	m.mu.Unlock()
	return nil
}

func (m *Manager) Status(ctx context.Context) (Status, error) {
	status := Status{Installed: true, Embedded: true, Addresses: []string{}, Peers: []Peer{}, Source: "embedded", BackendState: "NotStarted", Message: "内置组网已就绪，点击「连接私有网络」并在浏览器完成登录"}
	m.mu.Lock()
	started, closed, authURL := m.started, m.closed, m.authURL
	m.mu.Unlock()
	if closed {
		return status, errors.New("network core closed")
	}
	if !started {
		return status, nil
	}
	client, err := m.server.LocalClient()
	if err != nil {
		return status, err
	}
	state, err := client.Status(ctx)
	if err != nil {
		return status, err
	}
	status.BackendState = state.BackendState
	for _, address := range state.TailscaleIPs {
		if tailnetRange.Contains(address) {
			status.Addresses = append(status.Addresses, address.String())
		}
	}
	status.Running = status.BackendState == "Running" && len(status.Addresses) > 0
	for _, peer := range state.Peer {
		for _, address := range peer.TailscaleIPs {
			if !tailnetRange.Contains(address) {
				continue
			}
			path := "unknown"
			if peer.CurAddr != "" {
				path = "direct"
			} else if peer.PeerRelay != "" {
				path = "peer-relay"
			} else if peer.Active && peer.Relay != "" {
				path = "relay"
			}
			status.Peers = append(status.Peers, Peer{Name: peer.HostName, Address: address.String(), Online: peer.Online, Path: path})
			break
		}
	}
	sort.Slice(status.Peers, func(i, j int) bool {
		if status.Peers[i].Online != status.Peers[j].Online {
			return status.Peers[i].Online
		}
		return status.Peers[i].Name < status.Peers[j].Name
	})
	if len(status.Peers) > 200 {
		status.Peers = status.Peers[:200]
	}
	if validAuthURL(state.AuthURL) {
		authURL = state.AuthURL
	}
	if status.Running {
		status.Message = "内置组网已连接 · " + strings.Join(status.Addresses, ", ")
	} else if status.BackendState == "Stopped" {
		status.Message = "已退出私有网络；登录身份已保留，可重新连接"
	} else {
		status.Message = "等待私有网络登录或设备批准，请在浏览器完成授权"
		if validAuthURL(authURL) {
			status.AuthURL = authURL
		}
	}
	return status, nil
}

func (m *Manager) Login(ctx context.Context) (Status, error) {
	m.startMu.Lock()
	defer m.startMu.Unlock()
	if err := m.startLocked(); err != nil {
		return Status{}, err
	}
	if err := m.setRunning(ctx, true); err != nil {
		return Status{}, err
	}
	client, err := m.server.LocalClient()
	if err != nil {
		return Status{}, err
	}
	return waitForLogin(ctx, m.Status, client.StartLoginInteractive)
}

// Resuming a saved node can briefly report Stopped/Starting before Running.
// StartLoginInteractive explicitly requests a new login, so invoke it only
// after the backend confirms that its saved identity needs authentication.
func waitForLogin(ctx context.Context, readStatus func(context.Context) (Status, error), startInteractive func(context.Context) error) (Status, error) {
	var status Status
	interactiveStarted := false
	for i := 0; i < 15; i++ {
		if err := ctx.Err(); err != nil {
			return status, err
		}
		var err error
		status, err = readStatus(ctx)
		if err != nil || status.Running || status.AuthURL != "" {
			return status, err
		}
		if status.BackendState == "NeedsLogin" && !interactiveStarted {
			if err := startInteractive(ctx); err != nil {
				return status, err
			}
			interactiveStarted = true
		}
		select {
		case <-ctx.Done():
			return status, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	return status, nil
}

func (m *Manager) setRunning(ctx context.Context, running bool) error {
	client, err := m.server.LocalClient()
	if err != nil {
		return err
	}
	_, err = client.EditPrefs(ctx, &ipn.MaskedPrefs{Prefs: ipn.Prefs{WantRunning: running}, WantRunningSet: true})
	return err
}

func (m *Manager) Connect(ctx context.Context) (Status, error) {
	m.startMu.Lock()
	defer m.startMu.Unlock()
	if err := m.startLocked(); err != nil {
		return Status{}, err
	}
	if err := m.setRunning(ctx, true); err != nil {
		return Status{}, err
	}
	return m.Status(ctx)
}

// Disconnect revokes all forwarding resources and stops the authenticated node.
// It deliberately keeps its profile, login keys and private network identity.
func (m *Manager) Disconnect(ctx context.Context) (Status, error) {
	m.startMu.Lock()
	defer m.startMu.Unlock()
	m.mu.Lock()
	started, closed := m.started, m.closed
	resources := m.resources
	m.resources = make(map[string]*proxy)
	m.authURL = ""
	m.mu.Unlock()
	if closed {
		return Status{}, errors.New("network core closed")
	}
	for _, p := range resources {
		p.Close()
	}
	if !started {
		return m.Status(ctx)
	}
	if err := m.setRunning(ctx, false); err != nil {
		return Status{}, err
	}
	for {
		status, err := m.Status(ctx)
		if err != nil || !status.Running {
			status.AuthURL = ""
			return status, err
		}
		select {
		case <-ctx.Done():
			return status, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (m *Manager) add(p *proxy, port int) (Resource, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || len(m.resources) >= 16 {
		p.Close()
		return Resource{}, errors.New("network resource limit reached")
	}
	id := resourceID()
	m.resources[id] = p
	return Resource{ID: id, Port: port}, nil
}

func (m *Manager) Listen(ctx context.Context, port, targetPort int, limits ...int) (Resource, error) {
	m.startMu.Lock()
	defer m.startMu.Unlock()
	status, err := m.Status(ctx)
	if err != nil {
		return Resource{}, err
	}
	if !status.Running {
		return Resource{}, errors.New("log in to the private network first")
	}
	p, err := listenProxy(m.server, port, targetPort, limits...)
	if err != nil {
		return Resource{}, err
	}
	return m.add(p, port)
}

func (m *Manager) Dial(ctx context.Context, host string, port int, limits ...int) (Resource, error) {
	m.startMu.Lock()
	defer m.startMu.Unlock()
	status, err := m.Status(ctx)
	if err != nil {
		return Resource{}, err
	}
	if !status.Running {
		return Resource{}, errors.New("private network is not connected")
	}
	p, err := dialProxy(m.server, host, port, limits...)
	if err != nil {
		return Resource{}, err
	}
	return m.add(p, p.listener.Addr().(*net.TCPAddr).Port)
}

func (m *Manager) Release(id string) {
	m.mu.Lock()
	p := m.resources[id]
	delete(m.resources, id)
	m.mu.Unlock()
	if p != nil {
		p.Close()
	}
}

func (m *Manager) Close() {
	m.startMu.Lock()
	defer m.startMu.Unlock()
	m.tcpFlowIDs.ids = nil
	m.mu.Lock()
	m.closed = true
	started := m.started
	resources := m.resources
	m.resources = make(map[string]*proxy)
	m.mu.Unlock()
	for _, p := range resources {
		p.Close()
	}
	if started {
		m.server.Close()
	}
}
