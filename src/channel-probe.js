import { randomUUID } from 'node:crypto';
import { isTailscaleIp } from './tailscale.js';

const PLAN = Array.from({ length: 3 }, () => [{ type: 'TSMP', size: 0 }, { type: 'disco', size: 128 }, { type: 'disco', size: 1200 }]).flat();
const OUTCOMES = new Set(['reply', 'timeout', 'cancelled', 'busy', 'unavailable', 'probe-error', 'invalid-request']);
const GROUP_MS = 35000, COOLDOWN_MS = 60000, RPC_BOUND_MS = 4000;
const MESSAGES = {
  ready: '可手动探测当前配对设备；探测发送少量网络数据，不会修改系统网络设置。',
  closed: '网络探测已关闭。', unsupported: '当前运行模式不提供内置网络探测。',
  'network-stopped': '私有网络已停止或正在切换，请连接后再试。',
  'helper-unavailable': '现有内置组网组件尚未就绪；探测不会主动启动或登录。',
  'model-busy': '模型任务正在执行、排队或等待取消确认，请稍后再探测。',
  'recovery-busy': '桥接传输正在自动刷新，请完成后再探测。',
  'no-targets': '没有当前在线且已授权的配对设备可供探测。',
  busy: '网络探测正在进行；取消后会等待已发出的探测请求结束。',
  cooldown: '网络探测冷却中；每次开始后至少间隔 60 秒。',
};
const NOTES = [
  'TSMP 使用固定 29 字节内部 IPv4 包，实际路径未知，不能用于验证大包 MTU。',
  'disco 的 128/1200 字节指包含协议头的 UDP 载荷，不代表 WireGuard 大流量或下载测速。',
  'disco 可能主动发现并刷新节点路径；本探测不修改配对、系统网络设置或自动恢复策略。',
  '超时表示 2.5 秒内没有获得探测回复，不是单向丢包率或网站服务故障的证明。',
  'completed 仅表示固定探测计划执行完成，不代表网络健康。报告不包含设备名称或网络地址。',
];
const error = (message, status, code) => Object.assign(new Error(message), { status, code });
const copy = (value) => value === null ? null : structuredClone(value);

function delay(ms, signal) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

function safeResult(value, item) {
  const row = { type: item.type, size: item.size, outcome: 'invalid-result', actualVia: 'unknown' };
  if (!value || value.type !== item.type || value.size !== item.size || !OUTCOMES.has(value.outcome)) return row;
  row.outcome = value.outcome;
  if (row.outcome !== 'reply') return row;
  if (!Number.isFinite(value.latencySeconds) || value.latencySeconds < 0 || value.latencySeconds > 5) {
    row.outcome = 'invalid-result'; return row;
  }
  row.latencySeconds = value.latencySeconds;
  if (item.type === 'TSMP') return row;
  if (['direct', 'peer-relay'].includes(value.actualVia)) row.actualVia = value.actualVia;
  else if (value.actualVia === 'derp' && Number.isInteger(value.derpRegionId) && value.derpRegionId > 0 && value.derpRegionId <= 65535) {
    row.actualVia = 'derp'; row.derpRegionId = value.derpRegionId;
    if (typeof value.derpRegionCode === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(value.derpRegionCode)) row.derpRegionCode = value.derpRegionCode;
  }
  return row;
}

