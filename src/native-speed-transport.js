import { validatePeerAddress } from './tailscale.js';

const port = (value) => Number.isInteger(value) && value > 0 && value <= 65535;
const phases = new Map([['waiting', 'connecting'], ['connecting', 'connecting'],
  ['tcp-adaptive-download', 'multi-download'], ['tcp-adaptive-upload', 'multi-upload'],
  ['udp-download', 'udp-download'], ['udp-upload', 'udp-upload'], ['completed', 'completed']]);
const stopped = () => Object.assign(new Error('原生测速已取消'), { code: 'speed-cancelled' });

// This adapter moves only invitations and bounded statistics through JS. The
// native owner uses an isolated proxy instance and synthetic TCP/UDP targets.
export class NativeSpeedTransport {
  constructor({ bridge, pollMs = 500, leaseMs = 5000, now = () => performance.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.bridge = bridge; this.adapter = bridge.networkAdapter; this.native = true;
    this.transport = 'native-tailscale'; this.pollMs = pollMs; this.leaseMs = leaseMs; this.now = now; this.sleep = sleep; this.epoch = 0;
  }
  valid(job) {
    const { peer, connection, session, signal } = job.options;
    return !this.closed && !signal?.aborted && this.bridge.peer === peer && peer.isConnected(connection)
      && connection.session === session && (peer.role === 'host' || peer.clientConnection === connection)
      && this.bridge.networkAdapter === this.adapter && this.adapter?.child === job.child;
  }
  create(options) {
    if (this.closed || this.job || !options || typeof options.id !== 'string' || typeof options.ticket !== 'string'
      || typeof options.session !== 'string' || !options.signal) throw new Error('原生测速会话无效');
    const job = { options, child: this.adapter?.child, last: null, done: false, stop: null };
    if (!this.valid(job)) throw stopped();
    this.job = job;
    job.abort = () => { void this.cancel(job); };
    options.signal.addEventListener('abort', job.abort, { once: true });
    return job;
  }
  accept(job, value) {
    if (value?.protocolVersion !== 5) throw Object.assign(new Error('原生测速组件版本过旧，请升级至 1.2.11 或更新版本'), { reason: 'unsupported' });
    if (value.id !== job.options.id || typeof value.finished !== 'boolean' || !phases.has(value.phase)
      || !value.metrics || typeof value.metrics !== 'object') throw new Error('原生测速响应无效');
    job.last = value;
    if (!job.stop && this.valid(job)) {
      const phase = phases.get(value.phase), udp = phase.startsWith('udp-') ? value.metrics.udp?.[phase.slice(4)] : null;
      const tcp = phase.startsWith('multi-') ? value.metrics.tcpMulti?.[phase.slice(6)] : null;
      const measured = (udp || tcp)?.stages?.at(-1);
      const now = this.now();
      if (job.phase !== phase) { job.phase = phase; job.phaseStartedAt = now; }
      const stageKey = `${phase}:${measured?.index}`;
      if ((udp || tcp) && job.stageKey !== stageKey) { job.stageKey = stageKey; job.stageStartedAt = now; }
      const transferring = ['multi-download', 'multi-upload', 'udp-download', 'udp-upload'].includes(phase);
      const received = ['partial', 'complete'].includes(measured?.completion) && Number.isFinite(measured.durationMs) && measured.durationMs > 0;
      job.options.onProgress?.({ ...value.metrics, phase, protocol: phase.startsWith('udp-') ? 'udp' : 'tcp',
        ...(transferring ? { elapsedMs: received && tcp ? measured.durationMs : Math.min(210000, Math.max(0, now - (tcp ? job.stageStartedAt : job.phaseStartedAt))),
          durationMs: udp ? 30000 : 10000, maxBytes: (udp ? 512 : 192) * 1024 * 1024 } : {}),
        ...(received ? { bytes: udp ? udp.totalReceivedBytes : measured.receivedBytes, bytesPerSecond: measured.receivedBytes * 1000 / measured.durationMs } : {}),
        ...(udp && measured ? { stageIndex: measured.index, stageCount: udp.stages.length,
          stageElapsedMs: received ? measured.durationMs : Math.max(0, now - job.stageStartedAt),
          targetBytesPerSecond: measured.targetBytesPerSecond,
          senderBytesPerSecond: Number.isFinite(measured.sentBytes) && measured.senderDurationMs > 0 ? measured.sentBytes * 1000 / measured.senderDurationMs : null } : {}),
        ...(tcp && measured ? { stageIndex: measured.index, stageCount: 5, connections: measured.connections,
          stageElapsedMs: received ? measured.durationMs : Math.max(0, now - job.stageStartedAt) } : {}) });
    }
    return value;
  }
  host(options) {
    const job = this.create(options);
    const ready = (async () => {
      const peerIP = validatePeerAddress(options.connection.device?.address, { allowLoopback: this.bridge.demo });
      const prepared = await this.adapter.nativeSpeedPrepare({ protocolVersion: 5, epoch: ++this.epoch, id: options.id, session: options.session, ticket: options.ticket, peerIP }, job.child);
      if (!this.valid(job) || job.stop) { await this.cancel(job); throw stopped(); }
      const value = this.accept(job, prepared);
      if (value.finished || !port(value.port)) throw new Error('原生测速监听尚未就绪');
      return { port: value.port };
    })();
    const result = this.run(job, ready);
    return { ready, result };
  }
  client(options) {
    const job = this.create(options);
    const started = (async () => {
      const host = validatePeerAddress(options.peer.pairing?.host, { allowLoopback: this.bridge.demo });
      if (!port(options.port)) throw new Error('原生测速端口无效');
      const value = await this.adapter.nativeSpeedStart({ protocolVersion: 5, epoch: ++this.epoch, id: options.id, session: options.session,
        ticket: options.ticket, host, port: options.port }, job.child);
      if (!this.valid(job) || job.stop) { await this.cancel(job); throw stopped(); }
      this.accept(job, value);
    })();
    return this.run(job, started);
  }
  cancel(job) {
    if (job.stop) return job.stop;
    const epoch = ++this.epoch;
    job.stop = (async () => {
      if (job.child !== this.adapter?.child) return;
      try {
        const result = await this.adapter.nativeSpeedCancel({ epoch, id: job.options.id,
          reason: typeof job.options.signal.reason === 'string' ? job.options.signal.reason : 'user-cancelled' }, job.child);
        if (result?.id !== job.options.id || result.finished !== true) throw new Error('原生测速未确认停止');
        if (result.protocolVersion === 5 && result.metrics && typeof result.metrics === 'object') job.last = result;
      } catch {
        // No further renewals are issued. Wait for the native lease instead of
        // killing the helper that also carries unrelated proxy/model sessions.
        if (job.child === this.adapter?.child) await this.sleep(this.leaseMs);
      }
    })();
    return job.stop;
  }
  async run(job, prepared) {
    let result;
    try {
      await prepared;
      while (!job.last?.finished) {
        if (!this.valid(job) || job.stop) throw stopped();
        await this.sleep(this.pollMs);
        if (!this.valid(job) || job.stop) throw stopped();
        const result = await this.adapter.nativeSpeedStatus({ id: job.options.id, renew: true }, job.child);
        if (!this.valid(job) || job.stop) throw stopped();
        this.accept(job, result);
      }
      result = job.last.metrics;
    } catch (error) {
      // Cancellation can contain a final receiver snapshot. Read it only after
      // native cleanup settles so a partial result keeps its observed bytes.
      result = null; job.failureReason = error?.reason === 'unsupported' ? 'unsupported' : 'transport-failed';
    } finally {
      await this.cancel(job);
      job.options.signal.removeEventListener('abort', job.abort);
      job.done = true; if (this.job === job) this.job = null;
    }
    return result || { ...job.last?.metrics, completed: false,
      stopReason: job.options.signal.aborted && typeof job.options.signal.reason === 'string' ? job.options.signal.reason : job.failureReason || 'transport-failed' };
  }
  upgrade() { return false; }
  close() { this.closed = true; return this.job ? this.cancel(this.job) : Promise.resolve(); }
}
