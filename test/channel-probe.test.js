import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelProbe } from '../src/channel-probe.js';

function fixture(role = 'client') {
  let time = 0, deadline, cleared = 0, notifications = 0;
  const child = { stdin: { writable: true } }, requests = [], delays = [];
  const connection = { id: 'control-connection-1', authenticated: true, session: 'private-session', device: { name: 'Private A', address: '100.95.24.20' } };
  const peer = { role, pairing: { host: '100.122.138.42' }, clientConnection: role === 'client' ? connection : null,
    connections: new Set([connection]), state: { online: true, listening: role === 'host' },
    isConnected(item) { return Boolean(item && this.connections.has(item) && item.authenticated); } };
  const adapter = { embedded: true, child, wantRunning: true, initialized: new WeakSet([child]),
    start() { throw new Error('must-not-start'); }, login() { throw new Error('must-not-login'); }, dial() { throw new Error('must-not-dial'); },
    async channelProbe(params, capturedChild) {
      assert.equal(capturedChild, child); requests.push({ ...params, at: time });
      return { type: params.type, size: params.size, outcome: 'reply', latencySeconds: 0.025, actualVia: 'direct',
        endpoint: '203.0.113.13:54200', target: params.host, nodeName: 'private-name', session: 'private-session', error: 'private-error' };
    } };
  const bridge = { peer, networkAdapter: adapter, pending: new Map(), active: new Map(), queue: [], intentOnline: true,
    channelRecovery: { refreshing: false }, emit(name) { assert.equal(name, 'state'); notifications++; } };
  const controller = new ChannelProbe({ bridge, now: () => time,
    utcNow: () => new Date(Date.UTC(2026, 9, 22) + time).toISOString(),
    async delayFn(ms) { delays.push(ms); time += ms; },
    setTimeoutFn(fn, ms) { assert.equal(ms, 35000); deadline = fn; return { unref() {} }; },
    clearTimeoutFn() { cleared++; } });
  return { controller, bridge, peer, adapter, child, connection, requests, delays,
    get cleared() { return cleared; }, get notifications() { return notifications; }, get time() { return time; },
    advance(ms) { time += ms; }, deadline() { deadline(); },
    start() { return controller.start({ targetId: connection.id }); } };
}
async function entered(check) { for (let i = 0; i < 20 && !check(); i++) await Promise.resolve(); assert.ok(check(), 'Expected background work to begin'); }

test('A returns an immediate job then runs exactly nine serial bounded probes against its current paired B', async () => {
  const f = fixture(), targets = f.controller.status().targets;
  assert.deepEqual(targets, [{ id: f.connection.id, name: 'Private A', address: '100.122.138.42', role: 'host' }]);
  const job = f.start(); assert.equal(job.state, 'running'); assert.equal(f.requests.length, 0);
  assert.equal(f.bridge.channelProbeActive, true); assert.equal(f.controller.status().busy, true);
  await f.controller.running;
  assert.equal(f.requests.length, 9); assert.deepEqual(f.delays, Array(8).fill(1000));
  assert.ok(f.requests.every((p) => p.host === '100.122.138.42'));
  assert.deepEqual(f.requests.map(({ type, size }) => ({ type, size })), Array.from({ length: 3 }, () => [{ type: 'TSMP', size: 0 }, { type: 'disco', size: 128 }, { type: 'disco', size: 1200 }]).flat());
  const finished = f.controller.status(); assert.equal(finished.job.state, 'completed');
  assert.equal(finished.job.report.completed, true); assert.equal(finished.job.report.replies, 9);
  assert.equal(finished.job.report.helperUnchanged, true); assert.equal(finished.job.report.finishedAtUtc, '2026-10-22T00:00:08.000Z');
  assert.ok(finished.job.report.results.filter((r) => r.type === 'TSMP').every((r) => r.actualVia === 'unknown'));
  assert.equal(f.bridge.channelProbeActive, false); assert.equal(f.cleared, 1);
});

