import { randomUUID } from 'node:crypto';
import { randomId } from './crypto.js';

const MAX_BYTES = 256 * 1024 * 1024, MAX_MS = 60000, COOLDOWN_MS = 15000;
const TYPES = new Set(['speed-request', 'speed-offer', 'speed-reject', 'speed-cancel']);
const REASONS = new Set(['busy', 'unsupported', 'model-busy', 'cooldown', 'network-stopped', 'recovery-busy', 'control-unavailable',
  'target-changed', 'helper-changed', 'deadline', 'receiver-timeout', 'user-cancelled', 'closed', 'transport-failed']);
const PHASES = new Set(['connecting', 'download', 'upload', 'completed']);
const MESSAGES = {
  ready: '可测量当前 A 与 B 之间的上传、下载吞吐和往返延迟。',
  'not-connected': '请先连接配对设备。', unsupported: '当前对端不支持新版测速，请将两端升级至 1.2.0 或更新版本。',
  'helper-unavailable': '现有组网通道尚未就绪；测速不会主动启动或登录组网组件。',
  'network-stopped': '私有网络已停止或正在切换，请连接后再测速。',
  'model-busy': '模型任务正在执行、排队或等待取消确认，请稍后再测速。',
  'recovery-busy': '本机桥接传输正在刷新，请完成后再测速。',
  busy: '通道测速正在进行，可随时取消。', cooldown: '通道测速冷却中，请稍后再试。', closed: '通道测速已关闭。',
};
const NOTES = [
  '下载固定表示 B→A，上传固定表示 A→B；两端报告采用相同方向。',
  '本测试仅在当前桥接通道之间传送内存数据，不访问外部测速网站，不代表 B 的外网带宽。',
  '每方向发送最多 20 秒、256 MiB；之后等待接收端确认最多 5 秒，整组最长 60 秒。速率按实际接收字节和耗时计算。',
  '上传、下载期间持续采样负载 RTT，最多保留 64 次结果；包含排队与通道处理时间，不是空闲或 ICMP 延迟。',
  '部分或缺失测量不能视作零速率；测速不修改配对、Clash、TUN、系统代理或路由。',
];
const uuid = (value) => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const finite = (value, maximum = MAX_MS) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const clone = (value) => value === null ? null : structuredClone(value);
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

function latency(value) {
  if (!value || !Array.isArray(value.samples) || value.samples.length > 64 || !value.samples.every((sample) => finite(sample)) ||
      !integer(value.failedSamples, 64) || value.samples.length + value.failedSamples > 64) return null;
  const samples = [...value.samples], sorted = [...samples].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { samples, minMs: sorted[0] ?? null, medianMs: sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null,
    maxMs: sorted.at(-1) ?? null, failedSamples: value.failedSamples };
}

function transfer(value) {
  if (!value || !integer(value.receivedBytes, MAX_BYTES) || !finite(value.durationMs) || value.durationMs === 0 ||
      !['complete', 'partial', 'failed'].includes(value.completion) ||
      typeof value.limitReached !== 'boolean') return null;
  return { receivedBytes: value.receivedBytes, durationMs: value.durationMs,
    bytesPerSecond: value.durationMs > 0 ? value.receivedBytes * 1000 / value.durationMs : 0,
    completion: value.completion, limitReached: value.limitReached };
}

