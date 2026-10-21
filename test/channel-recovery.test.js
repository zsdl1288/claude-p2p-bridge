import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ChannelRecovery } from '../src/channel-recovery.js';

const TIMEOUTS = 'counter_tcp_timeouts', RETRANSMITS = 'counter_tcp_retransmits';
function fixture(role = 'client', options = {}) {
  let now = 0, reads = 0, refreshes = 0;
  const connection = { authenticated: true, session: 'private-session' }, sent = [], logs = [];
  const child = { stdin: { writable: true } }, initialized = new WeakSet([child]);
  const counters = { [TIMEOUTS]: 0, [RETRANSMITS]: 0 };
  const adapter = { embedded: true, child, initialized, wantRunning: true,
    async diagnostics() { reads++; return { available: true, netstack: { ...counters } }; },
    async refreshTransport() { refreshes++; if (options.failRefresh) throw new Error('private credential, hostname and URL'); return { refreshed: true, reason: 'refreshed' }; } };
  const peer = { role, state: { online: true }, clientConnection: role === 'client' ? connection : null, connections: new Set([connection]),
    isConnected(candidate) { return this.connections.has(candidate) && candidate.authenticated; },
    trySendHealthHint(message, target) { sent.push({ message, target }); return true; } };
  const entry = { connection, side: role, activeFlows: 2, blockedFlows: 2, pendingBytes: 65536, oldestPendingMs: 5000,
    completedBytes: 0, consumerBlocked: false };
  let entries = [entry];
  const proxy = { enabled: role === 'client', sharing: role === 'host', downloadBytes: 0, recoverySnapshot: () => entries };
  const bridge = { networkAdapter: adapter, networkProxy: proxy, peer, remoteSharing: true, intentOnline: true,
    pending: new Map(), active: new Map(), queue: [], log: (message) => logs.push(message) };
  const controller = new ChannelRecovery({ bridge, now: () => now, ...options.controller });
  const hint = (changes = {}) => ({ type: 'proxy-health', id: randomUUID(), v: 1, windowMs: 30000, blockedFlows: 2,
    pendingBytes: 65536, oldestPendingMs: 10000, completedBytes: 0, tcpTimeouts: 3, tcpRetransmits: 0, ...changes });
  return { bridge, adapter, peer, proxy, entry, counters, controller, connection, sent, logs, hint,
    get now() { return now; }, get reads() { return reads; }, get refreshes() { return refreshes; },
    advance(ms = 5000) { now += ms; }, setEntries(value) { entries = value; },
    async tick(ms = 0, loss = 0) { now += ms; counters[RETRANSMITS] += loss; await controller.tick(); } };
}
async function twoHints(f) {
  f.controller.onHint(f.hint(), f.connection); await f.controller.tick();
  f.advance(); f.controller.onHint(f.hint(), f.connection); await f.controller.tick();
}

test('idle traffic, unavailable helpers and compatibility mode never start or refresh a node', async () => {
  for (const change of [(f) => { f.entry.activeFlows = f.entry.blockedFlows = 0; }, (f) => { f.adapter.child = null; },
    (f) => { f.adapter.wantRunning = false; }, (f) => { f.adapter.embedded = false; }, (f) => { f.bridge.demo = true; }]) {
    const f = fixture(); change(f); await f.tick(); await f.tick(5000);
    assert.equal(f.reads, 0); assert.equal(f.refreshes, 0);
  }
});

test('healthy long-running traffic and a single unconfirmed hint avoid heavy native snapshots', async () => {
  const f = fixture(); f.entry.blockedFlows = f.entry.pendingBytes = 0;
  for (let i = 0; i < 120; i++) { f.proxy.downloadBytes += 16384; await f.tick(5000); }
  assert.equal(f.reads, 0, 'Ten minutes of healthy traffic only reads small JS counters');
  f.controller.onHint(f.hint(), f.connection); await f.tick(); assert.equal(f.reads, 0);
  f.advance(); f.controller.onHint(f.hint(), f.connection); await f.tick();
  assert.equal(f.reads, 1); assert.equal(f.refreshes, 1);
});