test('B can select only a current authenticated A connection and lets native verify its advertised tailnet address', async () => {
  const f = fixture('host');
  const second = { id: 'control-connection-2', authenticated: true, device: { name: 'Other A', address: '100.104.113.61' } };
  f.peer.connections.add(second);
  f.peer.connections.add({ id: 'invalid-public', authenticated: true, device: { address: '8.8.8.8' } });
  f.peer.connections.add({ id: 'not-authenticated', authenticated: false, device: { address: '100.80.80.80' } });
  assert.equal(f.controller.status().targets.length, 2);
  f.controller.start({ targetId: second.id }); await f.controller.running;
  assert.ok(f.requests.every((p) => p.host === '100.104.113.61'));
  assert.equal(f.controller.status().job.report.targetRole, 'client');
  const unavailable = fixture('host');
  unavailable.adapter.channelProbe = async ({ type, size }) => ({ type, size, outcome: 'unavailable', actualVia: 'unknown' });
  unavailable.start(); await unavailable.controller.running;
  assert.equal(unavailable.controller.status().job.state, 'failed');
  assert.equal(unavailable.controller.status().job.report.stopReason, 'rpc-unavailable');
});

test('input never accepts host, probe size, count, credentials or stale target IDs', () => {
  const f = fixture();
  for (const body of [null, [], {}, { host: '100.122.138.42' }, { targetId: f.connection.id, count: 100 },
    { targetId: f.connection.id, size: 65535 }, { targetId: f.connection.id, token: 'private' }, { targetId: 4 }, { targetId: 'x'.repeat(129) }]) {
    assert.throws(() => f.controller.start(body), (e) => e.status === 400 && e.code === 'probe-invalid-target');
  }
  assert.throws(() => f.controller.start({ targetId: 'retired-connection' }), (e) => e.status === 409 && e.code === 'probe-target-unavailable');
  assert.equal(f.requests.length, 0); assert.equal(f.bridge.channelProbeActive, undefined);
});

test('idle, stopped, unsupported, model-busy and recovery-busy states never start or enroll a helper', () => {
  for (const [mutate, expected] of [
    [(f) => { f.bridge.demo = true; }, 'unsupported'], [(f) => { f.adapter.embedded = false; }, 'unsupported'],
    [(f) => { f.adapter.child = null; }, 'helper-unavailable'], [(f) => { f.adapter.wantRunning = false; }, 'helper-unavailable'],
    [(f) => { f.bridge.paused = true; }, 'network-stopped'], [(f) => { f.bridge.stopRequested = true; }, 'network-stopped'],
    [(f) => { f.bridge.intentOnline = false; }, 'network-stopped'], [(f) => { f.bridge.identityChanging = true; }, 'network-stopped'],
    [(f) => { f.bridge.pairingInvalid = true; }, 'network-stopped'], [(f) => { f.bridge.applicationClosing = true; }, 'network-stopped'],
    [(f) => f.bridge.pending.set('cancel-await', {}), 'model-busy'], [(f) => f.bridge.active.set('job', {}), 'model-busy'],
    [(f) => f.bridge.queue.push({}), 'model-busy'], [(f) => { f.bridge.channelRecovery.refreshing = true; }, 'recovery-busy'],
    [(f) => f.peer.connections.clear(), 'no-targets'],
  ]) {
    const f = fixture(); mutate(f); assert.equal(f.controller.status().reason, expected);
    assert.throws(() => f.start(), (e) => e.status === 409 && e.code === `probe-${expected}`);
    assert.equal(f.requests.length, 0);
  }
});

test('cancellation retains single-flight and active flag until the actual in-flight RPC settles', async () => {
  const f = fixture(); let finish, calls = 0;
  f.adapter.channelProbe = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  const job = f.start(); await entered(() => Boolean(finish));
  f.controller.cancel(job.id);
  assert.equal(f.controller.status().busy, true); assert.equal(f.bridge.channelProbeActive, true);
  assert.equal(f.controller.status().job.state, 'running');
  assert.throws(() => f.start(), (e) => e.code === 'probe-busy');
  finish({ type: 'TSMP', size: 0, outcome: 'reply', latencySeconds: 0.1, actualVia: 'direct' });
  await f.controller.running;
  const status = f.controller.status(); assert.equal(status.busy, false); assert.equal(status.job.state, 'cancelled');
  assert.equal(status.job.report.stopReason, 'user-cancelled'); assert.equal(status.job.report.completedProbes, 1);
  assert.equal(status.job.report.results[0].outcome, 'cancelled'); assert.equal(status.job.report.replies, 0);
  assert.equal(calls, 1); assert.equal(f.bridge.channelProbeActive, false);
  assert.throws(() => f.controller.cancel('wrong-job'), (e) => e.status === 404 && e.code === 'probe-job-not-found');
});

