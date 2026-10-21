import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { SpeedTransport } from '../src/speed-transport.js';
import { BridgePeer } from '../src/peer.js';
import { randomId, digest, makePairing, SecureChannel } from '../src/crypto.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out'); await delay(5); }
}
async function fixture(t, options = {}) {
  const pairing = { host: '127.0.0.1', port: 0, room: randomId(18), secret: randomId(32) }, session = randomId(32);
  const connection = () => ({ session, authenticated: true, ws: { readyState: WebSocket.OPEN } });
  const bConnection = connection(), aConnection = connection();
  const peer = (role, conn) => ({ role, pairing, state: { online: true }, connections: new Set([conn]),
    clientConnection: role === 'client' ? conn : null,
    isConnected(item) { return Boolean(item && item.authenticated && item.session && this.connections.has(item) && this.state.online); } });
  const host = new EventEmitter(), client = new EventEmitter();
  host.peer = peer('host', bConnection); client.peer = peer('client', aConnection);
  const b = new SpeedTransport({ bridge: host, phaseMs: 100, maxBytes: 256 * 1024, deadlineMs: 3000, handshakeMs: 300, pingMs: 100, ...options });
  const a = new SpeedTransport({ bridge: client, phaseMs: 100, maxBytes: 256 * 1024, deadlineMs: 3000, handshakeMs: 300, pingMs: 100, ...options });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => { if (!b.upgrade(req, socket, head, host.peer)) socket.destroy(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); pairing.port = server.address().port;
  t.after(async () => { a.close(); b.close(); await new Promise((resolve) => server.close(resolve)); });
  const id = randomUUID(), ticket = randomId(32);
  const bArgs = { peer: host.peer, connection: bConnection, id, session, ticket };
  const aArgs = { peer: client.peer, connection: aConnection, id, session, ticket };
  const url = `ws://127.0.0.1:${pairing.port}/speed/${pairing.room}`;
  const headers = { Authorization: `Bearer ${digest(`p2pcc-speed-v1:${pairing.room}:${pairing.secret}`)}` };
  return { a, b, host, client, pairing, bArgs, aArgs, bConnection, aConnection, url, headers };
}

test('dedicated loopback measures receiver bytes and concurrent loaded RTTs without a separate latency phase', async (t) => {
  const f = await fixture(t), aProgress = [], bProgress = [];
  const host = f.b.host({ ...f.bArgs, onProgress: (p) => bProgress.push(p) });
  assert.equal(f.b.pending.size, 1, 'The host reservation exists before sending its control offer');
  const [b, a] = await Promise.all([host, f.a.client({ ...f.aArgs, onProgress: (p) => aProgress.push(p) })]);
  assert.deepEqual(a, b);
  assert.equal(a.completed, true, JSON.stringify(a));
  assert.ok(a.latency.samples.length >= 1 && a.latency.samples.length <= 64); assert.equal(a.latency.failedSamples, 0);
  assert.ok(a.latency.samples.every((ms) => ms >= 0 && Number.isFinite(ms)));
  for (const direction of ['download', 'upload']) {
    assert.equal(a[direction].receivedBytes, 256 * 1024);
    assert.equal(a[direction].completion, 'complete'); assert.equal(a[direction].limitReached, true);
    assert.ok(a[direction].durationMs > 0);
    assert.equal(a[direction].bytesPerSecond, a[direction].receivedBytes * 1000 / a[direction].durationMs);
    assert.ok(aProgress.some((p) => p.phase === direction)); assert.ok(bProgress.some((p) => p.phase === direction));
  }
  assert.equal(f.a.sessions.size, 0); assert.equal(f.b.sessions.size, 0);
  assert.equal(f.host.peer.isConnected(f.bConnection), true);
  assert.equal(f.client.peer.isConnected(f.aConnection), true);
  assert.ok(![...aProgress, ...bProgress].some((p) => p.phase === 'latency'));
  assert.ok(!/ticket|session|secret|127\.0\.0\.1/.test(JSON.stringify(a)));
});

test('a stalled write callback ends within the phase confirmation budget with actual partial receiver data', async (t) => {
  const f = await fixture(t, { phaseMs: 100, maxBytes: 8 * 1024 * 1024, confirmationMs: 120, deadlineMs: 2500, progressMs: 10 });
  const send = f.b.send.bind(f.b), started = performance.now(), progress = [];
  f.b.send = (s, value, binary) => {
    const written = send(s, value, binary);
    return binary ? written.then(() => new Promise(() => {})) : written;
  };
  const [b, a] = await Promise.all([f.b.host({ ...f.bArgs, onProgress: (p) => progress.push(p) }), f.a.client(f.aArgs)]);
  assert.equal(b.completed, false); assert.equal(b.stopReason, 'receiver-timeout');
  assert.ok(performance.now() - started < 800, 'A stuck local write must not wait for the overall 60-second deadline');
  assert.equal(a.completed, false); assert.equal(a.stopReason, 'receiver-timeout'); assert.ok(a.download.receivedBytes > 0);
  assert.equal(a.download.completion, 'partial');
  assert.ok(progress.some((p) => p.phase === 'download' && p.waitingForReceiver && p.confirmationRemainingMs <= 120));
  assert.equal(f.host.peer.isConnected(f.bConnection), true); assert.equal(f.client.peer.isConnected(f.aConnection), true);
});

test('missing receiver acknowledgement is bounded independently of the overall deadline', async (t) => {
  const f = await fixture(t, { confirmationMs: 100, deadlineMs: 2500 });
  const sendJSON = f.a.sendJSON.bind(f.a), started = performance.now();
  f.a.sendJSON = (s, value) => value.type === 'phase-result' ? Promise.resolve() : sendJSON(s, value);
  const [b, a] = await Promise.all([f.b.host(f.bArgs), f.a.client(f.aArgs)]);
  assert.equal(b.completed, false); assert.equal(b.stopReason, 'receiver-timeout');
  assert.ok(performance.now() - started < 700);
  assert.equal(a.download.receivedBytes, 256 * 1024); assert.equal(a.download.completion, 'complete');
  assert.equal(a.upload.receivedBytes, 0);
});

test('upload congestion cannot keep the measurement waiting after its confirmation budget', async (t) => {
  const f = await fixture(t, { phaseMs: 100, maxBytes: 8 * 1024 * 1024, confirmationMs: 150, deadlineMs: 2500, progressMs: 10 });
  const receiveProgress = f.b.receiveProgress.bind(f.b); let paused = false, resume;
  f.b.receiveProgress = (s) => {
    receiveProgress(s);
    if (s.receive?.direction === 'upload' && s.receive.bytes && !paused) {
      paused = true; s.ws.pause();
      resume = setTimeout(() => s.ws.resume(), 1000);
    }
  };
  t.after(() => clearTimeout(resume));
  const started = performance.now();
  const [b, a] = await Promise.all([f.b.host(f.bArgs), f.a.client(f.aArgs)]);
  assert.equal(a.completed, false); assert.equal(b.stopReason, 'receiver-timeout');
  assert.equal(a.download.completion, 'complete'); assert.ok(b.upload.receivedBytes > 0);
  assert.equal(b.upload.completion, 'partial');
  assert.ok(performance.now() - started < 1000, 'A stalled upload ends without waiting for the group deadline');
  assert.equal(f.host.peer.isConnected(f.bConnection), true); assert.equal(f.client.peer.isConnected(f.aConnection), true);
});

test('a receiver times out a peer that keeps replying to RTT but never sends upload data or phase-end', async (t) => {
  const f = await fixture(t, { phaseMs: 100, confirmationMs: 150, deadlineMs: 2500, pingIntervalMs: 30 });
  const sendPhase = f.a.sendPhase.bind(f.a), started = performance.now();
  f.a.sendPhase = (s, direction) => {
    if (direction !== 'upload') return sendPhase(s, direction);
    s.sending = { direction, sentBytes: 0 };
    return new Promise((_resolve, reject) => s.writes.add(reject));
  };
  const [b, a] = await Promise.all([f.b.host(f.bArgs), f.a.client(f.aArgs)]);
  assert.equal(b.completed, false); assert.equal(b.stopReason, 'receiver-timeout');
  assert.equal(b.download.completion, 'complete'); assert.equal(b.upload.completion, 'failed');
  assert.equal(b.upload.receivedBytes, 0); assert.equal(a.completed, false); assert.equal(a.stopReason, 'receiver-timeout');
  assert.ok(b.latency.samples.length >= 2, 'RTT replies alone cannot keep an absent upload alive');
  assert.ok(performance.now() - started < 800);
  assert.equal(f.host.peer.isConnected(f.bConnection), true); assert.equal(f.client.peer.isConnected(f.aConnection), true);
});

test('elapsed phases stop before their byte cap and keep real receive counts', async (t) => {
  const f = await fixture(t, { phaseMs: 12, maxBytes: 64 * 1024 * 1024 });
  const [b, a] = await Promise.all([f.b.host(f.bArgs), f.a.client(f.aArgs)]);
  assert.equal(a.completed, true, JSON.stringify(a)); assert.deepEqual(a, b);
  for (const dir of ['download', 'upload']) {
    assert.ok(a[dir].receivedBytes > 0); assert.ok(a[dir].receivedBytes < 64 * 1024 * 1024);
    assert.equal(a[dir].limitReached, false); assert.equal(a[dir].completion, 'complete');
  }
});

test('loaded RTT keeps sampling during payload and does not add a latency-only phase', async (t) => {
  const f = await fixture(t, { phaseMs: 150, maxBytes: 256 * 1024 * 1024, pingIntervalMs: 30, pingMs: 100 }), progress = [];
  const [b, a] = await Promise.all([f.b.host({ ...f.bArgs, onProgress: (p) => progress.push(p) }), f.a.client(f.aArgs)]);
  assert.equal(a.completed, true, JSON.stringify(a)); assert.deepEqual(a, b);
  assert.ok(a.latency.samples.length >= 4 && a.latency.samples.length <= 64, JSON.stringify(a.latency));
  assert.ok(progress.some((p) => p.phase === 'download' && p.latency?.samples.length >= 2));
  assert.ok(progress.some((p) => p.phase === 'upload' && p.latency?.samples.length >= 3));
  assert.ok(!progress.some((p) => p.phase === 'latency'));
});

test('concurrent RTT updates preserve receiver progress and the confirmation countdown without rewinding either direction', async (t) => {
  const f = await fixture(t, { phaseMs: 180, maxBytes: 256 * 1024 * 1024, pingIntervalMs: 30, pingMs: 100, progressMs: 60 });
  const aProgress = [], bProgress = [];
  const [b, a] = await Promise.all([
    f.b.host({ ...f.bArgs, onProgress: (p) => bProgress.push(p) }),
    f.a.client({ ...f.aArgs, onProgress: (p) => aProgress.push(p) })
  ]);
  assert.equal(a.completed, true, JSON.stringify(a)); assert.deepEqual(a, b);
  for (const progress of [aProgress, bProgress]) for (const direction of ['download', 'upload']) {
    const values = progress.filter((p) => p.phase === direction);
    assert.ok(values.some((p) => p.samplesDone && p.bytes > 0), 'RTT updates continue alongside nonzero received bytes');
    for (let i = 1; i < values.length; i++) {
      assert.ok(values[i].bytes >= values[i - 1].bytes, `${direction} receiver bytes must not reset on a pong`);
      assert.ok(values[i].elapsedMs >= values[i - 1].elapsedMs, `${direction} elapsed time must not reset on a pong`);
    }
    for (const value of values.filter((p) => p.waitingForReceiver)) {
      assert.ok(value.elapsedMs >= f.a.phaseMs); assert.ok(value.confirmationRemainingMs >= 0 && value.confirmationRemainingMs <= 5000);
    }
  }
});

test('missing RTT replies do not prevent completed receiver-verified throughput results', async (t) => {
  const f = await fixture(t, { phaseMs: 80, maxBytes: 256 * 1024 * 1024, pingIntervalMs: 20, pingMs: 20 });
  const bind = f.b.bind.bind(f.b);
  f.b.bind = (s, ws) => { bind(s, ws); ws.ping = (_data, _mask, callback) => callback?.(); };
  const [b, a] = await Promise.all([f.b.host(f.bArgs), f.a.client(f.aArgs)]);
  assert.equal(a.completed, true, JSON.stringify(a)); assert.deepEqual(a, b);
  assert.deepEqual(a.latency.samples, []); assert.ok(a.latency.failedSamples > 0);
  assert.equal(a.latency.medianMs, null);
  assert.equal(a.download.completion, 'complete'); assert.equal(a.upload.completion, 'complete');
});

test('receiver credits grow beyond a small bandwidth-delay window on an actual delayed data path', async (t) => {
  const f = await fixture(t, { phaseMs: 1000, maxBytes: 8 * 1024 * 1024, deadlineMs: 5000, handshakeMs: 1000, pingMs: 500, progressMs: 20 });
  const sockets = new Set(), timers = new Set();
  const forward = (from, to) => from.on('data', (data) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!to.destroyed) to.write(data); }, 40);
    timers.add(timer);
  });
  const delayed = net.createServer((incoming) => {
    const outgoing = net.createConnection({ host: '127.0.0.1', port: f.pairing.port });
    sockets.add(incoming); sockets.add(outgoing);
    for (const socket of [incoming, outgoing]) socket.on('error', () => {});
    incoming.once('close', () => outgoing.destroy()); outgoing.once('close', () => incoming.destroy());
    forward(incoming, outgoing); forward(outgoing, incoming);
  });
  await new Promise((resolve) => delayed.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => delayed.close(resolve)); });
  f.client.peer.dialResource = { port: delayed.address().port };
  const send = f.b.send.bind(f.b); let largestUnreceived = 0;
  f.b.send = (s, value, binary) => {
    if (binary) largestUnreceived = Math.max(largestUnreceived, s.sending.sentBytes - s.metrics.download.receivedBytes);
    return send(s, value, binary);
  };
  const [b, a] = await Promise.all([f.b.host(f.bArgs), f.a.client(f.aArgs)]);
  assert.equal(a.completed, true, JSON.stringify(a)); assert.deepEqual(a, b);
  assert.ok(a.latency.minMs >= 50, JSON.stringify(a.latency));
  assert.ok(largestUnreceived > 256 * 1024, 'Actual receiver feedback grows the initial credit window');
  assert.ok(largestUnreceived <= 4 * 1024 * 1024 + 64 * 1024, 'Unreceived application bytes remain bounded');
  assert.ok(a.download.receivedBytes >= 4 * 1024 * 1024 && a.download.receivedBytes <= 8 * 1024 * 1024);
  assert.ok(a.upload.receivedBytes >= 4 * 1024 * 1024 && a.upload.receivedBytes <= 8 * 1024 * 1024);
});

