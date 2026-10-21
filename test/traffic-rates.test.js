import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TrafficRates, RATE_WINDOW_MS } from '../src/traffic-rates.js';
import { NetworkProxy } from '../src/network-proxy.js';

test('fixed two-second traffic rates use real byte events and decay to zero without a sampling timer', () => {
  let now = 0; const rates = new TrafficRates({ now: () => now }), a = { session: 'a' }, b = { session: 'b' };
  assert.deepEqual(rates.read(a), { uploadBytesPerSecond: 0, downloadBytesPerSecond: 0 });
  rates.record(a, 2000, true); rates.record(a, 4000, false); rates.record(b, 6000, true);
  assert.deepEqual(rates.read(a), { uploadBytesPerSecond: 1000, downloadBytesPerSecond: 2000 });
  assert.equal(rates.read(b).uploadBytesPerSecond, 3000);
  now = 1999; assert.equal(rates.read(a).uploadBytesPerSecond, 1000);
  now = 2000; assert.deepEqual(rates.read(a), { uploadBytesPerSecond: 0, downloadBytesPerSecond: 0 });
  assert.equal(RATE_WINDOW_MS, 2000);
});

test('frequent reads do not create bytes or depend on polling frequency', () => {
  let now = 0; const rates = new TrafficRates({ now: () => now }), connection = { session: 'a' };
  rates.record(connection, 8000, false);
  for (let i = 0; i < 500; i++) assert.equal(rates.read(connection).downloadBytesPerSecond, 4000);
  now = 1000; for (let i = 0; i < 500; i++) assert.equal(rates.read(connection).downloadBytesPerSecond, 4000);
  now = 2000; assert.equal(rates.read(connection).downloadBytesPerSecond, 0);
  assert.equal(rates.connections.get(connection).buckets.length, 8);
});

test('new sessions, reconnects and backward clocks never reuse bytes or generate spikes', () => {
  let now = 2000; const rates = new TrafficRates({ now: () => now }), old = { session: 'old' };
  rates.record(old, 8000, true); assert.equal(rates.read(old).uploadBytesPerSecond, 4000);
  assert.equal(rates.read({ session: 'new' }).uploadBytesPerSecond, 0);
  old.session = 'new'; assert.equal(rates.read(old).uploadBytesPerSecond, 0);
  rates.record(old, 2000, true); assert.equal(rates.read(old).uploadBytesPerSecond, 1000);
  now = 1000; assert.equal(rates.read(old).uploadBytesPerSecond, 0);
  rates.record(old, 1000, true); assert.equal(rates.read(old).uploadBytesPerSecond, 500);
  now = 3000; assert.equal(rates.read(old).uploadBytesPerSecond, 0);
});

test('bucket storage remains bounded and invalid amounts or clocks cannot expose nonfinite rates', () => {
  let now = 0; const rates = new TrafficRates({ now: () => now }), connection = { session: 'a' };
  for (const bytes of [-1, NaN, Infinity, 2.5]) rates.record(connection, bytes, true);
  assert.equal(rates.read(connection).uploadBytesPerSecond, 0);
  for (let i = 0; i < 100; i++) { now += 250; rates.record(connection, 250, true); }
  assert.equal(rates.connections.get(connection).buckets.length, 8); assert.equal(rates.read(connection).uploadBytesPerSecond, 1000);
  now = NaN; assert.equal(rates.read(connection).uploadBytesPerSecond, 0);
  now = 0; assert.equal(rates.read(connection).uploadBytesPerSecond, 0);
});

function proxyFixture(t, role = 'host', options = {}) {
  let now = 0;
  const a = { id: 'a', session: 'a-session', authenticated: true, device: { name: 'A', address: '100.80.1.1' } };
  const peer = { role, heartbeatMs: 10000, state: { online: true }, connections: new Set([a]), clientConnection: role === 'client' ? a : null,
    isConnected(connection) { return Boolean(connection && this.connections.has(connection) && connection.authenticated); } };
  const bridge = Object.assign(new EventEmitter(), { peer, remoteSharing: true });
  const proxy = new NetworkProxy({ bridge, now: () => now, ...options });
  if (role === 'host') proxy.configure({ sharing: true }); else proxy.configure({ enabled: true });
  t.after(() => proxy.close());
  const flow = (connection = a) => ({ peer, connection, session: connection.session, side: role, dead: false,
    ws: { bufferedAmount: 0 }, bucketAt: Date.now(), bucketBytes: 0, close() { this.dead = true; } });
  return { peer, a, bridge, proxy, flow, setTime(value) { now = value; } };
}

