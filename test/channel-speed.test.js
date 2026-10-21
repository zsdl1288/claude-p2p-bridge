import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { randomId } from '../src/crypto.js';
import { ChannelSpeed } from '../src/channel-speed.js';

const metrics = () => ({ completed: true, stopReason: null,
  latency: { samples: [13, 9, 11, 12, 10], minMs: 0, medianMs: 0, maxMs: 999, failedSamples: 0 },
  download: { receivedBytes: 2000000, durationMs: 1000, bytesPerSecond: 999, completion: 'complete', limitReached: false },
  upload: { receivedBytes: 1000000, durationMs: 2000, bytesPerSecond: 999, completion: 'complete', limitReached: false },
  ticket: 'private-ticket', session: 'private-session', address: '203.0.113.10', nodeName: 'private-node' });

function fixture(role = 'client', mode = 'embedded') {
  let time = 0, timeout, monitor, clears = 0, intervalClears = 0;
  const sent = [], calls = [], child = { stdin: { writable: true } };
  const connection = { id: `${role}-connection`, session: 'current-session', authenticated: true, capabilities: { speedTest: 1 },
    device: { name: 'Private A', address: '100.95.24.20' } };
  const peer = { role, connections: new Set([connection]), clientConnection: role === 'client' ? connection : null,
    dialResource: role === 'client' ? { port: 12345 } : undefined, pairing: { host: '100.122.138.42' },
    isConnected(item) { return Boolean(item && this.connections.has(item) && item.authenticated); },
    trySendSpeedMessage(message, target) { sent.push({ message, target }); return true; },
    close() { throw Error('must-not-close-control-peer'); }, send() { throw Error('must-not-use-ordinary-control-send'); } };
  const adapter = mode === 'embedded' ? { embedded: true, child, initialized: new WeakSet([child]), wantRunning: true,
    start() { throw Error('must-not-start-helper'); }, dial() { throw Error('must-not-dial-A'); }, login() { throw Error('must-not-login'); } } : null;
  const bridge = Object.assign(new EventEmitter(), { peer, networkAdapter: adapter, intentOnline: true, pending: new Map(), active: new Map(), queue: [],
    demo: mode === 'demo', channelRecovery: { refreshing: false } });
  const transport = {
    host(options) { calls.push({ side: 'host', options }); return Promise.resolve(metrics()); },
    client(options) { calls.push({ side: 'client', options }); return Promise.resolve(metrics()); },
    close() { calls.push({ side: 'close' }); },
  };
  const controller = new ChannelSpeed({ bridge, transport, now: () => time, utcNow: () => new Date(Date.UTC(2026, 9, 22) + time).toISOString(),
    setTimeoutFn(fn, ms) { assert.equal(ms, 35000); timeout = fn; return { unref() {} }; }, clearTimeoutFn() { clears++; },
    setIntervalFn(fn, ms) { assert.equal(ms, 250); monitor = fn; return { unref() {} }; }, clearIntervalFn() { intervalClears++; } });
  const offer = (id, changes = {}) => ({ type: 'speed-offer', v: 1, id, session: connection.session, ticket: randomId(32), ...changes });
  return { controller, bridge, transport, adapter, child, peer, connection, sent, calls, offer,
    get clears() { return clears; }, get intervalClears() { return intervalClears; },
    advance(ms) { time += ms; }, deadline() { timeout(); }, monitor() { monitor(); },
    start() { return controller.start({ targetId: connection.id }); } };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function startClient(f) { const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection, f.peer); await f.controller.running; return job; }

