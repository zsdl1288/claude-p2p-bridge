import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { BridgePeer } from '../src/peer.js';
import { makePairing, SecureChannel } from '../src/crypto.js';

const hint = () => ({ type: 'proxy-health', id: randomUUID(), v: 1, windowMs: 30000,
  blockedFlows: 1, pendingBytes: 65536, oldestPendingMs: 10000, completedBytes: 0,
  tcpTimeouts: 3, tcpRetransmits: 32 });

function fixture({ role = 'host', channel = 'control', send } = {}) {
  const pairing = makePairing('100.100.1.2');
  const peer = new BridgePeer({ role, pairing, channel });
  const packets = [], callbacks = [];
  let terminations = 0;
  const ws = { readyState: WebSocket.OPEN, bufferedAmount: 0,
    terminate() { terminations++; },
    send(packet, callback) {
      if (send) return send(packet, callback, packets, callbacks);
      packets.push(JSON.parse(packet)); callbacks.push(callback); callback?.();
    } };
  const connection = { ws, crypto: new SecureChannel(pairing.secret, pairing.room, role),
    session: 'fixture-authenticated-session', authenticated: true, sendSequence: 0 };
  peer.connections.add(connection);
  const receiver = new SecureChannel(pairing.secret, pairing.room, role === 'host' ? 'client' : 'host');
  return { peer, connection, ws, packets, callbacks, receiver, get terminations() { return terminations; } };
}

test('congested health hints are skipped without consuming application sequence or encryption nonce', async () => {
  const f = fixture(), body = hint();
  for (const buffered of [64 * 1024, 4 * 1024 * 1024, 5 * 1024 * 1024]) {
    f.ws.bufferedAmount = buffered;
    assert.equal(f.peer.trySendHealthHint(body, f.connection), false);
  }
  await Promise.resolve();
  assert.equal(f.connection.sendSequence, 0); assert.equal(f.connection.crypto.counter, 0n);
  assert.equal(f.packets.length, 0); assert.equal(f.terminations, 0);
  f.ws.bufferedAmount = 64 * 1024 - 1;
  assert.equal(f.peer.trySendHealthHint(body, f.connection), true);
  const decoded = f.receiver.open(f.packets[0]);
  assert.equal(decoded.sequence, 1); assert.deepEqual(decoded.body, body);
});

test('a synchronous hint write failure preserves the channel sequence and does not explicitly terminate', async () => {
  let fail = true, discarded;
  const f = fixture({ send(packet, callback, packets) {
    if (fail) { discarded = JSON.parse(packet); throw new Error('synthetic synchronous write failure'); }
    packets.push(JSON.parse(packet)); callback?.();
  } });
  assert.equal(f.peer.trySendHealthHint(hint(), f.connection), false);
  await Promise.resolve();
  assert.equal(f.terminations, 0); assert.equal(f.connection.sendSequence, 0);
  assert.equal(f.peer.isConnected(f.connection), true);
  fail = false;
  const normal = { type: 'ordinary-message', content: 'still usable after skipped hint' };
  f.peer.send(normal, f.connection);
  const decoded = f.receiver.open(f.packets[0]);
  assert.equal(decoded.sequence, 1); assert.deepEqual(decoded.body, normal);
  assert.notEqual(f.packets[0].iv, discarded.iv, 'A rejected send must never cause AES-GCM nonce reuse');
  assert.equal(f.terminations, 0);
});

test('an asynchronous hint callback error does not proactively terminate the control session', async () => {
  const f = fixture({ send(packet, callback, packets) {
    packets.push(JSON.parse(packet)); queueMicrotask(() => callback?.(new Error('synthetic async write completion failure')));
  } });
  const body = hint();
  assert.equal(f.peer.trySendHealthHint(body, f.connection), true);
  assert.equal(f.connection.sendSequence, 1, 'A send accepted by ws reserves its sequence before completion');
  await Promise.resolve();
  assert.equal(f.terminations, 0); assert.equal(f.peer.isConnected(f.connection), true);
  assert.deepEqual(f.receiver.open(f.packets[0]).body, body);
  // A failed write callback cannot prove whether TCP delivered a packet. Here
  // the accepted packet is delivered; the next message must remain contiguous.
  f.ws.send = (packet, callback) => { f.packets.push(JSON.parse(packet)); callback?.(); };
  f.peer.send({ type: 'ordinary-message' }, f.connection);
  assert.equal(f.receiver.open(f.packets[1]).sequence, 2);
  assert.equal(f.terminations, 0);
});