test('host reports canonical A upload/download for each live A and sums only their current sessions', (t) => {
  const f = proxyFixture(t), b = { id: 'b', session: 'b-session', authenticated: true, device: { name: 'B', address: '100.80.1.2' } };
  f.peer.connections.add(b);
  f.proxy.account(f.flow(f.a), 2000, true); f.proxy.account(f.flow(f.a), 4000, false);
  f.proxy.account(f.flow(b), 6000, true); f.proxy.account(f.flow(b), 8000, false);
  const snapshot = f.proxy.status();
  assert.equal(snapshot.rateWindowMs, 2000); assert.equal(snapshot.uploadBytesPerSecond, 4000); assert.equal(snapshot.downloadBytesPerSecond, 6000);
  assert.equal(snapshot.clients.find((c) => c.id === 'a').uploadBytesPerSecond, 1000);
  assert.equal(snapshot.clients.find((c) => c.id === 'b').downloadBytesPerSecond, 4000);
  f.peer.connections.delete(f.a);
  assert.equal(f.proxy.status().uploadBytesPerSecond, 3000, 'A disconnected row contributes no residual window bytes');
  const reconnected = { ...f.a, session: 'fresh', latencyMs: null, latencyAt: null };
  f.peer.connections.add(reconnected); assert.equal(f.proxy.status().clients.find((c) => c.id === 'a').uploadBytesPerSecond, 0);
  f.peer.connections.clear(); assert.equal(f.proxy.status().uploadBytesPerSecond, null);
});

test('A total rate and RTT belong only to the current B control session; cumulative or other traffic is excluded', (t) => {
  const f = proxyFixture(t, 'client');
  f.proxy.account(f.flow(), 6000, true); f.proxy.account(f.flow(), 4000, false);
  f.a.latencyMs = 12.5; f.a.latencyAt = 0;
  assert.equal(f.proxy.status().uploadBytesPerSecond, 3000); assert.equal(f.proxy.status().downloadBytesPerSecond, 2000);
  assert.equal(f.proxy.status().latencyMs, 12.5);
  f.proxy.uploadBytes += 1e9; f.proxy.downloadBytes += 1e9; // Model/speed/system counters never call proxy.account().
  for (let i = 0; i < 100; i++) assert.equal(f.proxy.status().uploadBytesPerSecond, 3000);
  const replacement = { id: 'new-b', session: 'new-session', authenticated: true };
  f.peer.connections.add(replacement); f.peer.clientConnection = replacement;
  assert.equal(f.proxy.status().uploadBytesPerSecond, 0); assert.equal(f.proxy.status().latencyMs, null);
  f.peer.connections.delete(replacement);
  assert.equal(f.proxy.status().uploadBytesPerSecond, null); assert.equal(f.proxy.status().latencyMs, null);
});

test('only fresh current authenticated heartbeat RTT is exposed, with no active probe', (t) => {
  const f = proxyFixture(t); f.a.latencyMs = 24; f.a.latencyAt = 1000;
  f.setTime(1000); assert.equal(f.proxy.status().clients[0].latencyMs, 24);
  f.setTime(31000); assert.equal(f.proxy.status().clients[0].latencyMs, 24);
  f.setTime(31001); assert.equal(f.proxy.status().clients[0].latencyMs, null);
  f.peer.heartbeatMs = 20000; assert.equal(f.proxy.status().clients[0].latencyMs, 24);
  f.setTime(61001); assert.equal(f.proxy.status().clients[0].latencyMs, null);
  f.a.latencyAt = 62000; assert.equal(f.proxy.status().clients[0].latencyMs, null, 'A future clock timestamp is not a fresh RTT');
  f.a.authenticated = false; assert.equal(f.proxy.status().clients.length, 0);
});

test('idle rates expire while cumulative totals remain intact and rejected proxy frames are not counted', (t) => {
  const f = proxyFixture(t, 'client');
  f.proxy.account(f.flow(), 2000, false); const total = f.proxy.downloadBytes;
  f.setTime(2000); assert.equal(f.proxy.status().downloadBytesPerSecond, 0); assert.equal(f.proxy.downloadBytes, total);
  const limited = proxyFixture(t, 'host', { bytesPerSecond: 10 });
  assert.equal(limited.proxy.account(limited.flow(), 20, true), false);
  assert.equal(limited.proxy.status().uploadBytesPerSecond, 0); assert.equal(limited.proxy.uploadBytes, 0);
});
