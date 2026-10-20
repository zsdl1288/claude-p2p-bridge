import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { EmbeddedNetwork } from '../src/embedded-network.js';
import { BridgePeer } from '../src/peer.js';
import { makePairing } from '../src/crypto.js';
import { once, EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { PairingStore } from '../src/pairing-store.js';
import { encodeInvitation } from '../src/crypto.js';

async function removeTestDirectory(directory) {
  const parent = path.resolve('.bridge');
  assert.equal(path.dirname(directory), parent, 'Only an isolated test directory may be removed');
  assert.match(path.basename(directory), /^embedded-(?:test|lifecycle)-/);
  await rm(directory, { recursive: true, force: true });
}

async function fakeCore(t, options = {}) {
  await mkdir('.bridge', { recursive: true });
  const directory = await mkdtemp(path.resolve('.bridge/embedded-lifecycle-'));
  const helper = path.join(directory, 'helper.mjs');
  await writeFile(helper, `
    import { createInterface } from 'node:readline';
    const releases = [], methods = [];
    createInterface({ input: process.stdin }).on('line', (line) => {
      const { id, method, params } = JSON.parse(line);
      methods.push(method);
      if (method === 'hang') return;
      if (method === 'oversized') { process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1)); return; }
      if (method === 'invalid-utf8') { process.stdout.write(Buffer.from([123,34,120,34,58,34,255,34,125,10])); return; }
      if (method === 'init' && ${JSON.stringify(options.initError || null)}) {
        process.stdout.write(JSON.stringify({ id, error: ${JSON.stringify(options.initError || null)} }) + '\\n');
        return;
      }
      if (method === 'release') releases.push(params.id);
      const result = method === 'listen' || method === 'dial'
        ? { id: 'same-id-after-restart', port: 3211 }
        : { backendState: 'NotStarted', pid: process.pid, releases, methods };
      process.stdout.write(JSON.stringify({ id, result }) + '\\n');
    });
  `);
  const core = new EmbeddedNetwork({ directory, command: process.execPath, args: [helper], requestTimeoutMs: 1000, shutdownTimeoutMs: 1000, ...options });
  t.after(async () => { await core.close(); await removeTestDirectory(directory); });
  return core;
}

test('closing during the helper executable check cannot spawn a process afterwards', async () => {
  const core = new EmbeddedNetwork({ command: process.execPath, args: [] });
  const starting = core.start();
  await core.close();
  await assert.rejects(starting, /已关闭/);
  assert.equal(core.child, undefined);
  assert.equal(core.pending.size, 0);
});

test('status, login and reconnect retain the same local node name', async (t) => {
  const core = await fakeCore(t);
  const status = await core.status();
  assert.match(status.hostname, /^bridge-/);
  assert.equal((await core.login()).hostname, status.hostname);
  assert.equal((await core.connect()).hostname, status.hostname);
});

test('deliberate network disconnect retains the helper identity and never resumes after replacement', { timeout: 10000 }, async (t) => {
  const core = await fakeCore(t);
  await core.connect();
  const child = core.child;
  await core.disconnect();
  assert.equal(core.child, child, 'Logging out is unnecessary when leaving the private network');
  assert.equal(core.wantRunning, false);
  assert.ok((await core.status()).methods.includes('disconnect'));
  const reset = once(core, 'reset'), exited = once(child, 'exit'); child.kill(); await exited; await reset;
  const offline = await core.status();
  assert.equal(core.wantRunning, false);
  assert.deepEqual(offline.methods, ['init', 'status'], 'A status/credential operation must not resume a deliberately disconnected node');
  await core.connect();
  assert.equal(core.wantRunning, true);
  assert.ok((await core.status()).methods.includes('connect'));
});

test('helper resources remain bound to their original process after a restart', { timeout: 10000 }, async (t) => {
  const core = await fakeCore(t);
  const resource = await core.listen({ port: 3211, targetPort: 12345 });
  const first = core.child;
  const reset = once(core, 'reset');
  const exited = once(first, 'exit'); first.kill(); await exited;
  assert.match((await reset)[0].message, /进程已退出/);
  const replacement = await core.listen({ port: 3211, targetPort: 12345 });
  assert.notEqual(core.child.pid, first.pid);
  await core.release(resource);
  assert.deepEqual((await core.status()).releases, [], 'An old release must not revoke a resource owned by a replacement helper');
  await core.release(replacement);
  assert.deepEqual((await core.status()).releases, [replacement.id]);
});

test('failed initialization retires the still-running helper instead of leaking it', { timeout: 10000 }, async (t) => {
  const core = await fakeCore(t, { initError: 'fixture initialization failure' });
  await assert.rejects(core.start(), /fixture initialization failure/);
  assert.equal(core.child, null);
  assert.equal(core.pending.size, 0);
  await assert.rejects(core.start(), /fixture initialization failure/, 'The next start must receive its own response');
  assert.equal(core.child, null);
});

test('a timed-out RPC resets its helper so late allocations cannot leak', { timeout: 10000 }, async (t) => {
  const core = await fakeCore(t);
  await core.start();
  const first = core.child;
  let resets = 0; core.on('reset', () => resets++);
  await assert.rejects(core.call('hang'), /超时/);
  assert.equal(core.pending.size, 0);
  const status = await core.status();
  assert.equal(status.backendState, 'NotStarted');
  assert.notEqual(status.pid, first.pid);
  assert.equal(resets, 1, 'Reset must be emitted once even when the killed process subsequently exits');
  await core.close();
  assert.equal(resets, 1, 'Normal shutdown is not a recoverable network failure');
});

test('an oversized incomplete helper line retires its process before the RPC timeout', { timeout: 10000 }, async (t) => {
  const core = await fakeCore(t, { requestTimeoutMs: 3000 });
  await core.start();
  let resets = 0; core.on('reset', () => ++resets);
  await assert.rejects(core.call('oversized'), /单行输出超过 2048 KiB/);
  assert.equal(core.pending.size, 0);
  assert.equal(core.child, null);
  assert.equal(resets, 1);
  assert.equal((await core.status()).backendState, 'NotStarted');
});

test('invalid helper UTF-8 rejects the response and leaves no pending RPC', { timeout: 10000 }, async (t) => {
  const core = await fakeCore(t);
  await assert.rejects(core.call('invalid-utf8'), /有效的 UTF-8/);
  assert.equal(core.child, null);
  assert.equal(core.pending.size, 0);
});

test('Windows-protected pairing is durable across helper restarts, opaque on disk, and rejects invalid state', { timeout: 20000 }, async (t) => {
  const command = path.resolve('bin/bridge-net.exe');
  try { await access(command); } catch { t.skip('Build the native core before testing Windows credential protection'); return; }
  await mkdir('.bridge', { recursive: true });
  const directory = await mkdtemp(path.resolve('.bridge/embedded-test-'));
  let core = new EmbeddedNetwork({ directory, command, args: [] });
  t.after(async () => { await core.close(); await removeTestDirectory(directory); });
  const pair = makePairing('127.0.0.1', 3211, { allowLoopback: true });
  const original = { v: 1, mode: 'demo', role: 'client', invitation: encodeInvitation(pair) };
  let store = new PairingStore({ directory, protector: core, demo: true });
  await store.save(original);
  const sealed = await readFile(store.file);
  assert.ok(!sealed.includes(Buffer.from(pair.secret)) && !sealed.includes(Buffer.from(original.invitation)));
  await core.close(); core = new EmbeddedNetwork({ directory, command, args: [] });
  store = new PairingStore({ directory, protector: core, demo: true });
  assert.deepEqual(await store.load(), original);
  assert.equal((await core.status()).backendState, 'NotStarted', 'Encrypting state must never enroll a network node');
  await assert.rejects(store.save({ ...original, role: 'unsafe' }));
  assert.deepEqual(await store.load(), original, 'Invalid updates must not destroy valid credentials');
  await writeFile(store.file, 'not a Windows DPAPI record');
  await assert.rejects(store.load(), /无法读取或解密/);
  await store.clear(); assert.equal(await store.load(), null);
  const production = new PairingStore({ directory, protector: core });
  assert.notEqual(production.file, store.file, 'Demo credentials must be isolated from real pairings');
});

test('real embedded core starts over private stdio without enrolling or installing system Tailscale', { timeout: 20000 }, async (t) => {
  const command = path.resolve('bin/bridge-net.exe');
  try { await access(command); } catch { t.skip('Build the native core before testing the source checkout'); return; }
  await mkdir('.bridge', { recursive: true });
  const directory = await mkdtemp(path.resolve('.bridge/embedded-test-'));
  const network = new EmbeddedNetwork({ directory, command, args: [] });
  t.after(async () => { await network.close(); await removeTestDirectory(directory); });
  const status = await network.status();
  assert.equal(status.installed, true, JSON.stringify(status));
  assert.equal(status.embedded, true);
  assert.equal(status.running, false);
  assert.equal(status.backendState, 'NotStarted');
  assert.deepEqual(status.peers, []);
  await assert.rejects(network.listen({ port: 3211, targetPort: 12345 }), /log in/);
  await assert.rejects(network.call('invalid'), /unknown network method/);
});

test('embedded adapter keeps network listeners private while preserving encrypted pairing', { timeout: 10000 }, async (t) => {
  let localPort;
  const released = [];
  const adapter = {
    async listen({ port, targetPort }) { assert.equal(port, 3211); localPort = targetPort; return { id: 'host-listener', port }; },
    async dial({ host, port }) { assert.equal(host, '100.100.1.2'); assert.equal(port, 3211); return { id: 'client-dial', port: localPort }; },
    async release(resource) { if (resource) released.push(resource.id); }
  };
  const pairing = makePairing('100.100.1.2', 3211);
  const host = new BridgePeer({ role: 'host', pairing, networkAdapter: adapter });
  const client = new BridgePeer({ role: 'client', pairing, networkAdapter: adapter });
  t.after(async () => { await client.close(); await host.close(); });
  await host.start();
  assert.equal(host.server.address().address, '127.0.0.1');
  assert.equal(host.state.endpoint, '100.100.1.2:3211');
  await client.start();
  const message = once(host, 'message');
  client.send({ prompt: 'userspace network adapter 中文', id: 'adapter-test' });
  assert.equal((await message)[0].prompt, 'userspace network adapter 中文');
  await client.close(); await host.close();
  assert.ok(released.includes('host-listener'));
  assert.ok(released.includes('client-dial'));
});

test('connecting an already authenticated client preserves its session and releases its only dial', { timeout: 10000 }, async (t) => {
  let targetPort, dials = 0;
  const released = [];
  const adapter = {
    async listen({ targetPort: port }) { targetPort = port; return { id: 'host-listener' }; },
    async dial() { return { id: `client-dial-${++dials}`, port: targetPort }; },
    async release(resource) { released.push(resource.id); }
  };
  const pairing = makePairing('100.100.1.2', 3211);
  const host = new BridgePeer({ role: 'host', pairing, networkAdapter: adapter });
  const client = new BridgePeer({ role: 'client', pairing, networkAdapter: adapter });
  t.after(async () => { await client.close(); await host.close(); });
  await host.start(); await client.start();
  const session = client.session;
  await Promise.all([client.connect(), client.connect()]);
  assert.equal(dials, 1); assert.equal(client.connections.size, 1);
  assert.equal(client.session, session);
  await client.close();
  assert.deepEqual(released, ['client-dial-1']);
});

test('closing B during an adapter listen releases the late resource and cannot revive the listener', { timeout: 10000 }, async (t) => {
  let releaseListen, entered;
  const listening = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { releaseListen = resolve; });
  const released = [];
  const adapter = {
    async listen() { entered(); await gate; return { id: 'late-listener' }; },
    async release(resource) { released.push(resource.id); }
  };
  const peer = new BridgePeer({ role: 'host', pairing: makePairing('100.100.1.2', 3211), networkAdapter: adapter });
  t.after(() => peer.close());
  const starting = peer.start();
  const rejected = assert.rejects(starting, /已关闭/);
  await listening;
  await peer.close(); releaseListen(); await rejected;
  assert.equal(peer.server.listening, false);
  assert.equal(peer.state.listening, false);
  assert.deepEqual(released, ['late-listener']);
});

