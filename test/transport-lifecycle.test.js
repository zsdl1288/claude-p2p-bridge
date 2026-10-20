import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';
import { BridgePeer } from '../src/peer.js';
import { NetworkProxy } from '../src/network-proxy.js';
import { digest, makePairing, SecureChannel } from '../src/crypto.js';
import { rejectUpgrade } from '../src/http-upgrade.js';

async function bounded(promise, milliseconds = 1000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Transport did not close')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

for (const ending of ['concurrent starts', 'close during bind']) test(`B listener remains unique and disposable during ${ending}`, { timeout: 5000 }, async (t) => {
  const peer = new BridgePeer({ role: 'host', pairing: makePairing('127.0.0.1', 0, { allowLoopback: true }), allowLoopback: true });
  const servers = new Set();
  t.after(async () => {
    await peer.close();
    for (const server of servers) if (server?.listening) await new Promise((resolve) => server.close(resolve));
  });
  const starting = peer.start();
  const firstServer = peer.server; servers.add(firstServer);
  if (ending === 'concurrent starts') {
    const second = peer.start(); servers.add(peer.server);
    await Promise.all([starting, second]);
    assert.equal(peer.server, firstServer, 'Concurrent starts must share the same listener');
    await peer.start();
    servers.add(peer.server);
    assert.equal(peer.server, firstServer, 'Starting an already listening B must not replace its listener');
  } else {
    const rejected = assert.rejects(starting, /已关闭/);
    await peer.close();
    await bounded(rejected);
    assert.equal(peer.server.listening, false, 'A late bind must not outlive close()');
  }
});

test('a failed embedded B listener releases its loopback server before retrying', { timeout: 5000 }, async (t) => {
  let attempts = 0;
  const adapter = {
    async listen() { if (!attempts++) throw new Error('fixture listener failure'); return { id: 'recovered-listener' }; },
    async release() {}
  };
  const peer = new BridgePeer({ role: 'host', pairing: makePairing('100.100.1.2', 3211), networkAdapter: adapter });
  const servers = new Set();
  t.after(async () => {
    await peer.close();
    for (const server of servers) if (server?.listening) await new Promise((resolve) => server.close(resolve));
  });
  const starting = peer.start();
  const failedServer = peer.server; servers.add(failedServer);
  await assert.rejects(starting, /fixture listener failure/);
  assert.equal(failedServer.listening, false, 'Failure must not leave an unowned loopback listener');
  await peer.start(); servers.add(peer.server);
  assert.equal(peer.state.listening, true);
  assert.notEqual(peer.server, failedServer);
});

test('a reset while a rejected upgrade response is flushing cannot escape as an unhandled socket error', () => {
  // HTTP has relinquished this raw socket and no WebSocket has accepted it.
  // Keep the write pending so a transport reset can occur before the flush.
  const socket = new EventEmitter();
  let flush, destroyed = false;
  socket.end = () => { flush = () => socket.emit('error', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })); };
  socket.destroySoon = () => {};
  socket.destroy = () => { destroyed = true; };
  rejectUpgrade(socket, 401, 'Unauthorized');
  assert.doesNotThrow(() => flush());
  assert.equal(destroyed, true);
});

for (const channel of ['bridge', 'network']) test(`rejected ${channel} upgrades release half-open sockets and cannot block B shutdown`, { timeout: 5000 }, async (t) => {
  const bridge = new EventEmitter();
  const proxy = new NetworkProxy({ bridge });
  const peer = bridge.peer = new BridgePeer({ role: 'host', pairing: makePairing('127.0.0.1', 0, { allowLoopback: true }), allowLoopback: true,
    networkUpgrade: (...args) => proxy.upgrade(...args) });
  let socket;
  t.after(async () => { socket?.destroy(); await proxy.close(); await peer.close(); });
  await peer.start();
  let accepted;
  peer.server.once('connection', (connection) => { accepted = connection; });
  socket = net.createConnection({ host: '127.0.0.1', port: peer.pairing.port, allowHalfOpen: true });
  socket.on('error', () => {});
  await once(socket, 'connect');
  const serverClosed = once(accepted, 'close');
  let response = '';
  socket.on('data', (data) => { response += data.toString(); });
  const ended = once(socket, 'end');
  socket.write(`GET /${channel}/${peer.pairing.room} HTTP/1.1\r\nHost: local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: abcdefghijklmnopqrstuv==\r\n\r\n`);
  await bounded(ended);
  assert.match(response, /^HTTP\/1\.1 401 Unauthorized\r\n/);
  assert.equal(socket.writableEnded, false, 'The rejected peer deliberately keeps its sending half open');
  await bounded(serverClosed);
  await bounded(peer.close());
  assert.equal(peer.server.listening, false);
});

test('a forged acknowledgement cannot skip the model channel parent-session authorization', { timeout: 5000 }, async (t) => {
  let authorizations = 0, ready = false;
  const pairing = makePairing('127.0.0.1', 0, { allowLoopback: true });
  const peer = new BridgePeer({ role: 'host', channel: 'model', pairing, allowLoopback: true,
    authorize: () => { ++authorizations; return false; } });
  let ws;
  t.after(async () => { ws?.terminate(); await peer.close(); });
  peer.on('ready', () => { ready = true; });
  await peer.start();
  const crypto = new SecureChannel(pairing.secret, pairing.room, 'client');
  ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/model/${pairing.room}`, {
    headers: { Authorization: `Bearer ${digest(`p2pcc-model-v1:${pairing.room}:${pairing.secret}`)}` }
  });
  ws.on('error', () => {});
  const closed = once(ws, 'close');
  ws.once('message', (raw) => {
    const hello = crypto.open(JSON.parse(raw.toString()));
    assert.equal(hello.kind, 'hello');
    // Possession of the pairing secret alone must not authorize a model
    // socket: this deliberately omits the hello and its control-session proof.
    ws.send(JSON.stringify(crypto.seal({ kind: 'ack', echo: hello.nonce, nonce: null })));
  });
  await bounded(closed);
  assert.equal(ready, false);
  assert.equal(peer.state.online, false);
  assert.equal(authorizations, 0, 'The missing hello must be rejected before authentication');
});