test('health hints reject stale, unverified, stopped, client-role and model-channel connections', async () => {
  const cases = [
    (f) => { f.peer.connections.delete(f.connection); },
    (f) => { f.connection.authenticated = false; },
    (f) => { f.connection.session = null; },
    (f) => { f.peer.closed = true; },
    (f) => { f.ws.readyState = WebSocket.CLOSING; },
    (f) => { f.ws.readyState = WebSocket.CLOSED; },
  ];
  for (const mutate of cases) {
    const f = fixture(); mutate(f);
    assert.equal(f.peer.trySendHealthHint(hint(), f.connection), false);
    assert.equal(f.connection.sendSequence, 0); assert.equal(f.packets.length, 0);
    await Promise.resolve(); assert.equal(f.terminations, 0);
  }
  for (const options of [{ role: 'client' }, { channel: 'model' }]) {
    const f = fixture(options);
    assert.equal(f.peer.trySendHealthHint(hint(), f.connection), false);
    assert.equal(f.connection.sendSequence, 0); assert.equal(f.packets.length, 0); assert.equal(f.terminations, 0);
  }
});

test('health hints accept only bounded health payloads and leave ordinary encrypted messages contiguous', async () => {
  const f = fixture();
  const cyclic = hint(); cyclic.self = cyclic;
  for (const body of [null, {}, { ...hint(), type: 'run' }, { ...hint(), v: 2 },
    { ...hint(), padding: 'x'.repeat(2049) }, cyclic]) {
    assert.equal(f.peer.trySendHealthHint(body, f.connection), false);
  }
  assert.equal(f.connection.sendSequence, 0); assert.equal(f.connection.crypto.counter, 0n);
  f.peer.send({ type: 'before-hint' }, f.connection);
  const body = hint();
  assert.equal(f.peer.trySendHealthHint(body, f.connection), true);
  f.ws.bufferedAmount = 64 * 1024;
  assert.equal(f.peer.trySendHealthHint(hint(), f.connection), false);
  f.ws.bufferedAmount = 0;
  f.peer.send({ type: 'after-hint' }, f.connection);
  const decoded = f.packets.map((packet) => f.receiver.open(packet));
  assert.deepEqual(decoded.map((packet) => packet.sequence), [1, 2, 3]);
  assert.deepEqual(decoded.map((packet) => packet.body.type), ['before-hint', 'proxy-health', 'after-hint']);
  assert.ok(decoded.every((packet) => packet.kind === 'message' && packet.session === f.connection.session));
  assert.deepEqual(decoded[1].body, body);
  assert.equal(JSON.stringify(f.packets).includes('oldestPendingMs'), false, 'Hints use the existing encrypted envelope');
  await Promise.resolve(); assert.equal(f.terminations, 0);
});

test('real authenticated A and B exchange a health hint and later ordinary messages on the same session', { timeout: 10000 }, async (t) => {
  const pairing = makePairing('127.0.0.1', 0, { allowLoopback: true });
  const host = new BridgePeer({ role: 'host', pairing, allowLoopback: true });
  const client = new BridgePeer({ role: 'client', pairing, allowLoopback: true });
  t.after(async () => { await client.close(); await host.close(); });
  await host.start(); await client.start();
  const connection = [...host.connections].find((candidate) => host.isConnected(candidate));
  assert.ok(connection);
  const session = connection.session, receiving = client.clientConnection;
  const first = once(client, 'message'), body = hint();
  assert.equal(host.trySendHealthHint(body, connection), true);
  assert.deepEqual((await first)[0], body);
  const second = once(client, 'message'); host.send({ type: 'ordinary-after-hint' }, connection);
  assert.deepEqual((await second)[0], { type: 'ordinary-after-hint' });
  const reply = once(host, 'message'); client.send({ type: 'ordinary-client-reply' });
  assert.deepEqual((await reply)[0], { type: 'ordinary-client-reply' });
  assert.equal(connection.session, session); assert.equal(client.clientConnection, receiving);
  assert.equal(receiving.receiveSequence, 2); assert.equal(host.isConnected(connection), true);
  assert.equal(client.isConnected(receiving), true);
});
