import { randomUUID } from 'node:crypto';

const MIN_PENDING = 32 * 1024, MIN_PENDING_AGE = 3000, FAST_RATE = 128 * 1024;
const MULTI_WINDOW = 20000, SINGLE_WINDOW = 30000, COOLDOWN = 120000, BUDGET_WINDOW = 1800000;
const TIMEOUTS = 'counter_tcp_timeouts', RETRANSMITS = 'counter_tcp_retransmits';
const number = (value) => Number.isSafeInteger(value) && value >= 0;
const uuid = (value) => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const safeResults = new Set(['refreshed', 'cooldown', 'unavailable', 'busy']);

// Observe existing traffic only. A recovery refreshes the running A transport;
// it never starts a helper, changes pairing, closes streams or changes the OS.
export class ChannelRecovery {
  constructor({ bridge, intervalMs = 5000, now = () => performance.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    if (!bridge || !Number.isFinite(intervalMs) || intervalMs < 1) throw new Error('通道恢复配置无效');
    Object.assign(this, { bridge, intervalMs, now, setIntervalFn, clearIntervalFn });
    this.windows = new Map(); this.attempts = []; this.epoch = 0;
    this.lastAttempt = null; this.lastRefresh = null; this.lastResult = null; this.lastReason = null;
  }
  start() {
    if (this.closed || this.timer) return;
    this.stopped = false;
    this.timer = this.setIntervalFn(() => { void this.tick().catch(() => {}); }, this.intervalMs);
    this.timer?.unref?.();
  }
  stop() {
    this.stopped = true;
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null; this.reset();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.stop();
  }
  reset() {
    ++this.epoch; this.windows.clear(); this.hint = null;
    this.lastTick = null; this.downloadSample = null; this.downloadFast = false;
    this.owner = null; this.helper = null;
  }
  modelBusy() {
    const b = this.bridge;
    return Boolean(b.pending?.size || b.active?.size || b.queue?.length);
  }
  log(message) { try { this.bridge.log?.(message); } catch { /* Observability must not control recovery. */ } }
  allowed(role = this.bridge.peer?.role) {
    const b = this.bridge, adapter = b.networkAdapter, peer = b.peer;
    if (this.closed || this.stopped || b.channelSpeedActive || b.channelProbeActive || b.demo || b.closing || b.applicationClosing || b.stopRequested || b.paused || b.identityChanging ||
        b.intentOnline === false || b.pairingInvalid || !adapter?.embedded || adapter.closed || adapter.wantRunning !== true ||
        !adapter.child || !adapter.child.stdin?.writable || !adapter.initialized?.has(adapter.child) ||
        typeof adapter.diagnostics !== 'function' || !peer || peer.role !== role || !peer.state?.online) return false;
    if (role === 'host') return b.networkProxy?.sharing === true;
    return role === 'client' && b.networkProxy?.enabled === true && b.remoteSharing === true &&
      peer.isConnected(peer.clientConnection) && !this.modelBusy() && typeof adapter.refreshTransport === 'function';
  }
  snapshots() {
    const entries = this.bridge.networkProxy?.recoverySnapshot?.();
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry) => entry && ['host', 'client'].includes(entry.side) && entry.connection &&
      ['activeFlows', 'blockedFlows', 'pendingBytes', 'completedBytes'].every((key) => number(entry[key])) &&
      Number.isFinite(entry.oldestPendingMs) && entry.oldestPendingMs >= 0 && entry.oldestPendingMs <= Number.MAX_SAFE_INTEGER &&
      entry.blockedFlows <= entry.activeFlows && typeof entry.consumerBlocked === 'boolean')
      .map((entry) => ({ ...entry, oldestPendingMs: Math.floor(entry.oldestPendingMs) }));
  }
  clientSnapshot(entries = this.snapshots()) {
    const connection = this.bridge.peer?.clientConnection;
    const relevant = entries.filter((entry) => entry.side === 'client' && entry.connection === connection);
    if (relevant.length !== 1 || !relevant[0].activeFlows || relevant[0].consumerBlocked) return null;
    return relevant[0];
  }
  updateDownload(now) {
    const bytes = this.bridge.networkProxy?.downloadBytes;
    const previous = this.downloadSample;
    this.downloadFast = false;
    if (!number(bytes)) { this.downloadSample = null; return; }
    if (previous && now > previous.at && now - previous.at <= 2.5 * this.intervalMs && bytes >= previous.bytes) {
      this.downloadFast = (bytes - previous.bytes) * 1000 / (now - previous.at) >= FAST_RATE;
    }
    this.downloadSample = { at: now, bytes };
  }
  onHint(msg, connection) {
    const now = this.now(), peer = this.bridge.peer;
    if (!this.allowed('client') || connection !== peer?.clientConnection || !peer.isConnected(connection) || !this.clientSnapshot()) {
      this.reset(); return;
    }
    if (!msg || msg.type !== 'proxy-health' || msg.v !== 1 || !uuid(msg.id) ||
        !['windowMs', 'blockedFlows', 'pendingBytes', 'oldestPendingMs', 'completedBytes', 'tcpTimeouts', 'tcpRetransmits'].every((key) => number(msg[key])) ||
        msg.windowMs > 120000 || msg.windowMs < (msg.blockedFlows >= 2 ? MULTI_WINDOW : SINGLE_WINDOW) ||
        msg.blockedFlows < 1 || msg.blockedFlows > 100000 || msg.pendingBytes < MIN_PENDING || msg.oldestPendingMs < MIN_PENDING_AGE ||
        msg.completedBytes * 1000 / msg.windowMs >= FAST_RATE || (msg.tcpTimeouts < 3 && msg.tcpRetransmits < 32)) return;
    if (this.downloadFast) { this.hint = null; return; }
    const previous = this.hint;
    if (previous?.id === msg.id) return;
    if (previous && previous.connection === connection && previous.helper === this.bridge.networkAdapter.child &&
        now - previous.at <= 2.5 * this.intervalMs && now - previous.at >= this.intervalMs) {
      this.hint = { connection, helper: this.bridge.networkAdapter.child, id: msg.id, at: now, count: Math.min(2, previous.count + 1) };
    } else if (!previous || now - previous.at >= this.intervalMs) this.hint = { connection, helper: this.bridge.networkAdapter.child, id: msg.id, at: now, count: 1 };
  }
  sampleWindow(entry, counters, now) {
    if (!entry.activeFlows || !entry.blockedFlows || entry.pendingBytes < MIN_PENDING || entry.oldestPendingMs < MIN_PENDING_AGE || entry.consumerBlocked) {
      this.windows.delete(entry.connection); return null;
    }
    let state = this.windows.get(entry.connection);
    if (!state || now - state.at > 120000 || entry.completedBytes < state.completedBytes || counters.timeouts < state.timeouts || counters.retransmits < state.retransmits) {
      state = { at: now, samples: 0, completedBytes: entry.completedBytes, timeouts: counters.timeouts, retransmits: counters.retransmits,
        minBlocked: entry.blockedFlows, lastSent: null };
      this.windows.set(entry.connection, state);
    }
    state.samples++; state.minBlocked = Math.min(state.minBlocked, entry.blockedFlows);
    const windowMs = now - state.at, completedBytes = entry.completedBytes - state.completedBytes;
    if (windowMs > 0 && completedBytes * 1000 / windowMs >= FAST_RATE) { this.windows.delete(entry.connection); return null; }
    if (state.samples < 3 || windowMs < (state.minBlocked >= 2 ? MULTI_WINDOW : SINGLE_WINDOW)) return null;
    const tcpTimeouts = counters.timeouts - state.timeouts, tcpRetransmits = counters.retransmits - state.retransmits;
    if (tcpTimeouts < 3 && tcpRetransmits < 32) return null;
    return { state, metrics: { windowMs: Math.floor(windowMs), blockedFlows: state.minBlocked, pendingBytes: entry.pendingBytes,
      oldestPendingMs: entry.oldestPendingMs, completedBytes, tcpTimeouts, tcpRetransmits } };
  }
  tick() {
    if (this.closed) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const task = this.sample().catch(() => { this.reset(); });
    const running = task.finally(() => { if (this.ticking === running) this.ticking = null; });
    this.ticking = running; return running;
  }
  async sample() {
    const now = this.now(), b = this.bridge, peer = b.peer, adapter = b.networkAdapter;
    if (!this.allowed()) { this.reset(); return; }
    if ((this.owner && this.owner !== peer) || (this.helper && this.helper !== adapter.child) ||
        (this.lastTick !== null && (now < this.lastTick || now - this.lastTick > 2.5 * this.intervalMs))) this.reset();
    this.owner = peer; this.helper = adapter.child; this.lastTick = now;
    this.updateDownload(now);
    let entries = this.snapshots().filter((entry) => entry.side === peer.role && peer.isConnected(entry.connection));
    if (peer.role === 'client' && (!this.clientSnapshot(entries) || this.downloadFast)) {
      this.windows.clear(); this.hint = null; return;
    }
    if (!entries.some((entry) => entry.activeFlows)) { this.windows.clear(); this.hint = null; return; }
    const readyHint = this.hint?.connection === peer.clientConnection && this.hint.helper === adapter.child &&
      this.hint.count >= 2 && now - this.hint.at <= 2.5 * this.intervalMs;
    // Healthy browsing/video needs only these small in-memory counters. Read
    // the heavier native snapshot only for a real backlog or confirmed hints.
    const hasBacklog = entries.some((entry) => entry.activeFlows > 0 && entry.blockedFlows > 0 &&
      entry.pendingBytes >= MIN_PENDING && entry.oldestPendingMs >= MIN_PENDING_AGE && !entry.consumerBlocked);
    if ((peer.role === 'host' && !hasBacklog) || (peer.role === 'client' && !readyHint)) { this.windows.clear(); return; }
    const epoch = this.epoch, child = adapter.child;
    if (!this.allowed() || b.peer !== peer || adapter.child !== child) { this.reset(); return; }
    let diagnostics;
    try { diagnostics = await adapter.diagnostics(); } catch { this.reset(); return; }
    if (this.epoch !== epoch) return;
    if (!this.allowed() || b.peer !== peer || adapter !== b.networkAdapter || adapter.child !== child) { this.reset(); return; }
    const at = this.now();
    if (at - now > 2.5 * this.intervalMs || at < now || diagnostics?.available !== true ||
        !number(diagnostics.netstack?.[TIMEOUTS]) || !number(diagnostics.netstack?.[RETRANSMITS])) { this.reset(); return; }
    const counters = { timeouts: diagnostics.netstack[TIMEOUTS], retransmits: diagnostics.netstack[RETRANSMITS] };
    entries = this.snapshots().filter((entry) => entry.side === peer.role && peer.isConnected(entry.connection));
    const live = new Set(entries.map((entry) => entry.connection));
    for (const connection of this.windows.keys()) if (!live.has(connection)) this.windows.delete(connection);
    // A consumer can become blocked while a passive snapshot is in flight.
    if (peer.role === 'client' && !this.clientSnapshot(entries)) { this.windows.clear(); this.hint = null; return; }
    const bytes = b.networkProxy?.downloadBytes, baseline = this.downloadSample;
    if (peer.role === 'client' && baseline && number(bytes) && at > baseline.at && bytes >= baseline.bytes &&
        (bytes - baseline.bytes) * 1000 / (at - baseline.at) >= FAST_RATE) {
      this.windows.clear(); this.hint = null; return;
    }
    for (const entry of peer.role === 'host' ? entries : []) {
      const result = this.sampleWindow(entry, counters, at);
      if (!result) continue;
      if (result.state.lastSent !== null && at - result.state.lastSent < this.intervalMs) continue;
      if (!this.allowed('host') || this.bridge.peer !== peer || !peer.isConnected(entry.connection)) continue;
      try {
        if (peer.trySendHealthHint?.({ type: 'proxy-health', id: randomUUID(), v: 1, ...result.metrics }, entry.connection) === true) result.state.lastSent = at;
      } catch { /* A health hint never retires an otherwise usable channel. */ }
    }
    if (peer.role !== 'client') return;
    const hint = this.hint;
    const download = hint?.connection === peer.clientConnection && hint.helper === child && hint.count >= 2 && at - hint.at <= 2.5 * this.intervalMs;
    if (hint && at - hint.at > 2.5 * this.intervalMs) this.hint = null;
    if (!download) return;
    await this.refresh('download-stall', epoch, peer, adapter, child);
  }
  pruneBudget(now) { this.attempts = this.attempts.filter((at) => now - at < BUDGET_WINDOW && now >= at); }
  async refresh(reason, epoch, peer, adapter, child) {
    const now = this.now(); this.pruneBudget(now);
    if (this.refreshing || this.epoch !== epoch || !this.allowed('client') || this.bridge.peer !== peer ||
        this.bridge.networkAdapter !== adapter || adapter.child !== child || !this.clientSnapshot() || this.downloadFast ||
        (this.lastAttempt !== null && now - this.lastAttempt < COOLDOWN) || this.attempts.length >= 3) return;
    this.attempts.push(now); this.lastAttempt = now; this.lastReason = reason; this.refreshing = true;
    this.log('检测到桥接通道持续受阻，正在刷新本机桥接传输；配对保持不变');
    const current = () => this.epoch === epoch && !this.closed && this.bridge.peer === peer &&
      this.bridge.networkAdapter === adapter && adapter.child === child;
    try {
      const result = await adapter.refreshTransport();
      if (!current()) return;
      this.lastResult = safeResults.has(result?.reason) && result.refreshed === (result.reason === 'refreshed') ? result.reason : 'unavailable';
      if (result?.refreshed === true && result.reason === 'refreshed') {
        this.lastRefresh = this.now();
        this.log('本机桥接传输已刷新，继续观察通道状态');
      } else this.log('本次桥接传输未刷新，已进入恢复冷却期');
    } catch {
      if (current()) { this.lastResult = 'unavailable'; this.log('本次桥接传输暂不可用，已进入恢复冷却期'); }
    } finally { this.refreshing = false; if (current()) this.reset(); }
  }
  status() {
    const now = this.now(); this.pruneBudget(now);
    const cooldownMs = this.lastAttempt === null ? 0 : Math.max(0, Math.ceil(COOLDOWN - (now - this.lastAttempt)));
    const enabled = !this.closed && this.bridge.networkAdapter?.embedded === true;
    const state = !enabled ? 'disabled' : this.refreshing ? 'refreshing' : this.attempts.length >= 3 ? 'budget-exhausted' : cooldownMs ? 'cooldown' : this.allowed() ? 'monitoring' : 'waiting';
    return { enabled, state, attemptsInWindow: this.attempts.length, remainingAttempts: Math.max(0, 3 - this.attempts.length), cooldownMs,
      lastAttemptAgoMs: this.lastAttempt === null ? null : Math.max(0, Math.floor(now - this.lastAttempt)),
      lastRefreshAgoMs: this.lastRefresh === null ? null : Math.max(0, Math.floor(now - this.lastRefresh)),
      lastResult: this.lastResult, lastReason: this.lastReason };
  }
}