test('A queues a control request and opens only the existing B transport after its matching offer', async () => {
  const f = fixture(); assert.equal(f.controller.status().connected, true);
  const job = f.start(); assert.equal(job.state, 'running'); assert.equal(f.calls.length, 0);
  assert.equal(f.sent[0].message.type, 'speed-request'); assert.equal(f.sent[0].target, f.connection);
  assert.equal(f.bridge.channelSpeedActive, true); assert.equal(f.controller.status().busy, true);
  const offer = f.offer(job.id);
  assert.equal(f.controller.onMessage(offer, f.connection, f.peer), true);
  await f.controller.running;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].side, 'client');
  assert.equal(f.calls[0].options.peer, f.peer); assert.equal(f.calls[0].options.connection, f.connection);
  assert.equal(f.calls[0].options.ticket, offer.ticket); assert.equal(f.calls[0].options.session, f.connection.session);
  const { report } = f.controller.status().job;
  assert.equal(report.completed, true); assert.equal(report.download.bytesPerSecond, 2000000);
  assert.equal(report.upload.bytesPerSecond, 500000); assert.equal(report.latency.medianMs, 11);
  assert.equal(f.bridge.channelSpeedActive, false); assert.equal(f.clears, 1); assert.equal(f.intervalClears, 1);
  assert.equal(f.bridge.listenerCount('state'), 0);
});

test('B synchronously registers a receiver before offering and never dials the advertised A address', async () => {
  const f = fixture('host'); f.connection.device.address = '8.8.8.8'; let registered = false;
  const host = f.transport.host;
  f.transport.host = (options) => { registered = true; return host(options); };
  f.peer.trySendSpeedMessage = (message, target) => {
    assert.equal(registered, true); assert.equal(target, f.connection); f.sent.push({ message, target }); return true;
  };
  f.start(); await f.controller.running;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].side, 'host');
  assert.equal(f.calls[0].options.address, undefined); assert.equal(f.calls[0].options.host, undefined);
  assert.equal(f.sent[0].message.type, 'speed-offer'); assert.match(f.sent[0].message.ticket, /^[\w-]{43}$/);
});

function linked() {
  const a = fixture('client'), b = fixture('host');
  let hostOptions, resolveHost;
  b.transport.host = (options) => {
    b.calls.push({ side: 'host', options }); hostOptions = options;
    return new Promise((resolve) => {
      resolveHost = resolve;
      options.signal.addEventListener('abort', () => resolve({ completed: false }), { once: true });
    });
  };
  a.transport.client = async (options) => {
    a.calls.push({ side: 'client', options }); assert.ok(hostOptions, 'B was registered before A connected');
    assert.equal(options.id, hostOptions.id); assert.equal(options.ticket, hostOptions.ticket);
    resolveHost(metrics()); return metrics();
  };
  a.peer.trySendSpeedMessage = (message, target) => {
    assert.equal(target, a.connection); a.sent.push({ message, target });
    queueMicrotask(() => b.controller.onMessage(message, b.connection, b.peer)); return true;
  };
  b.peer.trySendSpeedMessage = (message, target) => {
    assert.equal(target, b.connection); b.sent.push({ message, target });
    queueMicrotask(() => a.controller.onMessage(message, a.connection, a.peer)); return true;
  };
  return { a, b };
}

for (const origin of ['client', 'host']) test(`${origin} can initiate a coordinated test while A always establishes the data connection`, async () => {
  const { a, b } = linked(); (origin === 'client' ? a : b).start(); await flush();
  await Promise.all([a.controller.running, b.controller.running]);
  assert.equal(a.calls.length, 1); assert.equal(a.calls[0].side, 'client');
  assert.equal(b.calls.length, 1); assert.equal(b.calls[0].side, 'host');
  assert.equal(a.controller.status().job.state, 'completed'); assert.equal(b.controller.status().job.state, 'completed');
  assert.deepEqual(a.controller.status().job.report.download, b.controller.status().job.report.download);
  assert.equal(a.bridge.channelSpeedActive, false); assert.equal(b.bridge.channelSpeedActive, false);
});

test('a busy or legacy A rejects B before opening a speed connection and B releases its reservation', async () => {
  const { a, b } = linked(); a.bridge.pending.set('model', {}); b.start(); await flush(); await b.controller.running;
  assert.equal(a.calls.length, 0); assert.equal(a.controller.status().job, null);
  assert.equal(b.controller.status().job.report.stopReason, 'model-busy'); assert.equal(b.bridge.channelSpeedActive, false);
  const old = fixture(); old.connection.capabilities = {};
  assert.equal(old.controller.status().connected, true); assert.equal(old.controller.status().reason, 'unsupported');
  assert.equal(old.controller.status().targets[0].supported, false);
  assert.throws(() => old.start(), (e) => e.code === 'speed-unsupported'); assert.equal(old.calls.length, 0);
});

