import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import WebSocket from 'ws';
import { NetworkProxy, encodeSocksAddress, decodeSocksAddress, isPublicAddress } from '../src/network-proxy.js';
import { randomId, digest } from '../src/crypto.js';
import { BridgePeer } from '../src/peer.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out'); await delay(10); }
}
class Reader {
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.events = new EventEmitter();
    socket.on('data', (data) => { this.buffer = Buffer.concat([this.buffer, data]); this.events.emit('data'); });
    socket.on('close', () => { this.closed = true; this.events.emit('data'); });
    socket.on('error', () => {});
  }
  async read(count) {
    const deadline = Date.now() + 3000;
    while (this.buffer.length < count) {
      if (this.closed) throw new Error('Socket closed before reply');
      if (Date.now() > deadline) throw new Error('Read timed out');
      await new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); this.events.off('data', finish); resolve(); };
        const timer = setTimeout(finish, 50); this.events.once('data', finish);
      });
    }
    const result = this.buffer.subarray(0, count); this.buffer = this.buffer.subarray(count); return result;
  }
}
async function setup(t, options = {}, clientOptions = {}) {
  const pairing = { host: '127.0.0.1', port: 0, room: randomId(18), secret: randomId(32) };
  const host = new EventEmitter(), client = new EventEmitter();
  const connection = () => ({ session: randomId(32), authenticated: true, ws: { readyState: WebSocket.OPEN } });
  const bConnection = connection(), aConnection = { ...bConnection };
  const peer = (role, conn) => ({ role, pairing, state: { online: true }, connections: new Set([conn]), clientConnection: role === 'client' ? conn : null,
    isConnected(item) { return Boolean(item && item.authenticated && item.session && this.connections.has(item) && this.state.online); } });
  host.peer = peer('host', bConnection); client.peer = peer('client', aConnection);
  const b = new NetworkProxy({ bridge: host, allowPrivateTargets: true, ...options }), a = new NetworkProxy({ bridge: client, ...clientOptions });
  b.on('state', () => host.emit('state')); a.on('state', () => client.emit('state'));
  b.configure({ sharing: true });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => b.upgrade(req, socket, head, host.peer));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); pairing.port = server.address().port;
  await a.start(); a.configure({ enabled: true });
  const localSockets = new Set();
  t.after(async () => { for (const socket of localSockets) socket.destroy(); await a.close(); await b.close(); await new Promise((resolve) => server.close(resolve)); });
  async function socks(command, address, credentials = {}) {
    const socket = net.createConnection({ host: '127.0.0.1', port: a.port, allowHalfOpen: true });
    localSockets.add(socket); const reader = new Reader(socket); await once(socket, 'connect');
    socket.write(Buffer.from([5, 1, 2])); assert.deepEqual(await reader.read(2), Buffer.from([5, 2]));
    const user = Buffer.from(credentials.username ?? a.username), pass = Buffer.from(credentials.password ?? a.password);
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    const auth = await reader.read(2);
    if (auth[1]) return { socket, reader, auth };
    socket.write(Buffer.concat([Buffer.from([5, command, 0]), encodeSocksAddress(address.host, address.port)]));
    const reply = await reader.read(10);
    return { socket, reader, reply, address: decodeSocksAddress(reply, 3) };
  }
  return { a, b, host, client, aConnection, bConnection, pairing, socks };
}
async function tcpEcho(t, handler = (socket) => socket.pipe(socket)) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); handler(socket); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  return server.address().port;
}
async function udpEcho(t) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (data, info) => socket.send(data, info.port, info.address));
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  t.after(() => socket.close()); return socket.address().port;
}
async function udpClient(t) {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  t.after(() => socket.close()); return socket;
}

test('concurrent local proxy starts wait for the same listening address', async (t) => {
  const proxy = new NetworkProxy({ bridge: new EventEmitter() });
  t.after(() => proxy.close());
  const [first, second] = await Promise.all([proxy.start(), proxy.start()]);
  assert.ok(first.listenPort > 0);
  assert.equal(second.listenPort, first.listenPort, 'A concurrent caller must not observe the temporary port 0 before listening completes');
  assert.equal(second.listening, true);
});

