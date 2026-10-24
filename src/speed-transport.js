import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { digest, equalSecret } from './crypto.js';
import { rejectUpgrade } from './http-upgrade.js';

const FRAME_BYTES = 64 * 1024, MAX_BYTES = 256 * 1024 * 1024, MAX_BUFFER = 4 * 1024 * 1024;
const SEND_FRAME_BYTES = 16 * 1024, INITIAL_CREDIT_BYTES = 128 * 1024;
const MAX_RTT_SAMPLES = 64;
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const STOP_REASONS = new Set(['busy', 'unsupported', 'model-busy', 'cooldown', 'network-stopped', 'recovery-busy',
  'control-unavailable', 'target-changed', 'helper-changed', 'deadline', 'receiver-timeout', 'user-cancelled', 'closed', 'transport-failed']);
const clone = (value) => structuredClone(value);
const failure = (reason = 'transport-failed') => Object.assign(new Error('测速传输已停止'), { reason });
const emptyPhase = () => ({ receivedBytes: 0, durationMs: 0, bytesPerSecond: 0, completion: 'failed', limitReached: false });
const emptyMetrics = () => ({ completed: false, latency: { samples: [], minMs: null, medianMs: null, maxMs: null, failedSamples: 0 },
  download: emptyPhase(), upload: emptyPhase(), stopReason: null });
const auth = (peer) => `Bearer ${digest(`p2pcc-speed-v1:${peer.pairing.room}:${peer.pairing.secret}`)}`;

function latencyResult(samples, failedSamples) {
  const sorted = [...samples].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { samples: [...samples], minMs: sorted.length ? sorted[0] : null,
    medianMs: sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null,
    maxMs: sorted.length ? sorted.at(-1) : null, failedSamples };
}