test('B selects exact current A; another A cannot offer, cancel or reuse that job', async () => {
  const f = fixture('host'), second = { ...f.connection, id: 'second-A', session: 'second-session', device: { address: '100.80.1.2' } };
  f.peer.connections.add(second); let finish;
  f.transport.host = (options) => { f.calls.push({ side: 'host', options }); return new Promise((resolve) => { finish = resolve; }); };
  const job = f.controller.start({ targetId: second.id });
  assert.equal(f.sent[0].target, second); assert.equal(f.calls[0].options.connection, second);
  f.controller.onMessage({ type: 'speed-cancel', v: 1, id: job.id, reason: 'user-cancelled' }, f.connection, f.peer);
  assert.equal(f.calls[0].options.signal.aborted, false);
  f.controller.onMessage({ type: 'speed-request', v: 1, id: randomUUID() }, f.connection, f.peer);
  assert.equal(f.sent.at(-1).message.type, 'speed-reject'); assert.equal(f.sent.at(-1).message.reason, 'busy');
  assert.equal(f.sent.at(-1).target, f.connection); assert.equal(f.calls.length, 1);
  finish(metrics()); await f.controller.running;
});

test('only supported current control sessions and valid offer tickets can start data work', async () => {
  const f = fixture(), job = f.start();
  assert.equal(f.controller.onMessage({ type: 'unrelated' }, f.connection, f.peer), false);
  for (const [message, connection, peer] of [
    [f.offer(job.id, { v: 2 }), f.connection, f.peer], [f.offer('bad-id'), f.connection, f.peer],
    [f.offer(job.id, { ticket: 'bad-ticket' }), f.connection, f.peer], [f.offer(job.id, { session: 'other-session' }), f.connection, f.peer],
    [f.offer(job.id), {}, f.peer], [f.offer(job.id), f.connection, { ...f.peer }],
  ]) assert.equal(f.controller.onMessage(message, connection, peer), true);
  assert.equal(f.calls.length, 0);
  f.controller.onMessage(f.offer(job.id), f.connection, f.peer);
  f.controller.onMessage(f.offer(job.id), f.connection, f.peer);
  assert.equal(f.calls.length, 1, 'A repeated offer does not create another socket'); await f.controller.running;
});

test('invalid local target options never reserve work or accept arbitrary hosts', () => {
  const f = fixture();
  for (const input of [null, [], {}, { host: '8.8.8.8' }, { targetId: f.connection.id, bytes: 1024 }, { targetId: 1 }]) {
    assert.throws(() => f.controller.start(input), (e) => e.status === 400 && e.code === 'speed-invalid-target');
  }
  assert.throws(() => f.controller.start({ targetId: 'stale-A' }), (e) => e.code === 'speed-target-unavailable');
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.bridge.channelSpeedActive, undefined);
});

test('embedded idle helper never starts, while system and demo connections support the same protocol', async () => {
  const idle = fixture(); idle.adapter.child = null;
  assert.equal(idle.controller.status().reason, 'helper-unavailable'); assert.throws(() => idle.start(), (e) => e.code === 'speed-helper-unavailable');
  assert.equal(idle.calls.length, 0);
  for (const mode of ['system', 'demo']) { const f = fixture('client', mode); await startClient(f); assert.equal(f.controller.status().job.state, 'completed'); }
});

test('cancelled pending invitation sends no bulk, retains cooldown and cannot cancel a later job', async () => {
  const f = fixture(), first = f.start();
  f.controller.cancel(first.id); assert.throws(() => f.start(), (e) => e.code === 'speed-busy'); await f.controller.running;
  assert.equal(f.calls.length, 0); assert.equal(f.controller.status().job.state, 'cancelled');
  assert.equal(f.sent.at(-1).message.type, 'speed-cancel'); assert.equal(f.controller.status().retryAfterMs, 15000);
  assert.throws(() => f.start(), (e) => e.status === 429 && e.code === 'speed-cooldown');
  f.advance(15000); const second = f.start();
  f.controller.onMessage({ type: 'speed-cancel', v: 1, id: first.id, reason: 'user-cancelled' }, f.connection, f.peer);
  assert.equal(f.controller.status().job.id, second.id); assert.equal(f.controller.status().job.report.stopReason, null);
  f.controller.cancel(); await f.controller.running;
  assert.throws(() => f.controller.cancel(first.id), (e) => e.code === 'speed-job-not-found');
});

