import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { BridgePeer } from '../src/peer.js';
import { makePairing, SecureChannel } from '../src/crypto.js';

const request = () => ({ type: 'channel-refresh-request', v: 1, id: randomUUID() });
const result = () => ({ type: 'channel-refresh-result', v: 1, id: randomUUID(), result: {
  refreshed: true, reason: 'refreshed', before: { path: 'derp', latencyMs: 150, regionId: 3 },
  after: { path: 'direct', latencyMs: 40 }, changed: true,
} });

function fixture({ channel = 'control', send } = {}) {
  const pairing = makePairing('100.100.1.2');
  const peer = new BridgePeer({ role: 'host', pairing, channel });
  const packets = []; let terminations = 0;
  const ws = { readyState: WebSocket.OPEN, bufferedAmount: 0, terminate() { terminations++; },
    send(packet, callback) { if (send) return send(packet, callback); packets.push(JSON.parse(packet)); callback?.(); } };
  const connection = { ws, crypto: new SecureChannel(pairing.secret, pairing.room, 'host'),
    session: 'paired-session', authenticated: true, sendSequence: 0 };
  peer.connections.add(connection);
  const receiver = new SecureChannel(pairing.secret, pairing.room, 'client');
  return { peer, connection, ws, packets, receiver, get terminations() { return terminations; } };
}

test('refresh control rejects debug commands, unknown result data and congestion before consuming a nonce', () => {
  const f = fixture(), unsafe = result(); unsafe.result.after.endpoint = '203.0.113.1:12345';
  for (const body of [{ ...request(), action: 'pick-new-derp' }, { ...request(), host: '8.8.8.8' },
    { ...request(), id: 'invalid' }, { ...request(), v: 2 }, unsafe,
    { ...result(), result: { ...result().result, reason: 'private raw error' } }]) {
    assert.equal(f.peer.trySendRefreshMessage(body, f.connection), false);
  }
  f.ws.bufferedAmount = 64 * 1024;
  assert.equal(f.peer.trySendRefreshMessage(request(), f.connection), false);
  assert.equal(f.connection.sendSequence, 0); assert.equal(f.connection.crypto.counter, 0n);
  f.ws.bufferedAmount = 0;
  const body = result(); assert.equal(f.peer.trySendRefreshMessage(body, f.connection), true);
  assert.deepEqual(f.receiver.open(f.packets[0]).body, body); assert.equal(f.terminations, 0);
  const model = fixture({ channel: 'model' });
  assert.equal(model.peer.trySendRefreshMessage(request(), model.connection), false);
});

test('a failed optional refresh write preserves the authenticated control channel', () => {
  const f = fixture({ send() { throw new Error('Synthetic write failure'); } });
  assert.equal(f.peer.trySendRefreshMessage(request(), f.connection), false);
  assert.equal(f.connection.sendSequence, 0); assert.equal(f.terminations, 0);
  f.ws.send = (packet, callback) => { f.packets.push(JSON.parse(packet)); callback?.(); };
  f.peer.send({ type: 'ordinary-after-refresh' }, f.connection);
  const decoded = f.receiver.open(f.packets[0]);
  assert.equal(decoded.sequence, 1); assert.equal(decoded.body.type, 'ordinary-after-refresh');
  assert.equal(f.peer.isConnected(f.connection), true);
});

test('refresh capability and fixed commands traverse the existing encrypted session without replacing it', async (t) => {
  const pairing = makePairing('127.0.0.1', 0, { allowLoopback: true });
  const capabilities = { speedTest: 2, channelRefresh: 1, secret: 'must not be advertised' };
  const b = new BridgePeer({ role: 'host', pairing, allowLoopback: true, capabilities });
  const a = new BridgePeer({ role: 'client', pairing, allowLoopback: true, capabilities });
  t.after(async () => { await a.close(); await b.close(); });
  await b.start(); await a.start();
  const connection = [...b.connections].find((item) => b.isConnected(item)), receiving = a.clientConnection;
  const session = receiving.session;
  assert.deepEqual(receiving.capabilities, { speedTest: 2, channelRefresh: 1 });
  assert.deepEqual(connection.capabilities, { speedTest: 2, channelRefresh: 1 });
  const command = request(), incoming = once(a, 'message');
  assert.equal(b.trySendRefreshMessage(command, connection), true); assert.deepEqual((await incoming)[0], command);
  const reply = { ...result(), id: command.id }, answered = once(b, 'message');
  assert.equal(a.trySendRefreshMessage(reply), true); assert.deepEqual((await answered)[0], reply);
  const normal = once(a, 'message'); b.send({ type: 'ordinary-after-refresh' }, connection);
  assert.equal((await normal)[0].type, 'ordinary-after-refresh');
  assert.equal(a.clientConnection, receiving); assert.equal(receiving.session, session);
});
