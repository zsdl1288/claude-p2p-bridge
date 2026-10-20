import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PeerDiscovery } from '../src/peer-discovery.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 3000;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await delay(10); }
}
async function fixture(t, handler, options = {}) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dials = [], releases = [];
  const adapter = { async dial(input) { dials.push(input); return { id: String(dials.length), port: server.address().port }; }, async release(value) { releases.push(value); } };
  const discovery = new PeerDiscovery({ adapter, ...options });
  t.after(async () => { discovery.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { discovery, adapter, dials, releases, server };
}
const peer = (address, online = true) => ({ address, online });
const reply = (res, value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const host = { role: 'host', protocol: 1, name: 'Bridge B' };

test('discovery probes only online private IPv4 nodes and caps its fixed-port read-only requests', async (t) => {
  let requests = 0, connections = new Set();
  const { discovery, dials, releases } = await fixture(t, (req, res) => {
    requests++; connections.add(req.socket);
    assert.equal(req.method, 'GET'); assert.equal(req.url, '/bridge-info'); assert.equal(req.headers.connection, 'close');
    assert.equal(req.headers.authorization, undefined); reply(res, host);
  });
  const peers = [peer('8.8.8.8'), peer('127.0.0.1'), peer('192.168.1.1'), peer('example.com'), peer('100.128.1.1'), peer('100.100.0.1', false),
    ...Array.from({ length: 20 }, (_, i) => peer(`100.100.1.${i + 1}`)), peer('100.100.1.1')];
  await discovery.refresh(peers);
  assert.equal(dials.length, 12); assert.equal(requests, 12); assert.equal(releases.length, 12); assert.equal(connections.size, 12);
  assert.ok(dials.every((value) => value.port === 3211 && value.maxConnections === 1));
  assert.equal(discovery.roles.size, 12); assert.equal(discovery.roles.get('100.100.1.1').role, 'host');
});

test('discovery coalesces work, limits concurrency and caches success and failure until TTL', async (t) => {
  let active = 0, maximum = 0, clock = 100000, count = 0;
  const { discovery, dials } = await fixture(t, async (_req, res) => {
    active++; maximum = Math.max(maximum, active); const current = count++;
    await delay(30); active--; reply(res, current % 2 ? { role: 'client', protocol: 1, name: 'A' } : host);
  }, { now: () => clock });
  const peers = Array.from({ length: 9 }, (_, i) => peer(`100.100.2.${i + 1}`));
  const first = discovery.refresh(peers); assert.equal(discovery.refresh(peers), first);
  await first; assert.ok(maximum <= 3); assert.equal(dials.length, 9); assert.equal(discovery.roles.size, 5);
  clock += 11000; await discovery.refresh(peers); assert.equal(dials.length, 9);
  clock += 1000; await discovery.refresh(peers); assert.equal(dials.length, 18);
  await discovery.refresh([]); assert.equal(discovery.roles.size, 0);
});

test('malformed, oversized, redirected and unsupported responses remain unknown and release resources', async (t) => {
  const values = [null, { ...host, role: 'client' }, { ...host, protocol: 2 }, { ...host, name: '' }, { ...host, name: 'x'.repeat(81) }, { ...host, name: 'B\nsecret' }];
  let requests = 0;
  const { discovery, releases } = await fixture(t, (_req, res) => {
    const index = requests++;
    if (index < values.length) reply(res, values[index]);
    else if (index === 6) res.end('{broken json');
    else if (index === 7) res.end(' '.repeat(2049));
    else if (index === 8) { res.writeHead(302, { Location: 'http://8.8.8.8/' }); res.end(); }
    else res.end(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]));
  });
  await discovery.refresh(Array.from({ length: 10 }, (_, i) => peer(`100.100.3.${i + 1}`)));
  assert.equal(requests, 10); assert.equal(discovery.roles.size, 0); assert.equal(releases.length, 10);
});

test('timeouts retain their allocation slots and release every late resource without stale writes', async (t) => {
  const pending = [], released = [];
  const adapter = { dial() { return new Promise((resolve) => pending.push(resolve)); }, async release(resource) { released.push(resource); } };
  const discovery = new PeerDiscovery({ adapter, timeoutMs: 100 }); t.after(() => discovery.close());
  const peers = Array.from({ length: 9 }, (_, i) => peer(`100.100.4.${i + 1}`));
  await discovery.refresh(peers); assert.equal(pending.length, 3);
  await discovery.refresh(peers); assert.equal(pending.length, 3, 'Unreturned allocations must not accumulate after each timeout');
  discovery.reset();
  pending.forEach((resolve, i) => resolve({ id: `late-${i}`, port: 12345 }));
  await until(() => released.length === 3);
  assert.equal(discovery.roles.size, 0); assert.equal(discovery.allocated, 0);
});

for (const action of ['reset', 'close']) test(`${action} cancels HTTP work and prevents late role updates`, async (t) => {
  let received, complete;
  const started = new Promise((resolve) => { received = resolve; });
  const { discovery, releases } = await fixture(t, (_req, res) => { complete = () => reply(res, host); received(); }, { timeoutMs: 500 });
  const refreshing = discovery.refresh([peer('100.100.5.1')]);
  await started; discovery[action](); await refreshing; complete(); await delay(30);
  assert.equal(discovery.roles.size, 0); assert.equal(releases.length, 1);
});

test('missing adapters and invalid limits never initiate network access', async () => {
  const discovery = new PeerDiscovery();
  assert.equal((await discovery.refresh([peer('100.100.1.1')])).size, 0);
  for (const limits of [{ timeoutMs: 1500 }, { ttlMs: 100 }, { maxPeers: 13 }, { concurrency: 4 }]) assert.throws(() => new PeerDiscovery(limits), /limits/);
  discovery.close(); assert.equal((await discovery.refresh([])).size, 0);
});

test('an offline update during a probe cannot publish a stale server label', async (t) => {
  let received, complete;
  const started = new Promise((resolve) => { received = resolve; });
  const { discovery } = await fixture(t, (_req, res) => { complete = () => reply(res, host); received(); });
  const first = discovery.refresh([peer('100.100.6.1')]);
  await started;
  const offline = discovery.refresh([peer('100.100.6.1', false)]);
  assert.equal(offline, first); complete(); await first;
  assert.equal(discovery.roles.size, 0);
});