test('late offers and replayed request IDs cannot restart a completed or cancelled job after cooldown', async () => {
  const a = fixture(); const old = a.start(); a.controller.cancel(); await a.controller.running;
  a.advance(15000); a.controller.onMessage(a.offer(old.id), a.connection, a.peer);
  assert.equal(a.calls.length, 0); assert.equal(a.controller.status().busy, false);
  assert.equal(a.controller.status().job.state, 'cancelled');
  const b = fixture('host'); const first = b.start(); await b.controller.running;
  b.advance(15000); b.controller.onMessage({ type: 'speed-request', v: 1, id: first.id }, b.connection, b.peer);
  assert.equal(b.calls.length, 1); assert.equal(b.controller.status().busy, false);
});

test('control write failure does not close control/helper and the failed attempt consumes cooldown', async () => {
  for (const role of ['client', 'host']) {
    const f = fixture(role); f.peer.trySendSpeedMessage = () => false;
    if (role === 'host') f.transport.host = ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ completed: false }), { once: true }));
    f.start(); await f.controller.running;
    assert.equal(f.controller.status().job.report.stopReason, 'control-unavailable');
    assert.equal(f.controller.status().job.state, 'failed'); assert.equal(f.controller.status().retryAfterMs, 15000);
    assert.equal(f.peer.isConnected(f.connection), true); assert.equal(f.adapter.child, f.child);
  }
});

test('watchdog and state events cancel only speed transport when models, network, helper or exact session changes', async () => {
  for (const [mutate, reason] of [
    [(f) => f.bridge.pending.set('cancel-wait', {}), 'model-busy'], [(f) => f.bridge.active.set('model', {}), 'model-busy'],
    [(f) => f.bridge.queue.push({}), 'model-busy'], [(f) => { f.bridge.stopRequested = true; }, 'network-stopped'],
    [(f) => { f.bridge.paused = true; }, 'network-stopped'], [(f) => { f.bridge.intentOnline = false; }, 'network-stopped'],
    [(f) => { f.bridge.identityChanging = true; }, 'network-stopped'], [(f) => { f.bridge.channelRecovery.refreshing = true; }, 'recovery-busy'],
    [(f) => { f.adapter.child = { stdin: { writable: true } }; }, 'helper-changed'],
    [(f) => { f.bridge.peer = { ...f.peer }; }, 'target-changed'], [(f) => { f.connection.session = 'new-session'; }, 'target-changed'],
    [(f) => { f.peer.dialResource = { port: 54321 }; }, 'target-changed'],
  ]) {
    const f = fixture(); let finish, signal;
    f.transport.client = (options) => { signal = options.signal; return new Promise((resolve) => { finish = resolve; }); };
    const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection, f.peer);
    mutate(f); f.bridge.emit('state'); assert.equal(signal.aborted, true, reason);
    assert.equal(f.controller.status().busy, true, 'Busy remains until owned socket cleanup settles');
    finish({ completed: false }); await f.controller.running;
    assert.equal(f.controller.status().job.report.stopReason, reason);
    assert.equal(f.bridge.channelSpeedActive, false); assert.equal(f.bridge.listenerCount('state'), 0);
  }
});

test('pending offers have a hard deadline and a remote cancellation affects only its matching session', async () => {
  const f = fixture(); f.start(); f.deadline(); await f.controller.running;
  assert.equal(f.controller.status().job.report.stopReason, 'deadline'); assert.equal(f.calls.length, 0);
  const g = fixture(), job = g.start();
  g.controller.onMessage({ type: 'speed-reject', v: 1, id: job.id, reason: 'private arbitrary exception' }, g.connection, g.peer);
  assert.equal(g.controller.status().job.report.stopReason, null);
  g.controller.onMessage({ type: 'speed-reject', v: 1, id: job.id, reason: 'model-busy' }, g.connection, g.peer);
  await g.controller.running; assert.equal(g.controller.status().job.report.stopReason, 'model-busy');
});