test('host requires sustained source backlog and loss, then hints only its affected current connection', async () => {
  const f = fixture('host'), healthy = { authenticated: true };
  f.entry.oldestPendingMs = 5000.12345; // Real performance.now() ages are fractional.
  f.peer.connections.add(healthy);
  f.setEntries([f.entry, { ...f.entry, connection: healthy, blockedFlows: 0, pendingBytes: 0 }]);
  await f.tick();
  for (let i = 0; i < 3; i++) await f.tick(5000, 8);
  assert.equal(f.sent.length, 0, 'Fifteen seconds is not a recovery window');
  await f.tick(5000, 8);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].target, f.connection);
  assert.equal(f.sent[0].message.windowMs, 20000); assert.equal(f.sent[0].message.tcpRetransmits, 32);
  assert.equal(f.sent[0].message.oldestPendingMs, 5000);
  assert.equal(f.refreshes, 0, 'B never refreshes its shared transport');
  await f.controller.tick(); assert.equal(f.sent.length, 1, 'Repeated same-time reads do not spam hints');
  await f.tick(5000, 8); assert.equal(f.sent.length, 2);
});

test('single TCP flow needs thirty seconds; healthy fast data and loss without backlog never hint', async () => {
  const single = fixture('host'); single.entry.activeFlows = single.entry.blockedFlows = 1;
  await single.tick();
  for (let i = 0; i < 5; i++) await single.tick(5000, 8);
  assert.equal(single.sent.length, 0); await single.tick(5000, 8); assert.equal(single.sent.length, 1);
  for (const mode of ['fast', 'no-loss', 'no-backlog']) {
    const f = fixture('host'); await f.tick();
    for (let i = 0; i < 10; i++) {
      if (mode === 'fast') f.entry.completedBytes += 128 * 1024 * 5;
      if (mode === 'no-backlog') f.entry.pendingBytes = 0;
      await f.tick(5000, mode === 'no-loss' ? 0 : 8);
    }
    assert.equal(f.sent.length, 0, mode);
  }
});

test('best-effort hint failure never closes B flows, refreshes B or poisons later samples', async () => {
  const f = fixture('host'); let attempts = 0;
  const original = f.peer.trySendHealthHint;
  f.peer.trySendHealthHint = () => { attempts++; if (attempts === 1) throw new Error('private write error'); return false; };
  f.peer.send = () => { throw new Error('Ordinary send must never be used for health hints'); };
  await f.tick(); for (let i = 0; i < 5; i++) await f.tick(5000, 8);
  assert.equal(attempts, 2); assert.equal(f.sent.length, 0); assert.equal(f.refreshes, 0);
  assert.equal(f.connection.authenticated, true); assert.equal(f.entry.activeFlows, 2);
  f.peer.trySendHealthHint = original; await f.tick(5000, 8);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].target, f.connection);
});

test('downstream recovery needs two distinct fresh hints separated by a real sample interval', async () => {
  const f = fixture(); f.entry.blockedFlows = f.entry.pendingBytes = 0;
  await f.tick();
  const first = f.hint(); f.controller.onHint(first, f.connection); await f.tick(); assert.equal(f.refreshes, 0);
  f.advance(1000); f.controller.onHint(f.hint(), f.connection); await f.tick(); assert.equal(f.refreshes, 0);
  f.advance(4000); f.controller.onHint(first, f.connection); await f.tick(); assert.equal(f.refreshes, 0, 'Duplicate is not fresh evidence');
  f.controller.onHint(f.hint(), f.connection); await f.tick(); assert.equal(f.refreshes, 1);
  assert.equal(f.controller.status().lastReason, 'download-stall');
  assert.equal(f.controller.status().lastResult, 'refreshed');
});