test('the default 200-ms feedback cadence does not throttle a low-RTT path to a tiny initial credit window', async (t) => {
  const f = await fixture(t, { phaseMs: 1000, maxBytes: 256 * 1024 * 1024, deadlineMs: 6000 });
  assert.equal(f.a.progressMs, 200); assert.equal(f.b.progressMs, 200);
  const [b, a] = await Promise.all([f.b.host(f.bArgs), f.a.client(f.aArgs)]);
  assert.equal(a.completed, true, JSON.stringify(a)); assert.deepEqual(a, b);
  for (const direction of ['download', 'upload']) {
    assert.ok(a[direction].receivedBytes > 4 * 1024 * 1024, `${direction} default-cadence receiver bytes: ${a[direction].receivedBytes}`);
    assert.ok(a[direction].bytesPerSecond > 4 * 1024 * 1024, `${direction} default-cadence bytes/sec: ${a[direction].bytesPerSecond}`);
  }
  t.diagnostic(`Default feedback: download ${a.download.bytesPerSecond.toFixed(0)} B/s; upload ${a.upload.bytesPerSecond.toFixed(0)} B/s`);
});

test('a temporarily paused receiver cannot accumulate a full four-MiB initial send queue', async (t) => {
  const f = await fixture(t, { phaseMs: 300, maxBytes: 8 * 1024 * 1024, progressMs: 20 });
  const beginReceive = f.a.beginReceive.bind(f.a); let heldBytes = 0;
  f.a.beginReceive = (s, direction) => {
    beginReceive(s, direction);
    if (direction === 'download') {
      s.ws.pause();
      setTimeout(() => {
        heldBytes = [...f.b.sessions][0]?.sending.sentBytes || 0;
        s.ws.resume();
      }, 150);
    }
  };
  const [b, a] = await Promise.all([f.b.host(f.bArgs), f.a.client(f.aArgs)]);
  assert.equal(a.completed, true, JSON.stringify(a)); assert.deepEqual(a, b);
  assert.ok(heldBytes > 0 && heldBytes <= 256 * 1024, heldBytes);
  assert.ok(a.download.durationMs >= 140);
  assert.equal(a.download.bytesPerSecond, a.download.receivedBytes * 1000 / a.download.durationMs);
});