test('a client retires an in-flight dial on reset and shares concurrent connection attempts', { timeout: 10000 }, async (t) => {
  let releaseDial, entered, dials = 0;
  const dialing = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { releaseDial = resolve; });
  const released = [];
  const adapter = new EventEmitter();
  adapter.dial = async () => { ++dials; entered(); await gate; return { id: 'old-dial', port: 3211 }; };
  adapter.release = async (resource) => { released.push(resource.id); };
  const peer = new BridgePeer({ role: 'client', pairing: makePairing('100.100.1.2', 3211), networkAdapter: adapter });
  t.after(() => peer.close());
  const first = peer.connect(), second = peer.connect();
  const rejected = assert.rejects(first, /已重启/);
  assert.equal(first, second);
  await dialing;
  adapter.emit('reset', new Error('simulated adapter replacement'));
  releaseDial(); await rejected;
  assert.equal(dials, 1);
  assert.equal(peer.connections.size, 0);
  assert.deepEqual(released, ['old-dial']);
  await peer.close();
  assert.equal(adapter.listenerCount('reset'), 0);
});

async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for the bridge to recover');
}

test('an adapter reset revokes the old session before publishing its offline state', { timeout: 10000 }, async (t) => {
  let targetPort;
  const adapter = new EventEmitter();
  adapter.listen = async ({ targetPort: port }) => { targetPort = port; return { id: 'host-listener' }; };
  adapter.dial = async () => ({ id: 'client-dial', port: targetPort });
  adapter.release = async () => {};
  const pairing = makePairing('100.100.1.2', 3211);
  const host = new BridgePeer({ role: 'host', pairing, networkAdapter: adapter });
  const client = new BridgePeer({ role: 'client', pairing, networkAdapter: adapter });
  t.after(async () => { await client.close(); await host.close(); });
  await host.start(); await client.start();
  const connection = client.clientConnection;
  let usableWhenOffline;
  client.once('state', (state) => {
    assert.equal(state.online, false);
    usableWhenOffline = client.isConnected(connection);
  });
  adapter.emit('reset', new Error('simulated helper replacement'));
  assert.equal(usableWhenOffline, false, 'Consumers of the offline event must immediately reject the retired control session and proxy streams');
  assert.throws(() => client.send({ stale: true }, connection), /未连接/);
});

