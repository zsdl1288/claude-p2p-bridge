import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ChannelRefresh, isRefreshMessage, sanitizeRefreshResult } from '../src/channel-refresh.js';
import { ChannelRecovery } from '../src/channel-recovery.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  for (let n = 0; n < 200 && !check(); n++) await delay(2);
  assert.ok(check(), 'The expected asynchronous stage was reached');
}
function fixture(t, role = 'client', options = {}) {
  let now = 0, refreshes = 0;
  const probes = [], messages = [], logs = [], child = { stdin: { writable: true } };
  const connection = { id: 'paired-device', authenticated: true, session: 'current-private-session', device: { name: 'paired name', address: '100.100.2.3' },
    capabilities: options.oldPeer ? {} : { channelRefresh: 1 } };
  const peer = { role, pairing: { host: '100.100.1.2', secret: 'private-pairing-secret' }, state: { online: true },
    connections: new Set([connection]), clientConnection: role === 'client' ? connection : null, dialResource: { port: 12345 },
    isConnected(candidate) { return this.connections.has(candidate) && candidate.authenticated === true && this.state.online; },
    trySendRefreshMessage(message, target) { messages.push({ message, target }); return true; } };
  const adapter = { embedded: true, wantRunning: true, child, initialized: new WeakSet([child]),
    async refreshTransport() { refreshes++; return { refreshed: true, reason: 'refreshed' }; },
    async channelProbe(params, owner) {
      probes.push({ params, owner });
      return probes.length === 1 ? { outcome: 'reply', actualVia: 'derp', latencySeconds: .263, derpRegionId: 3, derpRegionCode: 'tok', endpoint: '203.0.113.9:9999' } :
        { outcome: 'reply', actualVia: 'direct', latencySeconds: .041, endpoint: '203.0.113.10:12345' };
    } };
  const bridge = new EventEmitter();
  Object.assign(bridge, { peer, networkAdapter: adapter, intentOnline: true, pending: new Map(), active: new Map(), queue: [],
    networkProxy: { enabled: false, sharing: role === 'host' }, log: (value) => logs.push(value) });
  bridge.channelRecovery = new ChannelRecovery({ bridge, now: () => now });
  const controller = bridge.channelRefresh = new ChannelRefresh({ bridge, now: () => now, deadlineMs: 500,
    probeTimeoutMs: 100, refreshTimeoutMs: 100, settleMs: 0, monitorMs: 5, ...options });
  t.after(() => { controller.close(); bridge.channelRecovery.close(); });
  return { controller, bridge, peer, adapter, connection, child, probes, messages, logs,
    get refreshes() { return refreshes; }, advance(ms) { now += ms; }, start() { return controller.start({ targetId: connection.id }); } };
}
const route = (path = 'unknown', latencyMs = null) => ({ path, latencyMs });
const result = (reason = 'refreshed') => ({ refreshed: reason === 'refreshed', reason, before: route('direct', 10), after: route('direct', 12), changed: false });

test('A manually refreshes only its existing helper, even with an old B and no proxy or traffic backlog', async (t) => {
  const f = fixture(t, 'client', { oldPeer: true }), saved = JSON.stringify(f.peer.pairing), phases = [];
  f.bridge.on('state', () => phases.push(f.controller.job?.phase));
  assert.equal(f.controller.status().available, true); assert.equal(f.controller.status().targets[0].supported, true);
  const job = f.start(); assert.equal(job.state, 'running'); assert.equal(f.bridge.channelRefreshActive, true);
  await f.controller.running;
  const status = f.controller.status();
  assert.equal(status.job.state, 'completed'); assert.equal(status.job.phase, 'completed');
  assert.equal(status.job.result.refreshed, true); assert.equal(status.job.result.changed, true);
  assert.deepEqual(status.job.result.before, { path: 'derp', latencyMs: 263, regionId: 3, regionCode: 'tok' });
  assert.deepEqual(status.job.result.after, { path: 'direct', latencyMs: 41 });
  assert.ok(phases.includes('before') && phases.includes('refreshing') && phases.includes('after'));
  assert.equal(f.refreshes, 1); assert.equal(f.probes.length, 2); assert.equal(f.messages.length, 0);
  assert.ok(f.probes.every(({ params, owner }) => params.host === '100.100.1.2' && params.type === 'disco' && params.size === 128 && owner === f.child));
  assert.equal(f.bridge.channelRefreshActive, false); assert.equal(status.reason, 'cooldown'); assert.equal(status.retryAfterMs, 120000);
  assert.equal(JSON.stringify(f.peer.pairing), saved); assert.ok(!JSON.stringify(status.job).includes('203.0.113'));
  assert.equal(f.connection.authenticated, true); assert.equal(f.peer.dialResource.port, 12345);
});

