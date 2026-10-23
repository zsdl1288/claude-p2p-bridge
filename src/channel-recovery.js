import { randomUUID } from 'node:crypto';

const MIN_PENDING = 32 * 1024, MIN_PENDING_AGE = 3000, FAST_RATE = 128 * 1024;
const MULTI_WINDOW = 20000, SINGLE_WINDOW = 30000, COOLDOWN = 120000, BUDGET_WINDOW = 1800000;
const TIMEOUTS = 'counter_tcp_timeouts', RETRANSMITS = 'counter_tcp_retransmits';
const number = (value) => Number.isSafeInteger(value) && value >= 0;
const uuid = (value) => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const safeResults = new Set(['refreshed', 'cooldown', 'unavailable', 'busy']);

// Observe existing traffic only. Production defaults to a local suggestion;
// refreshing requires the user's existing manual action. The automatic mode
// remains available to internal callers and uses the same conservative guards.
export class ChannelRecovery {
  constructor({ bridge, mode = 'notify', intervalMs = 5000, now = () => performance.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    if (!bridge || !['notify', 'automatic'].includes(mode) || !Number.isFinite(intervalMs) || intervalMs < 1) throw new Error('通道恢复配置无效');
    Object.assign(this, { bridge, mode, intervalMs, now, setIntervalFn, clearIntervalFn });
    this.windows = new Map(); this.attempts = []; this.epoch = 0;
    this.notice = null; this.noticeSerial = 0;
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
    if (this.notice?.phase === 'suggested') this.notice = null;
    this.lastTick = null; this.downloadSample = null; this.downloadFast = false;
    this.owner = null; this.helper = null;
  }
  setNotice(phase, peer, adapter, child, result = null) {
    const connection = peer.clientConnection, session = connection?.session, resource = peer.dialResource;
    const previous = this.notice;
    const same = previous?.peer === peer && previous.adapter === adapter && previous.child === child &&
      previous.connection === connection && previous.session === session && previous.resource === resource;
    this.notice = { id: same ? previous.id : ++this.noticeSerial, at: phase === 'suggested' ? this.hint.at : this.now(), phase, result,
      peer, adapter, child, connection, session, resource };
  }
  freshHint(now, peer, child) {
    const h = this.hint;
    return Boolean(h && h.peer === peer && h.connection === peer?.clientConnection && h.session === peer?.clientConnection?.session &&
      h.resource === peer?.dialResource && h.helper === child && h.count >= 2 && now >= h.at && now - h.at <= 2.5 * this.intervalMs);
  }
  currentNotice(now) {
    const n = this.notice, b = this.bridge, peer = b.peer, adapter = b.networkAdapter;
    if (!n) return null;
    const age = now - n.at;
    const current = !this.closed && !this.stopped && !b.closing && !b.applicationClosing && !b.stopRequested && !b.paused &&
      !b.identityChanging && b.intentOnline !== false && !b.pairingInvalid && peer?.role === 'client' && peer.state?.online &&
      peer === n.peer && adapter === n.adapter && adapter?.child === n.child && peer.clientConnection === n.connection &&
      n.connection?.session === n.session && peer.dialResource === n.resource && peer.isConnected?.(n.connection) &&
      Number.isFinite(age) && age >= 0 && age <= (n.phase === 'suggested' ? 2.5 * this.intervalMs : 300000);
    if (!current || (n.phase === 'suggested' && (!this.freshHint(now, peer, adapter.child) || !this.allowed('client') ||
        !this.manualStatus().available || this.downloadFast || !this.clientSnapshot()))) {
      this.notice = null; return null;
    }
    return { id: n.id, phase: n.phase, ageMs: Math.floor(age), result: n.result };
  }
  modelBusy() {
    const b = this.bridge;
    return Boolean(b.pending?.size || b.active?.size || b.queue?.length);
  }
  log(message) { try { this.bridge.log?.(message); } catch { /* Observability must not control recovery. */ } }
  allowed(role = this.bridge.peer?.role) {
    const b = this.bridge, adapter = b.networkAdapter, peer = b.peer;
    if (this.closed || this.stopped || b.channelRefreshActive || b.channelSpeedActive || b.channelProbeActive || b.demo || b.closing || b.applicationClosing || b.stopRequested || b.paused || b.identityChanging ||
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
    if (previous && previous.connection === connection && previous.peer === peer && previous.session === connection.session &&
        previous.resource === peer.dialResource && previous.helper === this.bridge.networkAdapter.child &&
        now - previous.at <= 2.5 * this.intervalMs && now - previous.at >= this.intervalMs) {
      this.hint = { connection, peer, session: connection.session, resource: peer.dialResource,
        helper: this.bridge.networkAdapter.child, id: msg.id, at: now, count: Math.min(2, previous.count + 1) };
    } else if (!previous || now - previous.at >= this.intervalMs) this.hint = { connection, peer, session: connection.session, resource: peer.dialResource,
      helper: this.bridge.networkAdapter.child, id: msg.id, at: now, count: 1 };
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
      this.windows.clear(); this.hint = null; this.notice = null; return;
    }
    if (!entries.some((entry) => entry.activeFlows)) { this.windows.clear(); this.hint = null; this.notice = null; return; }
    const readyHint = this.freshHint(now, peer, adapter.child);
    // Healthy browsing/video needs only these small in-memory counters. Read
    // the heavier native snapshot only for a real backlog or confirmed hints.
    const hasBacklog = entries.some((entry) => entry.activeFlows > 0 && entry.blockedFlows > 0 &&
      entry.pendingBytes >= MIN_PENDING && entry.oldestPendingMs >= MIN_PENDING_AGE && !entry.consumerBlocked);
    if ((peer.role === 'host' && !hasBacklog) || (peer.role === 'client' && !readyHint)) {
      this.windows.clear(); if (this.notice?.phase === 'suggested') this.notice = null; return;
    }
    const epoch = this.epoch, child = adapter.child;
    if (!this.allowed() || b.peer !== peer || adapter.child !== child) { this.reset(); return; }
    let diagnostics;
    try { diagnostics = await adapter.diagnostics(); } catch { if (this.epoch === epoch) this.reset(); return; }
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
    const download = this.freshHint(at, peer, child);
    if (hint && at - hint.at > 2.5 * this.intervalMs) this.hint = null;
    if (!download) return;
    if (this.mode === 'notify') {
      if (this.manualStatus().available && !this.downloadFast && this.clientSnapshot()) this.setNotice('suggested', peer, adapter, child);
      return;
    }
    await this.refresh('download-stall', epoch, peer, adapter, child);
  }
  pruneBudget(now) { this.attempts = this.attempts.filter((at) => now - at < BUDGET_WINDOW && now >= at); }
  manualStatus({ ignoreRefreshing = false } = {}) {
    const b = this.bridge, adapter = b.networkAdapter, peer = b.peer, now = this.now(); this.pruneBudget(now);
    let reason = 'ready', retryAfterMs = 0;
    if (this.closed || this.stopped || b.demo || b.closing || b.applicationClosing || b.stopRequested || b.paused || b.identityChanging || b.intentOnline === false || b.pairingInvalid) reason = 'network-stopped';
    else if (this.modelBusy()) reason = 'model-busy';
    else if (b.channelSpeedActive || b.channelProbeActive) reason = 'speed-busy';
    else if (this.refreshing && !ignoreRefreshing) reason = 'recovery-busy';
    else if (!adapter?.embedded || adapter.closed || adapter.wantRunning !== true || !adapter.child?.stdin?.writable ||
        !adapter.initialized?.has(adapter.child) || typeof adapter.refreshTransport !== 'function') reason = 'unavailable';
    else if (peer?.role !== 'client' || !peer.state?.online || !peer.isConnected?.(peer.clientConnection)) reason = 'not-connected';
    else if (this.attempts.length >= 3) {
      reason = 'budget-exhausted'; retryAfterMs = Math.max(1, Math.ceil(this.attempts[0] + BUDGET_WINDOW - now));
    } else if (this.lastAttempt !== null && now - this.lastAttempt < COOLDOWN) {
      reason = 'cooldown'; retryAfterMs = Math.max(1, Math.ceil(COOLDOWN - (now - this.lastAttempt)));
    }
    return { available: reason === 'ready', reason, retryAfterMs };
  }
  async manualRefresh({ peer = this.bridge.peer, adapter = this.bridge.networkAdapter, child = adapter?.child, isCurrent = () => true } = {}) {
    const connection = peer?.clientConnection, session = connection?.session, resource = peer?.dialResource;
    const current = () => !this.closed && !this.stopped && this.bridge.peer === peer && this.bridge.networkAdapter === adapter &&
      adapter?.child === child && peer?.clientConnection === connection && connection?.session === session && peer?.dialResource === resource && isCurrent() === true;
    if (!current()) return { refreshed: false, reason: 'unavailable' };
    const status = this.manualStatus();
    if (!status.available) return { refreshed: false, reason: status.reason, ...(status.retryAfterMs ? { retryAfterMs: status.retryAfterMs } : {}) };
    this.notice = null;
    this.refreshing = true;
    try {
      this.log('正在按请求重新探测本机桥接传输，保留现有配对和服务端');
      // Logs can synchronously notify application observers. Recheck after
      // those callbacks, before reserving an attempt or touching the helper.
      if (!current()) return { refreshed: false, reason: 'unavailable' };
      const ready = this.manualStatus({ ignoreRefreshing: true });
      if (!ready.available) return { refreshed: false, reason: ready.reason, ...(ready.retryAfterMs ? { retryAfterMs: ready.retryAfterMs } : {}) };
      const now = this.now(); this.attempts.push(now); this.lastAttempt = now; this.lastReason = 'manual-refresh';
      const result = await adapter.refreshTransport();
      if (!current()) return { refreshed: false, reason: 'unavailable' };
      const reason = safeResults.has(result?.reason) && result.refreshed === (result.reason === 'refreshed') ? result.reason : 'unavailable';
      this.lastResult = reason;
      if (reason === 'refreshed') this.lastRefresh = this.now();
      return { refreshed: reason === 'refreshed', reason,
        ...(Number.isSafeInteger(result?.retryAfterMs) && result.retryAfterMs > 0 && result.retryAfterMs <= COOLDOWN ? { retryAfterMs: result.retryAfterMs } : {}) };
    } catch { if (current()) this.lastResult = 'unavailable'; return { refreshed: false, reason: 'unavailable' }; }
    finally { this.refreshing = false; if (current()) this.reset(); }
  }
  async refresh(reason, epoch, peer, adapter, child) {
    if (this.mode !== 'automatic') return;
    const now = this.now(); this.pruneBudget(now);
    if (this.refreshing || this.epoch !== epoch || !this.allowed('client') || this.bridge.peer !== peer ||
        this.bridge.networkAdapter !== adapter || adapter.child !== child || !this.clientSnapshot() || this.downloadFast ||
        (this.lastAttempt !== null && now - this.lastAttempt < COOLDOWN) || this.attempts.length >= 3) return;
    const connection = peer.clientConnection, session = connection?.session, resource = peer.dialResource;
    this.refreshing = true;
    const current = () => this.epoch === epoch && !this.closed && this.bridge.peer === peer &&
      this.bridge.networkAdapter === adapter && adapter.child === child && peer.clientConnection === connection &&
      connection?.session === session && peer.dialResource === resource;
    try {
      this.log('检测到桥接通道持续受阻，正在刷新本机桥接传输；配对保持不变');
      // State observers may synchronously replace the authenticated session or
      // queue model work while processing the log. Old backlog is not evidence
      // for a replacement session, and cancelled work consumes no attempt.
      if (!current() || !this.allowed('client') || this.modelBusy() || !this.clientSnapshot() || this.downloadFast) return;
      const at = this.now(); this.pruneBudget(at);
      if ((this.lastAttempt !== null && at - this.lastAttempt < COOLDOWN) || this.attempts.length >= 3) return;
      this.attempts.push(at); this.lastAttempt = at; this.lastReason = reason;
      this.setNotice('refreshing', peer, adapter, child);
      const result = await adapter.refreshTransport();
      if (!current()) return;
      this.lastResult = safeResults.has(result?.reason) && result.refreshed === (result.reason === 'refreshed') ? result.reason : 'unavailable';
      this.setNotice(this.lastResult === 'refreshed' ? 'refreshed' : 'failed', peer, adapter, child, this.lastResult);
      if (result?.refreshed === true && result.reason === 'refreshed') {
        this.lastRefresh = this.now();
        this.log('本机桥接传输已刷新，继续观察通道状态');
      } else this.log('本次桥接传输未刷新，已进入恢复冷却期');
    } catch {
      if (current()) { this.lastResult = 'unavailable'; this.setNotice('failed', peer, adapter, child, 'unavailable'); this.log('本次桥接传输暂不可用，已进入恢复冷却期'); }
    } finally { this.refreshing = false; if (current()) this.reset(); }
  }
  status() {
    const now = this.now(); this.pruneBudget(now);
    const cooldownMs = this.lastAttempt === null ? 0 : Math.max(0, Math.ceil(COOLDOWN - (now - this.lastAttempt)));
    const enabled = !this.closed && this.bridge.networkAdapter?.embedded === true;
    const state = !enabled ? 'disabled' : this.refreshing ? 'refreshing' : this.attempts.length >= 3 ? 'budget-exhausted' : cooldownMs ? 'cooldown' : this.allowed() ? 'monitoring' : 'waiting';
    return { enabled, mode: this.mode, state, notice: this.currentNotice(now), attemptsInWindow: this.attempts.length, remainingAttempts: Math.max(0, 3 - this.attempts.length), cooldownMs,
      lastAttemptAgoMs: this.lastAttempt === null ? null : Math.max(0, Math.floor(now - this.lastAttempt)),
      lastRefreshAgoMs: this.lastRefresh === null ? null : Math.max(0, Math.floor(now - this.lastRefresh)),
      lastResult: this.lastResult, lastReason: this.lastReason };
  }
}