test('wrong session or ticket cannot consume a reservation and a consumed ticket cannot replay', async (t) => {
  const f = await fixture(t), controller = new AbortController();
  const running = f.b.host({ ...f.bArgs, signal: controller.signal });
  for (const changed of [{ ticket: randomId(32) }, { session: randomId(32) }, { id: randomUUID() }]) {
    const ws = new WebSocket(f.url, { headers: f.headers }); ws.on('error', () => {});
    await once(ws, 'open');
    ws.send(JSON.stringify({ v: 1, id: f.bArgs.id, session: f.bArgs.session, ticket: f.bArgs.ticket, ...changed }));
    await once(ws, 'close');
    assert.equal(f.b.pending.size, 1);
  }
  const good = new WebSocket(f.url, { headers: f.headers }); good.on('error', () => {});
  await once(good, 'open');
  good.send(JSON.stringify({ v: 1, id: f.bArgs.id, session: f.bArgs.session, ticket: f.bArgs.ticket }));
  await until(() => f.b.pending.size === 0);
  const replay = new WebSocket(f.url, { headers: f.headers }); replay.on('error', () => {});
  const response = await new Promise((resolve) => replay.once('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); replay.terminate(); }));
  assert.equal(response, 409);
  controller.abort('user-cancelled'); good.terminate();
  assert.equal((await running).stopReason, 'user-cancelled');
});

test('upgrade rejects origin, wrong authorization and unrelated route without allocating data jobs', async (t) => {
  const f = await fixture(t), abort = new AbortController();
  const running = f.b.host({ ...f.bArgs, signal: abort.signal });
  for (const headers of [{ ...f.headers, Origin: 'https://example.invalid' }, { Authorization: 'Bearer wrong' }]) {
    const ws = new WebSocket(f.url, { headers }); ws.on('error', () => {});
    const status = await new Promise((resolve) => ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); ws.terminate(); }));
    assert.equal(status, 401);
  }
  assert.equal(f.b.upgrade({ url: '/network/other' }, {}, Buffer.alloc(0), f.host.peer), false);
  assert.equal(f.b.pending.size, 1); assert.equal(f.b.unverified.size, 0);
  abort.abort(); await running;
});