test('B requests only its selected A and receives the safe result without refreshing or probing B', async (t) => {
  const b = fixture(t, 'host'), a = fixture(t);
  b.peer.trySendRefreshMessage = (message, target) => { assert.equal(target, b.connection); queueMicrotask(() => a.controller.onMessage(message, a.connection, a.peer)); return true; };
  a.peer.trySendRefreshMessage = (message, target) => { assert.equal(target, a.connection); queueMicrotask(() => b.controller.onMessage(message, b.connection, b.peer)); return true; };
  b.start(); await until(() => b.controller.status().job?.state === 'completed'); await a.controller.running;
  assert.deepEqual(b.controller.status().job.result, a.controller.status().job.result);
  assert.equal(a.refreshes, 1); assert.equal(b.refreshes, 0); assert.equal(b.probes.length, 0);
  assert.equal(b.controller.status().reason, 'cooldown'); assert.equal(b.connection.authenticated, true);
});

test('unsupported A, disconnected peers and all interlocks reject without a helper side effect', async (t) => {
  const old = fixture(t, 'host', { oldPeer: true }); assert.equal(old.controller.status().reason, 'unsupported'); assert.throws(() => old.start(), { code: 'refresh-unsupported' });
  const cases = [
    ['model-busy', (f) => f.bridge.pending.set('job', {})], ['model-busy', (f) => f.bridge.active.set('job', {})],
    ['model-busy', (f) => f.bridge.queue.push({})], ['speed-busy', (f) => { f.bridge.channelSpeedActive = true; }],
    ['speed-busy', (f) => { f.bridge.channelProbeActive = true; }], ['recovery-busy', (f) => { f.bridge.channelRecovery.refreshing = true; }],
    ['network-stopped', (f) => { f.bridge.paused = true; }], ['network-stopped', (f) => { f.bridge.intentOnline = false; }],
    ['network-stopped', (f) => { f.bridge.identityChanging = true; }], ['unavailable', (f) => { f.adapter.child = null; }],
    ['unavailable', (f) => { f.adapter.wantRunning = false; }], ['not-connected', (f) => { f.connection.authenticated = false; }],
  ];
  for (const [reason, mutate] of cases) {
    const f = fixture(t); mutate(f); assert.equal(f.controller.status().reason, reason);
    assert.throws(() => f.start(), { code: `refresh-${reason}` }); assert.equal(f.refreshes, 0); assert.equal(f.probes.length, 0);
  }
});

test('safe control messages reject malformed envelopes, unexpected nested fields and forged route comparisons', () => {
  const id = randomUUID(), request = { type: 'channel-refresh-request', v: 1, id }, reply = { type: 'channel-refresh-result', v: 1, id, result: result() };
  assert.equal(isRefreshMessage(request), true); assert.equal(isRefreshMessage(reply), true);
  for (const invalid of [{ ...request, host: '203.0.113.1' }, { ...request, id: 'bad' }, { ...request, v: 2 },
    { ...reply, result: { ...result(), secret: 'private' } }, { ...reply, result: { ...result(), before: { ...route(), endpoint: 'private' } } },
    { ...reply, result: { ...result(), changed: true } }, { ...reply, result: { ...result(), retryAfterMs: 1800001 } },
    { ...reply, result: { ...result(), before: { path: 'direct', latencyMs: 0, regionId: 3 } } },
    { ...reply, result: { ...result(), after: { path: 'derp', latencyMs: NaN } } }]) assert.equal(isRefreshMessage(invalid), false);
  assert.equal(sanitizeRefreshResult({ ...result(), refreshed: false }), null);
});