test('cancelling before background execution sends nothing and the cooldown still applies', async () => {
  const f = fixture(); f.start(); f.controller.cancel(); await f.controller.running;
  assert.equal(f.requests.length, 0); assert.equal(f.controller.status().job.state, 'cancelled');
  assert.equal(f.controller.status().retryAfterMs, 60000);
  assert.throws(() => f.start(), (e) => e.status === 429 && e.code === 'probe-cooldown');
});

test('after every cadence wait, target/helper identity, user state, models and recovery are rechecked', async () => {
  for (const [mutate, expected] of [
    [(f) => f.peer.connections.clear(), 'target-changed'], [(f) => { f.bridge.peer = { ...f.peer }; }, 'target-changed'],
    [(f) => { f.peer.pairing.host = '100.64.1.2'; }, 'target-changed'],
    [(f) => { f.adapter.child = { stdin: { writable: true } }; }, 'helper-changed'],
    [(f) => { f.bridge.networkAdapter = { ...f.adapter }; }, 'helper-changed'],
    [(f) => { f.bridge.stopRequested = true; }, 'network-stopped'],
    [(f) => f.bridge.pending.set('new-task', {}), 'model-busy'],
    [(f) => { f.bridge.channelRecovery.refreshing = true; }, 'recovery-busy'],
  ]) {
    const f = fixture(); f.controller.delayFn = async () => { f.advance(1000); mutate(f); };
    f.start(); await f.controller.running;
    const job = f.controller.status().job; assert.equal(f.requests.length, 1, expected);
    assert.equal(job.state, 'cancelled'); assert.equal(job.report.stopReason, expected);
    assert.equal(job.report.completed, false); assert.equal(f.bridge.channelProbeActive, false);
  }
});

test('peer and helper changes during an awaited reply are not attributed to a replacement session', async () => {
  for (const reject of [false, true]) {
    const f = fixture(); let finish, fail;
    f.adapter.channelProbe = () => new Promise((resolve, error) => { finish = resolve; fail = error; });
    f.start(); await entered(() => Boolean(finish));
    f.adapter.child = { stdin: { writable: true } };
    if (reject) fail(new Error('private response body')); else finish({ type: 'TSMP', size: 0, outcome: 'reply', latencySeconds: 0.1 });
    await f.controller.running;
    const { report } = f.controller.status().job;
    assert.equal(report.stopReason, 'helper-changed'); assert.equal(report.results[0].outcome, 'cancelled');
    assert.equal(report.helperUnchanged, false); assert.equal(report.replies, 0);
  }
});

test('deadline aborts future work without releasing a still-pending RPC or resetting the helper', async () => {
  const f = fixture(); let finish;
  f.adapter.channelProbe = () => new Promise((resolve) => { finish = resolve; });
  f.start(); await entered(() => Boolean(finish)); f.advance(35000); f.deadline();
  assert.equal(f.controller.status().busy, true); assert.equal(f.bridge.channelProbeActive, true);
  finish({ type: 'TSMP', size: 0, outcome: 'timeout', actualVia: 'unknown' }); await f.controller.running;
  const { job } = f.controller.status(); assert.equal(job.state, 'failed'); assert.equal(job.report.stopReason, 'deadline');
  assert.equal(job.report.helperUnchanged, true); assert.equal(job.report.completed, false); assert.equal(job.report.completedProbes, 1);
});

test('a new RPC is not issued when its maximum settling time would exceed the group deadline', async () => {
  const f = fixture();
  const original = f.adapter.channelProbe;
  f.adapter.channelProbe = async (...args) => { const value = await original(...args); f.advance(3900); return value; };
  f.start(); await f.controller.running;
  assert.ok(f.requests.length < 9); assert.ok(f.time <= 35000);
  assert.equal(f.controller.status().job.report.stopReason, 'deadline');
});