test('cancelling an active transfer closes only the independent data socket and returns partial receive metrics', async (t) => {
  const f = await fixture(t, { phaseMs: 1000, maxBytes: 64 * 1024 * 1024 }), abort = new AbortController();
  const b = f.b.host({ ...f.bArgs, signal: abort.signal });
  const a = f.a.client({ ...f.aArgs, onProgress(p) { if (p.phase === 'download' && p.bytes > 0) abort.abort('user-cancelled'); } });
  const [host, client] = await Promise.all([b, a]);
  assert.equal(host.completed, false); assert.equal(host.stopReason, 'user-cancelled');
  assert.equal(client.completed, false);
  assert.ok(client.download.receivedBytes > 0); assert.equal(client.download.completion, 'partial');
  assert.equal(client.upload.receivedBytes, 0);
  assert.equal(f.host.peer.isConnected(f.bConnection), true); assert.equal(f.client.peer.isConnected(f.aConnection), true);
});

test('disconnecting the captured control session cancels pending data without changing pairing', async (t) => {
  const f = await fixture(t), saved = JSON.stringify(f.pairing);
  const running = f.b.host(f.bArgs);
  f.bConnection.session = randomId(32);
  const result = await running;
  assert.equal(result.completed, false); assert.equal(result.stopReason, 'target-changed');
  assert.equal(JSON.stringify(f.pairing), saved); assert.equal(f.b.pending.size, 0);
});

