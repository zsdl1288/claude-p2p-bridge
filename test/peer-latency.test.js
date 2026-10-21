import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { BridgePeer } from '../src/peer.js';
import { makePairing, randomId } from '../src/crypto.js';

class HeartbeatSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  pings = [];
  send(_packet, callback) { callback?.(); }
  ping(payload) { this.pings.push(payload); this.emit('sent-ping', payload); }
  terminate() { if (this.readyState === WebSocket.CLOSED) return; this.readyState = WebSocket.CLOSED; this.emit('close'); }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(t, { channel = 'control', authenticated = true } = {}) {
  const peer = new BridgePeer({ role: 'host', channel, pairing: makePairing('100.100.1.2'), heartbeatMs: 40 });
  const ws = new HeartbeatSocket(); peer.bindSocket(ws);
  const connection = [...peer.connections][0];
  connection.authenticated = authenticated; connection.session = authenticated ? randomId(32) : null;
  t.after(() => peer.close());
  return { peer, ws, connection };
}

test('existing control heartbeats publish RTT only once for their matching random pong token', async (t) => {
  const { ws, connection } = setup(t);
  assert.equal(connection.latencyMs, null); assert.equal(connection.latencyAt, null);
  ws.emit('pong', Buffer.from('unsolicited'));
  assert.equal(connection.latencyMs, null);
  const [token] = await once(ws, 'sent-ping');
  assert.match(token, /^[\w-]{16}$/);
  ws.emit('pong', Buffer.from('wrong-current-token'));
  assert.equal(connection.latencyMs, null);
  await delay(2); ws.emit('pong', Buffer.from(token));
  assert.ok(Number.isFinite(connection.latencyMs) && connection.latencyMs >= 0);
  assert.ok(Number.isFinite(connection.latencyAt));
  const ms = connection.latencyMs, at = connection.latencyAt;
  ws.emit('pong', Buffer.from(token)); ws.emit('pong', Buffer.from('unsolicited'));
  assert.equal(connection.latencyAt, at); assert.equal(connection.latencyMs, ms);
  assert.equal(ws.pings.length, 1, 'RTT collection adds no extra pings');
  ws.terminate(); assert.equal(connection.latencyAt, null); assert.equal(connection.latencyMs, null);
});

test('a retired token cannot refresh the RTT for a later heartbeat or a replacement connection', async (t) => {
  const { peer, ws, connection } = setup(t);
  const [oldToken] = await once(ws, 'sent-ping'); ws.emit('pong', Buffer.from(oldToken));
  const previous = connection.latencyAt;
  const [newToken] = await once(ws, 'sent-ping'); assert.notEqual(oldToken, newToken);
  ws.emit('pong', Buffer.from(oldToken)); assert.equal(connection.latencyAt, previous);
  ws.emit('pong', Buffer.from(newToken)); assert.ok(connection.latencyAt >= previous);
  ws.terminate();
  const replacement = new HeartbeatSocket(); peer.bindSocket(replacement);
  const next = [...peer.connections][0]; next.authenticated = true; next.session = randomId(32);
  replacement.emit('pong', Buffer.from(newToken));
  assert.equal(next.latencyAt, null); assert.equal(next.latencyMs, null);
});

test('model heartbeats and unverified control pongs never publish latency samples', async (t) => {
  const model = setup(t, { channel: 'model' });
  await once(model.ws, 'sent-ping'); assert.equal(model.ws.pings[0], undefined);
  model.ws.emit('pong', Buffer.from('unrelated'));
  assert.equal(model.connection.latencyAt, null); assert.equal(model.connection.latencyMs, null);
  model.ws.terminate();
  const control = setup(t, { authenticated: false });
  const [token] = await once(control.ws, 'sent-ping'); control.ws.emit('pong', Buffer.from(token));
  control.connection.authenticated = true; control.connection.session = randomId(32);
  control.ws.emit('pong', Buffer.from(token));
  assert.equal(control.connection.latencyAt, null); assert.equal(control.connection.latencyMs, null);
});