test('foreign, stale, duplicate and wrong-role requests cannot trigger a refresh', async (t) => {
  const f = fixture(t), message = { type: 'channel-refresh-request', v: 1, id: randomUUID() };
  assert.equal(f.controller.onMessage({ type: 'other' }, f.connection), false);
  f.controller.onMessage(message, {}, f.peer); f.controller.onMessage(message, f.connection, { ...f.peer });
  f.controller.onMessage({ ...message, extra: true }, f.connection, f.peer); await Promise.resolve(); assert.equal(f.refreshes, 0);
  f.controller.onMessage(message, f.connection, f.peer); f.controller.onMessage(message, f.connection, f.peer); await f.controller.running;
  f.advance(120000); f.controller.onMessage(message, f.connection, f.peer); await Promise.resolve(); assert.equal(f.refreshes, 1);
  const b = fixture(t, 'host'); b.controller.onMessage({ ...message, id: randomUUID() }, b.connection, b.peer); assert.equal(b.refreshes, 0);
});

test('an A returns a fixed busy rejection to B without spending a native refresh attempt', async (t) => {
  const f = fixture(t); f.bridge.channelSpeedActive = true;
  f.controller.onMessage({ type: 'channel-refresh-request', v: 1, id: randomUUID() }, f.connection, f.peer);
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].message.result.reason, 'speed-busy');
  assert.equal(f.refreshes, 0); assert.equal(f.bridge.channelRecovery.attempts.length, 0);
});

test('an immediate remote rejection or synchronous local state change cannot dispatch a stale refresh request', async (t) => {
  const b = fixture(t, 'host'), a = fixture(t); a.bridge.channelSpeedActive = true;
  b.peer.trySendRefreshMessage = (message) => { a.controller.onMessage(message, a.connection, a.peer); return true; };
  a.peer.trySendRefreshMessage = (message) => { b.controller.onMessage(message, b.connection, b.peer); return true; };
  const job = b.start(); assert.equal(job.state, 'failed'); assert.equal(job.result.reason, 'speed-busy');
  assert.equal(a.refreshes, 0); assert.equal(b.refreshes, 0);
  const stopped = fixture(t, 'host'); stopped.bridge.once('state', () => { stopped.bridge.pending.set('job', {}); stopped.bridge.emit('state'); });
  const cancelled = stopped.start(); assert.equal(cancelled.state, 'failed'); assert.equal(cancelled.result.reason, 'model-busy');
  assert.equal(stopped.messages.length, 0, 'A state observer cancelling creation prevents the control request');
});

test('B ignores results from another connection, another ID and a replaced authenticated session', async (t) => {
  const f = fixture(t, 'host'); const job = f.start(), response = { type: 'channel-refresh-result', v: 1, id: job.id, result: result() };
  const other = { ...f.connection, id: 'other' }; f.peer.connections.add(other);
  f.controller.onMessage(response, other, f.peer); f.controller.onMessage({ ...response, id: randomUUID() }, f.connection, f.peer);
  assert.equal(f.controller.status().job.state, 'running');
  f.connection.session = 'replacement'; f.controller.onMessage(response, f.connection, f.peer); f.bridge.emit('state');
  assert.equal(f.controller.status().job.result.reason, 'target-changed'); assert.equal(f.refreshes, 0);
});

test('a late before-probe response cannot refresh after cancellation, helper/session/resource replacement or model work', async (t) => {
  for (const mutate of [(f) => f.controller.cancel(), (f) => f.controller.close(),
    (f) => { f.adapter.child = { stdin: { writable: true } }; }, (f) => { f.connection.session = 'replacement'; },
    (f) => { f.peer.dialResource = { port: 23456 }; }, (f) => { f.bridge.peer = { ...f.peer }; },
    (f) => { f.peer.pairing.host = '100.100.1.3'; },
    (f) => f.bridge.pending.set('new-job', {})]) {
    const f = fixture(t), probe = deferred(); f.adapter.channelProbe = () => { f.probes.push({}); return probe.promise; };
    f.start(); await until(() => f.probes.length === 1); mutate(f); f.bridge.emit('state');
    probe.resolve({ outcome: 'reply', actualVia: 'direct', latencySeconds: .01 }); await f.controller.running;
    assert.equal(f.refreshes, 0); assert.equal(f.probes.length, 1); assert.equal(f.controller.status().job.state, 'failed');
    assert.equal(f.bridge.channelRefreshActive, false);
  }
});

