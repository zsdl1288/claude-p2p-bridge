import { randomUUID } from 'node:crypto';

const REASONS = new Set(['refreshed', 'cooldown', 'budget-exhausted', 'unavailable', 'busy', 'model-busy', 'speed-busy',
  'recovery-busy', 'network-stopped', 'not-connected', 'unsupported', 'target-changed', 'helper-changed', 'deadline',
  'user-cancelled', 'closed', 'control-unavailable']);
const PATHS = new Set(['direct', 'derp', 'peer-relay', 'unknown']);
const TEXT = {
  ready: '重新探测当前配对通道，保留服务端与配对；不保证切换路径或提高速度。',
  'not-connected': '请先连接当前配对设备。', unsupported: '所选调用端尚不支持远程刷新，请升级调用端。',
  unavailable: '现有内置组网通道尚未就绪；不会主动启动或登录组网组件。',
  busy: '通道刷新正在进行。', 'model-busy': '模型任务正在执行或排队，请稍后再试。',
  'speed-busy': '测速正在进行，请完成后再刷新通道。', 'recovery-busy': '自动恢复正在刷新通道，请稍后再试。',
  'network-stopped': '私有网络已停止或正在切换。', cooldown: '通道刷新冷却中，请稍后重试。',
  'budget-exhausted': '已达到三十分钟内三次的刷新上限，请稍后重试。', closed: '通道刷新已关闭。',
};
const uuid = (value) => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed, required) => object(value) && Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const clone = (value) => value === null ? null : structuredClone(value);
const unknown = () => ({ path: 'unknown', latencyMs: null });
const failure = (reason) => Object.assign(new Error('通道刷新已停止'), { reason });
const apiFailure = (reason, status = 409) => Object.assign(new Error(TEXT[reason] || '通道刷新暂不可用。'), { status, code: `refresh-${reason}` });

function route(value) {
  if (!keys(value, ['path', 'latencyMs', 'regionCode', 'regionId'], ['path', 'latencyMs']) || !PATHS.has(value.path) ||
      !(value.latencyMs === null || typeof value.latencyMs === 'number' && Number.isFinite(value.latencyMs) && value.latencyMs >= 0 && value.latencyMs <= 20000) ||
      (Object.hasOwn(value, 'regionCode') && (value.path !== 'derp' || typeof value.regionCode !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(value.regionCode))) ||
      (Object.hasOwn(value, 'regionId') && (value.path !== 'derp' || !integer(value.regionId, 65535) || value.regionId === 0))) return null;
  return { path: value.path, latencyMs: value.latencyMs, ...(value.regionCode ? { regionCode: value.regionCode } : {}),
    ...(value.regionId ? { regionId: value.regionId } : {}) };
}
function changed(before, after) {
  if (before.path === 'unknown' || after.path === 'unknown') return null;
  if (before.path !== after.path) return true;
  if (before.path !== 'derp') return false;
  if (before.regionId && after.regionId) return before.regionId !== after.regionId;
  if (before.regionCode && after.regionCode) return before.regionCode !== after.regionCode;
  return null;
}
export function sanitizeRefreshResult(value) {
  if (!keys(value, ['refreshed', 'reason', 'before', 'after', 'changed', 'retryAfterMs'], ['refreshed', 'reason', 'before', 'after', 'changed']) ||
      typeof value.refreshed !== 'boolean' || !REASONS.has(value.reason) || value.reason === 'refreshed' && !value.refreshed ||
      !(value.changed === null || typeof value.changed === 'boolean') ||
      Object.hasOwn(value, 'retryAfterMs') && (!integer(value.retryAfterMs, 1800000) || value.retryAfterMs === 0)) return null;
  const before = route(value.before), after = route(value.after);
  if (!before || !after || value.changed !== changed(before, after)) return null;
  return { refreshed: value.refreshed, reason: value.reason, before, after, changed: value.changed,
    ...(value.retryAfterMs ? { retryAfterMs: value.retryAfterMs } : {}) };
}
export function isRefreshMessage(value) {
  if (!object(value) || value.v !== 1 || !uuid(value.id)) return false;
  if (value.type === 'channel-refresh-request') return keys(value, ['type', 'v', 'id'], ['type', 'v', 'id']);
  return value.type === 'channel-refresh-result' && keys(value, ['type', 'v', 'id', 'result'], ['type', 'v', 'id', 'result']) && Boolean(sanitizeRefreshResult(value.result));
}