export class ChannelSpeed {
  constructor({ bridge, transport, now = () => performance.now(), utcNow = () => new Date().toISOString(),
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    if (!bridge || !transport) throw fail('通道测速配置无效', 400, 'speed-invalid-configuration');
    Object.assign(this, { bridge, transport, now, utcNow, setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn });
    this.context = null; this.job = null; this.lastStarted = null; this.seenIds = new Set();
  }
  notify() { try { this.bridge.emit?.('state'); } catch { /* UI observers cannot alter the speed session. */ } }
  baseReason() {
    const b = this.bridge, adapter = b.networkAdapter;
    if (this.closed) return 'closed';
    if (b.closing || b.applicationClosing || b.stopRequested || b.paused || b.identityChanging || b.intentOnline === false || b.pairingInvalid) return 'network-stopped';
    if (b.pending?.size || b.active?.size || b.queue?.length) return 'model-busy';
    if (b.channelRecovery?.refreshing === true) return 'recovery-busy';
    if (adapter?.embedded && (adapter.closed || adapter.wantRunning !== true || !adapter.child?.stdin?.writable || !adapter.initialized?.has(adapter.child))) return 'helper-unavailable';
    return 'ready';
  }
  current(peer, connection) {
    return peer && peer === this.bridge.peer && ['host', 'client'].includes(peer.role) && typeof peer.isConnected === 'function' &&
      peer.isConnected(connection) && (peer.role === 'host' || connection === peer.clientConnection);
  }
  candidates() {
    const peer = this.bridge.peer;
    if (!peer) return [];
    const connections = peer.role === 'client' ? [peer.clientConnection] : peer.role === 'host' ? [...(peer.connections || [])] : [];
    return connections.filter((connection) => this.current(peer, connection) && typeof connection.id === 'string' &&
      connection.id.length > 0 && connection.id.length <= 128).map((connection) => {
      const role = peer.role === 'client' ? 'host' : 'client';
      const name = typeof connection.device?.name === 'string' ? connection.device.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : '';
      // Addresses are display-only metadata. Every A always opens the existing
      // forwarder to B; a B never dials this advertised A address.
      const address = peer.role === 'client' ? peer.pairing?.host : connection.device?.address;
      return { connection, info: { id: connection.id, name: name || (role === 'host' ? '当前配对服务端' : '已授权调用端'), role,
        supported: connection.capabilities?.speedTest === 2,
        ...(typeof address === 'string' && /^[\d.:a-fA-F]{1,80}$/.test(address) ? { address } : {}) } };
    });
  }
  status() {
    const targets = this.candidates().map(({ info }) => ({ ...info })), busy = this.context !== null;
    const retryAfterMs = this.lastStarted === null ? 0 : Math.max(0, Math.ceil(COOLDOWN_MS - (this.now() - this.lastStarted)));
    let reason = this.baseReason();
    if (reason === 'ready' && !targets.length) reason = 'not-connected';
    else if (reason === 'ready' && !targets.some((target) => target.supported)) reason = 'unsupported';
    if (busy && reason !== 'closed') reason = 'busy';
    else if (reason === 'ready' && retryAfterMs) reason = 'cooldown';
    return { connected: targets.length > 0, available: reason === 'ready', reason, message: MESSAGES[reason], targets,
      busy, retryAfterMs, job: clone(this.job) };
  }
  start(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
        typeof input.targetId !== 'string' || !input.targetId.length || input.targetId.length > 128) throw fail('请选择当前配对设备，无需其他参数', 400, 'speed-invalid-target');
    if (this.context) throw fail(MESSAGES.busy, 409, 'speed-busy');
    const status = this.status();
    if (!status.available) throw fail(MESSAGES[status.reason], status.reason === 'cooldown' ? 429 : 409, `speed-${status.reason}`);
    const target = this.candidates().find(({ info }) => info.id === input.targetId);
    if (!target) throw fail('所选设备已断开或连接已变化，请重新选择', 409, 'speed-target-unavailable');
    if (!target.info.supported) throw fail(MESSAGES.unsupported, 409, 'speed-unsupported');
    const context = this.create(target.connection, randomUUID());
    if (context.peer.role === 'host') this.startHost(context);
    else if (!this.send(context, { type: 'speed-request' })) this.stop(context, 'control-unavailable', false);
    return clone(context.job);
  }
  create(connection, id) {
    this.seenIds.add(id);
    if (this.seenIds.size > 64) this.seenIds.delete(this.seenIds.values().next().value);
    const peer = this.bridge.peer, adapter = this.bridge.networkAdapter;
    const report = { v: 1, completed: false, startedAtUtc: this.utcNow(), finishedAtUtc: null,
      targetRole: peer.role === 'client' ? 'host' : 'client', maximumSeconds: 60, maxBytesPerDirection: MAX_BYTES,
      stopReason: null, latency: null, download: null, upload: null, notes: [...NOTES] };
    const job = this.job = { id, state: 'running', progress: { phase: 'connecting', elapsedMs: 0 }, report };
    let resolveOperation;
    const operation = new Promise((resolve) => { resolveOperation = resolve; });
    const context = this.context = { job, peer, connection, session: connection.session, adapter, child: adapter?.child,
      resource: peer.dialResource, controller: new AbortController(), operation, resolveOperation, operationStarted: false, stopReason: null };
    this.lastStarted = this.now(); this.bridge.channelSpeedActive = true;
    context.onState = () => { const reason = this.changed(context); if (reason) this.stop(context, reason); };
    this.bridge.on?.('state', context.onState);
    context.timer = this.setTimeoutFn(() => this.stop(context, 'deadline'), MAX_MS); context.timer?.unref?.();
    context.monitor = this.setIntervalFn(context.onState, 250); context.monitor?.unref?.();
    this.running = Promise.resolve().then(() => this.run(context));
    this.notify(); return context;
  }
  changed(context) {
    if (this.closed) return 'closed';
    if (this.bridge.networkAdapter !== context.adapter || (context.adapter?.embedded && context.adapter.child !== context.child)) return 'helper-changed';
    if (!this.current(context.peer, context.connection) || context.connection.session !== context.session ||
        (context.peer.role === 'client' && context.peer.dialResource !== context.resource)) return 'target-changed';
    if (context.connection.capabilities?.speedTest !== 2) return 'unsupported';
    const reason = this.baseReason();
    return reason === 'ready' ? null : reason === 'helper-unavailable' ? 'helper-changed' : reason;
  }
  send(context, body) {
    if (context.stopReason && body.type !== 'speed-cancel') return false;
    if (!this.current(context.peer, context.connection) || context.connection.session !== context.session) return false;
    try { return context.peer.trySendSpeedMessage?.({ ...body, v: 1, id: context.job.id }, context.connection) === true; } catch { return false; }
  }
  reject(message, connection, peer, reason) {
    if (!this.current(peer, connection)) return;
    try { peer.trySendSpeedMessage?.({ type: 'speed-reject', v: 1, id: message.id, reason }, connection); } catch { /* Best effort only. */ }
  }
  startOperation(context, promise) {
    context.operationStarted = true; context.resolveOperation(Promise.resolve(promise));
  }
  transportOptions(context, ticket) {
    return { peer: context.peer, connection: context.connection, id: context.job.id, session: context.session, ticket,
      signal: context.controller.signal, onProgress: (progress) => this.progress(context, progress) };
  }
  startHost(context) {
    if (context.stopReason) return;
    const ticket = randomId(32);
    try {
      // host() registers the pending ticket synchronously before offer is sent.
      const promise = this.transport.host(this.transportOptions(context, ticket));
      this.startOperation(context, promise);
      if (!this.send(context, { type: 'speed-offer', session: context.session, ticket })) this.stop(context, 'control-unavailable', false);
    } catch { this.stop(context, 'transport-failed'); }
  }
  startClient(context, ticket) {
    if (context.stopReason) return;
    try { this.startOperation(context, this.transport.client(this.transportOptions(context, ticket))); }
    catch { this.stop(context, 'transport-failed'); }
  }
  onMessage(message, connection, peer = this.bridge.peer) {
    if (!TYPES.has(message?.type)) return false;
    if (message.v !== 1 || !uuid(message.id) || !this.current(peer, connection)) return true;
    if (message.type === 'speed-request') {
      if (peer.role !== 'host') return true;
      if (this.context?.job.id === message.id && this.context.connection === connection) return true;
      if (this.seenIds.has(message.id)) return true;
      const reason = this.status().reason;
      if (connection.capabilities?.speedTest !== 2) { this.reject(message, connection, peer, 'unsupported'); return true; }
      if (reason !== 'ready') { this.reject(message, connection, peer, reason === 'helper-unavailable' ? 'network-stopped' : REASONS.has(reason) ? reason : 'unsupported'); return true; }
      this.startHost(this.create(connection, message.id)); return true;
    }
    if (message.type === 'speed-offer') {
      if (peer.role !== 'client' || message.session !== connection.session || typeof message.ticket !== 'string' || !/^[\w-]{43}$/.test(message.ticket)) return true;
      if (connection.capabilities?.speedTest !== 2) { this.reject(message, connection, peer, 'unsupported'); return true; }
      const existing = this.context;
      if (existing?.job.id === message.id && existing.connection === connection && existing.session === connection.session) {
        if (!existing.operationStarted && !existing.stopReason) {
          const changed = this.changed(existing);
          if (changed) this.stop(existing, changed); else this.startClient(existing, message.ticket);
        }
        return true;
      }
      if (this.seenIds.has(message.id)) return true;
      const reason = this.status().reason;
      if (reason !== 'ready') { this.reject(message, connection, peer, reason === 'helper-unavailable' ? 'network-stopped' : REASONS.has(reason) ? reason : 'unsupported'); return true; }
      this.startClient(this.create(connection, message.id), message.ticket); return true;
    }
    const context = this.context;
    if (!context || context.peer !== peer || context.connection !== connection || context.session !== connection.session || context.job.id !== message.id || !REASONS.has(message.reason)) return true;
    this.stop(context, message.reason, false); return true;
  }
  progress(context, value) {
    if (this.context !== context || context.stopReason || !value || !PHASES.has(value.phase)) return;
    const reason = this.changed(context); if (reason) { this.stop(context, reason); return; }
    const progress = { phase: value.phase };
    for (const key of ['elapsedMs', 'durationMs', 'latencyMs']) if (finite(value[key])) progress[key] = value[key];
    for (const key of ['bytes', 'maxBytes']) if (integer(value[key], MAX_BYTES)) progress[key] = value[key];
    if (finite(value.bytesPerSecond, MAX_BYTES * 1000)) progress.bytesPerSecond = value.bytesPerSecond;
    if (integer(value.samplesDone, 64)) progress.samplesDone = value.samplesDone;
    if (typeof value.waitingForReceiver === 'boolean') progress.waitingForReceiver = value.waitingForReceiver;
    if (finite(value.confirmationRemainingMs, 5000)) progress.confirmationRemainingMs = value.confirmationRemainingMs;
    const measuredLatency = latency(value.latency), download = transfer(value.download), upload = transfer(value.upload);
    if (measuredLatency) context.job.report.latency = measuredLatency;
    if (download) context.job.report.download = download;
    if (upload) context.job.report.upload = upload;
    context.job.progress = progress; this.notify();
  }
  stop(context, reason, notifyRemote = true) {
    if (context.stopReason) return;
    context.stopReason = REASONS.has(reason) ? reason : 'transport-failed'; context.job.report.stopReason = context.stopReason;
    if (notifyRemote) this.send(context, { type: 'speed-cancel', reason: context.stopReason });
    context.controller.abort();
    if (!context.operationStarted) context.resolveOperation(null);
    this.notify();
  }
  cancel(jobId) {
    if (jobId !== undefined && (typeof jobId !== 'string' || !this.job || jobId !== this.job.id)) throw fail('没有找到该测速任务', 404, 'speed-job-not-found');
    if (this.context) this.stop(this.context, 'user-cancelled');
    return clone(this.job);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.context) this.stop(this.context, 'closed');
    try { const closing = this.transport.close?.(); closing?.catch?.(() => {}); } catch { /* Only the test transport is disposed. */ }
    this.notify();
  }
  async run(context) {
    const { job } = context, { report } = job;
    try {
      const result = await context.operation;
      const changed = this.changed(context); if (changed) this.stop(context, changed);
      if (result && typeof result === 'object') {
        const measuredLatency = latency(result.latency), download = transfer(result.download), upload = transfer(result.upload);
        if (measuredLatency) report.latency = measuredLatency;
        if (download) report.download = download;
        if (upload) report.upload = upload;
        if (!context.stopReason && result.completed !== true) this.stop(context, REASONS.has(result.stopReason) ? result.stopReason : 'transport-failed');
      }
      report.completed = !context.stopReason && result?.completed === true &&
        report.download?.completion === 'complete' && report.upload?.completion === 'complete';
      if (!report.completed && !context.stopReason) this.stop(context, 'transport-failed');
    } catch { if (!context.stopReason) this.stop(context, this.changed(context) || 'transport-failed'); }
    finally {
      this.clearTimeoutFn(context.timer); this.clearIntervalFn(context.monitor);
      this.bridge.off?.('state', context.onState);
      report.stopReason = context.stopReason; report.finishedAtUtc = this.utcNow();
      job.state = report.completed ? 'completed' : ['user-cancelled', 'closed', 'model-busy', 'network-stopped', 'recovery-busy', 'target-changed', 'helper-changed'].includes(context.stopReason) ? 'cancelled' : 'failed';
      if (report.completed) job.progress = { phase: 'completed' };
      if (this.context === context) { this.context = null; this.bridge.channelSpeedActive = false; }
      this.notify();
    }
  }
}