// The data connection is independent of control/model/proxy queues. Both UI
// directions describe A: download is B -> A, upload is A -> B. Only synthetic
// bytes cross this connection; no destination or file input is accepted.
export class SpeedTransport {
  constructor({ bridge, phaseMs = 20000, maxBytes = MAX_BYTES, deadlineMs = 60000, handshakeMs = 5000,
    pingMs = 2500, pingIntervalMs = 1000, confirmationMs = 5000, progressMs = 200, now = () => performance.now() } = {}) {
    if (!bridge || ![phaseMs, maxBytes, deadlineMs, handshakeMs, pingMs, pingIntervalMs, confirmationMs, progressMs].every((n) => Number.isSafeInteger(n) && n > 0) ||
        phaseMs > 20000 || maxBytes > MAX_BYTES || deadlineMs > 60000 || handshakeMs > 5000 || pingMs > 2500 ||
        pingIntervalMs < 20 || confirmationMs > 5000 || progressMs > 0x7fffffff) throw new Error('测速传输配置无效');
    Object.assign(this, { bridge, phaseMs, maxBytes, deadlineMs, handshakeMs, pingMs, pingIntervalMs, confirmationMs, progressMs, now });
    this.sessions = new Set(); this.pending = new Map(); this.unverified = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
    this.wss.on('error', () => {});
  }
  valid(s) {
    const b = this.bridge;
    return !this.closed && !s.finished && b.peer === s.peer && s.peer.isConnected(s.connection) && s.connection.session === s.session &&
      !b.closing && !b.applicationClosing && !b.stopRequested && !b.paused && !b.identityChanging && b.intentOnline !== false &&
      b.networkAdapter === s.adapter && (!s.adapter?.embedded || s.adapter.child === s.child) &&
      (s.role !== 'client' || s.peer.dialResource === s.dialResource);
  }
  create(role, options) {
    const { peer, connection, id, session, ticket, signal, onProgress } = options || {};
    if (this.closed || this.sessions.size) throw failure(this.closed ? 'closed' : 'busy');
    if (peer !== this.bridge.peer || peer?.role !== role || !peer.isConnected(connection) || session !== connection.session ||
        typeof id !== 'string' || !UUID.test(id) || typeof ticket !== 'string' || !/^[\w-]{43}$/.test(ticket)) throw failure('target-changed');
    const s = { role, peer, connection, id, session, ticket, signal, onProgress, metrics: emptyMetrics(), startedAt: this.now(),
      adapter: this.bridge.networkAdapter, child: this.bridge.networkAdapter?.child, dialResource: peer.dialResource,
      queue: [], waiters: [], writes: new Set(), credits: new Set(), state: 'connecting', receive: null, received: {}, finished: false, nextPing: 0 };
    s.connected = new Promise((resolve, reject) => { s.resolveConnection = resolve; s.rejectConnection = reject; });
    // An early abort may happen before an asynchronous client socket opens.
    s.connected.catch(() => {});
    s.fail = (reason) => {
      if (s.finished || s.error) return;
      s.error = failure(STOP_REASONS.has(reason) ? reason : 'transport-failed');
      s.rejectConnection(s.error);
      for (const waiter of s.waiters.splice(0)) waiter.reject(s.error);
      this.stopLatency(s);
      for (const reject of [...s.writes]) reject(s.error);
      for (const waiter of [...s.credits]) waiter(s.error);
      if (s.error.reason === 'receiver-timeout' && s.ws?.readyState === WebSocket.OPEN) {
        // A receiver normally has no large outgoing queue. Let the other end
        // learn the fixed timeout reason, but never wait on a close handshake.
        s.timeoutClosing = true;
        s.terminateTimer = setTimeout(() => s.ws.terminate(), 100); s.terminateTimer.unref?.();
        try { s.ws.close(4001, 'receiver-timeout'); } catch { s.ws.terminate(); }
      } else s.ws?.terminate();
    };
    s.onAbort = () => s.fail(STOP_REASONS.has(signal?.reason) ? signal.reason : 'user-cancelled');
    this.sessions.add(s);
    s.deadline = setTimeout(() => s.fail('deadline'), this.deadlineMs);
    s.deadline.unref?.();
    s.guard = setInterval(() => { if (!this.valid(s)) s.fail('target-changed'); }, 100);
    s.guard.unref?.();
    signal?.addEventListener('abort', s.onAbort, { once: true });
    if (signal?.aborted) s.onAbort();
    this.progress(s, 'connecting');
    return s;
  }
  // Registration happens synchronously, before an offer is sent over control.
  host(options) {
    const s = this.create('host', options);
    this.pending.set(s.id, s);
    return this.run(s, () => this.runHost(s));
  }
  client(options) {
    const s = this.create('client', options);
    return this.run(s, () => this.runClient(s));
  }
  upgrade(req, socket, head, peer = this.bridge.peer) {
    if (!req.url?.startsWith('/speed/')) return false;
    if (this.closed || peer !== this.bridge.peer || peer?.role !== 'host' || req.url !== `/speed/${peer.pairing.room}` ||
        req.headers.origin !== undefined || !equalSecret(req.headers.authorization, auth(peer))) {
      rejectUpgrade(socket, 401, 'Unauthorized'); return true;
    }
    if (!this.pending.size || this.unverified.size >= 4) { rejectUpgrade(socket, 409, 'No speed reservation'); return true; }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, peer));
    return true;
  }
  accept(ws, peer) {
    const timer = setTimeout(() => ws.terminate(), this.handshakeMs); timer.unref?.();
    this.unverified.set(ws, timer);
    const cleanup = () => { clearTimeout(timer); this.unverified.delete(ws); };
    ws.once('close', cleanup); ws.on('error', () => {});
    ws.once('message', (raw, binary) => {
      cleanup();
      try {
        if (binary || raw.length > 2048) throw failure();
        const msg = JSON.parse(raw.toString()), s = this.pending.get(msg.id);
        if (!s || !this.valid(s) || s.error || s.peer !== peer || msg.v !== 1 ||
            Object.keys(msg).length !== 4 || !equalSecret(msg.session, s.session) || !equalSecret(msg.ticket, s.ticket)) throw failure();
        this.pending.delete(s.id); s.ticket = null;
        this.bind(s, ws); s.resolveConnection();
      } catch { ws.terminate(); }
    });
  }
  bind(s, ws) {
    s.ws = ws;
    ws.on('error', () => s.fail('transport-failed'));
    ws.on('close', (code, reason) => {
      clearTimeout(s.terminateTimer);
      if (!s.finished) s.fail(code === 4001 && reason.toString() === 'receiver-timeout' ? 'receiver-timeout' : 'transport-failed');
    });
    ws.on('pong', (raw) => {
      if (s.role !== 'host' || !this.valid(s) || s.error || !s.pongWaiter || raw.toString() !== s.pongWaiter.token) return;
      s.pongWaiter.finish(this.now() - s.pongWaiter.at);
    });
    ws.on('message', (raw, binary) => {
      try {
        if (!this.valid(s) || s.error) return s.fail('target-changed');
        if (binary) {
          const r = s.receive;
          if (!r || !raw.length || raw.length > FRAME_BYTES || r.bytes + raw.length > this.maxBytes) throw failure();
          r.bytes += raw.length; this.receiveProgress(s); return;
        }
        if (raw.length > 2048) throw failure();
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') throw failure();
        if (msg.type === 'latency-update') {
          if (s.role !== 'client') throw failure();
          const latency = this.parseLatency(msg.latency);
          if (latency.samples.length < s.metrics.latency.samples.length || latency.failedSamples < s.metrics.latency.failedSamples) throw failure();
          s.metrics.latency = latency;
          this.progress(s, s.state, { latencyMs: latency.medianMs, samplesDone: latency.samples.length + latency.failedSamples });
          return;
        }
        if (msg.type === 'progress') {
          if (!['download', 'upload'].includes(msg.direction) || msg.direction !== s.state ||
              (s.role === 'client' ? msg.direction !== 'upload' : msg.direction !== 'download')) throw failure();
          const partial = this.phaseResult(msg.metrics, false);
          const previous = s.metrics[msg.direction];
          if (partial.receivedBytes < previous.receivedBytes || partial.durationMs < previous.durationMs) throw failure();
          if (!s.sending || s.sending.direction !== msg.direction || partial.receivedBytes > s.sending.sentBytes) throw failure();
          const elapsed = partial.durationMs - previous.durationMs;
          const sampleRate = elapsed > 0 ? (partial.receivedBytes - previous.receivedBytes) * 1000 / elapsed : 0;
          if (!Number.isFinite(sampleRate)) throw failure();
          const weight = 1 - Math.exp(-elapsed / (2 * Math.max(this.progressMs, s.metrics.latency.minMs || 250)));
          const recentRate = s.sending.recentBytesPerSecond;
          // Frame boundaries and feedback timers can yield one zero-delta
          // sample. Smooth it in time; sustained stalls still decay the rate.
          s.sending.recentBytesPerSecond = recentRate > 0 ? recentRate + weight * (sampleRate - recentRate) : sampleRate;
          s.metrics[msg.direction] = { ...partial, completion: partial.receivedBytes ? 'partial' : 'failed' };
          for (const waiter of [...s.credits]) waiter();
          this.progress(s, msg.direction, { bytes: partial.receivedBytes, elapsedMs: partial.durationMs,
            bytesPerSecond: partial.bytesPerSecond }); return;
        }
        if (msg.type === 'phase') {
          if (s.role !== 'client' || !['download', 'upload'].includes(msg.direction) ||
              msg.durationMs !== this.phaseMs || msg.maxBytes !== this.maxBytes ||
              (msg.direction === 'download' ? s.state !== 'connecting' : s.state !== 'download' || !s.received.download)) throw failure();
          s.state = msg.direction;
          if (msg.direction === 'download') this.beginReceive(s, 'download');
        }
        if (msg.type === 'phase-end') {
          if (!s.receive || msg.direction !== s.receive.direction || !Number.isSafeInteger(msg.sentBytes) || msg.sentBytes <= 0 ||
              msg.sentBytes !== s.receive.bytes || typeof msg.limitReached !== 'boolean' || msg.limitReached !== (msg.sentBytes === this.maxBytes)) throw failure();
          this.endReceive(s, true, msg.limitReached);
        }
        if (!['ready', 'phase', 'phase-end', 'phase-result', 'result'].includes(msg.type)) throw failure();
        const waiter = s.waiters.shift();
        if (waiter) waiter.resolve(msg);
        else { if (s.queue.length >= 16) throw failure(); s.queue.push(msg); }
      } catch { s.fail('transport-failed'); }
    });
  }
  progress(s, phase, detail = {}) {
    const transfer = ['download', 'upload'].includes(phase), previous = s.progressSnapshot?.phase === phase ? s.progressSnapshot : null;
    const metrics = transfer ? s.receive?.direction === phase ? this.receiverResult(s) : s.metrics[phase] : null;
    const progress = { phase, elapsedMs: metrics?.durationMs || 0, durationMs: transfer ? this.phaseMs : this.deadlineMs,
      bytes: metrics?.receivedBytes || 0, ...(metrics ? { bytesPerSecond: metrics.bytesPerSecond } : {}), maxBytes: transfer ? this.maxBytes : 0,
      waitingForReceiver: Boolean(s.confirmUntil),
      ...(s.confirmUntil ? { confirmationRemainingMs: Math.max(0, s.confirmUntil - this.now()) } : {}),
      ...(s.metrics.latency.samples.length + s.metrics.latency.failedSamples ? { latency: clone(s.metrics.latency) } : {}),
      ...(s.metrics.download.completion !== 'failed' ? { download: clone(s.metrics.download) } : {}),
      ...(s.metrics.upload.completion !== 'failed' ? { upload: clone(s.metrics.upload) } : {}),
      ...detail };
    if (transfer) {
      // RTT updates carry no new throughput detail. Preserve the current
      // receiver measurement and never rewind a phase or its confirmation bar.
      progress.bytes = Math.max(progress.bytes, previous?.bytes || 0);
      progress.elapsedMs = Math.max(progress.elapsedMs, previous?.elapsedMs || 0, progress.waitingForReceiver ? this.phaseMs : 0);
    }
    s.progressSnapshot = { phase, bytes: progress.bytes, elapsedMs: progress.elapsedMs };
    try { s.onProgress?.(progress); } catch { /* UI cannot interrupt a measurement. */ }
  }
  check(s) { if (s.error) throw s.error; if (!this.valid(s)) throw failure('target-changed'); }
  send(s, value, binary) {
    return new Promise((resolve, reject) => {
      try {
        this.check(s);
        if (s.ws?.readyState !== WebSocket.OPEN || s.ws.bufferedAmount > MAX_BUFFER + FRAME_BYTES) throw failure();
        const fail = (error) => { s.writes.delete(fail); reject(error); };
        s.writes.add(fail);
        s.ws.send(value, { binary, compress: false }, (error) => {
          s.writes.delete(fail);
          if (error) { reject(failure()); s.fail('transport-failed'); } else resolve();
        });
      } catch (error) { reject(error); s.fail(error.reason); }
    });
  }
  sendJSON(s, value) { return this.send(s, JSON.stringify(value), false); }
  async next(s, type) {
    this.check(s);
    const message = s.queue.length ? s.queue.shift() : await new Promise((resolve, reject) => s.waiters.push({ resolve, reject }));
    this.check(s);
    if (message.type !== type) throw failure();
    return message;
  }
  parseLatency(value) {
    if (!value || !Array.isArray(value.samples) || value.samples.length > MAX_RTT_SAMPLES ||
        !value.samples.every((ms) => Number.isFinite(ms) && ms >= 0 && ms <= this.deadlineMs) ||
        !Number.isSafeInteger(value.failedSamples) || value.failedSamples < 0 ||
        value.samples.length + value.failedSamples > MAX_RTT_SAMPLES) throw failure();
    return latencyResult(value.samples, value.failedSamples);
  }
  ping(s) {
    if (s.pongWaiter || s.error || s.finished || !['download', 'upload'].includes(s.state) ||
        s.metrics.latency.samples.length + s.metrics.latency.failedSamples >= MAX_RTT_SAMPLES) return;
    const waiter = { token: `rtt:${s.nextPing++}`, at: this.now(), finish: (value) => {
      if (s.pongWaiter !== waiter) return;
      clearTimeout(waiter.timer); s.pongWaiter = null;
      if (s.error || s.finished) return;
      const latency = s.metrics.latency;
      s.metrics.latency = latencyResult(value === null ? latency.samples : [...latency.samples, value], latency.failedSamples + (value === null ? 1 : 0));
      this.progress(s, s.state, { latencyMs: s.metrics.latency.medianMs, samplesDone: s.nextPing });
      this.sendJSON(s, { type: 'latency-update', latency: s.metrics.latency }).catch(() => {});
    } };
    s.pongWaiter = waiter;
    waiter.timer = setTimeout(() => waiter.finish(null), this.pingMs); waiter.timer.unref?.();
    try {
      this.check(s);
      // WebSocket control frames share the measured connection and run while
      // payload flows. This is latency under load, with no separate warm-up.
      s.ws.ping(waiter.token, false, (error) => { if (error) waiter.finish(null); });
    } catch { waiter.finish(null); }
  }
  startLatency(s) {
    if (s.latencyTimer) return;
    s.latencyTimer = setInterval(() => this.ping(s), this.pingIntervalMs); s.latencyTimer.unref?.();
    this.ping(s);
  }
  stopLatency(s) {
    clearInterval(s.latencyTimer); s.latencyTimer = null;
    if (s.pongWaiter) { clearTimeout(s.pongWaiter.timer); s.pongWaiter = null; }
  }
  async waitUntil(s, promise, until, reason) {
    let timer;
    try {
      const expired = Symbol('expired');
      const result = await Promise.race([promise, new Promise((resolve) => {
        timer = setTimeout(() => resolve(expired), Math.max(0, until - this.now()));
      })]);
      this.check(s);
      if (result !== expired) return result;
      if (reason) throw failure(reason);
      return false;
    } finally { clearTimeout(timer); }
  }
  beginConfirmation(s, direction) {
    s.confirmUntil = this.now() + this.confirmationMs;
    this.progress(s, direction, { elapsedMs: this.phaseMs, waitingForReceiver: true, confirmationRemainingMs: this.confirmationMs });
    return s.confirmUntil;
  }
  async confirmed(s, type) {
    return this.waitUntil(s, this.next(s, type), s.confirmUntil, 'receiver-timeout');
  }
  beginReceive(s, direction) {
    if (s.receive) throw failure();
    s.confirmUntil = null;
    const receive = s.receive = { direction, bytes: 0, reportedBytes: 0, at: this.now(), lastProgress: -Infinity };
    receive.timer = setTimeout(() => { if (s.receive === receive) this.receiveProgress(s, true); }, this.progressMs);
    receive.timer.unref?.();
    // The receiver also owns a phase deadline: a peer that keeps its socket
    // alive but never sends phase-end must not hold the UI until the group cap.
    receive.deadline = setTimeout(() => { if (s.receive === receive) s.fail('receiver-timeout'); }, this.phaseMs + this.confirmationMs);
    receive.deadline.unref?.();
    this.progress(s, direction);
  }
  receiverResult(s, complete = false, limitReached = false) {
    const r = s.receive, elapsed = Math.max(0.001, this.now() - r.at);
    return { receivedBytes: r.bytes, durationMs: elapsed, bytesPerSecond: r.bytes * 1000 / elapsed,
      completion: complete ? 'complete' : r.bytes ? 'partial' : 'failed', limitReached };
  }
  receiveProgress(s, scheduled = false) {
    const r = s.receive, now = this.now();
    if (!r || s.error || s.finished) return;
    const due = scheduled || now - r.lastProgress >= this.progressMs;
    const initialCreditReceived = r.bytes >= INITIAL_CREDIT_BYTES && r.reportedBytes < INITIAL_CREDIT_BYTES;
    if (!due && !initialCreditReceived) return;
    // A single deadline follows actual feedback. A fixed interval plus an
    // elapsed-time guard can skip a whole tick after sub-ms timer jitter.
    // Data that cannot emit feedback must not postpone this deadline.
    r.lastProgress = now;
    r.reportedBytes = r.bytes;
    clearTimeout(r.timer);
    r.timer = setTimeout(() => { if (s.receive === r) this.receiveProgress(s, true); }, this.progressMs);
    r.timer.unref?.();
    const metrics = this.receiverResult(s);
    s.metrics[r.direction] = metrics;
    this.progress(s, r.direction, { bytes: metrics.receivedBytes, elapsedMs: metrics.durationMs, bytesPerSecond: metrics.bytesPerSecond });
    this.sendJSON(s, { type: 'progress', direction: r.direction, metrics }).catch(() => {});
  }
  endReceive(s, complete, limitReached = false) {
    if (!s.receive) return;
    const { direction } = s.receive, metrics = this.receiverResult(s, complete, limitReached);
    clearTimeout(s.receive.timer); clearTimeout(s.receive.deadline);
    s.metrics[direction] = metrics; s.received[direction] = metrics; s.receive = null;
    this.progress(s, direction, { bytes: metrics.receivedBytes, elapsedMs: metrics.durationMs, bytesPerSecond: metrics.bytesPerSecond });
    return metrics;
  }
  phaseResult(value, complete = true) {
    if (!value || !Number.isSafeInteger(value.receivedBytes) || value.receivedBytes < 0 || value.receivedBytes > this.maxBytes ||
        !Number.isFinite(value.durationMs) || value.durationMs <= 0 || value.durationMs > this.deadlineMs ||
        typeof value.limitReached !== 'boolean' || !['complete', 'partial', 'failed'].includes(value.completion) ||
        (complete && value.completion !== 'complete') || (value.limitReached && value.receivedBytes !== this.maxBytes)) throw failure();
    // Recompute the rate, rather than trusting a peer-supplied quotient.
    const bytesPerSecond = value.receivedBytes * 1000 / value.durationMs;
    if (!Number.isFinite(bytesPerSecond)) throw failure();
    return { receivedBytes: value.receivedBytes, durationMs: value.durationMs, bytesPerSecond,
      completion: value.completion, limitReached: value.limitReached };
  }
  async sendPhase(s, direction) {
    const startedAt = this.now(), data = Buffer.alloc(SEND_FRAME_BYTES, 0xa5), pending = new Set();
    let sentBytes = 0, paceAt = startedAt;
    s.confirmUntil = null;
    s.sending = { direction, sentBytes: 0 };
    this.progress(s, direction);
    while (this.now() - startedAt < this.phaseMs && sentBytes < this.maxBytes) {
      this.check(s);
      const remote = s.metrics[direction], rtt = s.metrics.latency.minMs || 250;
      // Queueing increases loaded RTT, so it must never enlarge its own send
      // window. Recent receiver feedback shrinks credit after a path slowdown.
      const rate = Math.min(remote.bytesPerSecond, s.sending.recentBytesPerSecond ?? remote.bytesPerSecond);
      // Receipt is reported at progressMs intervals: a short RTT alone would
      // cap local/nearby paths at one tiny credit window every 200 ms. Cover
      // that feedback interval without adding it twice to long-RTT queues.
      const feedbackMs = Math.max(Math.max(1, rtt) * 2, Math.max(1, rtt) + this.progressMs);
      // A first small frame can arrive with the phase header in one read.
      // Its near-zero duration is not evidence for a multi-MiB send window.
      const credit = remote.receivedBytes < INITIAL_CREDIT_BYTES ? INITIAL_CREDIT_BYTES
        : Math.min(MAX_BUFFER, Math.max(INITIAL_CREDIT_BYTES, rate * feedbackMs / 1000 + INITIAL_CREDIT_BYTES));
      if (sentBytes - remote.receivedBytes >= credit) {
        await new Promise((resolve, reject) => {
          const finish = (error) => { clearTimeout(timer); s.credits.delete(finish); if (error) reject(error); else resolve(); };
          const timer = setTimeout(finish, Math.max(1, this.phaseMs - (this.now() - startedAt)));
          s.credits.add(finish);
        });
        paceAt = this.now();
        continue;
      }
      // A four-MiB pipeline accommodates a high-latency path without allowing
      // unbounded ws memory or treating local write callbacks as remote receipt.
      if (pending.size >= MAX_BUFFER / SEND_FRAME_BYTES || s.ws.bufferedAmount >= MAX_BUFFER) {
        if (!pending.size) throw failure();
        // A local write callback is only queue backpressure. Never let it turn
        // a 20-second sampling phase into an unbounded wait for the path.
        if (await this.waitUntil(s, Promise.race(pending), startedAt + this.phaseMs) === false) break;
        paceAt = this.now();
        continue;
      }
      const length = Math.min(SEND_FRAME_BYTES, this.maxBytes - sentBytes);
      // The embedded userspace TCP path benefits from smaller paced bursts.
      // Kernel TCP keeps its own scheduling. Use actual receiver feedback,
      // never local write callbacks, to estimate a useful sending rate.
      const paceEnabled = s.adapter?.embedded === true && s.metrics.latency.minMs >= 20;
      const paceRate = Math.min(32 * 1024 * 1024, Math.max(256 * 1024,
        rate * 1.25 + INITIAL_CREDIT_BYTES * 1000 / Math.max(20, rtt)));
      if (paceEnabled && paceAt > this.now()) {
        await new Promise((resolve, reject) => {
          const finish = (error) => { clearTimeout(timer); s.credits.delete(finish); if (error) reject(error); else resolve(); };
          const timer = setTimeout(finish, Math.max(1, Math.min(paceAt, startedAt + this.phaseMs) - this.now()));
          s.credits.add(finish);
        });
        this.check(s);
        if (this.now() >= startedAt + this.phaseMs) break;
        if (paceAt - this.now() > 0.1) continue;
      }
      // Compensate coarse timer wakeups, but cap total catchup at the initial
      // window. Credit/write stalls above reset this clock instead of banking
      // an entire blocked interval for an oversized burst on recovery.
      const intervalMs = length * 1000 / paceRate;
      paceAt = paceEnabled ? Math.max(paceAt, this.now() - (INITIAL_CREDIT_BYTES - length) * 1000 / paceRate) + intervalMs : this.now();
      const write = this.send(s, data.subarray(0, length), true);
      pending.add(write);
      write.then(() => pending.delete(write), () => pending.delete(write));
      sentBytes += length;
      s.sending.sentBytes = sentBytes;
    }
    const confirmUntil = this.beginConfirmation(s, direction);
    await this.waitUntil(s, Promise.all(pending), confirmUntil, 'receiver-timeout');
    this.check(s);
    await this.waitUntil(s, this.sendJSON(s, { type: 'phase-end', direction, sentBytes, limitReached: sentBytes === this.maxBytes }), confirmUntil, 'receiver-timeout');
    return sentBytes;
  }
  async runHost(s) {
    await this.waitUntil(s, s.connected, s.startedAt + this.handshakeMs, 'receiver-timeout'); this.check(s);
    await this.waitUntil(s, this.sendJSON(s, { type: 'ready' }), this.now() + this.handshakeMs, 'receiver-timeout');
    s.state = 'download';
    await this.waitUntil(s, this.sendJSON(s, { type: 'phase', direction: 'download', durationMs: this.phaseMs, maxBytes: this.maxBytes }),
      this.now() + this.confirmationMs, 'receiver-timeout');
    this.startLatency(s);
    const sentBytes = await this.sendPhase(s, 'download');
    const download = await this.confirmed(s, 'phase-result');
    if (download.direction !== 'download') throw failure();
    s.metrics.download = this.phaseResult(download.metrics);
    if (s.metrics.download.receivedBytes !== sentBytes) throw failure();
    s.confirmUntil = null;
    s.state = 'upload'; this.beginReceive(s, 'upload');
    await this.waitUntil(s, this.sendJSON(s, { type: 'phase', direction: 'upload', durationMs: this.phaseMs, maxBytes: this.maxBytes }),
      this.now() + this.confirmationMs, 'receiver-timeout');
    this.ping(s);
    const upload = await this.next(s, 'phase-end');
    if (upload.direction !== 'upload' || !s.received.upload) throw failure();
    const confirmUntil = this.beginConfirmation(s, 'upload');
    await this.waitUntil(s, this.sendJSON(s, { type: 'phase-result', direction: 'upload', metrics: s.received.upload }), confirmUntil, 'receiver-timeout');
    this.stopLatency(s);
    s.metrics.completed = true;
    await this.waitUntil(s, this.sendJSON(s, { type: 'result', metrics: s.metrics }), confirmUntil, 'receiver-timeout');
    s.confirmUntil = null;
  }
  async runClient(s) {
    this.check(s);
    if (s.adapter?.embedded && !s.dialResource?.port) throw failure('helper-changed');
    const host = s.dialResource ? '127.0.0.1' : s.peer.pairing.host, port = s.dialResource?.port || s.peer.pairing.port;
    const ws = new WebSocket(`ws://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}/speed/${s.peer.pairing.room}`, {
      headers: { Authorization: auth(s.peer) }, handshakeTimeout: this.handshakeMs, maxPayload: 128 * 1024,
      perMessageDeflate: false, followRedirects: false });
    this.bind(s, ws);
    ws.once('unexpected-response', (_request, response) => { response.resume(); s.fail('transport-failed'); ws.terminate(); });
    ws.once('open', () => {
      this.sendJSON(s, { v: 1, id: s.id, session: s.session, ticket: s.ticket }).then(() => { s.ticket = null; }, () => {});
    });
    await this.waitUntil(s, this.next(s, 'ready'), s.startedAt + this.handshakeMs, 'receiver-timeout');
    const download = await this.next(s, 'phase');
    if (download.direction !== 'download') throw failure();
    await this.next(s, 'phase-end');
    if (!s.received.download) throw failure();
    await this.sendJSON(s, { type: 'phase-result', direction: 'download', metrics: s.received.download });
    const upload = await this.next(s, 'phase');
    if (upload.direction !== 'upload') throw failure();
    const uploadSentBytes = await this.sendPhase(s, 'upload');
    const result = await this.confirmed(s, 'phase-result');
    if (result.direction !== 'upload') throw failure();
    s.metrics.upload = this.phaseResult(result.metrics);
    if (s.metrics.upload.receivedBytes !== uploadSentBytes) throw failure();
    const final = (await this.confirmed(s, 'result')).metrics;
    if (!final || final.completed !== true || final.stopReason !== null ||
        final.download?.receivedBytes !== s.received.download.receivedBytes || final.upload?.receivedBytes !== s.metrics.upload.receivedBytes) throw failure();
    s.metrics.latency = this.parseLatency(final.latency);
    s.confirmUntil = null;
    s.metrics.completed = true;
  }
  async run(s, execute) {
    try { await execute(); }
    catch (error) { s.fail(error?.reason); }
    finally {
      if (s.receive) this.endReceive(s, false);
      if (s.error) { s.metrics.completed = false; s.metrics.stopReason = s.error.reason; }
      s.finished = true;
      s.confirmUntil = null;
      this.stopLatency(s);
      clearTimeout(s.deadline); clearInterval(s.guard); s.signal?.removeEventListener('abort', s.onAbort);
      if (this.pending.get(s.id) === s) this.pending.delete(s.id);
      this.sessions.delete(s); s.ticket = null;
      if (s.ws) {
        if (s.metrics.completed) s.ws.close(1000);
        else if (!s.timeoutClosing) s.ws.terminate();
      }
      const phase = s.metrics.completed ? 'completed' : s.state, value = s.metrics[phase];
      this.progress(s, phase, { waitingForReceiver: false, confirmationRemainingMs: 0,
        ...(value ? { bytes: value.receivedBytes, elapsedMs: value.durationMs, bytesPerSecond: value.bytesPerSecond } : {}) });
    }
    return clone(s.metrics);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.sessions) s.fail('closed');
    for (const [ws, timer] of this.unverified) { clearTimeout(timer); ws.terminate(); }
    this.unverified.clear(); this.pending.clear();
    this.wss.close(() => {});
  }
}
