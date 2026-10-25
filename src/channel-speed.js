import { randomUUID } from 'node:crypto';
import { randomId } from './crypto.js';

const MAX_BYTES = 256 * 1024 * 1024, MAX_MS = 60000, COOLDOWN_MS = 15000;
const NATIVE_MAX_MS = 210000, UDP_MAX_BYTES = 512 * 1024 * 1024, TCP_STAGE_MAX_BYTES = 192 * 1024 * 1024;
const TCP_COUNTS = [1, 2, 4, 8, 16], TCP_MULTI_MAX_BYTES = 960 * 1024 * 1024, NATIVE_MAX_BYTES = 1472 * 1024 * 1024;
const TYPES = new Set(['speed-request', 'speed-offer', 'speed-reject', 'speed-cancel']);
const REASONS = new Set(['busy', 'unsupported', 'model-busy', 'cooldown', 'network-stopped', 'recovery-busy', 'control-unavailable',
  'target-changed', 'helper-changed', 'deadline', 'receiver-timeout', 'user-cancelled', 'closed', 'transport-failed']);
const PHASES = new Set(['connecting', 'download', 'upload', 'multi-download', 'multi-upload', 'udp-download', 'udp-upload', 'completed']);
const MESSAGES = {
  ready: '可测量当前 A 与 B 之间的上传、下载吞吐和往返延迟。',
  'not-connected': '请先连接配对设备。', unsupported: '当前对端不支持所需测速方式；TCP 自动逐档及低增幅提前停止需要两端均升级至 1.2.11 或更新版本。',
  'helper-unavailable': '现有组网通道尚未就绪；测速不会主动启动或登录组网组件。',
  'network-stopped': '私有网络已停止或正在切换，请连接后再测速。',
  'model-busy': '模型任务正在执行、排队或等待取消确认，请稍后再测速。',
  'recovery-busy': '本机桥接传输正在刷新，请完成后再测速。',
  busy: '通道测速正在进行，可随时取消。', cooldown: '通道测速冷却中，请稍后再试。', closed: '通道测速已关闭。',
};
const NOTES = [
  '下载固定表示 B→A，上传固定表示 A→B；两端报告采用相同方向。',
  '本测试仅测量配对通道参考吞吐，不访问外部测速网站，不代表原生 TCP/UDP 代理或 B 的外网带宽。',
  '每方向发送最多 20 秒、256 MiB；之后等待接收端确认最多 5 秒，整组最长 60 秒。速率按实际接收字节和耗时计算。',
  '上传、下载期间持续采样负载 RTT，最多保留 64 次结果；包含排队与通道处理时间，不是空闲或 ICMP 延迟。',
  '部分或缺失测量不能视作零速率；测速不修改配对、Clash、TUN、系统代理或路由。',
];
const NATIVE_NOTES = [
  '下载固定表示 B→A，上传固定表示 A→B；两端报告采用相同方向。',
  '通过原生 Tailscale 代理的 SOCKS、TCP 转发和 UDP 数据报路径访问固定合成目标，不访问外部测速网站，不代表 B 的外网带宽。',
  '每方向 TCP 按 1、2、4、8、16 条连接逐档测试；连续两档相比此前最佳实收速率提升不足 5% 时提前停止，已满五档则正常完成。每档共同使用 10 秒、192 MiB 预算，最多 50 秒发送预算、960 MiB；单连接基准就是第一档，已包含在预算内，不重复测试。聚合速率按总接收字节除以共同测量时长计算，不相加各连接速率。',
  '每方向 UDP 升档预算为 30 秒、512 MiB，预算耗尽后停止启动新档，当前档收尾确认可延长；整组最长 210 秒、合计最多 2944 MiB。速率按实际接收字节和耗时计算。',
  'UDP 从 1 Mbps 逐级加压至最高 1000 Mbps，每级约 1.5 秒；每包 1100 字节（含测速头）。报告展示短时测量的有效接收速率及对应丢包，目标发送速率不等于实测带宽。',
  'RTT 在 TCP 负载期间经相同原生代理路径采样，最多 64 次；不是空闲或 ICMP 延迟。',
  '部分或缺失测量不能视作零速率；测速不修改网络共享、配对、Clash、TUN、系统代理或路由。',
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

function transfer(value, maximum = MAX_BYTES) {
  if (!value || !integer(value.receivedBytes, maximum) || !finite(value.durationMs) || value.durationMs === 0 ||
      !['complete', 'partial', 'failed'].includes(value.completion) ||
      typeof value.limitReached !== 'boolean') return null;
  return { receivedBytes: value.receivedBytes, durationMs: value.durationMs,
    bytesPerSecond: value.durationMs > 0 ? value.receivedBytes * 1000 / value.durationMs : 0,
    completion: value.completion, limitReached: value.limitReached };
}

function multiTransfer(value, connections) {
  if (!value || !Array.isArray(value.streams) || value.streams.length !== connections ||
      !integer(value.receivedBytes, TCP_STAGE_MAX_BYTES) || !finite(value.durationMs, NATIVE_MAX_MS) ||
      !['complete', 'partial', 'failed'].includes(value.completion) || typeof value.limitReached !== 'boolean') return null;
  const streams = [];
  for (const [index, stream] of value.streams.entries()) {
    if (!stream || stream.index !== index || !integer(stream.receivedBytes, TCP_STAGE_MAX_BYTES) ||
        !finite(stream.durationMs, value.durationMs) || !['complete', 'partial', 'failed'].includes(stream.completion) ||
        typeof stream.limitReached !== 'boolean' || (stream.durationMs === 0 && (stream.receivedBytes !== 0 || stream.completion === 'complete'))) return null;
    streams.push({ index, receivedBytes: stream.receivedBytes, durationMs: stream.durationMs, completion: stream.completion, limitReached: stream.limitReached });
  }
  const receivedBytes = streams.reduce((sum, stream) => sum + stream.receivedBytes, 0);
  if (receivedBytes !== value.receivedBytes || (value.durationMs === 0 && (receivedBytes !== 0 || value.completion === 'complete')) ||
      (value.completion === 'complete' && streams.some((stream) => stream.completion !== 'complete'))) return null;
  return { receivedBytes, durationMs: value.durationMs, bytesPerSecond: value.durationMs > 0 ? receivedBytes * 1000 / value.durationMs : null,
    completion: value.completion, limitReached: value.limitReached, streams };
}

function tcpAdaptive(value) {
  if (!value || !Array.isArray(value.stages) || value.stages.length > TCP_COUNTS.length ||
      !['complete', 'partial', 'failed'].includes(value.completion) || ![null, 'completed', 'plateau', 'cancelled', 'failed'].includes(value.stopReason)) return null;
  const stages = [];
  for (const [index, stage] of value.stages.entries()) {
    if (stage?.index !== index || stage.connections !== TCP_COUNTS[index] || (index > 0 && stages[index - 1].completion !== 'complete')) return null;
    const measured = multiTransfer(stage, stage.connections); if (!measured) return null;
    stages.push({ index, connections: stage.connections, ...measured });
  }
  const totalReceivedBytes = stages.reduce((sum, stage) => sum + stage.receivedBytes, 0);
  if (!integer(totalReceivedBytes, TCP_MULTI_MAX_BYTES) || totalReceivedBytes !== value.totalReceivedBytes) return null;
  let bestStageIndex = null, plateauStageIndex = null, lowGainStages = 0;
  for (const stage of stages) if (stage.completion === 'complete') {
    const priorBestRate = bestStageIndex === null ? 0 : stages[bestStageIndex].bytesPerSecond;
    lowGainStages = priorBestRate > 0 && stage.bytesPerSecond * 100 < priorBestRate * 105 ? lowGainStages + 1 : 0;
    if (lowGainStages >= 2 && plateauStageIndex === null) plateauStageIndex = stage.index;
    if (bestStageIndex === null || stage.bytesPerSecond > priorBestRate) bestStageIndex = stage.index;
  }
  if (value.bestStageIndex !== bestStageIndex) return null;
  if (plateauStageIndex !== null && plateauStageIndex < TCP_COUNTS.length - 1 && stages.length > plateauStageIndex + 1) return null;
  const allComplete = stages.length === TCP_COUNTS.length && stages.every((stage) => stage.completion === 'complete');
  const plateauComplete = stages.length >= 3 && stages.length < TCP_COUNTS.length &&
    stages.every((stage) => stage.completion === 'complete') && plateauStageIndex === stages.length - 1;
  if ((value.completion === 'complete' || ['completed', 'plateau'].includes(value.stopReason)) &&
      !(value.completion === 'complete' && (value.stopReason === 'completed' && allComplete || value.stopReason === 'plateau' && plateauComplete))) return null;
  return { completion: value.completion, stages, bestStageIndex, totalReceivedBytes, stopReason: value.stopReason };
}

function sameBaseline(value, stage) {
  return Boolean(value && stage && ['receivedBytes', 'durationMs', 'completion', 'limitReached'].every((key) => value[key] === stage[key]));
}

const UDP_REASONS = new Set(['loss-limited', 'sender-limited', 'rate-ceiling', 'byte-budget', 'time-budget', 'cancelled', 'failed']);
const UDP_NORMAL_STOPS = new Set(['loss-limited', 'sender-limited', 'rate-ceiling', 'byte-budget', 'time-budget']);
const UDP_LOWER_BOUNDS = new Set(['sender-limited', 'rate-ceiling', 'byte-budget', 'time-budget']);
const UDP_PACKET_LIMIT = Math.floor(UDP_MAX_BYTES / 1100);

function udpStage(value, index) {
  if (!value || value.index !== index || !integer(value.targetBytesPerSecond, 125000000) || value.targetBytesPerSecond < 31250 ||
      value.offeredBytesPerSecond !== value.targetBytesPerSecond || value.packetBytes !== 1100 ||
      !['complete', 'partial', 'failed'].includes(value.completion) || typeof value.limitReached !== 'boolean' ||
      !integer(value.receivedBytes, UDP_MAX_BYTES) || !integer(value.receivedPackets, UDP_PACKET_LIMIT) ||
      value.receivedBytes !== value.receivedPackets * 1100 || !finite(value.durationMs, 30000) ||
      (value.durationMs === 0 && value.receivedBytes !== 0) ||
      !integer(value.duplicatePackets, 10000000) || !integer(value.outOfOrderPackets, value.receivedPackets)) return null;
  const senderKnown = value.sentBytes !== null && value.sentPackets !== null && value.senderDurationMs !== null && value.senderBytesPerSecond !== null;
  if (senderKnown ? !integer(value.sentBytes, UDP_MAX_BYTES) || !integer(value.sentPackets, UDP_PACKET_LIMIT) ||
      value.receivedPackets > value.sentPackets || value.sentBytes !== value.sentPackets * 1100 ||
      !finite(value.senderDurationMs, 30000) || value.senderDurationMs === 0 || value.durationMs < value.senderDurationMs ||
      !finite(value.senderBytesPerSecond, UDP_MAX_BYTES * 1000)
    : value.sentBytes !== null || value.sentPackets !== null || value.senderDurationMs !== null || value.senderBytesPerSecond !== null) return null;
  const confirmed = value.lostPackets !== null && value.lossPercent !== null;
  if (confirmed ? !senderKnown || !integer(value.lostPackets, value.sentPackets) ||
      value.lostPackets !== value.sentPackets - value.receivedPackets || !finite(value.lossPercent, 100)
    : value.lostPackets !== null || value.lossPercent !== null) return null;
  if (value.completion === 'complete' && (!confirmed || value.durationMs === 0)) return null;
  const senderBytesPerSecond = senderKnown ? value.sentBytes * 1000 / value.senderDurationMs : null;
  const lossPercent = confirmed ? value.sentPackets ? (value.sentPackets - value.receivedPackets) * 100 / value.sentPackets : 0 : null;
  const targetReached = senderKnown && senderBytesPerSecond >= value.targetBytesPerSecond * 0.85;
  const assessment = value.completion !== 'complete' ? 'incomplete' : !targetReached ? 'sender-limited' : lossPercent > 1 ? 'loss-limited' : 'passed';
  if (value.targetReached !== targetReached || value.assessment !== assessment) return null;
  return { index, targetBytesPerSecond: value.targetBytesPerSecond, senderDurationMs: value.senderDurationMs, senderBytesPerSecond,
    targetReached, assessment, receivedBytes: value.receivedBytes, durationMs: value.durationMs,
    bytesPerSecond: value.durationMs > 0 ? value.receivedBytes * 1000 / value.durationMs : null,
    completion: value.completion, limitReached: value.limitReached, sentBytes: value.sentBytes, sentPackets: value.sentPackets,
    receivedPackets: value.receivedPackets, lostPackets: confirmed ? value.sentPackets - value.receivedPackets : null, lossPercent,
    duplicatePackets: value.duplicatePackets, outOfOrderPackets: value.outOfOrderPackets,
    offeredBytesPerSecond: value.offeredBytesPerSecond, packetBytes: value.packetBytes };
}

function udpTransfer(value) {
  if (!value || value.mode !== 'adaptive' || !['complete', 'partial', 'failed'].includes(value.completion) ||
      !Array.isArray(value.stages) || value.stages.length > 16 || value.rateCeilingBytesPerSecond !== 125000000 ||
      value.lossThresholdPercent !== 1 || value.minimumSenderRatio !== 0.85 ||
      !(value.stopReason === null || UDP_REASONS.has(value.stopReason)) ||
      value.lowerBound !== UDP_LOWER_BOUNDS.has(value.stopReason)) return null;
  const stages = value.stages.map(udpStage);
  if (stages.some((stage) => stage === null)) return null;
  const totalSentBytes = stages.reduce((sum, stage) => sum + (stage.sentBytes ?? 0), 0);
  const totalReceivedBytes = stages.reduce((sum, stage) => sum + stage.receivedBytes, 0);
  if (!integer(totalSentBytes, UDP_MAX_BYTES) || !integer(totalReceivedBytes, UDP_MAX_BYTES) ||
      value.totalSentBytes !== totalSentBytes || value.totalReceivedBytes !== totalReceivedBytes) return null;
  let lowLossStageIndex = null, peakStageIndex = null;
  for (const stage of stages) {
    if (stage.completion !== 'complete') continue;
    if (peakStageIndex === null || stage.bytesPerSecond > stages[peakStageIndex].bytesPerSecond) peakStageIndex = stage.index;
    if (stage.lossPercent <= 1 && (lowLossStageIndex === null || stage.bytesPerSecond > stages[lowLossStageIndex].bytesPerSecond)) lowLossStageIndex = stage.index;
  }
  if (value.lowLossStageIndex !== lowLossStageIndex || value.peakStageIndex !== peakStageIndex ||
      (value.completion === 'complete' && (peakStageIndex === null || !UDP_NORMAL_STOPS.has(value.stopReason)))) return null;
  if (value.stopReason === 'sender-limited' && !stages.some((stage) => stage.completion === 'complete' && stage.assessment === 'sender-limited') ||
      value.stopReason === 'loss-limited' && !stages.some((stage) => stage.completion === 'complete' && stage.assessment === 'loss-limited') ||
      value.stopReason === 'rate-ceiling' && !stages.some((stage) => stage.completion === 'complete' && stage.targetBytesPerSecond === 125000000 && stage.assessment === 'passed')) return null;
  return { mode: 'adaptive', completion: value.completion, stages, lowLossStageIndex, peakStageIndex,
    stopReason: value.stopReason, lowerBound: value.lowerBound, totalSentBytes, totalReceivedBytes,
    rateCeilingBytesPerSecond: 125000000, lossThresholdPercent: 1, minimumSenderRatio: 0.85 };
}

export class ChannelSpeed {
  constructor({ bridge, transport, now = () => performance.now(), utcNow = () => new Date().toISOString(),
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    if (!bridge || !transport) throw fail('通道测速配置无效', 400, 'speed-invalid-configuration');
    Object.assign(this, { bridge, transport, now, utcNow, setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn });
    this.context = null; this.job = null; this.lastStarted = null; this.seenIds = new Set();
    this.native = transport.native === true;
    this.version = this.native ? 6 : 1; this.transportName = this.native ? 'native-tailscale' : 'legacy-websocket';
  }
  supported(connection) { return this.native ? connection.capabilities?.nativeSpeed === 5 : connection.capabilities?.speedTest === 2; }
  notify() { try { this.bridge.emit?.('state'); } catch { /* UI observers cannot alter the speed session. */ } }
  baseReason() {
    const b = this.bridge, adapter = b.networkAdapter;
    if (this.closed) return 'closed';
    if (b.closing || b.applicationClosing || b.stopRequested || b.paused || b.identityChanging || b.intentOnline === false || b.pairingInvalid) return 'network-stopped';
    if (b.pending?.size || b.active?.size || b.queue?.length) return 'model-busy';
    if (b.channelRefreshActive || b.channelRecovery?.refreshing === true) return 'recovery-busy';
    if (this.native && typeof adapter?.nativeSpeedPrepare !== 'function') return 'helper-unavailable';
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
      // Display metadata never supplies a dial target. A uses its paired B;
      // native B binds the authenticated A address as an inbound permission.
      const address = peer.role === 'client' ? peer.pairing?.host : connection.device?.address;
      return { connection, info: { id: connection.id, name: name || (role === 'host' ? '当前配对服务端' : '已授权调用端'), role,
        supported: this.supported(connection),
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
    return { transport: this.transportName, connected: targets.length > 0, available: reason === 'ready', reason, message: MESSAGES[reason], targets,
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
    const report = { v: this.version, transport: this.transportName, completed: false, startedAtUtc: this.utcNow(), finishedAtUtc: null,
      targetRole: peer.role === 'client' ? 'host' : 'client', maximumSeconds: this.native ? 210 : 60, maxBytesPerDirection: this.native ? NATIVE_MAX_BYTES : MAX_BYTES,
      stopReason: null, latency: null, download: null, upload: null,
      ...(this.native ? { tcpMaxBytesPerDirection: TCP_STAGE_MAX_BYTES, tcpStageMaxBytes: TCP_STAGE_MAX_BYTES, tcpStageSeconds: 10,
        tcpMultiMaxBytesPerDirection: TCP_MULTI_MAX_BYTES, tcpMultiSecondsPerDirection: 50,
        tcpMulti: { mode: 'adaptive', connectionCounts: [...TCP_COUNTS], earlyStop: { minimumGainPercent: 5, consecutiveStages: 2 }, download: null, upload: null }, udpMaxBytesPerDirection: UDP_MAX_BYTES,
        tcpSecondsPerDirection: 10, udpSecondsPerDirection: 30, udpBudgetIsSoft: true, udp: { download: null, upload: null } } : {}), notes: [...(this.native ? NATIVE_NOTES : NOTES)] };
    const job = this.job = { id, state: 'running', progress: { phase: 'connecting', elapsedMs: 0 }, report };
    let resolveOperation;
    const operation = new Promise((resolve) => { resolveOperation = resolve; });
    const context = this.context = { job, peer, connection, session: connection.session, adapter, child: adapter?.child,
      resource: peer.dialResource, controller: new AbortController(), operation, resolveOperation, operationStarted: false, stopReason: null };
    this.lastStarted = this.now(); this.bridge.channelSpeedActive = true;
    context.onState = () => { const reason = this.changed(context); if (reason) this.stop(context, reason); };
    this.bridge.on?.('state', context.onState);
    context.timer = this.setTimeoutFn(() => this.stop(context, 'deadline'), this.native ? NATIVE_MAX_MS : MAX_MS); context.timer?.unref?.();
    context.monitor = this.setIntervalFn(context.onState, 250); context.monitor?.unref?.();
    this.running = Promise.resolve().then(() => this.run(context));
    this.notify(); return context;
  }
  changed(context) {
    if (this.closed) return 'closed';
    if (this.bridge.networkAdapter !== context.adapter || (context.adapter?.embedded && context.adapter.child !== context.child)) return 'helper-changed';
    if (!this.current(context.peer, context.connection) || context.connection.session !== context.session ||
        (context.peer.role === 'client' && context.peer.dialResource !== context.resource)) return 'target-changed';
    if (!this.supported(context.connection)) return 'unsupported';
    const reason = this.baseReason();
    return reason === 'ready' ? null : reason === 'helper-unavailable' ? 'helper-changed' : reason;
  }
  send(context, body) {
    if (context.stopReason && body.type !== 'speed-cancel') return false;
    if (!this.current(context.peer, context.connection) || context.connection.session !== context.session) return false;
    try { return context.peer.trySendSpeedMessage?.({ ...body, v: this.version, id: context.job.id }, context.connection) === true; } catch { return false; }
  }
  reject(message, connection, peer, reason) {
    if (!this.current(peer, connection)) return;
    try { peer.trySendSpeedMessage?.({ type: 'speed-reject', v: message.v, id: message.id, reason }, connection); } catch { /* Best effort only. */ }
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
      if (this.native) {
        const reservation = this.transport.host(this.transportOptions(context, ticket));
        this.startOperation(context, reservation.result);
        void Promise.resolve(reservation.ready).then((endpoint) => {
          const changed = this.changed(context);
          if (changed) this.stop(context, changed);
          if (context.stopReason) return;
          if (!this.send(context, { type: 'speed-offer', session: context.session, ticket, port: endpoint.port })) this.stop(context, 'control-unavailable', false);
        }).catch((error) => this.stop(context, this.changed(context) || (REASONS.has(error?.reason) ? error.reason : 'transport-failed')));
        return;
      }
      // host() registers the pending ticket synchronously before offer is sent.
      const promise = this.transport.host(this.transportOptions(context, ticket));
      this.startOperation(context, promise);
      if (!this.send(context, { type: 'speed-offer', session: context.session, ticket })) this.stop(context, 'control-unavailable', false);
    } catch { this.stop(context, 'transport-failed'); }
  }
  startClient(context, ticket, port) {
    if (context.stopReason) return;
    try { this.startOperation(context, this.transport.client({ ...this.transportOptions(context, ticket), ...(this.native ? { port } : {}) })); }
    catch { this.stop(context, 'transport-failed'); }
  }
  onMessage(message, connection, peer = this.bridge.peer) {
    if (!TYPES.has(message?.type)) return false;
    if (!uuid(message.id) || !this.current(peer, connection)) return true;
    if (message.v !== this.version) {
      if ([1, 2, 3, 4, 5, 6].includes(message.v) && ['speed-request', 'speed-offer'].includes(message.type)) this.reject(message, connection, peer, 'unsupported');
      return true;
    }
    if (message.type === 'speed-request') {
      if (peer.role !== 'host') return true;
      if (this.context?.job.id === message.id && this.context.connection === connection) return true;
      if (this.seenIds.has(message.id)) return true;
      const reason = this.status().reason;
      if (!this.supported(connection)) { this.reject(message, connection, peer, 'unsupported'); return true; }
      if (reason !== 'ready') { this.reject(message, connection, peer, reason === 'helper-unavailable' ? 'network-stopped' : REASONS.has(reason) ? reason : 'unsupported'); return true; }
      this.startHost(this.create(connection, message.id)); return true;
    }
    if (message.type === 'speed-offer') {
      if (peer.role !== 'client' || message.session !== connection.session || typeof message.ticket !== 'string' || !/^[\w-]{43}$/.test(message.ticket)) return true;
      if (this.native && (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535)) return true;
      if (!this.supported(connection)) { this.reject(message, connection, peer, 'unsupported'); return true; }
      const existing = this.context;
      if (existing?.job.id === message.id && existing.connection === connection && existing.session === connection.session) {
        if (!existing.operationStarted && !existing.stopReason) {
          const changed = this.changed(existing);
          if (changed) this.stop(existing, changed); else this.startClient(existing, message.ticket, message.port);
        }
        return true;
      }
      if (this.seenIds.has(message.id)) return true;
      const reason = this.status().reason;
      if (reason !== 'ready') { this.reject(message, connection, peer, reason === 'helper-unavailable' ? 'network-stopped' : REASONS.has(reason) ? reason : 'unsupported'); return true; }
      this.startClient(this.create(connection, message.id), message.ticket, message.port); return true;
    }
    const context = this.context;
    if (!context || context.peer !== peer || context.connection !== connection || context.session !== connection.session || context.job.id !== message.id || !REASONS.has(message.reason)) return true;
    this.stop(context, message.reason, false); return true;
  }
  progress(context, value) {
    if (this.context !== context || context.stopReason || !value || !PHASES.has(value.phase)) return;
    const reason = this.changed(context); if (reason) { this.stop(context, reason); return; }
    const progress = { phase: value.phase };
    if (this.native && ['tcp', 'udp'].includes(value.protocol)) progress.protocol = value.protocol;
    if (this.native && value.protocol === 'udp') {
      if (integer(value.stageIndex, 15)) progress.stageIndex = value.stageIndex;
      if (integer(value.stageCount, 16)) progress.stageCount = value.stageCount;
      if (finite(value.stageElapsedMs, 30000)) progress.stageElapsedMs = value.stageElapsedMs;
      if (finite(value.targetBytesPerSecond, 125000000)) progress.targetBytesPerSecond = value.targetBytesPerSecond;
      if (finite(value.senderBytesPerSecond, UDP_MAX_BYTES * 1000)) progress.senderBytesPerSecond = value.senderBytesPerSecond;
    }
    if (this.native && value.phase.startsWith('multi-')) {
      if (integer(value.stageIndex, 4)) progress.stageIndex = value.stageIndex;
      if (integer(value.stageCount, 5)) progress.stageCount = value.stageCount;
      if (finite(value.stageElapsedMs, NATIVE_MAX_MS)) progress.stageElapsedMs = value.stageElapsedMs;
      if (TCP_COUNTS.includes(value.connections)) progress.connections = value.connections;
    }
    for (const key of ['elapsedMs', 'durationMs', 'latencyMs']) if (finite(value[key], this.native ? NATIVE_MAX_MS : MAX_MS)) progress[key] = value[key];
    for (const key of ['bytes', 'maxBytes']) if (integer(value[key], this.native ? NATIVE_MAX_BYTES : MAX_BYTES)) progress[key] = value[key];
    if (finite(value.bytesPerSecond, MAX_BYTES * 1000)) progress.bytesPerSecond = value.bytesPerSecond;
    if (integer(value.samplesDone, 64)) progress.samplesDone = value.samplesDone;
    if (typeof value.waitingForReceiver === 'boolean') progress.waitingForReceiver = value.waitingForReceiver;
    if (finite(value.confirmationRemainingMs, 5000)) progress.confirmationRemainingMs = value.confirmationRemainingMs;
    this.measure(context.job.report, value);
    context.job.progress = progress; this.notify();
  }
  stop(context, reason, notifyRemote = true) {
    if (context.stopReason) return;
    context.stopReason = REASONS.has(reason) ? reason : 'transport-failed'; context.job.report.stopReason = context.stopReason;
    if (notifyRemote) this.send(context, { type: 'speed-cancel', reason: context.stopReason });
    context.controller.abort(context.stopReason);
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
  measure(report, value) {
    const measuredLatency = latency(value.latency), maximum = this.native ? 192 * 1024 * 1024 : MAX_BYTES;
    const download = !this.native && transfer(value.download, maximum), upload = !this.native && transfer(value.upload, maximum);
    if (measuredLatency) report.latency = measuredLatency;
    if (download) report.download = download;
    if (upload) report.upload = upload;
    let complete = this.native || download?.completion === 'complete' && upload?.completion === 'complete';
    const plan = value.tcpMulti;
    const validPlan = plan?.mode === 'adaptive' && Array.isArray(plan.connectionCounts) && plan.connectionCounts.length === TCP_COUNTS.length &&
      plan.connectionCounts.every((count, index) => count === TCP_COUNTS[index]) && plan.earlyStop?.minimumGainPercent === 5 && plan.earlyStop?.consecutiveStages === 2;
    if (this.native) for (const direction of ['download', 'upload']) {
      const measured = udpTransfer(value.udp?.[direction]); if (measured) report.udp[direction] = measured;
      const multi = validPlan ? tcpAdaptive(plan[direction]) : null;
      if (multi) report.tcpMulti[direction] = multi;
      const stage = multi?.stages[0], baselineMatches = sameBaseline(value[direction], stage);
      if (stage) report[direction] = { receivedBytes: stage.receivedBytes, durationMs: stage.durationMs, bytesPerSecond: stage.bytesPerSecond,
        completion: stage.completion, limitReached: stage.limitReached };
      complete &&= measured?.completion === 'complete' && multi?.completion === 'complete' && baselineMatches;
    }
    return complete;
  }
  async run(context) {
    const { job } = context, { report } = job;
    try {
      const result = await context.operation;
      const changed = this.changed(context); if (changed) this.stop(context, changed);
      let finalComplete = false;
      if (result && typeof result === 'object') {
        finalComplete = this.measure(report, result);
        if (!context.stopReason && result.completed !== true) this.stop(context, REASONS.has(result.stopReason) ? result.stopReason : 'transport-failed');
      }
      report.completed = !context.stopReason && result?.completed === true && (!this.native || finalComplete) &&
        report.download?.completion === 'complete' && report.upload?.completion === 'complete' &&
        (!this.native || report.tcpMulti.download?.completion === 'complete' && report.tcpMulti.upload?.completion === 'complete' &&
          report.udp.download?.completion === 'complete' && report.udp.upload?.completion === 'complete');
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