// Manual, in-memory jobs only. Targets are captured authenticated connections;
// the native layer additionally checks that the chosen address is an online peer.
export class ChannelProbe {
  constructor({ bridge, now = () => performance.now(), utcNow = () => new Date().toISOString(),
    delayFn = delay, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    if (!bridge) throw error('缺少桥接实例', 400, 'probe-invalid-configuration');
    Object.assign(this, { bridge, now, utcNow, delayFn, setTimeoutFn, clearTimeoutFn });
    this.lastStarted = null; this.job = null; this.context = null;
  }
  notify() { try { this.bridge.emit?.('state'); } catch { /* UI listeners never control the probe. */ } }
  reason() {
    const b = this.bridge, adapter = b.networkAdapter, peer = b.peer;
    if (this.closed) return 'closed';
    if (b.demo || adapter?.embedded !== true || typeof adapter.channelProbe !== 'function') return 'unsupported';
    if (b.closing || b.applicationClosing || b.stopRequested || b.paused || b.identityChanging || b.intentOnline === false || b.pairingInvalid) return 'network-stopped';
    if (adapter.closed || adapter.wantRunning !== true || !adapter.child?.stdin?.writable || !adapter.initialized?.has(adapter.child)) return 'helper-unavailable';
    if (b.pending?.size || b.active?.size || b.queue?.length) return 'model-busy';
    if (b.channelRecovery?.refreshing === true) return 'recovery-busy';
    if (!peer || !['client', 'host'].includes(peer.role) || typeof peer.isConnected !== 'function') return 'no-targets';
    return 'ready';
  }
  candidates() {
    const peer = this.bridge.peer;
    if (!peer || typeof peer.isConnected !== 'function') return [];
    const connections = peer.role === 'client' ? [peer.clientConnection] : peer.role === 'host' ? [...(peer.connections || [])] : [];
    return connections.filter((connection) => connection && peer.isConnected(connection) && typeof connection.id === 'string' &&
      connection.id.length > 0 && connection.id.length <= 128).flatMap((connection) => {
      const address = peer.role === 'client' ? peer.pairing?.host : connection.device?.address;
      if (!isTailscaleIp(address)) return [];
      const role = peer.role === 'client' ? 'host' : 'client';
      const name = typeof connection.device?.name === 'string' ? connection.device.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : '';
      return [{ connection, address, info: { id: connection.id, name: name || (role === 'host' ? '当前配对服务端' : '已授权调用端'), address, role } }];
    });
  }
  status() {
    const targets = this.candidates().map(({ info }) => ({ ...info }));
    const busy = this.context !== null;
    const retryAfterMs = this.lastStarted === null ? 0 : Math.max(0, Math.ceil(COOLDOWN_MS - (this.now() - this.lastStarted)));
    let reason = this.reason();
    if (reason === 'ready' && !targets.length) reason = 'no-targets';
    if (busy && reason !== 'closed') reason = 'busy';
    else if (reason === 'ready' && retryAfterMs) reason = 'cooldown';
    return { available: reason === 'ready', reason, message: MESSAGES[reason], targets, busy, retryAfterMs, job: copy(this.job) };
  }
  start(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
        typeof input.targetId !== 'string' || !input.targetId.length || input.targetId.length > 128) {
      throw error('请选择当前已授权的探测设备', 400, 'probe-invalid-target');
    }
    if (this.context) throw error('网络探测正在进行，请等待或取消当前探测', 409, 'probe-busy');
    const status = this.status();
    if (status.reason === 'cooldown') throw error('网络探测冷却中，请稍后再试', 429, 'probe-cooldown');
    if (!status.available) throw error('当前无法探测，请确认私有网络已连接、没有模型任务且设备已授权', 409, `probe-${status.reason}`);
    const target = this.candidates().find(({ info }) => info.id === input.targetId);
    if (!target) throw error('所选设备已断开或授权已变化，请重新选择', 409, 'probe-target-unavailable');
    const adapter = this.bridge.networkAdapter, child = adapter.child, peer = this.bridge.peer;
    const report = { v: 1, completed: false, startedAtUtc: this.utcNow(), finishedAtUtc: null, targetRole: target.info.role,
      plannedProbes: 9, completedProbes: 0, replies: 0, maximumSeconds: 35, helperUnchanged: false, stopReason: null, results: [], notes: [...NOTES] };
    const job = this.job = { id: randomUUID(), state: 'running', report };
    const context = this.context = { job, target, adapter, child, peer, controller: new AbortController(), startedAt: this.now(), stopReason: null };
    this.lastStarted = context.startedAt;
    this.bridge.channelProbeActive = true;
    this.notify();
    // The POST returns this small job immediately. Only subsequent status reads
    // expose progress; no HTTP connection must wait for the network sequence.
    this.running = Promise.resolve().then(() => this.run(context));
    return copy(job);
  }
  cancel(jobId) {
    if (jobId !== undefined && (typeof jobId !== 'string' || !this.job || jobId !== this.job.id)) {
      throw error('没有找到该网络探测任务', 404, 'probe-job-not-found');
    }
    if (this.context) this.stop(this.context, 'user-cancelled');
    return copy(this.job);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.context) this.stop(this.context, 'closed');
    this.notify();
  }
  stop(context, reason) {
    if (!context.stopReason) {
      context.stopReason = reason; context.job.report.stopReason = reason;
      context.controller.abort(); this.notify();
    }
  }
  changed(context) {
    if (this.closed) return 'closed';
    if (this.bridge.networkAdapter !== context.adapter || context.adapter.child !== context.child) return 'helper-changed';
    if (this.bridge.peer !== context.peer) return 'target-changed';
    const reason = this.reason();
    if (reason !== 'ready') return ['helper-unavailable', 'unsupported'].includes(reason) ? 'helper-changed' : reason === 'no-targets' ? 'target-changed' : reason;
    if (!context.peer.isConnected(context.target.connection)) return 'target-changed';
    const current = this.candidates().find(({ connection }) => connection === context.target.connection);
    if (!current || current.address !== context.target.address) return 'target-changed';
    return null;
  }
  async run(context) {
    const { job, adapter, child } = context, { report } = job;
    let timer;
    try {
      timer = this.setTimeoutFn(() => this.stop(context, 'deadline'), GROUP_MS);
      timer?.unref?.();
      let previousStart = null;
      for (const item of PLAN) {
        if (context.controller.signal.aborted) break;
        let changed = this.changed(context);
        if (changed) { this.stop(context, changed); break; }
        if (previousStart !== null) await this.delayFn(Math.max(0, 1000 - (this.now() - previousStart)), context.controller.signal);
        if (context.controller.signal.aborted) break;
        changed = this.changed(context);
        if (changed) { this.stop(context, changed); break; }
        // Reserve the wrapper's four-second non-destructive RPC bound. The
        // final outstanding call can settle within the 35-second group budget.
        if (this.now() - context.startedAt > GROUP_MS - RPC_BOUND_MS) { this.stop(context, 'deadline'); break; }
        previousStart = this.now();
        let row;
        try {
          const value = await adapter.channelProbe({ host: context.target.address, type: item.type, size: item.size }, child);
          changed = this.changed(context);
          if (context.controller.signal.aborted || changed) {
            if (changed) this.stop(context, changed);
            row = { type: item.type, size: item.size, outcome: 'cancelled', actualVia: 'unknown' };
          } else row = safeResult(value, item);
        } catch {
          changed = this.changed(context);
          if (changed) this.stop(context, changed);
          row = { type: item.type, size: item.size, outcome: context.controller.signal.aborted ? 'cancelled' : 'rpc-gap', actualVia: 'unknown' };
        }
        report.results.push(row); report.completedProbes = report.results.length;
        if (row.outcome === 'reply') report.replies++;
        this.notify();
        if (row.outcome === 'busy') this.stop(context, 'probe-busy');
        else if (row.outcome === 'unavailable' || row.outcome === 'rpc-gap') this.stop(context, 'rpc-unavailable');
      }
      report.helperUnchanged = this.bridge.networkAdapter === adapter && adapter.child === child && !adapter.closed;
      report.completed = !context.stopReason && report.completedProbes === PLAN.length && report.helperUnchanged;
      job.state = report.completed ? 'completed' : ['user-cancelled', 'closed', 'model-busy', 'network-stopped', 'helper-changed', 'target-changed', 'recovery-busy'].includes(context.stopReason) ? 'cancelled' : 'failed';
    } catch {
      this.stop(context, context.stopReason || 'probe-group-failed'); job.state = 'failed';
    } finally {
      this.clearTimeoutFn(timer);
      report.completedProbes = report.results.length;
      report.helperUnchanged = this.bridge.networkAdapter === adapter && adapter.child === child && !adapter.closed;
      report.finishedAtUtc = this.utcNow(); report.stopReason = context.stopReason;
      if (this.context === context) {
        this.context = null; this.bridge.channelProbeActive = false;
      }
      this.notify();
    }
  }
}