test('the existing embedded dial proxy is reused without allocating or closing helper resources', async (t) => {
  const f = await fixture(t); let helperCalls = 0;
  const adapter = { embedded: true, child: {}, dial() { helperCalls++; }, listen() { helperCalls++; }, release() { helperCalls++; } };
  f.client.networkAdapter = adapter;
  f.client.peer.dialResource = { port: f.pairing.port, id: 'existing-dial' };
  f.client.peer.pairing = { ...f.pairing, host: '100.100.1.2', port: 3211 };
  const [b, a] = await Promise.all([f.b.host(f.bArgs), f.a.client(f.aArgs)]);
  assert.equal(a.completed, true, JSON.stringify(a)); assert.deepEqual(a, b); assert.equal(helperCalls, 0);
  assert.equal(f.client.peer.dialResource.id, 'existing-dial');
});

test('a deadline or close releases the speed reservation and never claims zero throughput as success', async (t) => {
  const f = await fixture(t, { deadlineMs: 40 });
  const result = await f.b.host(f.bArgs);
  assert.equal(result.completed, false); assert.equal(result.stopReason, 'deadline');
  assert.equal(result.download.completion, 'failed'); assert.equal(result.upload.completion, 'failed');
  const next = f.b.host({ ...f.bArgs, id: randomUUID() });
  assert.throws(() => f.b.host({ ...f.bArgs, id: randomUUID() }), { reason: 'busy' });
  f.b.close(); assert.equal((await next).stopReason, 'closed'); assert.equal(f.b.pending.size, 0);
});