test('A survives an offline interval and changed underlying route without replacing its pairing', { timeout: 10000 }, async (t) => {
  const pairing = makePairing('100.100.1.2', 3211);
  let targetPort, available = true, failedDials = 0, route = 1;
  const adapter = new EventEmitter();
  adapter.listen = async ({ targetPort: port }) => { targetPort = port; return { id: 'host-listener' }; };
  adapter.dial = async () => {
    if (!available) { ++failedDials; throw new Error('simulated internet outage'); }
    return { id: `dial-route-${route}`, port: targetPort };
  };
  adapter.release = async () => {};
  const host = new BridgePeer({ role: 'host', pairing, networkAdapter: adapter });
  const client = new BridgePeer({ role: 'client', pairing: structuredClone(pairing), retryMs: 20, networkAdapter: adapter });
  t.after(async () => { await client.close(); await host.close(); });
  await host.start(); await client.start();
  const session = client.session;
  available = false;
  adapter.emit('reset', new Error('simulated network helper restart'));
  assert.equal(client.state.online, false, 'A must stop advertising an obsolete helper connection immediately');
  await until(() => failedDials >= 3);
  assert.equal(client.state.online, false);
  available = true; ++route;
  await until(() => client.state.online && host.state.online);
  assert.deepEqual(client.pairing, pairing, 'Changes to the public route must not change the pairing identity');
  assert.notEqual(client.session, session, 'A new encrypted connection gets fresh nonces and a fresh session');
  assert.equal(client.retry, 0);
  const message = once(host, 'message');
  client.send({ recovered: true });
  assert.deepEqual((await message)[0], { recovered: true });
});

test('reconnect attempts use bounded backoff, coalesce duplicate schedules and stop on close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const peer = new BridgePeer({ role: 'client', pairing: makePairing('100.100.1.2', 3211), retryInitial: true });
  let attempts = 0;
  peer.connect = async () => { ++attempts; throw new Error('offline'); };
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  peer.scheduleReconnect(); peer.scheduleReconnect();
  for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
    const before = attempts;
    t.mock.timers.tick(delay - 1); await flush(); assert.equal(attempts, before);
    t.mock.timers.tick(1); await flush(); assert.equal(attempts, before + 1);
  }
  await peer.close();
  t.mock.timers.tick(60000); await flush();
  assert.equal(attempts, 6);
  assert.equal(peer.state.online, false);
});