test('a successful listener retry clears its earlier bind error before publishing state', async (t) => {
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  t.after(async () => { if (occupied.listening) await new Promise((resolve) => occupied.close(resolve)); });
  const port = occupied.address().port;
  const proxy = new NetworkProxy({ bridge: new EventEmitter(), listenPort: port });
  t.after(() => proxy.close());
  await assert.rejects(proxy.start(), { code: 'EADDRINUSE' });
  assert.match(proxy.status().error, /EADDRINUSE/);
  await new Promise((resolve) => occupied.close(resolve));
  const states = [];
  proxy.on('state', () => states.push(proxy.status()));
  const recovered = await proxy.start();
  assert.equal(recovered.listening, true);
  assert.equal(recovered.listenPort, port);
  assert.equal(recovered.error, null);
  assert.ok(states.some((state) => state.listening));
  assert.ok(states.every((state) => state.error === null));
});

test('closing while the local proxy binds cancels startup without a stale listener or address error', async (t) => {
  const proxy = new NetworkProxy({ bridge: new EventEmitter() });
  t.after(() => proxy.close());
  const starting = proxy.start();
  const rejected = assert.rejects(starting, /网络代理已关闭/);
  await proxy.close();
  await rejected;
  assert.equal(proxy.status().listening, false);
  assert.equal(proxy.server?.listening ?? false, false);
});