test('foreign, old, malformed, unsupported and stale hints cannot trigger a refresh', async () => {
  for (const changes of [{ v: 2 }, { id: 'not-a-uuid' }, { pendingBytes: -1 }, { oldestPendingMs: 2999 },
    { windowMs: 19999 }, { tcpTimeouts: 0, tcpRetransmits: 31 }, { completedBytes: 128 * 1024 * 30 }]) {
    const f = fixture(); f.entry.blockedFlows = 0;
    f.controller.onHint(f.hint(changes), f.connection); f.advance();
    f.controller.onHint(f.hint(changes), f.connection); await f.tick(); assert.equal(f.refreshes, 0);
  }
  const f = fixture(); f.entry.blockedFlows = 0; await f.tick();
  f.controller.onHint(f.hint(), {}); f.advance(); f.controller.onHint(f.hint(), f.connection); await f.tick();
  assert.equal(f.refreshes, 0);
  f.advance(13000); f.controller.onHint(f.hint(), f.connection); await f.tick(); assert.equal(f.refreshes, 0);
  f.advance(); await f.tick(); assert.equal(f.refreshes, 0);
});

test('local slow readers veto downstream hints and require fresh evidence after draining', async () => {
  const f = fixture(); f.entry.consumerBlocked = true;
  await twoHints(f); assert.equal(f.refreshes, 0); assert.equal(f.reads, 0);
  f.entry.consumerBlocked = false; f.entry.blockedFlows = 0;
  await f.tick(); assert.equal(f.refreshes, 0);
  await twoHints(f); assert.equal(f.refreshes, 1);
});

test('fast A download progress vetoes otherwise valid downstream hints', async () => {
  const f = fixture(); await f.tick(); f.controller.onHint(f.hint(), f.connection);
  f.advance(); f.proxy.downloadBytes += 128 * 1024 * 5;
  f.controller.onHint(f.hint(), f.connection); await f.tick(); assert.equal(f.refreshes, 0);
  for (let i = 0; i < 8; i++) {
    f.proxy.downloadBytes += 1024 * 1024;
    await f.tick(5000, 16);
  }
  assert.equal(f.refreshes, 0);
});

test('A upload-only stalls and target backpressure never refresh without two B downstream hints', async () => {
  const f = fixture(); await f.tick();
  for (let i = 0; i < 20; i++) await f.tick(5000, 32);
  assert.equal(f.refreshes, 0); assert.equal(f.reads, 0);
  assert.equal(f.controller.status().lastReason, null);
});

test('model execution, queueing, cancellation waiting and user stop states erase old evidence', async () => {
  for (const mutate of [(f) => f.bridge.pending.set('cancel-wait', {}), (f) => f.bridge.active.set('job', {}), (f) => f.bridge.queue.push({}),
    (f) => { f.bridge.paused = true; }, (f) => { f.bridge.stopRequested = true; }, (f) => { f.bridge.closing = true; },
    (f) => { f.bridge.channelProbeActive = true; },
    (f) => { f.bridge.applicationClosing = true; }, (f) => { f.bridge.identityChanging = true; }, (f) => { f.bridge.intentOnline = false; },
    (f) => { f.bridge.pairingInvalid = true; }, (f) => { f.proxy.enabled = false; }, (f) => { f.bridge.remoteSharing = false; }]) {
    const f = fixture(); f.entry.blockedFlows = 0; await f.tick(); f.controller.onHint(f.hint(), f.connection);
    mutate(f); f.advance(); f.controller.onHint(f.hint(), f.connection); await f.tick();
    assert.equal(f.refreshes, 0); assert.equal(f.controller.hint, null);
  }
  const f = fixture(); f.entry.blockedFlows = 0;
  f.controller.onHint(f.hint(), f.connection); f.bridge.pending.set('queued', {}); await f.tick();
  f.bridge.pending.clear(); f.advance(); f.controller.onHint(f.hint(), f.connection); await f.tick(); assert.equal(f.refreshes, 0);
  f.advance(); f.controller.onHint(f.hint(), f.connection); await f.tick(); assert.equal(f.refreshes, 1);
});