test('only one job runs, failed runs consume start cooldown, and a later run replaces just the recent report', async () => {
  const f = fixture();
  f.adapter.channelProbe = async () => { throw new Error('private RPC body'); };
  const first = f.start(); assert.throws(() => f.start(), (e) => e.code === 'probe-busy');
  await f.controller.running; assert.equal(f.controller.status().job.state, 'failed');
  assert.equal(f.controller.status().job.report.stopReason, 'rpc-unavailable');
  assert.throws(() => f.start(), (e) => e.code === 'probe-cooldown');
  f.advance(60000); const second = f.start(); assert.notEqual(second.id, first.id);
  await f.controller.running; assert.equal(f.controller.status().job.id, second.id);
});

test('finishing all probes can still mean no replies; TSMP path and malformed native values remain unknown', async () => {
  const f = fixture(); let count = 0;
  f.adapter.channelProbe = async ({ type, size }) => {
    count++;
    if (count === 1) return { type, size, outcome: 'timeout', latencySeconds: 5, actualVia: 'direct' };
    if (count === 2) return { type, size, outcome: 'reply', latencySeconds: -1, actualVia: 'derp', derpRegionId: 3 };
    if (count === 3) return { type, size, outcome: 'reply', latencySeconds: 0.1, actualVia: 'derp', derpRegionId: 3, derpRegionCode: 'tok' };
    if (count === 4) return { type, size, outcome: 'reply', latencySeconds: 0.1, actualVia: 'direct', derpRegionId: 3 };
    return { type, size, outcome: 'probe-error', error: 'private' };
  };
  f.start(); await f.controller.running;
  const { report } = f.controller.status().job; assert.equal(report.completed, true); assert.equal(report.replies, 2);
  assert.equal(report.results[0].latencySeconds, undefined); assert.equal(report.results[1].outcome, 'invalid-result');
  assert.deepEqual(report.results[2], { type: 'disco', size: 1200, outcome: 'reply', actualVia: 'derp', latencySeconds: 0.1, derpRegionId: 3, derpRegionCode: 'tok' });
  assert.equal(report.results[3].actualVia, 'unknown'); assert.equal(report.results[3].derpRegionId, undefined);
  const timeouts = fixture(); timeouts.adapter.channelProbe = async ({ type, size }) => ({ type, size, outcome: 'timeout', actualVia: 'unknown' });
  timeouts.start(); await timeouts.controller.running;
  assert.equal(timeouts.controller.status().job.report.completed, true); assert.equal(timeouts.controller.status().job.report.replies, 0);
});

test('report and returned copies contain no addresses, identities, job IDs, errors or mutable internal references', async () => {
  const f = fixture(); const started = f.start(); started.report.notes.push('injected private'); await f.controller.running;
  const status = f.controller.status(), text = JSON.stringify(status.job.report);
  for (const secret of ['Private A', '100.95.24.20', '100.122.138.42', '203.0.113.13', f.connection.id, 'private-session', 'private-name', 'private-error', status.job.id, 'injected private']) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(Object.keys(status.job.report).sort(), ['v', 'completed', 'startedAtUtc', 'finishedAtUtc', 'targetRole', 'plannedProbes', 'completedProbes', 'replies', 'maximumSeconds', 'helperUnchanged', 'stopReason', 'results', 'notes'].sort());
  status.job.report.results[0].outcome = 'mutated';
  assert.equal(f.controller.status().job.report.results[0].outcome, 'reply');
});

test('closing cancels current work, preserves partial report, releases active flag on settling and is permanent', async () => {
  const f = fixture(); let finish;
  f.adapter.channelProbe = () => new Promise((resolve) => { finish = resolve; });
  f.start(); await entered(() => Boolean(finish)); f.controller.close();
  assert.equal(f.controller.status().reason, 'closed'); assert.equal(f.controller.status().busy, true);
  finish({}); await f.controller.running;
  assert.equal(f.controller.status().job.state, 'cancelled'); assert.equal(f.controller.status().job.report.stopReason, 'closed');
  assert.equal(f.bridge.channelProbeActive, false);
  f.advance(60000); assert.throws(() => f.start(), (e) => e.code === 'probe-closed');
});
