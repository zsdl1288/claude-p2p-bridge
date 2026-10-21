import { EventEmitter } from 'node:events';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { SecureChannel, digest, randomId, equalSecret } from './crypto.js';
import { validatePeerAddress } from './tailscale.js';
import { rejectUpgrade } from './http-upgrade.js';

// B owns a private listener with one independently authenticated channel per A.
// Connections never share nonces, sequence counters, replay windows or replies.
export class BridgePeer extends EventEmitter {
  constructor({ role, pairing, allowLoopback = false, heartbeatMs = 10000, retryMs = 1000, networkAdapter = null, retryInitial = false, maxClients = 16, networkUpgrade = null, channel = 'control', sharedListener = null, parentSession = null, authorize = null, metadata = null, info = null }) {
    super();
    validatePeerAddress(pairing.host, { allowLoopback });
    Object.assign(this, { role, pairing, allowLoopback, heartbeatMs, retryMs, networkAdapter, retryInitial, maxClients });
    this.networkUpgrade = networkUpgrade;
    Object.assign(this, { channel, sharedListener, parentSession, authorize, metadata, info });
    this.route = `${channel === 'model' ? '/model' : '/bridge'}/${pairing.room}`;
    this.authLabel = channel === 'model' ? 'p2pcc-model-v1' : 'p2pcc-v2';
    this.state = { mode: 'tailscale', role, online: false, listening: false, connectedClients: 0, maxClients, transport: 'offline', endpoint: `${pairing.host}:${pairing.port}`, error: null };
    this.connections = new Set();
    this.retry = 0;
    this.networkGeneration = 0;
    this.onNetworkReset = (error) => {
      if (this.closed || this.role !== 'client') return;
      ++this.networkGeneration;
      // A helper reset retires every proxy it owned. Do not keep an old socket
      // usable when the offline event asks consumers to prune their streams.
      for (const connection of this.connections) connection.ws.terminate();
      this.update({ online: false, transport: 'offline', error: error?.message || '内置组网已中断，正在自动重连' });
      if (!this.connections.size && !this.connecting) this.scheduleReconnect();
    };
    if (role === 'client') this.networkAdapter?.on?.('reset', this.onNetworkReset);
  }
  get ws() { return (this.clientConnection || [...this.connections].find((connection) => connection.authenticated) || [...this.connections][0])?.ws || null; }
  get session() { return (this.clientConnection || [...this.connections].find((connection) => connection.authenticated))?.session || null; }
  update(values) { Object.assign(this.state, values); this.emit('state', this.state); }
  updateConnections(values = {}) {
    const count = [...this.connections].filter((connection) => this.isConnected(connection)).length;
    this.update({ online: count > 0, connectedClients: this.role === 'host' ? count : 0, transport: count ? this.allowLoopback ? 'loopback-demo' : 'tailscale' : 'offline', ...values });
  }
  isConnected(connection) { return !this.closed && Boolean(connection?.authenticated && connection.session && this.connections.has(connection) && connection.ws.readyState === WebSocket.OPEN); }
  async start() {
    if (this.role === 'host') return this.listen();
    if (!this.retryInitial) return this.connect();
    this.connect().catch((error) => { if (!this.closed) { this.update({ error: error.message }); this.scheduleReconnect(); } });
  }
  listen() {
    if (this.closed) return Promise.reject(new Error('配对已关闭'));
    if (this.listeningStart) return this.listeningStart;
    if (this.state.listening) return Promise.resolve();
    const starting = this.listenOnce().catch(async (error) => {
      // A private-listener failure may happen after its loopback HTTP server
      // has bound. Retire that attempt before a retry can replace its handles.
      for (const connection of this.connections) connection.ws.terminate();
      await this.closeListener();
      if (!this.closed) this.updateConnections({ listening: false });
      throw error;
    }).finally(() => { if (this.listeningStart === starting) this.listeningStart = null; });
    this.listeningStart = starting;
    return starting;
  }
  async listenOnce() {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024, perMessageDeflate: false });
    if (this.sharedListener) { this.update({ listening: true }); return; }
    const server = this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/bridge-info' && this.info) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(this.info())); return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end('{"error":"Bridge WebSocket only"}');
    });
    server.headersTimeout = 10000;
    server.requestTimeout = 10000;
    server.keepAliveTimeout = 1000;
    server.on('upgrade', (req, socket, head) => {
      const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '');
      try { validatePeerAddress(remote, { allowLoopback: this.allowLoopback || Boolean(this.networkAdapter) }); }
      catch { return rejectUpgrade(socket, 403, 'Forbidden'); }
      if (this.networkUpgrade?.(req, socket, head, this)) return;
      this.upgrade(req, socket, head);
    });
    server.on('error', (error) => { if (!this.closed) this.update({ error: `B 端监听失败：${error.message}` }); });
    await new Promise((resolve, reject) => {
      const cleanup = () => { server.off('error', onError); server.off('listening', onListen); server.off('close', onClose); };
      const onError = (error) => { cleanup(); reject(error); };
      const onListen = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error('配对已关闭')); };
      server.once('error', onError);
      server.once('listening', onListen);
      server.once('close', onClose);
      server.listen(this.networkAdapter ? 0 : this.pairing.port, this.networkAdapter ? '127.0.0.1' : this.pairing.host);
    });
    if (this.closed) throw new Error('配对已关闭');
    if (this.networkAdapter) {
      const resource = await this.networkAdapter.listen({ port: this.pairing.port, targetPort: server.address().port, maxConnections: 0 });
      if (this.closed) { await this.networkAdapter.release(resource).catch(() => {}); throw new Error('配对已关闭'); }
      this.listenResource = resource;
    }
    else this.pairing.port = server.address().port;
    this.update({ listening: true, endpoint: `${this.pairing.host}:${this.pairing.port}` });
  }
  upgrade(req, socket, head) {
    if (this.closed || !this.wss) return rejectUpgrade(socket, 503, 'Service unavailable');
    if (req.url !== this.route || req.headers.origin || !equalSecret(req.headers.authorization, `Bearer ${digest(`${this.authLabel}:${this.pairing.room}:${this.pairing.secret}`)}`)) return rejectUpgrade(socket, 401, 'Unauthorized');
    // Handshakes also reserve a slot, bounding unverified sockets.
    if (this.connections.size >= this.maxClients) return rejectUpgrade(socket, 409, 'Client limit reached');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.bindSocket(ws));
  }
  connect() {
    if (this.state.pairingRejected) return Promise.reject(new Error('配对已失效，请使用服务端的新配对码重新配对'));
    if (this.connecting) return this.connecting;
    if (this.isConnected(this.clientConnection)) return Promise.resolve();
    const attempt = this.connectOnce().finally(() => { if (this.connecting === attempt) this.connecting = null; });
    this.connecting = attempt;
    return attempt;
  }
  async connectOnce() {
    if (this.closed) return Promise.reject(new Error('配对已关闭'));
    const generation = this.networkGeneration;
    const resource = this.networkAdapter ? await this.networkAdapter.dial({ ...this.pairing, maxConnections: 0 }) : null;
    if (this.closed || generation !== this.networkGeneration) {
      if (resource) await this.networkAdapter.release(resource).catch(() => {});
      throw new Error(this.closed ? '配对已关闭' : '内置组网已重启，正在自动重连');
    }
    this.dialResource = resource;
    return new Promise((resolve, reject) => {
      const { host, port, room, secret } = this.pairing;
      const ws = new WebSocket(`ws://${resource ? '127.0.0.1' : host}:${resource?.port || port}${this.route}`, { headers: { Authorization: `Bearer ${digest(`${this.authLabel}:${room}:${secret}`)}` }, handshakeTimeout: 10000, maxPayload: 3 * 1024 * 1024, perMessageDeflate: false, followRedirects: false });
      this.bindSocket(ws, resolve, reject, resource);
    });
  }
  bindSocket(ws, resolve, reject, resource) {
    const connection = { id: randomId(12), ws, crypto: new SecureChannel(this.pairing.secret, this.pairing.room, this.role), localNonce: randomId(), remoteNonce: null, session: null, sendSequence: 0, receiveSequence: 0, authenticated: false };
    this.connections.add(connection);
    if (this.role === 'client') this.clientConnection = connection;
    let alive = true;
    let lastError;
    const reportError = (message) => { if (this.role === 'client' || !this.state.online) this.update({ error: message }); };
    const fail = (message) => { lastError = message; reportError(message); ws.terminate(); };
    const deadline = setTimeout(() => fail('连接 B 端超时，请检查 Tailscale 登录、B 的桥接端口与防火墙'), 12000);
    const heartbeat = setInterval(() => {
      if (!alive) return fail('连接心跳超时');
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, this.heartbeatMs);
    heartbeat.unref();
    ws.on('pong', () => { alive = true; });
    ws.on('error', (error) => {
      if (this.state.pairingRejected || lastError) return;
      lastError = `连接 B 端失败：${error.message}。请确认两端 Tailscale 已连接、B 正在提供服务，且 TCP ${this.pairing.port} 未被防火墙阻止`; reportError(lastError);
    });
    if (this.role === 'client' && this.channel === 'control') ws.on('unexpected-response', (_request, response) => {
      // Only a control-channel credential rejection invalidates a saved pair.
      // Address policy (403), capacity (409) and service outages remain retryable.
      response.resume();
      if (response.statusCode === 401) {
        clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
        this.update({ pairingRejected: true });
        fail('配对已失效（HTTP 401），请使用服务端的新配对码重新配对');
      } else fail(`服务端暂时拒绝连接（HTTP ${response.statusCode}），正在等待恢复`);
    });
    ws.on('message', (raw) => {
      if (this.closed || !this.connections.has(connection)) return;
      try {
        const msg = connection.crypto.open(JSON.parse(raw.toString()));
        if (msg.kind === 'hello') {
          if (typeof msg.nonce !== 'string' || !/^[\w-]{32}$/.test(msg.nonce) || (connection.remoteNonce && connection.remoteNonce !== msg.nonce)) throw new Error('身份验证失败');
          if (this.authorize && !this.authorize(msg, connection)) throw new Error('控制连接身份无效');
          connection.parentSession = typeof msg.parentSession === 'string' ? msg.parentSession : null;
          if (msg.device && typeof msg.device === 'object') connection.device = {
            name: typeof msg.device.name === 'string' ? msg.device.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : '',
            address: typeof msg.device.address === 'string' && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(msg.device.address) ? msg.device.address : ''
          };
          connection.remoteNonce = msg.nonce;
          this.write({ kind: 'ack', echo: msg.nonce, nonce: connection.localNonce }, connection);
        } else if (msg.kind === 'ack') {
          // A peer must first supply its own verified hello. In the model
          // channel that is also where its parent control session is checked.
          if (connection.authenticated || !connection.remoteNonce || msg.echo !== connection.localNonce || msg.nonce !== connection.remoteNonce) throw new Error('身份验证失败');
          connection.session = digest(this.role === 'host' ? `${connection.localNonce}:${connection.remoteNonce}` : `${connection.remoteNonce}:${connection.localNonce}`);
          connection.authenticated = true;
          this.hasConnected = true;
          this.retry = 0;
          clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
          clearTimeout(deadline);
          this.updateConnections({ error: null });
          this.emit('ready', connection);
          resolve?.();
        } else if (connection.authenticated && msg.kind === 'message' && msg.session === connection.session) {
          if (msg.sequence !== connection.receiveSequence + 1) throw new Error('消息顺序无效');
          connection.receiveSequence = msg.sequence;
          this.emit('message', msg.body, connection);
        } else throw new Error('未认证的消息');
      } catch (error) { fail(`加密消息被拒绝：${error.message}`); }
    });
    ws.on('close', () => {
      if (resource) {
        if (this.dialResource === resource) this.dialResource = null;
        this.networkAdapter.release(resource).catch(() => {});
      }
      clearTimeout(deadline);
      clearInterval(heartbeat);
      if (!connection.authenticated) reject?.(new Error(lastError || 'B 端拒绝连接，请检查配对码是否有效或是否已达到 16 台 A 端的连接上限'));
      if (!this.connections.delete(connection)) return;
      const wasOnline = connection.authenticated;
      connection.authenticated = false;
      connection.retiredSession = connection.session;
      connection.session = null;
      if (this.clientConnection === connection) this.clientConnection = null;
      this.updateConnections();
      if (wasOnline && !this.closed) this.emit('disconnect', '与对端的 Tailscale 连接已断开，当前任务已停止', connection);
      if (!this.closed && this.role === 'client' && (this.hasConnected || this.retryInitial)) this.scheduleReconnect();
    });
    const hello = () => { try { this.write({ kind: 'hello', nonce: connection.localNonce,
      ...(this.parentSession ? { parentSession: typeof this.parentSession === 'function' ? this.parentSession() : this.parentSession } : {}),
      ...(this.metadata ? { device: typeof this.metadata === 'function' ? this.metadata() : this.metadata } : {}) }, connection); } catch (error) { fail(error.message); } };
    if (ws.readyState === WebSocket.OPEN) hello(); else ws.once('open', hello);
  }
  scheduleReconnect() {
    if (this.closed || this.state.pairingRejected || this.reconnectTimer || (!this.hasConnected && !this.retryInitial)) return;
    const delay = Math.min(this.retryMs * 2 ** Math.min(this.retry++, 30), 15000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.connect().catch((error) => { if (!this.closed) { this.update({ error: error.message }); this.scheduleReconnect(); } });
    }, delay);
  }
  write(message, connection = this.clientConnection) {
    const ws = connection?.ws;
    if (!this.connections.has(connection) || ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount > 4 * 1024 * 1024) throw new Error('传输连接不可用或过慢');
    ws.send(JSON.stringify(connection.crypto.seal(message)), (error) => { if (error) ws.terminate(); });
  }
  send(body, connection = this.clientConnection) {
    if (!this.isConnected(connection)) throw new Error('对端未连接');
    if (Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024) throw new Error('单条消息超过 2 MiB');
    try { this.write({ kind: 'message', session: connection.session, sequence: ++connection.sendSequence, body }, connection); }
    catch (error) {
      queueMicrotask(() => connection.ws.terminate());
      throw error;
    }
  }
  // Health evidence is optional. Skip it under control-channel pressure and
  // never turn a failed hint write into an explicit session termination.
  trySendHealthHint(body, connection) {
    if (this.channel !== 'control' || this.role !== 'host' || !this.isConnected(connection) ||
        body?.type !== 'proxy-health' || body.v !== 1 || connection.ws.bufferedAmount >= 64 * 1024) return false;
    try {
      if (Buffer.byteLength(JSON.stringify(body)) > 2048) return false;
      const sequence = connection.sendSequence + 1;
      const packet = JSON.stringify(connection.crypto.seal({ kind: 'message', session: connection.session, sequence, body }));
      connection.ws.send(packet, () => {});
      connection.sendSequence = sequence;
      return true;
    } catch { return false; }
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    ++this.networkGeneration;
    this.networkAdapter?.off?.('reset', this.onNetworkReset);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closing = this.dispose();
    return this.closing;
  }
  async dispose() {
    for (const connection of this.connections) connection.ws.terminate();
    const dialResource = this.dialResource; this.dialResource = null;
    if (dialResource) await this.networkAdapter.release(dialResource).catch(() => {});
    const listenResource = this.listenResource; this.listenResource = null;
    if (listenResource) await this.networkAdapter.release(listenResource).catch(() => {});
    await this.closeListener();
    this.update({ online: false, listening: false, connectedClients: 0, transport: 'offline' });
    this.removeAllListeners();
  }
  async closeListener() {
    if (this.wss) await new Promise((resolve) => this.wss.close(resolve));
    if (this.server) {
      this.server.closeAllConnections();
      if (this.server.listening) await new Promise((resolve) => this.server.close(resolve));
    }
  }
}
