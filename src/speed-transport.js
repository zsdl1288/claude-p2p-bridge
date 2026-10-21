import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { digest, equalSecret } from './crypto.js';
import { rejectUpgrade } from './http-upgrade.js';

const FRAME_BYTES = 64 * 1024, MAX_BYTES = 64 * 1024 * 1024, MAX_BUFFER = 4 * 1024 * 1024;
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const STOP_REASONS = new Set(['busy', 'unsupported', 'model-busy', 'cooldown', 'network-stopped', 'recovery-busy',
  'control-unavailable', 'target-changed', 'helper-changed', 'deadline', 'user-cancelled', 'closed', 'transport-failed']);
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
  constructor({ bridge, phaseMs = 5000, maxBytes = MAX_BYTES, deadlineMs = 35000, handshakeMs = 5000,
    pingMs = 2500, progressMs = 200, now = () => performance.now() } = {}) {
    if (!bridge || ![phaseMs, maxBytes, deadlineMs, handshakeMs, pingMs, progressMs].every((n) => Number.isSafeInteger(n) && n > 0) ||
        phaseMs > 5000 || maxBytes > MAX_BYTES || deadlineMs > 35000 || handshakeMs > 5000 || pingMs > 2500) throw new Error('测速传输配置无效');
    Object.assign(this, { bridge, phaseMs, maxBytes, deadlineMs, handshakeMs, pingMs, progressMs, now });
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
      s.pongWaiter?.finish(null);
      for (const reject of [...s.writes]) reject(s.error);
      for (const waiter of [...s.credits]) waiter(s.error);
      s.ws?.terminate();
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
    ws.on('close', () => { if (!s.finished) s.fail('transport-failed'); });
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
        if (msg.type === 'ping') {
          if (s.role !== 'client' || !['connecting', 'latency'].includes(s.state) || msg.index !== s.nextPing || msg.index >= 5) throw failure();
          s.nextPing++; s.state = 'latency';
          this.sendJSON(s, { type: 'pong', index: msg.index }).catch(() => {});
          this.progress(s, 'latency', { samplesDone: s.nextPing }); return;
        }
        if (msg.type === 'pong') {
          if (s.role !== 'host' || s.state !== 'latency' || !Number.isInteger(msg.index) || msg.index < 0 || msg.index >= 5) throw failure();
          if (s.pongWaiter?.index === msg.index) s.pongWaiter.finish(this.now() - s.pongWaiter.at);
          return;
        }
        if (msg.type === 'progress') {
          if (!['download', 'upload'].includes(msg.direction) || msg.direction !== s.state ||
              (s.role === 'client' ? msg.direction !== 'upload' : msg.direction !== 'download')) throw failure();
          const partial = this.phaseResult(msg.metrics, false);
          if (partial.receivedBytes < s.metrics[msg.direction].receivedBytes) throw failure();
          if (!s.sending || s.sending.direction !== msg.direction || partial.receivedBytes > s.sending.sentBytes) throw failure();
          s.metrics[msg.direction] = { ...partial, completion: partial.receivedBytes ? 'partial' : 'failed' };
          for (const waiter of [...s.credits]) waiter();
          this.progress(s, msg.direction, { bytes: partial.receivedBytes, elapsedMs: partial.durationMs,
            bytesPerSecond: partial.bytesPerSecond }); return;
        }
        if (msg.type === 'phase') {
          if (s.role !== 'client' || !['download', 'upload'].includes(msg.direction) ||
              msg.durationMs !== this.phaseMs || msg.maxBytes !== this.maxBytes ||
              (msg.direction === 'download' ? s.state !== 'latency' : s.state !== 'download' || !s.received.download)) throw failure();
          s.state = msg.direction;
          if (msg.direction === 'download') this.beginReceive(s, 'download');
        }
        if (msg.type === 'phase-end') {
          if (!s.receive || msg.direction !== s.receive.direction || !Number.isSafeInteger(msg.sentBytes) || msg.sentBytes <= 0 ||
              msg.sentBytes !== s.receive.bytes || typeof msg.limitReached !== 'boolean' || msg.limitReached !== (msg.sentBytes === this.maxBytes)) throw failure();
          this.endReceive(s, true, msg.limitReached);
        }
        if (!['ready', 'latency-result', 'phase', 'phase-end', 'phase-result', 'result'].includes(msg.type)) throw failure();
        const waiter = s.waiters.shift();
        if (waiter) waiter.resolve(msg);
        else { if (s.queue.length >= 16) throw failure(); s.queue.push(msg); }
      } catch { s.fail('transport-failed'); }
    });
  }
  progress(s, phase, detail = {}) {
    try { s.onProgress?.({ phase, elapsedMs: 0, durationMs: ['download', 'upload'].includes(phase) ? this.phaseMs : this.deadlineMs,
      bytes: 0, maxBytes: ['download', 'upload'].includes(phase) ? this.maxBytes : 0,
      ...(s.metrics.latency.samples.length + s.metrics.latency.failedSamples === 5 ? { latency: clone(s.metrics.latency) } : {}),
      ...(s.metrics.download.completion !== 'failed' ? { download: clone(s.metrics.download) } : {}),
      ...(s.metrics.upload.completion !== 'failed' ? { upload: clone(s.metrics.upload) } : {}),
      ...detail }); } catch { /* UI cannot interrupt a measurement. */ }
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
  ping(s, index) {
    return new Promise((resolve) => {
      const waiter = { index, at: this.now(), finish: (value) => {
        clearTimeout(waiter.timer); if (s.pongWaiter === waiter) s.pongWaiter = null; resolve(value);
      } };
      s.pongWaiter = waiter;
      waiter.timer = setTimeout(() => waiter.finish(null), this.pingMs);
      this.sendJSON(s, { type: 'ping', index }).catch(() => waiter.finish(null));
    });
  }
  beginReceive(s, direction) {
    if (s.receive) throw failure();
    s.receive = { direction, bytes: 0, at: this.now(), lastProgress: -Infinity };
    s.receive.timer = setInterval(() => this.receiveProgress(s), this.progressMs);
    s.receive.timer.unref?.();
    this.progress(s, direction);
  }
  receiverResult(s, complete = false, limitReached = false) {
    const r = s.receive, elapsed = Math.max(0.001, this.now() - r.at);
    return { receivedBytes: r.bytes, durationMs: elapsed, bytesPerSecond: r.bytes * 1000 / elapsed,
      completion: complete ? 'complete' : r.bytes ? 'partial' : 'failed', limitReached };
  }
  receiveProgress(s) {
    const r = s.receive, now = this.now();
    if (!r || s.error || s.finished || now - r.lastProgress < this.progressMs) return;
    r.lastProgress = now;
    const metrics = this.receiverResult(s);
    s.metrics[r.direction] = metrics;
    this.progress(s, r.direction, { bytes: metrics.receivedBytes, elapsedMs: metrics.durationMs, bytesPerSecond: metrics.bytesPerSecond });
    this.sendJSON(s, { type: 'progress', direction: r.direction, metrics }).catch(() => {});
  }
  endReceive(s, complete, limitReached = false) {
    if (!s.receive) return;
    const { direction } = s.receive, metrics = this.receiverResult(s, complete, limitReached);
    clearInterval(s.receive.timer);
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
    return { receivedBytes: value.receivedBytes, durationMs: value.durationMs, bytesPerSecond: value.receivedBytes * 1000 / value.durationMs,
      completion: value.completion, limitReached: value.limitReached };
  }
  async sendPhase(s, direction) {
    const startedAt = this.now(), data = Buffer.alloc(FRAME_BYTES, 0xa5), pending = new Set();
    let sentBytes = 0;
    s.sending = { direction, sentBytes: 0 };
    this.progress(s, direction);
    while (this.now() - startedAt < this.phaseMs && sentBytes < this.maxBytes) {
      this.check(s);
      const remote = s.metrics[direction], rtt = s.metrics.latency.medianMs || 250;
      const credit = Math.min(MAX_BUFFER, Math.max(256 * 1024, remote.bytesPerSecond * Math.max(50, rtt) / 1000 * 2 + 256 * 1024));
      if (sentBytes - remote.receivedBytes >= credit) {
        await new Promise((resolve, reject) => {
          const finish = (error) => { clearTimeout(timer); s.credits.delete(finish); if (error) reject(error); else resolve(); };
          const timer = setTimeout(finish, Math.max(1, this.phaseMs - (this.now() - startedAt)));
          s.credits.add(finish);
        });
        continue;
      }
      // A four-MiB pipeline accommodates a high-latency path without allowing
      // unbounded ws memory or treating local write callbacks as remote receipt.
      if (pending.size >= MAX_BUFFER / FRAME_BYTES || s.ws.bufferedAmount >= MAX_BUFFER) {
        if (!pending.size) throw failure();
        await Promise.race(pending); continue;
      }
      const length = Math.min(FRAME_BYTES, this.maxBytes - sentBytes);
      const write = this.send(s, data.subarray(0, length), true);
      pending.add(write);
      write.then(() => pending.delete(write), () => pending.delete(write));
      sentBytes += length;
      s.sending.sentBytes = sentBytes;
    }
    await Promise.all(pending);
    this.check(s);
    await this.sendJSON(s, { type: 'phase-end', direction, sentBytes, limitReached: sentBytes === this.maxBytes });
    return sentBytes;
  }
  async runHost(s) {
    await s.connected; this.check(s);
    await this.sendJSON(s, { type: 'ready' });
    s.state = 'latency'; this.progress(s, 'latency');
    const samples = []; let failedSamples = 0;
    for (let index = 0; index < 5; index++) {
      this.check(s);
      const ms = await this.ping(s, index);
      this.check(s);
      if (ms === null) failedSamples++; else samples.push(ms);
      this.progress(s, 'latency', { latencyMs: ms, samplesDone: index + 1 });
    }
    s.metrics.latency = latencyResult(samples, failedSamples);
    await this.sendJSON(s, { type: 'latency-result', latency: s.metrics.latency });
    s.state = 'download';
    await this.sendJSON(s, { type: 'phase', direction: 'download', durationMs: this.phaseMs, maxBytes: this.maxBytes });
    const sentBytes = await this.sendPhase(s, 'download');
    const download = await this.next(s, 'phase-result');
    if (download.direction !== 'download') throw failure();
    s.metrics.download = this.phaseResult(download.metrics);
    if (s.metrics.download.receivedBytes !== sentBytes) throw failure();
    s.state = 'upload'; this.beginReceive(s, 'upload');
    await this.sendJSON(s, { type: 'phase', direction: 'upload', durationMs: this.phaseMs, maxBytes: this.maxBytes });
    const upload = await this.next(s, 'phase-end');
    if (upload.direction !== 'upload' || !s.received.upload) throw failure();
    await this.sendJSON(s, { type: 'phase-result', direction: 'upload', metrics: s.received.upload });
    s.metrics.completed = true;
    await this.sendJSON(s, { type: 'result', metrics: s.metrics });
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
    await this.next(s, 'ready');
    const latency = (await this.next(s, 'latency-result')).latency;
    if (!latency || !Array.isArray(latency.samples) || latency.samples.length > 5 ||
        !latency.samples.every((ms) => Number.isFinite(ms) && ms >= 0 && ms <= this.deadlineMs) ||
        !Number.isInteger(latency.failedSamples) || latency.failedSamples < 0 || latency.samples.length + latency.failedSamples !== 5) throw failure();
    s.metrics.latency = latencyResult(latency.samples, latency.failedSamples);
    this.progress(s, 'latency', { latencyMs: s.metrics.latency.medianMs, samplesDone: 5 });
    const download = await this.next(s, 'phase');
    if (download.direction !== 'download') throw failure();
    await this.next(s, 'phase-end');
    if (!s.received.download) throw failure();
    await this.sendJSON(s, { type: 'phase-result', direction: 'download', metrics: s.received.download });
    const upload = await this.next(s, 'phase');
    if (upload.direction !== 'upload') throw failure();
    const uploadSentBytes = await this.sendPhase(s, 'upload');
    const result = await this.next(s, 'phase-result');
    if (result.direction !== 'upload') throw failure();
    s.metrics.upload = this.phaseResult(result.metrics);
    if (s.metrics.upload.receivedBytes !== uploadSentBytes) throw failure();
    const final = (await this.next(s, 'result')).metrics;
    if (!final || final.completed !== true || final.stopReason !== null ||
        final.download?.receivedBytes !== s.received.download.receivedBytes || final.upload?.receivedBytes !== s.metrics.upload.receivedBytes) throw failure();
    s.metrics.completed = true;
  }
  async run(s, execute) {
    try { await execute(); }
    catch (error) { s.fail(error?.reason); }
    finally {
      if (s.receive) this.endReceive(s, false);
      if (s.error) { s.metrics.completed = false; s.metrics.stopReason = s.error.reason; }
      s.finished = true;
      clearTimeout(s.deadline); clearInterval(s.guard); s.signal?.removeEventListener('abort', s.onAbort);
      if (this.pending.get(s.id) === s) this.pending.delete(s.id);
      this.sessions.delete(s); s.ticket = null;
      if (s.ws) {
        if (s.metrics.completed) s.ws.close(1000);
        else s.ws.terminate();
      }
      this.progress(s, 'completed');
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