test('a late native refresh completion cannot launch an after-probe into a changed connection', async (t) => {
  const f = fixture(t), refresh = deferred(); let calls = 0;
  f.adapter.refreshTransport = () => { calls++; return refresh.promise; };
  f.start(); await until(() => calls === 1); f.connection.session = 'replacement'; f.bridge.emit('state');
  refresh.resolve({ refreshed: true, reason: 'refreshed' }); await f.controller.running;
  assert.equal(f.probes.length, 1); assert.equal(f.controller.status().job.result.reason, 'target-changed');
  assert.equal(f.bridge.channelRecovery.attempts.length, 1); assert.equal(f.bridge.channelRecovery.refreshing, false);
});

test('a synchronous state observer fired by recovery logging cancels before the native refresh call', async (t) => {
  for (const [reason, mutate] of [['model-busy', (f) => f.bridge.pending.set('queued-in-state-observer', {})],
    ['target-changed', (f) => { f.connection.session = 'changed-in-state-observer'; }],
    ['helper-changed', (f) => { f.adapter.child = { stdin: { writable: true } }; }]]) {
    const f = fixture(t);
    f.bridge.log = () => { mutate(f); f.bridge.emit('state'); };
    f.start(); await f.controller.running;
    const job = f.controller.status().job;
    assert.equal(job.state, 'failed'); assert.equal(job.result.reason, reason);
    assert.equal(f.refreshes, 0); assert.equal(f.probes.length, 1);
    assert.equal(f.bridge.channelRecovery.attempts.length, 0);
    assert.equal(f.bridge.channelRecovery.refreshing, false); assert.equal(f.bridge.channelRefreshActive, false);
  }
});

test('cancelling observation after native acceptance preserves that the action already happened', async (t) => {
  const f = fixture(t, 'client', { settleMs: 80 }); f.start();
  await until(() => f.controller.status().job.phase === 'after'); f.controller.cancel(); await f.controller.running;
  const job = f.controller.status().job;
  assert.equal(job.state, 'failed'); assert.equal(job.result.reason, 'user-cancelled'); assert.equal(job.result.refreshed, true);
  assert.equal(f.probes.length, 1); assert.equal(f.connection.authenticated, true);
});

test('the group deadline releases a stuck observation and prevents every later native action', async (t) => {
  const f = fixture(t, 'client', { deadlineMs: 35, probeTimeoutMs: 100 }); f.adapter.channelProbe = () => new Promise(() => {});
  f.start(); await delay(60); await f.controller.running;
  assert.equal(f.controller.status().job.result.reason, 'deadline'); assert.equal(f.refreshes, 0);
  assert.equal(f.bridge.channelRefreshActive, false); assert.equal(f.controller.status().busy, false);
});

test('failed optional path probes do not prevent an accepted refresh, and never fabricate a changed path', async (t) => {
  const f = fixture(t); f.adapter.channelProbe = async () => { throw new Error('private raw endpoint and credentials'); };
  f.start(); await f.controller.running;
  const job = f.controller.status().job;
  assert.equal(job.state, 'completed'); assert.equal(job.result.refreshed, true); assert.equal(job.result.changed, null);
  assert.deepEqual(job.result.before, route()); assert.deepEqual(job.result.after, route()); assert.ok(!JSON.stringify(job).includes('credentials'));
});

test('a failed native action keeps the common cooldown and does not run an after probe', async (t) => {
  const f = fixture(t); f.adapter.refreshTransport = async () => { throw new Error('private failure'); };
  f.start(); await f.controller.running;
  const status = f.controller.status();
  assert.equal(status.job.state, 'failed'); assert.equal(status.job.result.reason, 'unavailable'); assert.equal(f.probes.length, 1);
  assert.equal(status.job.result.retryAfterMs, 120000);
  assert.equal(status.reason, 'cooldown'); assert.equal(status.retryAfterMs, 120000);
});