export class ChannelRefresh {
  constructor({ bridge, now = () => performance.now(), utcNow = () => new Date().toISOString(), deadlineMs = 20000,
    probeTimeoutMs = 4000, refreshTimeoutMs = 5000, settleMs = 800, monitorMs = 250,
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    if (!bridge || ![deadlineMs, probeTimeoutMs, refreshTimeoutMs, monitorMs].every((value) => Number.isSafeInteger(value) && value > 0) ||
        deadlineMs > 20000 || probeTimeoutMs > 4000 || refreshTimeoutMs > 5000 || !integer(settleMs, 2000)) throw apiFailure('unavailable', 400);
    Object.assign(this, { bridge, now, utcNow, deadlineMs, probeTimeoutMs, refreshTimeoutMs, settleMs, monitorMs,
      setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn });
    this.context = null; this.job = null; this.seenIds = new Set(); this.cooldowns = new WeakMap();
  }
  notify() { try { this.bridge.emit?.('state'); } catch { /* Observers cannot affect refresh. */ } }
  current(peer, connection) {
    return peer === this.bridge.peer && ['client', 'host'].includes(peer?.role) && peer.isConnected?.(connection) === true &&
      (peer.role === 'host' || peer.clientConnection === connection);
  }
  baseReason(context = null) {
    const b = this.bridge, adapter = b.networkAdapter;
    if (this.closed) return 'closed';
    if (b.demo || b.closing || b.applicationClosing || b.stopRequested || b.paused || b.identityChanging || b.intentOnline === false || b.pairingInvalid) return 'network-stopped';
    if (b.pending?.size || b.active?.size || b.queue?.length) return 'model-busy';
    if (b.channelSpeedActive || b.channelProbeActive) return 'speed-busy';
    if (b.channelRecovery?.refreshing && !(context?.local && context.job.phase === 'refreshing')) return 'recovery-busy';
    if (b.channelRefreshActive && !this.context) return 'busy';
    if (!adapter?.embedded || adapter.closed || adapter.wantRunning !== true || !adapter.child?.stdin?.writable || !adapter.initialized?.has(adapter.child)) return 'unavailable';
    return 'ready';
  }
  candidates() {
    const peer = this.bridge.peer;
    const connections = peer?.role === 'client' ? [peer.clientConnection] : peer?.role === 'host' ? [...(peer.connections || [])] : [];
    return connections.filter((connection) => this.current(peer, connection) && typeof connection.id === 'string' && connection.id.length > 0 && connection.id.length <= 128)
      .map((connection) => {
        const role = peer.role === 'client' ? 'host' : 'client', raw = peer.role === 'client' ? peer.pairing?.host : connection.device?.address;
        return { connection, info: { id: connection.id, role, supported: peer.role === 'client' || connection.capabilities?.channelRefresh === 1,
          name: typeof connection.device?.name === 'string' ? connection.device.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) || '当前配对设备' : '当前配对设备',
          ...(typeof raw === 'string' && /^[\da-fA-F:.]{1,80}$/.test(raw) ? { address: raw } : {}) } };
      });
  }
  status() {
    const candidates = this.candidates(), targets = candidates.map(({ info }) => info), busy = Boolean(this.context);
    let reason = this.baseReason(), retryAfterMs = 0;
    if (reason === 'ready' && !targets.length) reason = 'not-connected';
    if (reason === 'ready' && !targets.some((target) => target.supported)) reason = 'unsupported';
    if (reason === 'ready' && this.bridge.peer?.role === 'client') {
      const status = this.bridge.channelRecovery?.manualStatus?.();
      reason = status?.available ? 'ready' : REASONS.has(status?.reason) ? status.reason : 'unavailable';
      retryAfterMs = integer(status?.retryAfterMs, 1800000) ? status.retryAfterMs : 0;
    } else if (reason === 'ready') {
      const waits = candidates.filter(({ info }) => info.supported).map(({ connection }) => Math.max(0, (this.cooldowns.get(connection) || 0) - this.now()));
      if (waits.length && waits.every((wait) => wait > 0)) { reason = 'cooldown'; retryAfterMs = Math.ceil(Math.min(...waits)); }
    }
    if (busy && reason !== 'closed') reason = 'busy';
    return { connected: targets.length > 0, available: reason === 'ready', busy, reason, message: TEXT[reason] || TEXT.unavailable,
      retryAfterMs, targets, job: clone(this.job) };
  }
  start(input) {
    if (!keys(input, ['targetId'], ['targetId']) || typeof input.targetId !== 'string' || !input.targetId.length || input.targetId.length > 128) throw apiFailure('target-changed', 400);
    const status = this.status();
    if (!status.available) throw apiFailure(status.reason, ['cooldown', 'budget-exhausted'].includes(status.reason) ? 429 : 409);
    const target = this.candidates().find(({ info }) => info.id === input.targetId);
    if (!target) throw apiFailure('target-changed');
    if (!target.info.supported) throw apiFailure('unsupported');
    if (this.bridge.peer.role === 'host' && (this.cooldowns.get(target.connection) || 0) > this.now()) throw apiFailure('cooldown', 429);
    const context = this.create(target.connection, randomUUID(), false);
    if (!context.local) {
      if (!this.send(context, { type: 'channel-refresh-request', v: 1, id: context.job.id })) this.finish(context, this.result(context, 'control-unavailable'));
      else if (!context.finished && this.context === context) this.phase(context, 'refreshing');
    }
    return clone(context.job);
  }
  create(connection, id, remote) {
    const peer = this.bridge.peer, adapter = this.bridge.networkAdapter;
    this.seenIds.add(id); if (this.seenIds.size > 128) this.seenIds.delete(this.seenIds.values().next().value);
    const job = this.job = { id, targetId: connection.id, state: 'running', phase: 'before', startedAtUtc: this.utcNow(), finishedAtUtc: null, result: null };
    let stop;
    const context = this.context = { peer, adapter, connection, session: connection.session, child: adapter?.child, resource: peer.dialResource,
      host: peer.pairing?.host, local: peer.role === 'client', remote, job, before: unknown(), after: unknown(), accepted: false,
      stopped: new Promise((resolve) => { stop = resolve; }) };
    context.stop = stop; this.bridge.channelRefreshActive = true;
    context.onState = () => { const reason = this.changed(context); if (reason) this.finish(context, this.result(context, reason)); };
    this.bridge.on?.('state', context.onState);
    context.timer = this.setTimeoutFn(() => this.finish(context, this.result(context, 'deadline')), this.deadlineMs); context.timer?.unref?.();
    context.monitor = this.setIntervalFn(context.onState, this.monitorMs); context.monitor?.unref?.();
    this.running = Promise.resolve().then(() => context.local ? this.run(context) : context.stopped);
    this.notify(); return context;
  }
  changed(context) {
    if (context.finished || this.context !== context) return 'closed';
    if (this.bridge.networkAdapter !== context.adapter || context.adapter?.child !== context.child) return 'helper-changed';
    if (!this.current(context.peer, context.connection) || context.connection.session !== context.session || context.peer.pairing?.host !== context.host ||
        (context.local && context.peer.dialResource !== context.resource)) return 'target-changed';
    if (!context.local && context.connection.capabilities?.channelRefresh !== 1) return 'unsupported';
    const reason = this.baseReason(context); return reason === 'ready' ? null : reason;
  }
  guard(context) { const reason = this.changed(context); if (reason) throw failure(reason); }
  send(context, message) {
    if (context.finished && message.type === 'channel-refresh-request' || !this.current(context.peer, context.connection) ||
        context.connection.session !== context.session || !isRefreshMessage(message)) return false;
    try { return context.peer.trySendRefreshMessage?.(message, context.connection) === true; } catch { return false; }
  }
  result(context, reason, retryAfterMs) {
    return { refreshed: context.accepted, reason, before: clone(context.before), after: clone(context.after), changed: changed(context.before, context.after),
      ...(integer(retryAfterMs, 1800000) && retryAfterMs > 0 ? { retryAfterMs } : {}) };
  }
  finish(context, result) {
    if (context.finished || this.context !== context) return;
    context.finished = true; context.stop();
    this.clearTimeoutFn(context.timer); this.clearIntervalFn(context.monitor); this.bridge.off?.('state', context.onState);
    context.job.result = sanitizeRefreshResult(result) || this.result(context, 'unavailable');
    context.job.state = context.job.result.reason === 'refreshed' && context.job.result.refreshed ? 'completed' : 'failed';
    context.job.phase = context.job.state === 'completed' ? 'completed' : context.job.phase;
    context.job.finishedAtUtc = this.utcNow();
    if (!context.local && (result.refreshed || result.retryAfterMs)) this.cooldowns.set(context.connection, this.now() + (result.retryAfterMs || 120000));
    if (context.remote) this.send(context, { type: 'channel-refresh-result', v: 1, id: context.job.id, result: context.job.result });
    this.context = null; this.bridge.channelRefreshActive = false; this.notify();
  }
  async bounded(context, operation, timeoutMs) {
    let timer;
    try {
      const expired = Symbol('expired'), stopped = Symbol('stopped');
      const result = await Promise.race([operation, context.stopped.then(() => stopped), new Promise((resolve) => {
        timer = this.setTimeoutFn(() => resolve(expired), timeoutMs); timer?.unref?.();
      })]);
      this.guard(context);
      if (result === expired) throw failure('deadline');
      if (result === stopped) throw failure('closed');
      return result;
    } finally { this.clearTimeoutFn(timer); }
  }
  phase(context, phase) { this.guard(context); context.job.phase = phase; this.notify(); }
  async probe(context) {
    this.guard(context);
    if (typeof context.adapter.channelProbe !== 'function') return unknown();
    let value;
    try { value = await this.bounded(context, context.adapter.channelProbe({ host: context.host, type: 'disco', size: 128 }, context.child), this.probeTimeoutMs); }
    catch (error) { this.guard(context); if (error.reason === 'deadline') return unknown(); return unknown(); }
    this.guard(context);
    if (value?.outcome !== 'reply') return unknown();
    const candidate = { path: PATHS.has(value.actualVia) ? value.actualVia : 'unknown',
      latencyMs: typeof value.latencySeconds === 'number' && Number.isFinite(value.latencySeconds) && value.latencySeconds >= 0 && value.latencySeconds <= 20 ? value.latencySeconds * 1000 : null,
      ...(value.actualVia === 'derp' && typeof value.derpRegionCode === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(value.derpRegionCode) ? { regionCode: value.derpRegionCode } : {}),
      ...(value.actualVia === 'derp' && integer(value.derpRegionId, 65535) && value.derpRegionId > 0 ? { regionId: value.derpRegionId } : {}) };
    return route(candidate) || unknown();
  }
  async run(context) {
    try {
      this.guard(context); context.before = await this.probe(context); this.guard(context);
      this.phase(context, 'refreshing'); this.guard(context);
      if (typeof this.bridge.channelRecovery?.manualRefresh !== 'function') throw failure('unavailable');
      const result = await this.bounded(context, this.bridge.channelRecovery.manualRefresh({ peer: context.peer, adapter: context.adapter,
        child: context.child, isCurrent: () => !this.changed(context) }), this.refreshTimeoutMs);
      this.guard(context); context.accepted = result?.refreshed === true;
      if (!context.accepted || result?.reason !== 'refreshed') {
        const budget = this.bridge.channelRecovery.manualStatus?.();
        this.finish(context, this.result(context, REASONS.has(result?.reason) ? result.reason : 'unavailable', result?.retryAfterMs || budget?.retryAfterMs)); return;
      }
      this.phase(context, 'after'); this.guard(context);
      if (this.settleMs) await this.bounded(context, new Promise((resolve) => {
        context.settleTimer = this.setTimeoutFn(resolve, this.settleMs);
      }), this.settleMs + 100);
      this.guard(context); context.after = await this.probe(context); this.guard(context);
      this.finish(context, this.result(context, 'refreshed'));
    } catch (error) { if (!context.finished) this.finish(context, this.result(context, REASONS.has(error?.reason) ? error.reason : 'unavailable')); }
    finally { this.clearTimeoutFn(context.settleTimer); }
  }
  onMessage(message, connection, peer = this.bridge.peer) {
    if (!['channel-refresh-request', 'channel-refresh-result'].includes(message?.type)) return false;
    if (!isRefreshMessage(message) || !this.current(peer, connection)) return true;
    if (message.type === 'channel-refresh-result') {
      const context = this.context;
      if (peer.role === 'host' && context && !context.local && context.peer === peer && context.connection === connection &&
          context.session === connection.session && context.job.id === message.id && !this.changed(context)) this.finish(context, sanitizeRefreshResult(message.result));
      return true;
    }
    if (peer.role !== 'client' || connection.capabilities?.channelRefresh !== 1 || this.seenIds.has(message.id)) return true;
    const status = this.status();
    if (!status.available) {
      const result = { refreshed: false, reason: REASONS.has(status.reason) ? status.reason : 'unavailable', before: unknown(), after: unknown(), changed: null,
        ...(status.retryAfterMs ? { retryAfterMs: status.retryAfterMs } : {}) };
      try { peer.trySendRefreshMessage?.({ type: 'channel-refresh-result', v: 1, id: message.id, result }, connection); } catch { /* Optional replies do not close control. */ }
      return true;
    }
    this.create(connection, message.id, true); return true;
  }
  cancel(reason = 'user-cancelled') {
    if (this.context) this.finish(this.context, this.result(this.context, REASONS.has(reason) ? reason : 'user-cancelled'));
    return clone(this.job);
  }
  close() { if (this.closed) return; this.closed = true; this.cancel('closed'); }
}