function controlFixture({ role = 'host', channel = 'control', send } = {}) {
  const pairing = makePairing('100.100.1.2'), peer = new BridgePeer({ role, channel, pairing, capabilities: { speedTest: 1, extra: 'private' } });
  const packets = []; let terminations = 0;
  const ws = { readyState: WebSocket.OPEN, bufferedAmount: 0, terminate() { terminations++; },
    send(packet, callback) { if (send) return send(packet, callback); packets.push(JSON.parse(packet)); callback?.(); } };
  const connection = { ws, crypto: new SecureChannel(pairing.secret, pairing.room, role), session: randomId(32), authenticated: true, sendSequence: 0 };
  peer.connections.add(connection); if (role === 'client') peer.clientConnection = connection;
  const receiver = new SecureChannel(pairing.secret, pairing.room, role === 'host' ? 'client' : 'host');
  return { peer, connection, ws, packets, receiver, get terminations() { return terminations; } };
}

test('speed control negotiation uses strict small payloads on either control role without terminating it', async () => {
  for (const role of ['host', 'client']) {
    const f = controlFixture({ role });
    assert.deepEqual(f.peer.capabilities, { speedTest: 1 });
    const offer = { type: 'speed-offer', v: 1, id: randomUUID(), session: f.connection.session, ticket: randomId(32) };
    assert.equal(f.peer.trySendSpeedMessage(offer, f.connection), true);
    assert.deepEqual(f.receiver.open(f.packets[0]).body, offer);
    f.ws.bufferedAmount = 64 * 1024;
    assert.equal(f.peer.trySendSpeedMessage({ type: 'speed-request', v: 1, id: randomUUID() }, f.connection), false);
    assert.equal(f.connection.sendSequence, 1);
    f.ws.bufferedAmount = 0;
    for (const body of [{ ...offer, ticket: 'wrong' }, { ...offer, session: randomId(32) }, { ...offer, secret: 'not permitted' },
      { type: 'speed-cancel', v: 1, id: randomUUID(), reason: 'raw sensitive error' }, { type: 'speed-request', v: 1, id: 'not-a-uuid' }]) {
      assert.equal(f.peer.trySendSpeedMessage(body, f.connection), false);
    }
    assert.equal(f.terminations, 0);
  }
  const f = controlFixture({ send() { throw new Error('write failed'); } });
  assert.equal(f.peer.trySendSpeedMessage({ type: 'speed-request', v: 1, id: randomUUID() }, f.connection), false);
  assert.equal(f.connection.sendSequence, 0); assert.equal(f.terminations, 0);
  const model = controlFixture({ channel: 'model' }); assert.deepEqual(model.peer.capabilities, {});
  assert.equal(model.peer.trySendSpeedMessage({ type: 'speed-request', v: 1, id: randomUUID() }, model.connection), false);
});

test('real encrypted hello advertises only the supported control speed capability', async (t) => {
  const pairing = makePairing('127.0.0.1', 0, { allowLoopback: true });
  const b = new BridgePeer({ role: 'host', pairing, allowLoopback: true, capabilities: { speedTest: 1, hidden: 'no' } });
  await b.start();
  const a = new BridgePeer({ role: 'client', pairing, allowLoopback: true, capabilities: { speedTest: 1, hidden: 'no' } });
  t.after(async () => { await a.close(); await b.close(); });
  await a.start(); await until(() => b.state.online);
  assert.deepEqual(a.clientConnection.capabilities, { speedTest: 1 });
  assert.deepEqual([...b.connections][0].capabilities, { speedTest: 1 });
});
