import { EventEmitter } from 'node:events';
import net from 'node:net';
import dgram from 'node:dgram';
import { lookup } from 'node:dns/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { digest, equalSecret, randomId } from './crypto.js';
import { rejectUpgrade } from './http-upgrade.js';

const DATA = 1, FIN = 2, DATAGRAM = 3;
const MAX_FRAME = 128 * 1024, MAX_BUFFER = 4 * 1024 * 1024;
const FAILURE = Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]);
const CAPACITY_CODE = 'PROXY_CAPACITY';
const CAPACITY_MESSAGE = '代理连接数已达上限，请等待空闲连接释放后重试';

// Zero means no fixed connection count; combine only explicitly bounded limits.
function connectionLimit(...limits) {
  const bounded = limits.filter((limit) => limit > 0);
  return bounded.length ? Math.min(...bounded) : 0;
}

function ipv6Bytes(host) {
  let text = host.toLowerCase();
  if (text.includes('.')) {
    const index = text.lastIndexOf(':');
    const octets = text.slice(index + 1).split('.').map(Number);
    text = `${text.slice(0, index)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [left, right] = text.split('::');
  const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
  const groups = right !== undefined ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  const output = Buffer.alloc(16);
  groups.forEach((group, i) => output.writeUInt16BE(parseInt(group || '0', 16), i * 2));
  return output;
}

// Reject special-use ranges, including IPv4-mapped IPv6 and transition routes.
// The address that passed this check is the address actually passed to connect/send.
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 ||
        (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('%')) return false;
  const bytes = ipv6Bytes(address);
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  // 2001::/23 contains special-purpose allocations; 2002::/16 embeds IPv4.
  return !(bytes[0] === 0x20 && ((bytes[1] === 1 && bytes[2] <= 1) ||
    (bytes[1] === 1 && bytes[2] === 0x0d && bytes[3] === 0xb8) || bytes[1] === 2));
}

export function encodeSocksAddress(host, port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('无效端口');
  let address;
  if (net.isIP(host) === 4) address = Buffer.from([1, ...host.split('.').map(Number)]);
  else if (net.isIP(host) === 6) address = Buffer.concat([Buffer.from([4]), ipv6Bytes(host)]);
  else {
    const name = Buffer.from(host || '', 'utf8');
    if (!name.length || name.length > 253 || name.includes(0)) throw new Error('无效目标域名');
    address = Buffer.concat([Buffer.from([3, name.length]), name]);
  }
  const tail = Buffer.alloc(2); tail.writeUInt16BE(port);
  return Buffer.concat([address, tail]);
}

export function decodeSocksAddress(buffer, offset = 0) {
  const type = buffer[offset];
  let length, start = offset + 1, host;
  if (type === 1) length = 4;
  else if (type === 4) length = 16;
  else if (type === 3) { if (buffer.length <= start) return null; length = buffer[start++]; if (!length) throw new Error('无效域名'); }
  else if (type === undefined) return null;
  else throw new Error('不支持的地址类型');
  if (buffer.length < start + length + 2) return null;
  const address = buffer.subarray(start, start + length);
  if (type === 1) host = [...address].join('.');
  else if (type === 4) host = Array.from({ length: 8 }, (_, i) => address.readUInt16BE(i * 2).toString(16)).join(':');
  else { host = address.toString('utf8'); if (!host || host.includes('\0') || host.includes('%') || /[\s/\\]/.test(host)) throw new Error('无效目标域名'); }
  return { host, port: buffer.readUInt16BE(start + length), bytes: start + length + 2 - offset };
}

function socksReply(host = '0.0.0.0', port = 0) { return Buffer.concat([Buffer.from([5, 0, 0]), encodeSocksAddress(host, port)]); }
function closeDatagram(socket) { try { socket.close(); } catch {} }
function udpKey(host, port) { return `${net.isIP(host) === 6 ? ipv6Bytes(host).toString('hex') : host}:${port}`; }

/** Independent proxy sockets never use the model channel or its request queue. */
export class NetworkProxy extends EventEmitter {
  constructor({ bridge, listenPort = 0, username = randomId(12), password = randomId(24), allowPrivateTargets = false,
    maxConnections = 0, maxPerSession = 0, maxUdpTargets = 128, bytesPerSecond = 32 * 1024 * 1024,
    handshakeMs = 10000, heartbeatMs = 10000, udpIdleMs = 60000, resolve = lookup } = {}) {
    super();
    if (!bridge) throw new Error('缺少桥接实例');
    if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw new Error('代理端口无效');
    if (!username || !password || Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255) throw new Error('代理凭据无效');
    if (![maxConnections, maxPerSession].every((limit) => Number.isSafeInteger(limit) && limit >= 0)) throw new Error('代理连接数限制无效');
    Object.assign(this, { bridge, listenPort, username, password, allowPrivateTargets, maxConnections, maxPerSession, maxUdpTargets, bytesPerSecond, handshakeMs, heartbeatMs, udpIdleMs, resolve });
    this.enabled = false; this.sharing = false; this.flows = new Set(); this.localSockets = new Set();
    this.sessionBuckets = new WeakMap();
    this.uploadBytes = 0; this.downloadBytes = 0; this.error = null; this.lastError = null;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
    this.onPeerState = () => this.prune();
    this.bridge.on?.('state', this.onPeerState);
  }
  start() {
    if (this.closed) return Promise.reject(new Error('网络代理已关闭'));
    if (this.starting) return this.starting;
    if (this.server) return Promise.resolve(this.status());
    const starting = this.listen().finally(() => { if (this.starting === starting) this.starting = null; });
    this.starting = starting;
    return starting;
  }
  async listen() {
    const server = this.server = net.createServer({ allowHalfOpen: true }, (socket) => this.acceptLocal(socket));
    server.on('error', (error) => { this.error = error.message; this.emit('state'); });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.listenPort, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    } catch (error) { this.server = null; throw error; }
    if (this.closed) throw new Error('网络代理已关闭');
    this.port = server.address().port; this.error = null; this.emit('state');
    return this.status();
  }
  status() {
    const peer = this.bridge.peer;
    const available = Boolean(peer?.role === 'client' && peer.state.online && this.bridge.remoteSharing !== false);
    const clients = peer?.role === 'host' ? [...peer.connections].filter((connection) => peer.isConnected(connection)).map((connection) => {
      const connections = [...this.flows].filter((flow) => !flow.dead && flow.connection === connection).length;
      return { id: connection.id, name: connection.device?.name || '调用端', address: connection.device?.address || '',
        role: 'client', online: true, paired: true, usingProxy: connections > 0, connections,
        uploadBytes: connection.proxyUploadBytes || 0, downloadBytes: connection.proxyDownloadBytes || 0 };
    }) : [];
    return { enabled: this.enabled, sharing: this.sharing, listening: Boolean(this.server?.listening), listenPort: this.port || this.listenPort,
      username: this.username, password: this.password, online: available,
      blocked: Boolean(this.enabled && !available), connections: this.flows.size,
      connectionLimit: peer?.role === 'client' ? connectionLimit(this.maxConnections, this.maxPerSession) : this.maxConnections,
      sessionConnectionLimit: this.maxPerSession, lastError: this.lastError,
      uploadBytes: this.uploadBytes, downloadBytes: this.downloadBytes, clients, error: this.error };
  }
  capacityError() {
    const first = this.lastError?.code !== CAPACITY_CODE;
    this.lastError = { code: CAPACITY_CODE, message: CAPACITY_MESSAGE, at: new Date().toISOString() };
    if (first) this.bridge.log?.(CAPACITY_MESSAGE);
    this.emit('state');
    return Object.assign(new Error(CAPACITY_MESSAGE), { code: CAPACITY_CODE });
  }
  clearCapacityError() {
    if (this.lastError) { this.lastError = null; this.emit('state'); }
  }
  configure({ enabled = this.enabled, sharing = this.sharing } = {}) {
    if (typeof enabled !== 'boolean' || typeof sharing !== 'boolean') throw new Error('网络共享开关无效');
    if (enabled !== this.enabled || sharing !== this.sharing) this.lastError = null;
    this.enabled = enabled; this.sharing = sharing; this.prune(); this.emit('state'); return this.status();
  }
  peerChanged() { this.prune(); this.emit('state'); }
  prune() {
    for (const flow of this.flows) if (!this.valid(flow)) flow.close();
    if (!this.enabled || !this.bridge.peer?.state.online || this.bridge.remoteSharing === false) for (const socket of this.localSockets) if (!socket.networkFlow) socket.destroy();
  }
  valid(flow) {
    if (flow.dead) return false;
    if (!this.closed && flow.pending && flow.peer === this.bridge.peer && this.sharing && flow.peer.role === 'host') return true;
    return !this.closed && flow.peer === this.bridge.peer && flow.peer.isConnected(flow.connection) &&
      flow.session === flow.connection.session && (flow.side === 'host' ? this.sharing : this.enabled && this.bridge.remoteSharing !== false);
  }
  makeFlow(peer, connection, side, ws) {
    const flow = { peer, connection, session: connection?.session, pending: !connection, side, ws, resources: new Set(), timers: new Set(), dead: false,
      bucketAt: Date.now(), bucketBytes: 0 };
    flow.close = (graceful = false) => {
      if (flow.dead) return; flow.dead = true;
      for (const timer of flow.timers) { clearTimeout(timer); clearInterval(timer); }
      for (const resource of flow.resources) {
        if (resource instanceof net.Socket) {
          if (resource === flow.localSocket && !flow.localReady && !resource.destroyed) { resource.end(FAILURE); resource.destroySoon(); }
          else if (graceful && flow.remoteEnded && !resource.destroyed) {
            resource.end(); resource.destroySoon();
            const deadline = setTimeout(() => resource.destroy(), this.handshakeMs); deadline.unref();
            resource.once('close', () => clearTimeout(deadline));
          }
          else resource.destroy();
        } else closeDatagram(resource);
      }
      ws.terminate(); this.flows.delete(flow); this.emit('state');
    };
    ws.on('error', () => flow.close()); ws.on('close', (code) => flow.close(code === 1000));
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive || !this.valid(flow)) return flow.close(); alive = false; if (ws.readyState === WebSocket.OPEN) ws.ping(); }, this.heartbeatMs);
    heartbeat.unref(); flow.timers.add(heartbeat);
    this.flows.add(flow); this.emit('state');
    return flow;
  }
  account(flow, bytes, outgoing) {
    if (!this.valid(flow)) { flow.close(); return false; }
    const now = Date.now();
    if (now - flow.bucketAt >= 1000) { flow.bucketAt = now; flow.bucketBytes = 0; }
    flow.bucketBytes += bytes;
    let bucket = this.sessionBuckets.get(flow.connection);
    if (!bucket || now - bucket.at >= 1000) { bucket = { at: now, bytes: 0 }; this.sessionBuckets.set(flow.connection, bucket); }
    bucket.bytes += bytes;
    if (flow.bucketBytes > this.bytesPerSecond || bucket.bytes > this.bytesPerSecond || flow.ws.bufferedAmount > MAX_BUFFER) { flow.close(); return false; }
    if (outgoing) this.uploadBytes += bytes; else this.downloadBytes += bytes;
    if (flow.connection) {
      const key = outgoing ? 'proxyUploadBytes' : 'proxyDownloadBytes';
      flow.connection[key] = (flow.connection[key] || 0) + bytes;
    }
    return true;
  }
  send(flow, frame, outgoing = true, callback) {
    if (!this.account(flow, frame.length, outgoing) || flow.ws.readyState !== WebSocket.OPEN) return false;
    flow.ws.send(frame, (error) => { if (error) flow.close(); else callback?.(); }); return true;
  }
  async destination(host, port) {
    if (typeof host !== 'string' || host.length > 253 || host.includes('%') || /[\s/\\\0]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('目标地址无效');
    let timer;
    const entries = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await Promise.race([
      this.resolve(host, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('目标 DNS 解析超时')), this.handshakeMs); timer.unref(); })
    ]).finally(() => clearTimeout(timer));
    if (!entries.length || entries.length > 64 || entries.some(({ address }) => !net.isIP(address) || (!this.allowPrivateTargets && !isPublicAddress(address)))) throw new Error('禁止访问非公网目标');
    return { address: entries[0].address, family: entries[0].family, port };
  }
  upgrade(req, socket, head, peer = this.bridge.peer) {
    if (!req.url?.startsWith('/network/')) return false;
    if (this.closed || peer !== this.bridge.peer || peer?.role !== 'host' || req.url !== `/network/${peer.pairing.room}` || req.headers.origin ||
      !equalSecret(req.headers.authorization, `Bearer ${digest(`p2pcc-network-v1:${peer.pairing.room}:${peer.pairing.secret}`)}`)) { rejectUpgrade(socket, 401, 'Unauthorized'); return true; }
    if (!this.sharing) { rejectUpgrade(socket, 403, 'Sharing disabled'); return true; }
    if (this.maxConnections > 0 && this.flows.size >= this.maxConnections) { this.capacityError(); rejectUpgrade(socket, 429, 'Connection limit'); return true; }
    // Track the pending flow before asynchronous authentication and destination lookup.
    this.wss.handleUpgrade(req, socket, head, (ws) => this.acceptRemote(ws, peer)); return true;
  }
  acceptRemote(ws, peer) {
    let authenticated = false;
    // Pending sockets are tracked for timeout, revocation and optional limits.
    const flow = this.makeFlow(peer, null, 'host', ws);
    const deadline = setTimeout(() => flow.close(), this.handshakeMs); deadline.unref(); flow.timers.add(deadline);
    ws.once('message', async (raw, binary) => {
      try {
        if (binary || raw.length > 2048) throw new Error('无效代理握手');
        const msg = JSON.parse(raw.toString());
        const connection = [...peer.connections].find((candidate) => peer.isConnected(candidate) && equalSecret(msg.session, candidate.session));
        if (msg.v !== 1 || !connection || !['tcp', 'udp'].includes(msg.command)) throw new Error('网络代理身份验证失败');
        authenticated = true;
        if (this.maxPerSession > 0 && [...this.flows].filter((item) => item !== flow && item.connection === connection).length >= this.maxPerSession) throw this.capacityError();
        flow.connection = connection; flow.session = connection.session; flow.pending = false;
        if (!this.valid(flow)) throw new Error('网络共享已停用');
        if (msg.command === 'tcp') await this.hostTcp(flow, msg);
        else await this.hostUdp(flow);
        this.clearCapacityError();
        clearTimeout(deadline);
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ok: false, error: authenticated ? error.message : '代理授权失败',
          ...(authenticated && error.code === CAPACITY_CODE ? { code: CAPACITY_CODE } : {}) }), () => flow.close());
        else flow.close();
      }
    });
  }
  async hostTcp(flow, { host, port }) {
    const target = await this.destination(host, port);
    if (!this.valid(flow)) return flow.close();
    const socket = net.createConnection({ host: target.address, port: target.port, family: target.family, allowHalfOpen: true });
    flow.resources.add(socket);
    socket.on('error', () => flow.close());
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('目标连接关闭'))); });
    if (!this.valid(flow)) return flow.close();
    flow.ws.send(JSON.stringify({ ok: true }));
    this.pipeTcp(flow, socket);
  }
  pipeTcp(flow, socket) {
    socket.setNoDelay(true);
    socket.on('data', (data) => {
      socket.pause();
      const chunks = [];
      for (let offset = 0; offset < data.length; offset += 64 * 1024) chunks.push(Buffer.concat([Buffer.from([DATA]), data.subarray(offset, offset + 64 * 1024)]));
      let remaining = chunks.length;
      for (const frame of chunks) if (!this.send(flow, frame, flow.side === 'client', () => { if (!--remaining && !flow.dead) socket.resume(); })) break;
    });
    socket.on('end', () => this.send(flow, Buffer.from([FIN]), flow.side === 'client'));
    socket.on('error', () => flow.close());
    socket.on('close', () => { if (flow.ws.readyState === WebSocket.OPEN) flow.ws.close(1000); });
    socket.on('drain', () => flow.ws.resume());
    let ended = false;
    const receive = (frame, binary) => {
      if (!binary || !frame.length || !this.account(flow, frame.length, flow.side === 'host')) return flow.close();
      if (frame[0] === FIN && frame.length === 1 && !ended) { ended = true; flow.remoteEnded = true; socket.end(); }
      else if (frame[0] === DATA && !ended && frame.length > 1) { if (!socket.write(frame.subarray(1))) flow.ws.pause(); }
      else flow.close();
    };
    this.receiveFrames(flow, receive);
  }
  async hostUdp(flow) {
    const sockets = new Map(), bindings = new Map(), targets = new Map();
    const getSocket = (family) => {
      if (bindings.has(family)) return bindings.get(family);
      const socket = dgram.createSocket(family === 6 ? 'udp6' : 'udp4'); flow.resources.add(socket);
      socket.on('error', () => flow.close());
      socket.on('message', (data, info) => {
        const key = udpKey(info.address, info.port);
        const active = targets.get(key);
        if (!active || Date.now() - active > this.udpIdleMs) return;
        this.send(flow, Buffer.concat([Buffer.from([DATAGRAM]), encodeSocksAddress(info.address, info.port), data]), false);
      });
      const ready = new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, family === 6 ? '::' : '0.0.0.0', () => { socket.off('error', reject); sockets.set(family, socket); resolve(socket); }); });
      bindings.set(family, ready);
      return ready;
    };
    let pending = 0;
    const destinations = new Map();
    flow.ws.on('message', async (frame, binary) => {
      if (!binary || frame[0] !== DATAGRAM || !this.account(flow, frame.length, true)) return flow.close();
      // UDP can lose packets under load. Bound outstanding DNS/bind operations
      // without disconnecting an otherwise healthy association during a burst.
      if (pending >= 32) return;
      ++pending;
      try {
        const address = decodeSocksAddress(frame, 1);
        if (!address || frame.length - address.bytes - 1 > 65507) throw new Error('无效 UDP 地址');
        const name = `${address.host}:${address.port}`;
        const now = Date.now();
        for (const [key, time] of targets) if (now - time > this.udpIdleMs) targets.delete(key);
        for (const [key, entry] of destinations) if (now - entry.at > this.udpIdleMs) destinations.delete(key);
        let entry = destinations.get(name);
        if (!entry) {
          if (destinations.size >= this.maxUdpTargets || targets.size >= this.maxUdpTargets) throw new Error('UDP 目标数超限');
          const target = await this.destination(address.host, address.port);
          if (destinations.size >= this.maxUdpTargets && !destinations.has(name)) throw new Error('UDP 目标数超限');
          entry = { ...target, at: now }; destinations.set(name, entry);
        }
        if (!this.valid(flow)) return flow.close();
        // Avoid an unnecessary microtask for every packet once the socket is
        // bound: a single WebSocket read may contain dozens of UDP frames.
        const socket = sockets.get(entry.family) || await getSocket(entry.family);
        if (!this.valid(flow)) return flow.close();
        if (targets.size >= this.maxUdpTargets && !targets.has(udpKey(entry.address, entry.port))) throw new Error('UDP 目标数超限');
        targets.set(udpKey(entry.address, entry.port), Date.now());
        socket.send(frame.subarray(1 + address.bytes), entry.port, entry.address, (error) => { if (error) flow.close(); });
      } catch { flow.close(); }
      finally { pending--; }
    });
    flow.ws.send(JSON.stringify({ ok: true }));
  }
  acceptLocal(socket) {
    if (this.closed || !this.enabled || this.bridge.remoteSharing === false || this.bridge.peer?.role !== 'client' || !this.bridge.peer.state.online) return socket.destroy();
    if (this.maxConnections > 0 && this.localSockets.size >= this.maxConnections) { this.capacityError(); return socket.destroy(); }
    this.localSockets.add(socket);
    socket.on('error', () => {}); socket.on('close', () => this.localSockets.delete(socket));
    let buffer = Buffer.alloc(0), phase = 'greeting';
    const deadline = setTimeout(() => socket.destroy(), this.handshakeMs); deadline.unref();
    socket.on('close', () => clearTimeout(deadline));
    const fail = (reply = FAILURE) => {
      socket.off('data', onData); clearTimeout(deadline);
      if (socket.destroyed) return;
      if (!socket.writableEnded) socket.end(reply);
      // This listener allows half-close for successful TCP streams. A rejected
      // handshake has no stream and must not wait forever for the client's FIN.
      socket.destroySoon();
    };
    const onData = (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 65536) return socket.destroy();
      try {
        if (phase === 'greeting') {
          if (buffer.length < 2) return;
          if (buffer[0] !== 5 || !buffer[1]) return socket.destroy();
          const count = buffer[1]; if (buffer.length < count + 2) return;
          if (!buffer.subarray(2, count + 2).includes(2)) return fail(Buffer.from([5, 255]));
          buffer = buffer.subarray(count + 2); phase = 'auth'; socket.write(Buffer.from([5, 2]));
        }
        if (phase === 'auth') {
          if (buffer.length < 2) return;
          if (buffer[0] !== 1 || !buffer[1]) return socket.destroy();
          const userLength = buffer[1]; if (buffer.length < userLength + 3) return;
          const passwordLength = buffer[userLength + 2]; if (buffer.length < userLength + passwordLength + 3) return;
          if (!equalSecret(buffer.subarray(2, userLength + 2).toString(), this.username) || !equalSecret(buffer.subarray(userLength + 3, userLength + passwordLength + 3).toString(), this.password)) return fail(Buffer.from([1, 1]));
          buffer = buffer.subarray(userLength + passwordLength + 3); phase = 'request'; socket.write(Buffer.from([1, 0]));
        }
        if (phase === 'request') {
          if (buffer.length < 4) return;
          if (buffer[0] !== 5 || buffer[2] !== 0 || ![1, 3].includes(buffer[1])) return fail();
          const address = decodeSocksAddress(buffer, 3); if (!address) return;
          const command = buffer[1] === 1 ? 'tcp' : 'udp';
          const rest = buffer.subarray(3 + address.bytes);
          socket.off('data', onData); socket.pause(); phase = 'connecting';
          this.openClient(socket, command, address, rest).then(() => clearTimeout(deadline)).catch(() => { fail(); });
        }
      } catch { fail(); }
    };
    socket.on('data', onData);
  }
  async openClient(socket, command, address, rest) {
    const peer = this.bridge.peer, connection = peer?.clientConnection;
    if (!this.enabled || this.bridge.remoteSharing === false || peer?.role !== 'client' || !peer.isConnected(connection)) throw new Error('B 未连接');
    const limit = connectionLimit(this.maxConnections, this.maxPerSession);
    if (limit > 0 && this.flows.size >= limit) throw this.capacityError();
    const resource = peer.dialResource;
    const host = resource ? '127.0.0.1' : peer.pairing.host, port = resource?.port || peer.pairing.port;
    const ws = new WebSocket(`ws://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}/network/${peer.pairing.room}`, {
      headers: { Authorization: `Bearer ${digest(`p2pcc-network-v1:${peer.pairing.room}:${peer.pairing.secret}`)}` },
      handshakeTimeout: this.handshakeMs, maxPayload: MAX_FRAME, perMessageDeflate: false, followRedirects: false });
    const flow = this.makeFlow(peer, connection, 'client', ws);
    flow.resources.add(socket); flow.localSocket = socket; socket.networkFlow = flow;
    socket.once('close', () => flow.close());
    const queued = []; let queuedBytes = 0, waitingAck = true;
    const queueFrames = (frame, binary) => {
      if (waitingAck) return;
      queuedBytes += frame.length;
      if (queuedBytes > MAX_BUFFER) return flow.close();
      queued.push([frame, binary]);
    };
    ws.on('message', queueFrames);
    flow.receiveQueue = { queued, queueFrames };
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('B 代理握手超时')), this.handshakeMs); timer.unref(); flow.timers.add(timer);
        const fail = () => { clearTimeout(timer); reject(new Error('B 代理不可用')); };
        ws.once('error', fail); ws.once('close', fail);
        ws.once('unexpected-response', (_request, response) => {
          response.resume(); clearTimeout(timer);
          reject(response.statusCode === 429 ? this.capacityError() : new Error('B 拒绝代理连接'));
        });
        ws.once('open', () => { if (!this.valid(flow)) return fail(); ws.send(JSON.stringify({ v: 1, session: flow.session, command, host: address.host, port: address.port })); });
        ws.once('message', (raw, binary) => {
          waitingAck = false;
          clearTimeout(timer); ws.off('error', fail); ws.off('close', fail);
          try {
            if (binary || !this.valid(flow)) return reject(new Error('B 握手无效'));
            const reply = JSON.parse(raw.toString());
            if (reply.ok !== true) return reject(reply.code === CAPACITY_CODE ? this.capacityError() : new Error('B 拒绝代理'));
            this.clearCapacityError(); resolve();
          } catch { reject(new Error('B 握手无效')); }
        });
      });
      if (command === 'tcp') {
        flow.localReady = true; socket.write(socksReply()); this.pipeTcp(flow, socket);
        if (rest.length) this.send(flow, Buffer.concat([Buffer.from([DATA]), rest]));
        socket.resume();
      } else {
        if (rest.length) throw new Error('UDP 控制连接不允许数据');
        await this.clientUdp(flow, socket, address);
      }
    } catch (error) { flow.close(); throw error; }
  }
  async clientUdp(flow, control, address) {
    if (!['0.0.0.0', '127.0.0.1', '0:0:0:0:0:0:0:0', '::'].includes(address.host)) throw new Error('仅允许本机 UDP');
    const udp = dgram.createSocket('udp4'); flow.resources.add(udp);
    udp.on('error', () => flow.close());
    await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(0, '127.0.0.1', () => { udp.off('error', reject); resolve(); }); });
    if (!this.valid(flow)) return flow.close();
    let sourcePort = address.port, lastActivity = Date.now();
    const idle = setInterval(() => { if (Date.now() - lastActivity > this.udpIdleMs) flow.close(); }, Math.min(this.udpIdleMs, 10000)); idle.unref(); flow.timers.add(idle);
    udp.on('message', (data, info) => {
      if (info.address !== '127.0.0.1' || (sourcePort && info.port !== sourcePort) || data.length < 4 || data[0] !== 0 || data[1] !== 0 || data[2] !== 0) return;
      try {
        const target = decodeSocksAddress(data, 3); if (!target || !target.port || data.length - 3 - target.bytes > 65507) return;
        sourcePort ||= info.port; lastActivity = Date.now();
        this.send(flow, Buffer.concat([Buffer.from([DATAGRAM]), data.subarray(3)]));
      } catch {}
    });
    this.receiveFrames(flow, (frame, binary) => {
      if (!binary || frame[0] !== DATAGRAM || !this.account(flow, frame.length, false)) return flow.close();
      try {
        const target = decodeSocksAddress(frame, 1);
        if (!target || !sourcePort || frame.length - 1 - target.bytes > 65507) return flow.close();
        lastActivity = Date.now();
        udp.send(Buffer.concat([Buffer.from([0, 0, 0]), frame.subarray(1)]), sourcePort, '127.0.0.1', (error) => { if (error) flow.close(); });
      } catch { flow.close(); }
    });
    control.on('data', () => flow.close()); control.on('end', () => flow.close()); control.resume();
    flow.localReady = true; control.write(socksReply('127.0.0.1', udp.address().port));
  }
  receiveFrames(flow, receive) {
    if (flow.receiveQueue) {
      flow.ws.off('message', flow.receiveQueue.queueFrames);
      for (const [frame, binary] of flow.receiveQueue.queued) { receive(frame, binary); if (flow.dead) break; }
      flow.receiveQueue = null;
    }
    flow.ws.on('message', receive);
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true; this.bridge.off?.('state', this.onPeerState);
    for (const flow of this.flows) flow.close();
    for (const socket of this.localSockets) socket.destroy();
    this.closing = (async () => {
      // listen() may still be assigning the loopback port. Let its completion
      // observe closed before disposing the server it created.
      try { await this.starting; } catch {}
      await new Promise((resolve) => this.wss.close(resolve));
      if (this.server?.listening) await new Promise((resolve) => this.server.close(resolve));
      this.removeAllListeners();
    })();
    return this.closing;
  }
}