test('SOCKS address codec and public-target policy cover IPv4 and IPv6 special ranges', () => {
  for (const host of ['8.8.8.8', 'example.com', '2001:4860:4860::8888']) {
    const encoded = encodeSocksAddress(host, 443), decoded = decodeSocksAddress(encoded);
    assert.equal(decoded.port, 443); assert.equal(decoded.bytes, encoded.length);
    assert.equal(decodeSocksAddress(encoded.subarray(0, encoded.length - 1)), null);
    assert.deepEqual(encodeSocksAddress(decoded.host, decoded.port), encoded);
  }
  for (const address of ['0.0.0.0', '10.1.2.3', '100.100.100.100', '127.0.0.1', '169.254.169.254', '172.31.1.1', '192.168.1.1', '198.19.1.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:8.8.8.8', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
});

test('authenticated SOCKS TCP transfers independent streams, early data and half-close', { timeout: 10000 }, async (t) => {
  const { a, b, socks } = await setup(t);
  const port = await tcpEcho(t);
  const first = await socks(1, { host: '127.0.0.1', port }), second = await socks(1, { host: '127.0.0.1', port });
  assert.equal(first.reply[1], 0); assert.equal(second.reply[1], 0);
  const payload = Buffer.alloc(256 * 1024, 0x61);
  first.socket.write(payload); second.socket.write('separate');
  assert.deepEqual(await first.reader.read(payload.length), payload);
  assert.equal((await second.reader.read(8)).toString(), 'separate');
  first.socket.end(); second.socket.end(); await until(() => a.flows.size === 0 && b.flows.size === 0);
  assert.ok(a.uploadBytes >= payload.length && a.downloadBytes >= payload.length);
});

test('unbounded defaults keep 2100 real TCP streams usable and release all local and remote slots', { timeout: 30000 }, async (t) => {
  const { a, b, socks } = await setup(t), port = await tcpEcho(t);
  assert.equal(a.status().connectionLimit, 0);
  assert.equal(b.status().connectionLimit, 0);
  assert.equal(b.status().sessionConnectionLimit, 0);
  const streams = [];
  // Keep every stream open while filling the capacity, without exceeding the
  // Windows listener's accept backlog in a single connection burst.
  for (let i = 0; i < 21; ++i) streams.push(...await Promise.all(Array.from({ length: 100 }, () => socks(1, { host: '127.0.0.1', port }))));
  assert.equal(a.flows.size, 2100); assert.equal(b.flows.size, 2100); assert.equal(a.localSockets.size, 2100);
  await Promise.all(streams.map(async ({ socket, reader, reply }, i) => {
    assert.equal(reply[1], 0, `stream ${i} must fit within the default capacity`);
    const payload = `stream-${i}`;
    socket.write(payload); assert.equal((await reader.read(Buffer.byteLength(payload))).toString(), payload);
  }));
  for (const { socket } of streams) socket.end();
  await until(() => a.flows.size === 0 && b.flows.size === 0 && a.localSockets.size === 0 && b.localSockets.size === 0);
});

test('TCP target may send data immediately after connect without losing coalesced WebSocket frames', { timeout: 10000 }, async (t) => {
  const { socks } = await setup(t);
  const port = await tcpEcho(t, (socket) => { socket.write('welcome'); socket.on('data', (data) => socket.write(data)); socket.on('end', () => socket.end('goodbye')); });
  const { socket, reader, reply } = await socks(1, { host: '127.0.0.1', port });
  assert.equal(reply[1], 0); assert.equal((await reader.read(7)).toString(), 'welcome');
  socket.end('hello'); assert.equal((await reader.read(12)).toString(), 'hellogoodbye');
});

test('a slow TCP reader receives all queued bytes before a normal half-close', { timeout: 10000 }, async (t) => {
  const { socks } = await setup(t), payload = Buffer.alloc(2 * 1024 * 1024, 0x62);
  const port = await tcpEcho(t, (socket) => socket.on('end', () => socket.end(payload)));
  const { socket, reader, reply } = await socks(1, { host: '127.0.0.1', port }); assert.equal(reply[1], 0);
  socket.pause(); socket.end(); await delay(75); socket.resume();
  assert.deepEqual(await reader.read(payload.length), payload);
});

test('UDP ASSOCIATE relays real datagrams, resolves names on B and pins local source port', { timeout: 10000 }, async (t) => {
  let lookups = 0;
  const { socks } = await setup(t, { resolve: async (name) => { assert.equal(name, 'dns.example'); lookups++; return [{ address: '127.0.0.1', family: 4 }]; } });
  const port = await udpEcho(t), udp = await udpClient(t), rogue = await udpClient(t);
  const association = await socks(3, { host: '0.0.0.0', port: 0 }); assert.equal(association.reply[1], 0);
  const send = (socket, text) => socket.send(Buffer.concat([Buffer.from([0, 0, 0]), encodeSocksAddress('dns.example', port), Buffer.from(text)]), association.address.port, '127.0.0.1');
  let result = once(udp, 'message'); send(udp, 'dns-query');
  let [reply] = await result, target = decodeSocksAddress(reply, 3);
  assert.equal(reply.subarray(3 + target.bytes).toString(), 'dns-query'); assert.equal(target.port, port);
  result = once(udp, 'message'); send(udp, 'second'); [reply] = await result;
  assert.equal(reply.subarray(3 + decodeSocksAddress(reply, 3).bytes).toString(), 'second'); assert.equal(lookups, 1);
  let leaked = false; rogue.on('message', () => { leaked = true; }); send(rogue, 'forged'); await delay(60); assert.equal(leaked, false);
  association.socket.end();
});

test('unused and inactive UDP associations expire and make their capacity available again', { timeout: 10000 }, async (t) => {
  const { a, b, socks } = await setup(t, { maxConnections: 1, maxPerSession: 1, udpIdleMs: 200 }, { udpIdleMs: 200 });
  const first = await socks(3, { host: '0.0.0.0', port: 0 }); assert.equal(first.reply[1], 0);
  await until(() => a.flows.size === 0 && b.flows.size === 0 && a.localSockets.size === 0);
  const port = await udpEcho(t), local = await udpClient(t);
  const second = await socks(3, { host: '0.0.0.0', port: local.address().port }); assert.equal(second.reply[1], 0);
  const received = once(local, 'message');
  local.send(Buffer.concat([Buffer.from([0, 0, 0]), encodeSocksAddress('127.0.0.1', port), Buffer.from('before-idle')]), second.address.port, '127.0.0.1');
  const [reply] = await received;
  assert.equal(reply.subarray(3 + decodeSocksAddress(reply, 3).bytes).toString(), 'before-idle');
  await until(() => a.flows.size === 0 && b.flows.size === 0 && a.localSockets.size === 0);
  const tcpPort = await tcpEcho(t), restored = await socks(1, { host: '127.0.0.1', port: tcpPort });
  assert.equal(restored.reply[1], 0);
  restored.socket.write('reused'); assert.equal((await restored.reader.read(6)).toString(), 'reused');
});

test('UDP bursts and pending DNS overload keep the association available', { timeout: 10000 }, async (t) => {
  let release, lookups = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const { a, b, socks } = await setup(t, { resolve: async () => { ++lookups; await gate; return [{ address: '127.0.0.1', family: 4 }]; } });
  const port = await udpEcho(t), local = await udpClient(t);
  const association = await socks(3, { host: '0.0.0.0', port: local.address().port });
  const flow = [...a.flows][0], replies = new Set();
  local.on('message', (data) => replies.add(data.subarray(3 + decodeSocksAddress(data, 3).bytes).toString()));
  const send = (message) => flow.ws.send(Buffer.concat([Buffer.from([3]), encodeSocksAddress('burst.example', port), Buffer.from(message)]));
  for (let i = 0; i < 40; i++) send('warmup');
  await until(() => lookups === 32);
  await delay(50);
  assert.equal(b.flows.size, 1, 'Exhausting outstanding DNS slots must drop a packet, not the association');
  release(); await until(() => replies.has('warmup'));
  for (let i = 0; i < 64; i++) send(`burst-${i}`);
  await until(() => Array.from({ length: 64 }, (_, i) => `burst-${i}`).every((message) => replies.has(message)));
  assert.equal(a.flows.size, 1); assert.equal(b.flows.size, 1);
  association.socket.end();
});

test('local proxy rejects wrong credentials and unauthenticated SOCKS clients', { timeout: 10000 }, async (t) => {
  const { a, socks } = await setup(t);
  assert.deepEqual((await socks(1, { host: '8.8.8.8', port: 80 }, { password: 'wrong' })).auth, Buffer.from([1, 1]));
  const socket = net.createConnection({ host: '127.0.0.1', port: a.port }); const reader = new Reader(socket); t.after(() => socket.destroy()); await once(socket, 'connect');
  socket.write(Buffer.from([5, 1, 0])); assert.deepEqual(await reader.read(2), Buffer.from([5, 255]));
});

test('rejected SOCKS handshakes release their slots without waiting for the client FIN', { timeout: 10000 }, async (t) => {
  const { a, socks } = await setup(t);
  const rejected = await socks(1, { host: '8.8.8.8', port: 80 }, { password: 'wrong' });
  assert.equal(rejected.auth[1], 1);
  await until(() => a.localSockets.size === 0);
  const socket = net.createConnection({ host: '127.0.0.1', port: a.port, allowHalfOpen: true });
  const reader = new Reader(socket); t.after(() => socket.destroy()); await once(socket, 'connect');
  socket.write(Buffer.concat([Buffer.from([5, 1, 2, 1, a.username.length]), Buffer.from(a.username), Buffer.from([a.password.length]), Buffer.from(a.password), Buffer.from([5, 2, 0, 1, 8, 8, 8, 8, 0, 80])]));
  assert.deepEqual(await reader.read(4), Buffer.from([5, 2, 1, 0]));
  assert.equal((await reader.read(10))[1], 1, 'unsupported BIND must fail');
  await until(() => a.localSockets.size === 0);
});

test('B sharing is opt-in and disables established connections immediately', { timeout: 10000 }, async (t) => {
  const { b, socks } = await setup(t); const port = await tcpEcho(t);
  const first = await socks(1, { host: '127.0.0.1', port }); assert.equal(first.reply[1], 0);
  b.configure({ sharing: false }); await until(() => first.socket.readableEnded || first.socket.destroyed);
  const rejected = await socks(1, { host: '127.0.0.1', port }); assert.notEqual(rejected.reply[1], 0);
  b.configure({ sharing: true }); const restored = await socks(1, { host: '127.0.0.1', port }); assert.equal(restored.reply[1], 0);
});

test('disconnect revokes TCP and UDP; a new authenticated session restores only new streams', { timeout: 10000 }, async (t) => {
  const { a, b, host, client, aConnection, bConnection, socks } = await setup(t);
  const port = await tcpEcho(t), tcp = await socks(1, { host: '127.0.0.1', port }), udp = await socks(3, { host: '0.0.0.0', port: 0 });
  aConnection.authenticated = bConnection.authenticated = false; host.peer.state.online = client.peer.state.online = false;
  host.emit('state'); client.emit('state');
  await until(() => (tcp.socket.readableEnded || tcp.socket.destroyed) && (udp.socket.readableEnded || udp.socket.destroyed) && a.flows.size === 0 && b.flows.size === 0);
  assert.equal(a.status().blocked, true);
  const session = randomId(32); aConnection.session = bConnection.session = session; aConnection.authenticated = bConnection.authenticated = true;
  host.peer.state.online = client.peer.state.online = true; host.emit('state'); client.emit('state');
  const restored = await socks(1, { host: '127.0.0.1', port }); assert.equal(restored.reply[1], 0);
  restored.socket.write('reconnected'); assert.equal((await restored.reader.read(11)).toString(), 'reconnected');
});

test('B rejects unauthenticated network paths and stale control sessions', { timeout: 10000 }, async (t) => {
  const { pairing } = await setup(t);
  const url = `ws://127.0.0.1:${pairing.port}/network/${pairing.room}`;
  const denied = new WebSocket(url); denied.on('error', () => {});
  const [, response] = await once(denied, 'unexpected-response'); assert.equal(response.statusCode, 401); denied.terminate();
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${digest(`p2pcc-network-v1:${pairing.room}:${pairing.secret}`)}` } }); ws.on('error', () => {});
  await once(ws, 'open'); const message = once(ws, 'message');
  ws.send(JSON.stringify({ v: 1, session: randomId(32), command: 'tcp', host: '8.8.8.8', port: 80 }));
  assert.equal(JSON.parse((await message)[0].toString()).ok, false); ws.terminate();
});

test('default policy rejects literal and DNS-rebound private destinations', { timeout: 10000 }, async (t) => {
  const { socks } = await setup(t, { allowPrivateTargets: false, resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  const port = await tcpEcho(t);
  const literal = await socks(1, { host: '127.0.0.1', port }); assert.notEqual(literal.reply[1], 0);
  const rebound = await socks(1, { host: 'rebound.example', port }); assert.notEqual(rebound.reply[1], 0);
});

test('per-session limits reject excess streams with an unbounded global limit', { timeout: 10000 }, async (t) => {
  const { a, b, socks } = await setup(t, { maxConnections: 0, maxPerSession: 1 }); const port = await tcpEcho(t);
  const first = await socks(1, { host: '127.0.0.1', port }); assert.equal(first.reply[1], 0);
  const excess = await socks(1, { host: '127.0.0.1', port }); assert.notEqual(excess.reply[1], 0);
  assert.equal(a.status().lastError?.code, 'PROXY_CAPACITY');
  assert.equal(b.status().lastError?.code, 'PROXY_CAPACITY');
  assert.ok(a.status().lastError.message); assert.ok(b.status().lastError.message);
  assert.ok(a.status().lastError.at); assert.ok(b.status().lastError.at);
  first.socket.write('still-alive'); assert.equal((await first.reader.read(11)).toString(), 'still-alive');
  first.socket.end(); await until(() => a.flows.size === 0 && b.flows.size === 0 && a.localSockets.size === 0);
  const restored = await socks(1, { host: '127.0.0.1', port }); assert.equal(restored.reply[1], 0);
  restored.socket.write('restored'); assert.equal((await restored.reader.read(8)).toString(), 'restored');
  assert.equal(a.status().lastError, null); assert.equal(b.status().lastError, null);
});

test('global capacity rejection preserves established streams with an unbounded session limit', { timeout: 10000 }, async (t) => {
  const { a, b, socks } = await setup(t, { maxConnections: 1, maxPerSession: 0 }), port = await tcpEcho(t);
  const first = await socks(1, { host: '127.0.0.1', port }); assert.equal(first.reply[1], 0);
  const excess = await socks(1, { host: '127.0.0.1', port }); assert.notEqual(excess.reply[1], 0);
  assert.equal(a.status().lastError?.code, 'PROXY_CAPACITY');
  assert.equal(b.status().lastError?.code, 'PROXY_CAPACITY');
  first.socket.write('preserved'); assert.equal((await first.reader.read(9)).toString(), 'preserved');
  first.socket.end(); await until(() => a.flows.size === 0 && b.flows.size === 0 && a.localSockets.size === 0);
  const restored = await socks(1, { host: '127.0.0.1', port }); assert.equal(restored.reply[1], 0);
  restored.socket.write('new-slot'); assert.equal((await restored.reader.read(8)).toString(), 'new-slot');
  assert.equal(a.status().lastError, null); assert.equal(b.status().lastError, null);
});

test('a zero client limit leaves the other positive limit effective', { timeout: 10000 }, async (t) => {
  for (const options of [{ maxConnections: 0, maxPerSession: 1 }, { maxConnections: 1, maxPerSession: 0 }]) {
    await t.test(JSON.stringify(options), async (t) => {
      const { a, b, socks } = await setup(t, { maxConnections: 0, maxPerSession: 0 }, options), port = await tcpEcho(t);
      assert.equal(a.status().connectionLimit, 1);
      assert.equal(b.status().connectionLimit, 0);
      const first = await socks(1, { host: '127.0.0.1', port }); assert.equal(first.reply[1], 0);
      if (options.maxConnections) await assert.rejects(() => socks(1, { host: '127.0.0.1', port }));
      else assert.notEqual((await socks(1, { host: '127.0.0.1', port })).reply[1], 0);
      assert.equal(a.status().lastError?.code, 'PROXY_CAPACITY');
      assert.equal(b.status().lastError, null, 'A must enforce its positive limit before opening another B flow');
      first.socket.write('survives'); assert.equal((await first.reader.read(8)).toString(), 'survives');
      first.socket.end(); await until(() => a.flows.size === 0 && b.flows.size === 0 && a.localSockets.size === 0);
      const restored = await socks(1, { host: '127.0.0.1', port }); assert.equal(restored.reply[1], 0);
      restored.socket.write('reused'); assert.equal((await restored.reader.read(6)).toString(), 'reused');
      assert.equal(a.status().lastError, null);
    });
  }
});

test('uncompleted remote handshakes expire and release their connection slots', { timeout: 10000 }, async (t) => {
  const { b, pairing } = await setup(t, { handshakeMs: 100 });
  const ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/network/${pairing.room}`, { headers: { Authorization: `Bearer ${digest(`p2pcc-network-v1:${pairing.room}:${pairing.secret}`)}` } });
  ws.on('error', () => {}); t.after(() => ws.terminate()); await once(ws, 'open'); assert.equal(b.flows.size, 1);
  await once(ws, 'close'); assert.equal(b.flows.size, 0);
});

test('private UDP targets are blocked before B sends a datagram', { timeout: 10000 }, async (t) => {
  const { socks } = await setup(t, { allowPrivateTargets: false });
  const target = await udpClient(t), local = await udpClient(t); let received = false;
  target.on('message', () => { received = true; });
  const association = await socks(3, { host: '0.0.0.0', port: local.address().port });
  local.send(Buffer.concat([Buffer.from([0, 0, 0]), encodeSocksAddress('127.0.0.1', target.address().port), Buffer.from('blocked')]), association.address.port, '127.0.0.1');
  await until(() => association.socket.readableEnded || association.socket.destroyed); assert.equal(received, false);
});

test('real BridgePeer authenticates the independent network path and revokes it on control disconnect', { timeout: 10000 }, async (t) => {
  const pairing = { v: 2, mode: 'tailscale', host: '127.0.0.1', port: 0, room: randomId(18), secret: randomId(32) };
  const host = new EventEmitter(), client = new EventEmitter();
  const b = new NetworkProxy({ bridge: host, allowPrivateTargets: true }), a = new NetworkProxy({ bridge: client });
  const bp = host.peer = new BridgePeer({ role: 'host', pairing, allowLoopback: true, heartbeatMs: 100, networkUpgrade: (...args) => b.upgrade(...args) });
  bp.on('state', () => host.emit('state')); b.on('state', () => host.emit('state')); b.configure({ sharing: true }); await bp.start();
  const ap = client.peer = new BridgePeer({ role: 'client', pairing: { ...pairing }, allowLoopback: true, heartbeatMs: 100 });
  ap.on('state', () => client.emit('state')); a.on('state', () => client.emit('state'));
  await ap.start(); await a.start(); a.configure({ enabled: true });
  t.after(async () => { await a.close(); await b.close(); await ap.close(); await bp.close(); });
  const port = await tcpEcho(t), socket = net.createConnection({ host: '127.0.0.1', port: a.port });
  const reader = new Reader(socket); t.after(() => socket.destroy()); await once(socket, 'connect');
  // Pipelining every SOCKS phase also exercises fragmented/coalesced parsing.
  socket.write(Buffer.concat([Buffer.from([5, 1, 2, 1, a.username.length]), Buffer.from(a.username), Buffer.from([a.password.length]), Buffer.from(a.password), Buffer.from([5, 1, 0]), encodeSocksAddress('127.0.0.1', port)]));
  assert.deepEqual(await reader.read(4), Buffer.from([5, 2, 1, 0])); assert.equal((await reader.read(10))[1], 0);
  socket.write('real-peer'); assert.equal((await reader.read(9)).toString(), 'real-peer');
  await ap.close(); await until(() => a.flows.size === 0 && b.flows.size === 0);
  assert.equal(a.status().blocked, true);
});
