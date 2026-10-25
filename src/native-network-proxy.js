import { EventEmitter } from 'node:events';
import { digest, randomId } from './crypto.js';
import { TrafficRates, RATE_WINDOW_MS } from './traffic-rates.js';
import { rejectUpgrade } from './http-upgrade.js';

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const validPort = (value) => Number.isInteger(value) && value > 0 && value <= 65535;
const plus = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const peerAddress = (value, demo) => {
  if (demo && value === '127.0.0.1') return true;
  const parts = typeof value === 'string' && value.split('.');
  return Boolean(parts && parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
    && Number(parts[0]) === 100 && Number(parts[1]) >= 64 && Number(parts[1]) <= 127);
};

// Only the control plane crosses the JS boundary. TCP payloads and UDP
// datagrams remain in the native helper; credentials are scoped to one live
// pairing session and never appear in the generated Clash subscription.
export class NativeNetworkProxy extends EventEmitter {
  constructor({ bridge, listenPort = 0, username = randomId(12), password = randomId(24), now = () => performance.now(), pollMs = 1000, renewMs = 10000 } = {}) {
    super();
    this.bridge = bridge; this.adapter = bridge.networkAdapter; this.native = true;
    this.listenPort = listenPort; this.username = username; this.password = password;
    this.now = now; this.pollMs = pollMs; this.renewMs = renewMs;
    this.enabled = false; this.sharing = false; this.port = 0; this.hostPort = 0;
    this.server = { listening: false }; this.listenRequested = false;
    this.uploadBytes = 0; this.downloadBytes = 0; this.lastError = null; this.error = null;
    this.trafficRates = new TrafficRates({ now }); this.counters = new Map();
    this.operations = Promise.resolve(); this.revision = 0; this.epoch = 0;
    this.desiredKey = ''; this.appliedKey = ''; this.appliedEpoch = 0; this.snapshot = null;
    this.metricsAvailable = false;
    this.retryAttempts = 0;
    this.onState = () => { void this.reconcile().catch(() => {}); };
    this.onReset = () => {
      ++this.revision; this.appliedKey = ''; this.snapshot = null;
      this.server.listening = false; this.hostPort = 0; this.remoteEndpoint = null;
      this.metricsAvailable = false;
      this.counters.clear(); this.totals = null;
      this.error = '原生网络通道已中断，正在等待配对恢复';
      this.desiredKey = JSON.stringify(this.desired()); this.scheduleRetry();
      this.emit('state');
    };
    this.bridge.on('state', this.onState); this.adapter.on?.('reset', this.onReset);
  }
  connections() {
    const peer = this.bridge.peer;
    if (!peer) return [];
    return peer.role === 'host' ? [...peer.connections].filter((connection) => peer.isConnected(connection))
      : peer.isConnected(peer.clientConnection) ? [peer.clientConnection] : [];
  }
  fresh(connection) {
    const age = this.now() - connection.lastActivityAt;
    return Number.isFinite(age) && age >= 0 && age < 25000;
  }
  credential(connection) {
    const { room, secret } = this.bridge.peer.pairing;
    return { username: digest(`native-user:${connection.session}`).slice(0, 24),
      password: digest(`native-network-v1:${room}:${secret}:${connection.session}`) };
  }
  desired() {
    const peer = this.bridge.peer;
    if (this.closed) return null;
    if (peer?.role === 'host') {
      if (!this.sharing && this.snapshot?.role !== 'host') return null;
      const enabled = this.sharing && peer.state.listening;
      const sessions = enabled ? this.connections().filter((connection) => connection.capabilities?.nativeProxy === 1
        && this.fresh(connection) && peerAddress(connection.device?.address, this.bridge.demo)).map((connection) => ({
          id: connection.session, peerIP: connection.device.address, ...this.credential(connection)
        })).sort((a, b) => a.id.localeCompare(b.id)) : [];
      return { role: 'host', enabled: Boolean(enabled), port: this.hostPort, sessions };
    }
    if (!this.listenRequested) return null;
    const connection = peer?.role === 'client' ? peer.clientConnection : null;
    const endpoint = this.remoteEndpoint;
    const remoteReady = this.enabled && this.bridge.remoteSharing === true && peer?.isConnected(connection)
      && this.fresh(connection) && connection.capabilities?.nativeProxy === 1 && endpoint?.connection === connection
      && endpoint.session === connection.session && validPort(endpoint.port);
    return { role: 'client', enabled: Boolean(remoteReady), port: this.port || this.listenPort,
      username: this.username, password: this.password,
      ...(remoteReady ? { remote: { host: peer.pairing.host, port: endpoint.port, session: connection.session, ...this.credential(connection) } } : {}) };
  }
  reconcile(force = false) {
    const desired = this.desired(), key = JSON.stringify(desired);
    if (!force && key === this.desiredKey) return this.operations;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    this.desiredKey = key; const revision = ++this.revision;
    const operation = this.operations.catch(() => {}).then(async () => {
      if (revision !== this.revision) return;
      // Odd epochs are reserved for native-only cleanup after a rejected RPC.
      const epoch = (this.epoch += 2);
      try {
        const result = desired ? await this.adapter.nativeProxyConfigure({ ...desired, epoch }) : await this.adapter.nativeProxyClose({ epoch });
        if (revision !== this.revision) return;
        this.error = null; this.retryAttempts = 0; this.appliedEpoch = epoch; this.appliedKey = key;
        if (desired) {
          if (!result || result.role !== desired.role || result.epoch !== epoch || !validPort(result.port) || result.listening !== true) {
            this.adapter.abortNativeProxy?.(); throw new Error('原生网络组件返回了无效监听状态');
          }
          if (desired.role === 'client') { this.port = result.port; this.server.listening = true; this.hostPort = 0; }
          else { this.hostPort = result.port; this.server.listening = false; }
          this.applySnapshot(result); this.startTimers();
        } else {
          this.snapshot = null; this.server.listening = false; this.hostPort = 0;
          this.stopTimers(); this.counters.clear(); this.totals = null;
        }
        this.bridge.broadcastProxyStatus?.(); this.emit('state');
      } catch (error) {
        if (revision === this.revision) {
          this.appliedKey = ''; this.server.listening = false;
          this.snapshot = null; this.hostPort = 0; this.error = '原生网络通道暂不可用，正在等待恢复';
          this.scheduleRetry();
          this.bridge.broadcastProxyStatus?.(); this.emit('state');
        }
        throw error;
      }
    });
    this.operations = operation; operation.catch(() => {}); return operation;
  }
  scheduleRetry() {
    if (this.closed || this.retryTimer) return;
    const delay = Math.min(1500 * 2 ** Math.min(this.retryAttempts++, 4), 15000);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.reconcile(true).catch(() => {}); }, delay);
    this.retryTimer.unref();
  }
  async flush() { await this.reconcile(); await this.operations; }
  startTimers() {
    if (!this.pollTimer) { this.pollTimer = setInterval(() => { void this.poll(); }, this.pollMs); this.pollTimer.unref(); }
    if (!this.renewTimer) { this.renewTimer = setInterval(() => { void this.reconcile(true).catch(() => {}); }, this.renewMs); this.renewTimer.unref(); }
  }
  stopTimers() { clearInterval(this.pollTimer); clearInterval(this.renewTimer); this.pollTimer = this.renewTimer = null; }
  async poll() {
    if (this.closed || this.polling || !this.snapshot) return;
    this.polling = true;
    try {
      const result = await this.adapter.nativeProxyStatus();
      if (!this.closed && result?.epoch === this.appliedEpoch && result.role === this.snapshot?.role) {
        this.applySnapshot(result); this.bridge.broadcastProxyStatus?.(); this.emit('state');
      }
      else this.metricsAvailable = false;
    } catch { this.metricsAvailable = false; } finally { this.polling = false; }
  }
  applySnapshot(result) {
    const previous = this.totals;
    const upload = count(result.uploadBytes), download = count(result.downloadBytes);
    this.uploadBytes = plus(this.uploadBytes, upload - (previous?.role === result.role && previous.upload <= upload ? previous.upload : 0));
    this.downloadBytes = plus(this.downloadBytes, download - (previous?.role === result.role && previous.download <= download ? previous.download : 0));
    this.totals = { role: result.role, upload, download };
    const rows = (Array.isArray(result.sessions) ? result.sessions : []).filter((session) => session && typeof session.id === 'string')
      .map((session) => ({ id: session.id, connections: count(session.connections), uploadBytes: count(session.uploadBytes), downloadBytes: count(session.downloadBytes) }));
    this.snapshot = { epoch: result.epoch, role: result.role, enabled: result.enabled === true, listening: result.listening === true,
      port: result.port, connections: count(result.connections), uploadBytes: upload, downloadBytes: download, sessions: rows };
    this.metricsAvailable = true;
    const sessions = new Map(rows.map((session) => [session.id, session]));
    for (const connection of this.connections()) {
      const row = sessions.get(connection.session);
      if (!row) continue;
      const before = this.counters.get(connection.session);
      const up = count(row.uploadBytes), down = count(row.downloadBytes);
      const upDelta = up - (before && before.upload <= up ? before.upload : 0), downDelta = down - (before && before.download <= down ? before.download : 0);
      this.counters.set(connection.session, { upload: up, download: down });
      this.trafficRates.record(connection, upDelta, true); this.trafficRates.record(connection, downDelta, false);
      connection.proxyUploadBytes = plus(connection.proxyUploadBytes || 0, upDelta);
      connection.proxyDownloadBytes = plus(connection.proxyDownloadBytes || 0, downDelta);
    }
    for (const id of this.counters.keys()) if (!sessions.has(id)) this.counters.delete(id);
  }
  async start() {
    if (this.closed) throw new Error('网络代理已关闭');
    this.listenRequested = true;
    if (this.error) await this.reconcile(true);
    await this.flush();
    if (!this.server.listening) throw new Error('本地原生 SOCKS5 监听尚未就绪');
    return this.status();
  }
  configure({ enabled = this.enabled, sharing = this.sharing } = {}) {
    if (typeof enabled !== 'boolean' || typeof sharing !== 'boolean') throw new Error('网络共享开关无效');
    this.enabled = enabled; this.sharing = sharing;
    void this.reconcile().catch(() => {}); this.emit('state'); return this.status();
  }
  peerChanged() { return this.reconcile(); }
  receiveStatus(message, connection) {
    const peer = this.bridge.peer;
    if (peer?.role !== 'client' || connection !== peer.clientConnection || !peer.isConnected(connection)) return;
    const endpoint = message.nativeProxy;
    this.remoteEndpoint = connection.capabilities?.nativeProxy === 1 && endpoint?.v === 1 && validPort(endpoint.port)
      ? { connection, session: connection.session, port: endpoint.port } : null;
    void this.reconcile().catch(() => {});
  }
  advertisement(connection) {
    if (!this.sharing || this.snapshot?.role !== 'host' || !this.snapshot.enabled || !validPort(this.hostPort)
      || !this.bridge.peer?.isConnected(connection) || !this.snapshot.sessions?.some((session) => session.id === connection.session)) return null;
    return { v: 1, port: this.hostPort };
  }
  status() {
    const peer = this.bridge.peer, connections = this.connections(), rates = this.trafficRates.sample(connections);
    const sessions = new Map((this.snapshot?.sessions || []).map((session) => [session.id, session]));
    const latency = (connection) => {
      const age = rates.at - connection.latencyAt;
      return typeof connection.latencyMs === 'number' && Number.isFinite(connection.latencyMs) && connection.latencyMs >= 0
        && typeof connection.latencyAt === 'number' && age >= 0 && age <= Math.max(30000, 3 * (peer?.heartbeatMs || 10000)) ? connection.latencyMs : null;
    };
    const clients = peer?.role === 'host' ? connections.map((connection) => {
      const active = count(sessions.get(connection.session)?.connections);
      return { id: connection.id, name: connection.device?.name || '调用端', address: connection.device?.address || '', role: 'client',
        online: true, paired: true, usingProxy: active > 0, connections: active, uploadBytes: connection.proxyUploadBytes || 0,
        downloadBytes: connection.proxyDownloadBytes || 0,
        ...(this.metricsAvailable ? rates.values.get(connection) : { uploadBytesPerSecond: null, downloadBytesPerSecond: null }), latencyMs: latency(connection) };
    }) : [];
    const totals = connections.length && this.metricsAvailable ? connections.reduce((sum, connection) => {
      const rate = rates.values.get(connection); sum.uploadBytesPerSecond += rate.uploadBytesPerSecond;
      sum.downloadBytesPerSecond += rate.downloadBytesPerSecond; return sum;
    }, { uploadBytesPerSecond: 0, downloadBytesPerSecond: 0 }) : { uploadBytesPerSecond: null, downloadBytesPerSecond: null };
    const online = Boolean(peer?.role === 'client' && this.snapshot?.role === 'client' && this.snapshot.enabled
      && this.server.listening && this.appliedKey === JSON.stringify(this.desired()));
    let error = this.error;
    if (this.enabled && peer?.role === 'client' && peer.isConnected(peer.clientConnection) && peer.clientConnection.capabilities?.nativeProxy !== 1) {
      error = '服务端尚不支持原生 TCP/UDP 网络共享，请将 A、B 更新到相同新版';
    }
    return { transport: 'native-tailscale', enabled: this.enabled, sharing: this.sharing, online, blocked: this.enabled && !online,
      metricsAvailable: this.metricsAvailable,
      ready: Boolean(this.snapshot?.role === 'host' && this.snapshot.enabled && this.snapshot.listening),
      listening: this.server.listening, listenPort: this.port || this.listenPort, username: this.username, password: this.password,
      connections: count(this.snapshot?.connections), connectionLimit: 0, sessionConnectionLimit: 0, lastError: null,
      uploadBytes: this.uploadBytes, downloadBytes: this.downloadBytes, ...totals, rateWindowMs: RATE_WINDOW_MS,
      latencyMs: peer?.role === 'client' && connections.length ? latency(connections[0]) : null, clients, error };
  }
  recoverySnapshot() { return []; }
  upgrade(req, socket) {
    if (!req.url?.startsWith('/network/')) return false;
    rejectUpgrade(socket, 426, 'Native transport required'); return true;
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true; this.stopTimers(); this.bridge.off('state', this.onState); this.adapter.off?.('reset', this.onReset);
    clearTimeout(this.retryTimer); this.retryTimer = null;
    this.bridge.channelRefresh?.close(); this.bridge.channelRecovery?.close(); this.bridge.channelSpeed?.close(); this.bridge.speedTransport?.close();
    this.closing = this.reconcile().finally(() => { this.server.listening = false; this.removeAllListeners(); });
    return this.closing;
  }
}
