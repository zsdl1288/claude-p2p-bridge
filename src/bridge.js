import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import { BridgePeer } from './peer.js';
import { makePairing, encodeInvitation, parseInvitation } from './crypto.js';
import { getTailscaleStatus, networkDevices } from './tailscale.js';
import { runClaude, validateRequest, probeClaude } from './runner.js';
import { NetworkProxy } from './network-proxy.js';
import { hostname } from 'node:os';
import path from 'node:path';

export class Bridge extends EventEmitter {
  constructor({ demo = false, networkProvider = getTailscaleStatus, networkAdapter = null, cancelTimeoutMs = 5000, responseTimeoutMs = 3610000, proxyOptions = {} } = {}) {
    super();
    this.demo = demo;
    this.networkProvider = networkProvider;
    this.networkAdapter = networkAdapter;
    this.cancelTimeoutMs = cancelTimeoutMs;
    this.responseTimeoutMs = responseTimeoutMs;
    this.pending = new Map();
    this.active = new Map();
    this.sessions = new Map();
    this.queue = [];
    this.maxQueued = 15;
    this.logs = [];
    this.networkProxy = new NetworkProxy({ bridge: this, ...proxyOptions });
    this.remoteSharing = null;
    this.modelEnabled = false;
    this.modelGeneration = 0;
    this.remoteModel = null;
    this.networkGeneration = 0;
  }
  log(message) { this.logs.unshift({ time: new Date().toISOString(), message }); this.logs = this.logs.slice(0, 40); this.emit('state'); }
  status() {
    const peer = this.peer, state = peer?.state || {}, config = this.config;
    return {
      ...state, mode: 'tailscale', role: peer?.role || null, online: state.online || false,
      transport: state.transport || 'offline', connectionId: peer?.role === 'client' && this.modelPeer?.state.online ? this.modelPeer.session : null,
      controlConnectionId: peer?.role === 'client' && state.online ? peer.session : null,
      connectedClients: state.connectedClients || 0, queuedRequests: this.queue.length,
      demo: this.demo, network: this.networkStatus(),
      model: this.modelStatus(),
      config: this.networkIdentity().role === 'host' && config ? { workspace: config.workspace, profile: config.profile, claudeCommand: config.claudeCommand,
        timeoutMs: config.timeoutMs, maxTurns: config.maxTurns, tailscaleIp: config.tailscaleIp, bridgePort: config.bridgePort } : null,
      invitation: this.invitation || null, activeRequests: this.active.size + this.queue.length + this.pending.size, logs: this.logs
    };
  }
  networkIdentity() {
    const role = this.peer?.role || null;
    return { role, serverAddress: role === 'client' ? this.peer.pairing.host : null };
  }
  networkStatus() { return this.network ? { ...this.network, devices: networkDevices(this.network, this.networkIdentity()) } : null; }
  invalidateNetworkInfo() { ++this.networkGeneration; this.networkPromise = null; }
  setNetwork(info) {
    // A completed up/down operation supersedes polls started before it. They
    // may finish later, but must not overwrite the committed transition.
    this.invalidateNetworkInfo();
    this.network = info; this.networkAt = Date.now();
    return this.networkStatus();
  }
  async networkInfo(refresh = false) {
    if (this.demo) {
      this.network = { demo: true, installed: false, running: false, addresses: ['127.0.0.1'], source: 'demo', backendState: 'Demo', message: '本机演示：模拟两端连接，不代表已经安装或连接 Tailscale' };
      return this.networkStatus();
    }
    if (!refresh && this.network && Date.now() - this.networkAt < 5000) return this.networkStatus();
    if (!this.networkPromise) {
      const generation = this.networkGeneration;
      const reading = Promise.resolve().then(() => this.networkProvider()).then((info) => {
        if (generation === this.networkGeneration) { this.network = info; this.networkAt = Date.now(); }
      }).finally(() => { if (this.networkPromise === reading) this.networkPromise = null; });
      this.networkPromise = reading;
    }
    await this.networkPromise;
    return this.networkStatus();
  }
  async loginNetwork() {
    if (!this.networkAdapter) throw new Error('当前模式使用系统 Tailscale，请在系统客户端登录');
    return this.setNetwork(await this.networkAdapter.login());
  }
  async host(input, { pairing: restoredPairing } = {}) {
    input ||= {};
    const legacyModel = input.workspace ? await this.prepareModel({ ...input, enabled: true }) : null;
    const network = await this.networkInfo(true);
    const tailscaleIp = input.tailscaleIp || network.addresses[0];
    if ((!network.running && !this.demo) || !tailscaleIp) throw new Error(network.message || '请先安装并登录 Tailscale');
    if (!network.addresses.includes(tailscaleIp)) throw new Error('只能选择检测到的本机 Tailscale IPv4 地址');
    const pairing = restoredPairing ? parseInvitation(encodeInvitation(restoredPairing), { allowLoopback: this.demo }) : makePairing(tailscaleIp, input.bridgePort ?? 3211, { allowLoopback: this.demo });
    if (pairing.host !== tailscaleIp) throw new Error('保存的设备地址已变更，请重新配对');
    await this.stopPeer();
    if (legacyModel) this.applyModel(legacyModel);
    await this.attach('host', pairing);
    if (this.config) Object.assign(this.config, { tailscaleIp, bridgePort: pairing.port });
    this.invitation = encodeInvitation(pairing);
    this.log(`B 端桥接已监听 ${tailscaleIp}:${pairing.port}，等待 A 端配对`);
    return this.status();
  }
  async join(input, { retryInitial = false } = {}) {
    const pairing = parseInvitation(input.invitation, { allowLoopback: this.demo });
    const network = await this.networkInfo(true);
    if (this.demo && pairing.host !== '127.0.0.1') throw new Error('演示模式仅允许连接本机模拟 B 端');
    if (!this.demo && !network.running) throw new Error(network.message || 'A 端尚未连接 Tailscale');
    await this.stopPeer();
    await this.attach('client', pairing, { retryInitial });
    this.log(`${this.peer.state.online ? 'A 端已通过加密连接接入 B' : 'A 端正在等待 B 上线'} · ${pairing.host}:${pairing.port}`);
    return this.status();
  }
  async attach(role, pairing, { retryInitial = false } = {}) {
    const peer = this.peer = new BridgePeer({ role, pairing, retryInitial, allowLoopback: this.demo, networkAdapter: this.demo ? null : this.networkAdapter,
      metadata: () => this.deviceMetadata(), info: () => ({ role: 'host', name: this.deviceMetadata().name, protocol: 1 }),
      networkUpgrade: (req, socket, head, current) => {
        if (current !== this.peer) { socket.destroy(); return true; }
        if (req.url?.startsWith('/model/')) { if (this.modelPeer) this.modelPeer.upgrade(req, socket, head); else socket.destroy(); return true; }
        return this.networkProxy.upgrade(req, socket, head, current);
      } });
    const modelPeer = this.modelPeer = new BridgePeer({ role, pairing, channel: 'model', retryInitial: true,
      allowLoopback: this.demo, networkAdapter: this.demo ? null : this.networkAdapter,
      sharedListener: role === 'host' ? peer : null,
      parentSession: role === 'client' ? () => peer.session : null,
      authorize: role === 'host' ? (msg) => [...peer.connections].some((connection) => peer.isConnected(connection) && connection.session === msg.parentSession) : null });
    modelPeer.on('state', () => { if (this.modelPeer === modelPeer) this.emit('state'); });
    modelPeer.on('ready', (connection) => { if (role === 'host') this.sessions.set(connection, new Set()); this.emit('state'); });
    modelPeer.on('message', (msg, connection) => this.onModelMessage(msg, connection));
    modelPeer.on('disconnect', (reason, connection) => {
      if (this.modelPeer !== modelPeer) return;
      if (role === 'host') { this.cancelConnection(connection); this.sessions.delete(connection); }
      else this.cancelAll(reason);
      this.emit('state');
    });
    if (role === 'host') await modelPeer.start();
    this.proxyController?.synchronize();
    this.networkProxy.peerChanged();
    peer.on('state', () => { if (this.peer === peer) this.emit('state'); });
    peer.on('ready', (connection) => {
      if (this.peer !== peer) return;
      if (role === 'host') { this.broadcastProxyStatus(); this.broadcastModelStatus(); }
      else { this.remoteSharing = null; this.remoteModel = null; modelPeer.connect().catch(() => modelPeer.scheduleReconnect()); }
      this.log(role === 'host' ? `A 端身份验证完成，当前连接 ${peer.state.connectedClients} 台 A` : '双端身份验证完成，可开始调用');
    });
    peer.on('message', (msg, connection) => this.onMessage(msg, connection));
    peer.on('disconnect', (reason, connection) => {
      if (this.peer !== peer) return;
      if (role === 'host') {
        for (const candidate of modelPeer.connections) if (candidate.parentSession === connection.retiredSession) candidate.ws.terminate();
        this.log(`一台 A 端已断开，当前连接 ${peer.state.connectedClients} 台 A`);
      } else { modelPeer.ws?.terminate(); this.remoteSharing = null; this.remoteModel = null; this.cancelAll(reason); this.log(reason); }
    });
    try {
      await peer.start();
      if (role === 'client' && peer.state.online) await modelPeer.connect().catch(() => modelPeer.scheduleReconnect());
    } catch (error) { await modelPeer.close(); await peer.close(); if (this.peer === peer) this.peer = null; if (this.modelPeer === modelPeer) this.modelPeer = null; this.invitation = null; throw error; }
  }
  deviceMetadata() { return { name: this.network?.hostname || hostname(), address: this.network?.addresses?.[0] || '' }; }
  async prepareModel(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) throw new Error('Claude 配置无效');
    const enabled = input.enabled ?? this.modelEnabled;
    const config = { profile: 'read', claudeCommand: 'claude', timeoutMs: 600000, maxTurns: 30, ...this.config, ...Object.fromEntries(['workspace', 'profile', 'claudeCommand', 'timeoutMs', 'maxTurns'].filter((key) => input[key] !== undefined).map((key) => [key, input[key]])) };
    if (!enabled && !config.workspace) return { enabled, config: null };
    if (typeof config.workspace !== 'string' || !config.workspace.trim()) throw new Error('请先在模型 API 页面设置 B 端 Claude 工作目录');
    if (/[\0\r\n]/.test(config.workspace) || config.workspace.length > 32768) throw new Error('工作目录无效');
    if (enabled) {
      config.workspace = await realpath(config.workspace);
      if (!(await stat(config.workspace)).isDirectory()) throw new Error('工作目录不存在');
    } else config.workspace = path.resolve(config.workspace);
    if (!['read', 'edit', 'develop'].includes(config.profile)) throw new Error('工具权限无效');
    if (typeof config.claudeCommand !== 'string' || !config.claudeCommand.trim() || config.claudeCommand.length > 4096 || /[\0\r\n]/.test(config.claudeCommand)) throw new Error('Claude 路径无效');
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 3600000 || !Number.isInteger(config.maxTurns) || config.maxTurns < 1 || config.maxTurns > 200) throw new Error('执行限制无效');
    config.demo = this.demo;
    return { enabled, config };
  }
  applyModel({ enabled, config }) {
    ++this.modelGeneration;
    this.cancelModelTasks('Claude 配置已更新，本次任务已停止');
    for (const sessions of this.sessions.values()) sessions.clear();
    this.modelEnabled = enabled; this.config = config ? { ...config } : null;
    this.broadcastModelStatus(); this.emit('state');
    return this.status();
  }
  async configureModel(input) { return this.applyModel(await this.prepareModel(input)); }
  modelStatus() {
    const role = this.networkIdentity().role;
    if (role === 'client') {
      const remote = this.remoteModel || {};
      const controlOnline = Boolean(this.peer?.state.online);
      const online = Boolean(this.modelPeer?.state.online && controlOnline);
      return { enabled: remote.enabled === true, configured: remote.configured === true, available: online && remote.available === true, online,
        state: !controlOnline ? 'offline' : this.modelPeer?.state.error && !online ? 'error' : !this.remoteModel ? 'checking' : !remote.enabled ? 'disabled' : online ? 'ready' : 'connecting',
        message: !controlOnline ? '尚未连接服务端' : this.modelPeer?.state.error && !online ? '独立 Claude 模型通道连接失败，请确认 A、B 使用相同新版；网络代理不受影响' : !this.remoteModel ? '正在读取 B 的 Claude 服务状态' : !remote.enabled ? 'B 尚未启用 Claude 模型服务' : !online ? '正在连接独立的 Claude 模型通道' : 'Claude 模型服务已就绪', config: null };
    }
    const configured = Boolean(this.config?.workspace), enabled = this.modelEnabled && configured, hosting = this.peer?.role === 'host';
    return { enabled, configured, available: enabled && hosting, online: Boolean(hosting && this.modelPeer?.state.listening),
      state: !configured ? 'unconfigured' : !enabled ? 'disabled' : hosting ? 'ready' : 'offline',
      message: !configured ? '请先配置 Claude 工作目录与运行参数' : !enabled ? 'Claude 模型服务已关闭，网络共享不受影响' : hosting ? 'Claude 模型服务已就绪' : 'Claude 配置已保存，等待 B 服务端连接私有网络',
      config: this.peer?.role === 'client' ? null : this.config ? { ...this.config } : null };
  }
  broadcastModelStatus() {
    const peer = this.peer;
    if (peer?.role !== 'host') return;
    const { enabled, configured, available } = this.modelStatus();
    for (const connection of peer.connections) if (peer.isConnected(connection)) {
      try { peer.send({ type: 'model-status', id: randomUUID(), model: { enabled, configured, available } }, connection); } catch { connection.ws.terminate(); }
    }
  }
  cancelModelTasks(reason) {
    for (const task of this.active.values()) task.controller.abort();
    for (const task of this.queue) { try { task.emit({ type: 'error', code: 'MODEL_DISABLED', message: reason }); task.emit({ type: 'done', exitCode: null, cancelled: true }); } catch {} }
    this.queue = [];
  }
  async probe(command) { return this.demo ? { available: true, message: '演示模式：使用模拟 Claude，不调用真实模型' } : probeClaude(command || 'claude'); }
  broadcastProxyStatus() {
    const peer = this.peer;
    if (peer?.role !== 'host') return;
    for (const connection of peer.connections) {
      if (!peer.isConnected(connection) || connection.advertisedSharing === this.networkProxy.sharing) continue;
      connection.advertisedSharing = this.networkProxy.sharing;
      try { peer.send({ type: 'proxy-status', id: randomUUID(), sharing: this.networkProxy.sharing }, connection); }
      catch { connection.ws.terminate(); }
    }
  }
  onMessage(msg, connection) {
    if (!msg || typeof msg !== 'object' || !/^[a-f0-9-]{36}$/i.test(msg.id)) return;
    if (this.peer?.role === 'host' && msg.type === 'run' && this.peer.isConnected(connection)) {
      // Older clients sent model jobs on the control channel. Fail explicitly
      // instead of leaving their HTTP request waiting until its response timeout.
      try {
        this.peer.send({ type: 'event', id: msg.id, event: { type: 'error', code: 'MODEL_CHANNEL_REQUIRED', message: '模型服务已使用独立通道，请更新 A 端到相同版本' } }, connection);
        this.peer.send({ type: 'event', id: msg.id, event: { type: 'done', exitCode: null, cancelled: false } }, connection);
      } catch { connection.ws.terminate(); }
      return;
    }
    if (this.peer?.role === 'client' && msg.type === 'proxy-status' && typeof msg.sharing === 'boolean') {
      this.remoteSharing = msg.sharing;
      this.networkProxy.peerChanged();
      this.emit('state');
      return;
    }
    if (this.peer?.role === 'client' && msg.type === 'model-status' && msg.model && typeof msg.model === 'object') { this.remoteModel = msg.model; this.emit('state'); }
  }
  onModelMessage(msg, connection) {
    if (!msg || typeof msg !== 'object' || !/^[a-f0-9-]{36}$/i.test(msg.id)) return;
    if (this.peer?.role === 'host') {
      if (msg.type === 'run') this.handleRun(msg, connection);
      if (msg.type === 'cancel') this.cancelConnection(connection, msg.id);
    } else if (msg.type === 'event') {
      const pending = this.pending.get(msg.id);
      if (!pending || !msg.event || typeof msg.event !== 'object') return;
      if (msg.event.type === 'done') this.finishPending(msg.id, [{ ...msg.event, requestId: msg.id }]);
      else {
        try { pending.emit({ ...msg.event, requestId: msg.id }); }
        catch { pending.cancel(); this.finishPending(msg.id); }
      }
    }
  }
  handleRun(msg, connection) {
    const peer = this.modelPeer;
    if (!peer?.isConnected(connection)) return;
    const key = `${connection.id}:${msg.id}`;
    const emit = (event) => { if (this.modelPeer === peer && peer.isConnected(connection)) peer.send({ type: 'event', id: msg.id, event }, connection); };
    if (this.active.has(key) || this.queue.some((task) => task.key === key)) return;
    try {
      if (!this.modelEnabled || !this.config) throw new Error('B 尚未启用 Claude 模型服务，网络共享不受影响');
      const request = validateRequest(msg.request);
      if (request.sessionId && !this.sessions.get(connection)?.has(request.sessionId)) throw new Error('该会话不属于当前配对连接。请先不传 sessionId 创建会话');
      if ([...this.active.values(), ...this.queue].some((task) => task.connection === connection)) throw new Error('该 A 端已有任务执行或排队中');
      if (this.queue.length >= this.maxQueued) throw new Error('B 端任务队列已满，请稍后重试');
      this.queue.push({ key, id: msg.id, peer, connection, request, config: { ...this.config }, generation: this.modelGeneration, emit, controller: new AbortController() });
      this.drainQueue();
      this.updateQueue();
    } catch (error) {
      try { emit({ type: 'error', code: 'RUN_REJECTED', message: error.message }); emit({ type: 'done', exitCode: null, cancelled: false }); } catch {}
    }
  }
  updateQueue() {
    for (let index = 0; index < this.queue.length; index++) {
      try { this.queue[index].emit({ type: 'queued', position: index + 1, message: `B 端正在执行其他 A 的任务，当前排队第 ${index + 1} 位` }); }
      catch { this.queue[index].connection.ws.terminate(); }
    }
    this.emit('state');
  }
  drainQueue() {
    if (this.active.size) return;
    while (this.queue.length) {
      const task = this.queue.shift();
      if (this.modelPeer !== task.peer || !task.peer.isConnected(task.connection)) continue;
      this.active.set(task.key, task);
      this.executeTask(task);
      break;
    }
  }
  async executeTask(task) {
    const { peer, connection, request, emit, controller } = task;
    this.log(`开始任务 ${task.id.slice(0, 8)}`);
    try {
      await runClaude(task.config, request, (event) => {
        if (this.modelPeer !== peer || !peer.isConnected(connection)) return;
        const sessions = this.sessions.get(connection);
        if (task.generation === this.modelGeneration && request.kind !== 'model' && sessions && event.type === 'claude' && typeof event.event?.session_id === 'string') {
          if (sessions.size >= 1000) sessions.delete(sessions.values().next().value);
          sessions.add(event.event.session_id);
        }
        emit(event);
      }, controller.signal);
    } catch (error) {
      try { emit({ type: 'error', code: 'RUN_REJECTED', message: error.message }); emit({ type: 'done', exitCode: null, cancelled: false }); } catch {}
    } finally {
      this.active.delete(task.key);
      this.drainQueue();
      this.updateQueue();
    }
  }
  cancelConnection(connection, id) {
    for (const task of this.active.values()) if (task.connection === connection && (!id || task.id === id)) task.controller.abort();
    const cancelled = this.queue.filter((task) => task.connection === connection && (!id || task.id === id));
    this.queue = this.queue.filter((task) => !cancelled.includes(task));
    for (const task of cancelled) { try { task.emit({ type: 'done', exitCode: null, cancelled: true }); } catch {} }
    this.drainQueue();
    this.updateQueue();
  }
  run(input, emit, signal) {
    const request = validateRequest(input);
    signal?.throwIfAborted();
    if (this.peer?.role !== 'client' || !this.peer.state.online) throw new Error('A 端尚未连接 B 端');
    if (!this.modelPeer?.state.online) throw new Error('Claude 模型通道尚未连接，网络代理不受影响');
    if (this.pending.size) throw new Error('已有任务执行中，请等待完成或取消');
    const peer = this.modelPeer;
    const id = randomUUID();
    let cancelTimer;
    const retireConnection = (message) => {
      if (this.modelPeer !== peer) return;
      peer.update({ online: false, transport: 'offline', error: message });
      peer.ws?.terminate();
    };
    const cancel = () => {
      if (!this.pending.has(id) || cancelTimer) return;
      try { if (this.modelPeer === peer) peer.send({ type: 'cancel', id }); } catch {}
      cancelTimer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        // Never reuse a connection whose B has not confirmed cancellation:
        // disconnecting also revokes that connection's tasks and sessions.
        retireConnection('取消确认超时，正在重新连接 B');
        this.finishPending(id, [
          { type: 'error', requestId: id, code: 'CANCEL_TIMEOUT', message: 'B 端未确认取消，已断开本次连接并自动重连；原任务不会重放' },
          { type: 'done', requestId: id, exitCode: null, cancelled: true }
        ]);
      }, this.cancelTimeoutMs);
    };
    const timeout = setTimeout(() => {
      if (!this.pending.has(id)) return;
      retireConnection('等待 B 端响应超时，正在重新连接');
      this.finishPending(id, [{ type: 'error', requestId: id, code: 'RESPONSE_TIMEOUT', message: '等待 B 端响应超时' }, { type: 'done', requestId: id, exitCode: null, cancelled: true }]);
    }, this.responseTimeoutMs);
    const cleanup = () => { clearTimeout(timeout); clearTimeout(cancelTimer); signal?.removeEventListener('abort', cancel); };
    this.pending.set(id, { emit, cleanup, cancel });
    signal?.addEventListener('abort', cancel, { once: true });
    try { peer.send({ type: 'run', id, request }); }
    catch (error) { cleanup(); this.pending.delete(id); throw error; }
    this.emit('state');
    return id;
  }
  finishPending(id, events = []) {
    const pending = this.pending.get(id);
    if (!pending) return;
    // Release the busy state before notifying consumers: a completion callback
    // may immediately submit its next request or close the connection.
    this.pending.delete(id);
    pending.cleanup();
    this.emit('state');
    for (const event of events) { try { pending.emit(event); } catch { break; } }
  }
  cancel(id) { const task = this.pending.get(id); if (!task) return false; task.cancel(); return true; }
  cancelAll(reason) {
    for (const task of this.active.values()) task.controller.abort();
    this.queue = [];
    for (const id of [...this.pending.keys()]) this.finishPending(id, [
      { type: 'error', requestId: id, code: 'PEER_DISCONNECTED', message: reason },
      { type: 'done', requestId: id, exitCode: null, cancelled: true }
    ]);
  }
  async disconnect() { await this.stopPeer(); }
  async stopPeer() {
    const peer = this.peer, modelPeer = this.modelPeer;
    this.peer = null;
    this.modelPeer = null;
    this.remoteSharing = null;
    this.remoteModel = null;
    this.networkProxy.peerChanged();
    this.cancelAll('配对已断开');
    this.invitation = null;
    this.sessions.clear();
    await modelPeer?.close();
    await peer?.close();
    this.emit('state');
  }
}