test('confirmed stage progress survives a later cancellation and a result missing those fields', async () => {
  const f = fixture(); let finish;
  f.transport.client = ({ onProgress }) => {
    onProgress({ phase: 'upload', elapsedMs: 6000, latency: metrics().latency, download: metrics().download,
      privatePayload: 'private-data', endpoint: '203.0.113.10' });
    return new Promise((resolve) => { finish = resolve; });
  };
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection, f.peer);
  const progress = f.controller.status().job;
  assert.equal(progress.progress.phase, 'upload'); assert.equal(progress.report.download.receivedBytes, 2000000);
  assert.equal(progress.report.upload, null); assert.equal(progress.report.latency.samples.length, 5);
  f.controller.cancel(); finish({ completed: false, download: null, upload: null }); await f.controller.running;
  const report = f.controller.status().job.report;
  assert.equal(report.download.receivedBytes, 2000000); assert.equal(report.upload, null); assert.equal(report.completed, false);
  assert.equal(JSON.stringify(progress).includes('private-data'), false); assert.equal(JSON.stringify(progress).includes('203.0.113.10'), false);
});

test('receiver byte/time limits are enforced, missing metrics remain null and arbitrary result fields never export', async () => {
  const f = fixture(); f.transport.client = async () => ({ ...metrics(), download: { ...metrics().download, receivedBytes: 67108865 }, upload: null });
  await startClient(f); const { report } = f.controller.status().job;
  assert.equal(report.completed, false); assert.equal(report.download, null); assert.equal(report.upload, null);
  assert.equal(report.stopReason, 'transport-failed');
  for (const secret of ['private-ticket', 'private-session', '203.0.113.10', 'private-node', 'Private A', '100.122.138.42', '100.95.24.20', f.connection.id, f.controller.status().job.id]) assert.equal(JSON.stringify(report).includes(secret), false, secret);
  const copy = f.controller.status().job; copy.report.notes.push('changed'); assert.equal(f.controller.status().job.report.notes.includes('changed'), false);
});

test('unstarted phase sentinels remain null while a measured zero-byte phase retains its real duration', async () => {
  const f = fixture();
  f.transport.client = async () => ({ completed: false, stopReason: 'transport-failed',
    download: { receivedBytes: 0, durationMs: 0, bytesPerSecond: 0, completion: 'failed', limitReached: false },
    upload: { receivedBytes: 0, durationMs: 5000, bytesPerSecond: 0, completion: 'failed', limitReached: false } });
  await startClient(f);
  const { report } = f.controller.status().job;
  assert.equal(report.download, null); assert.equal(report.upload.receivedBytes, 0); assert.equal(report.upload.durationMs, 5000);
});

test('synchronous transport setup failure and rejected data sockets release only owned state', async () => {
  for (const role of ['host', 'client']) {
    const f = fixture(role); f.transport[role] = () => { throw new Error('private setup exception'); };
    if (role === 'client') await startClient(f); else { f.start(); await f.controller.running; }
    const status = f.controller.status(); assert.equal(status.job.report.stopReason, 'transport-failed');
    assert.equal(status.busy, false); assert.equal(f.bridge.channelSpeedActive, false);
    assert.equal(JSON.stringify(status.job.report).includes('private'), false);
  }
});

test('close is permanent, aborts the owned test, and leaves paired control sockets connected', async () => {
  const f = fixture(); let finish;
  f.transport.client = () => new Promise((resolve) => { finish = resolve; });
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection, f.peer);
  f.controller.close(); assert.equal(f.controller.status().reason, 'closed');
  finish({ completed: false }); await f.controller.running;
  assert.equal(f.controller.status().job.report.stopReason, 'closed'); assert.equal(f.calls.at(-1).side, 'close');
  assert.equal(f.peer.isConnected(f.connection), true); assert.equal(f.bridge.channelSpeedActive, false);
  f.advance(15000); assert.throws(() => f.start(), (e) => e.code === 'speed-closed');
});