test('passive-read races recheck consumer, model work, current helper and peer before refresh', async () => {
  for (const mutate of [(f) => { f.entry.consumerBlocked = true; }, (f) => f.bridge.pending.set('new-job', {}),
    (f) => { f.adapter.child = { stdin: { writable: true } }; }, (f) => { f.bridge.peer = { ...f.peer }; },
    (f) => f.controller.stop(), (f) => f.controller.close()]) {
    const f = fixture(); f.entry.blockedFlows = 0; await f.tick(); f.controller.onHint(f.hint(), f.connection);
    f.advance(); f.controller.onHint(f.hint(), f.connection);
    let resolve; f.adapter.diagnostics = () => new Promise((done) => { resolve = done; });
    const reading = f.controller.tick(); assert.equal(typeof resolve, 'function');
    mutate(f); resolve({ available: true, netstack: { ...f.counters } }); await reading;
    assert.equal(f.refreshes, 0);
  }
});

test('a fast burst during an awaited passive snapshot prevents a stale downstream refresh', async () => {
  const f = fixture(); f.entry.blockedFlows = 0; await f.tick(); f.controller.onHint(f.hint(), f.connection);
  f.advance(); f.controller.onHint(f.hint(), f.connection);
  let resolve; f.adapter.diagnostics = () => new Promise((done) => { resolve = done; });
  const reading = f.controller.tick(); f.advance(1000); f.proxy.downloadBytes += 256 * 1024;
  resolve({ available: true, netstack: { ...f.counters } }); await reading;
  assert.equal(f.refreshes, 0);
});

test('a model arriving during passive read clears hints instead of deferring a stale refresh until it finishes', async () => {
  const f = fixture(); f.entry.blockedFlows = 0; await f.tick(); f.controller.onHint(f.hint(), f.connection);
  f.advance(); f.controller.onHint(f.hint(), f.connection);
  let resolve; const original = f.adapter.diagnostics;
  f.adapter.diagnostics = () => new Promise((done) => { resolve = done; });
  const reading = f.controller.tick(); f.bridge.pending.set('job', {});
  resolve({ available: true, netstack: { ...f.counters } }); await reading;
  f.bridge.pending.clear(); f.adapter.diagnostics = original;
  f.advance(); await f.tick(); assert.equal(f.refreshes, 0);
  f.controller.onHint(f.hint(), f.connection); await f.tick(); assert.equal(f.refreshes, 0);
  f.advance(); f.controller.onHint(f.hint(), f.connection); await f.tick(); assert.equal(f.refreshes, 1);
});

test('sampling gaps, unavailable diagnostics and counter resets cannot manufacture a loss window', async () => {
  const f = fixture('host'); await f.tick(); await f.tick(5000, 16); await f.tick(5000, 16);
  await f.tick(13000, 64); assert.equal(f.sent.length, 0);
  f.counters[RETRANSMITS] = 0; await f.tick(5000); assert.equal(f.sent.length, 0);
  const g = fixture(); g.entry.blockedFlows = 0; g.adapter.diagnostics = async () => ({ available: false, message: 'private URL' });
  await twoHints(g); assert.equal(g.refreshes, 0); assert.equal(g.controller.hint, null);
});

test('failed attempts obey the two-minute cooldown and three-per-thirty-minute budget across reset', async () => {
  const f = fixture('client', { failRefresh: true }); f.entry.blockedFlows = 0;
  await twoHints(f); assert.equal(f.refreshes, 1);
  f.controller.reset(); await twoHints(f); assert.equal(f.refreshes, 1, 'reset preserves cooldown');
  for (let i = 0; i < 2; i++) { f.advance(120000); await f.tick(); await twoHints(f); }
  assert.equal(f.refreshes, 3); assert.equal(f.controller.status().state, 'budget-exhausted');
  f.advance(120000); await f.tick(); await twoHints(f); assert.equal(f.refreshes, 3);
  f.advance(1800000); await f.tick(); await twoHints(f); assert.equal(f.refreshes, 4, 'Expired rolling-window attempts release budget');
  assert.equal(f.controller.status().lastResult, 'unavailable');
});

test('in-flight reads and refresh calls are single-flight; stop is resumable and close is permanent', async () => {
  let scheduled = 0, cleared = 0, callback;
  const f = fixture('client', { controller: { setIntervalFn: (fn) => { scheduled++; callback = fn; return { unref() {} }; }, clearIntervalFn: () => { cleared++; } } });
  f.entry.blockedFlows = 0; f.controller.start(); f.controller.start(); assert.equal(scheduled, 1);
  await f.tick(); f.controller.onHint(f.hint(), f.connection); f.advance(); f.controller.onHint(f.hint(), f.connection);
  let finish, refreshes = 0; f.adapter.refreshTransport = () => { refreshes++; return new Promise((done) => { finish = done; }); };
  const a = f.controller.tick(), b = f.controller.tick(); assert.equal(a, b);
  await Promise.resolve(); assert.equal(refreshes, 1); assert.equal(f.controller.status().state, 'refreshing');
  callback(); await Promise.resolve(); assert.equal(refreshes, 1);
  finish({ refreshed: true, reason: 'refreshed' }); await a;
  f.controller.stop(); assert.equal(cleared, 1); f.controller.start(); assert.equal(scheduled, 2);
  f.controller.close(); f.controller.start(); assert.equal(scheduled, 2); assert.equal(cleared, 2);
  const reads = f.reads; await f.tick(); assert.equal(f.reads, reads); assert.equal(f.controller.status().state, 'disabled');
});

test('old refresh completion cannot write result, log or reset evidence belonging to a replacement session', async () => {
  for (const reject of [false, true]) {
    const f = fixture(); f.entry.blockedFlows = 0;
    await f.tick(); f.controller.onHint(f.hint(), f.connection); f.advance(); f.controller.onHint(f.hint(), f.connection);
    let finish, fail;
    f.adapter.refreshTransport = () => new Promise((resolve, error) => { finish = resolve; fail = error; });
    const refresh = f.controller.tick(); await Promise.resolve(); assert.equal(typeof finish, 'function');
    const logs = f.logs.length;
    f.controller.reset();
    const connection = { authenticated: true, session: 'new-private-session' };
    f.peer.clientConnection = connection; f.peer.connections = new Set([connection]);
    f.bridge.peer = { ...f.peer };
    f.adapter.child = { stdin: { writable: true } }; f.adapter.initialized.add(f.adapter.child);
    f.setEntries([{ ...f.entry, connection }]);
    const hint = f.hint(); f.controller.onHint(hint, connection);
    assert.equal(f.controller.hint.id, hint.id);
    if (reject) fail(new Error('old private exception')); else finish({ refreshed: true, reason: 'refreshed' });
    await refresh;
    assert.equal(f.controller.hint.id, hint.id, 'Old finally does not reset new evidence');
    assert.equal(f.logs.length, logs, 'Old outcome never logs against the new session');
    assert.equal(f.controller.status().lastResult, null); assert.equal(f.controller.status().lastRefreshAgoMs, null);
    assert.equal(f.controller.refreshing, false);
  }
});

test('public status and fixed logs never serialize identities, credentials, flows or raw errors', async () => {
  const f = fixture('client', { failRefresh: true }); f.entry.blockedFlows = 0;
  await twoHints(f);
  const text = JSON.stringify({ status: f.controller.status(), logs: f.logs });
  for (const forbidden of ['private-session', 'private credential', 'hostname', 'URL', 'connection', 'pendingBytes', 'completedBytes']) assert.equal(text.includes(forbidden), false, forbidden);
  assert.equal(f.controller.status().attemptsInWindow, 1);
  assert.equal(f.controller.status().remainingAttempts, 2);
});
