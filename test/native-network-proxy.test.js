import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativeNetworkProxy } from '../src/native-network-proxy.js';
import { ClashProxy } from '../src/clash-proxy.js';
import { makePairing, digest } from '../src/crypto.js';
import { EmbeddedNetwork } from '../src/embedded-network.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

class Adapter extends EventEmitter {
  calls = []; closes = []; state = null;
  async nativeProxyConfigure(config) {
    this.calls.push(structuredClone(config));
    if (this.gate) { const gate = this.gate; this.gate = null; await gate.promise; }
    const sessions = config.sessions || (config.remote ? [{ id: config.remote.session }] : []);
    this.state = { epoch: config.epoch, role: config.role, enabled: config.enabled, port: config.port || 32123,
      listening: true, connections: 0, uploadBytes: 0, downloadBytes: 0,
      sessions: sessions.map(({ id }) => ({ id, connections: 0, uploadBytes: 0, downloadBytes: 0 })) };
    return structuredClone(this.state);
  }
  async nativeProxyClose(config) { this.closes.push(config); this.state = null; return { epoch: config.epoch }; }
  async nativeProxyStatus() { return structuredClone(this.state); }
}

function fixture(t, role = 'client') {
  let time = 1000;
  const adapter = new Adapter(), bridge = new EventEmitter();
  const pairing = makePairing('100.100.1.2');
  const connection = { id: 'connection-a', session: digest('control-session-a'), authenticated: true,
    capabilities: { nativeProxy: 1 }, lastActivityAt: time, device: { address: '100.100.1.3', name: 'A' } };
  const peer = { role, pairing, state: { listening: true, online: true }, heartbeatMs: 10000,
    connections: new Set([connection]), clientConnection: connection,
    isConnected(c) { return Boolean(c?.authenticated && c.session && this.connections.has(c)); } };
  Object.assign(bridge, { peer, networkAdapter: adapter, remoteSharing: true, networkIdentity: () => ({ role: bridge.peer?.role || role }),
    broadcastProxyStatus() {}, networkStatus: () => null });
  const proxy = bridge.networkProxy = new NativeNetworkProxy({ bridge, now: () => time, pollMs: 100000, renewMs: 100000 });
  t.after(() => proxy.close());
  const endpoint = (port = 40000) => proxy.receiveStatus({ nativeProxy: { v: 1, port } }, connection);
  return { adapter, bridge, peer, connection, proxy, endpoint, setTime(value) { time = value; } };
}

test('native local SOCKS listener can restore offline and keeps its saved port and subscription credentials', async (t) => {
  const f = fixture(t); f.bridge.peer = null;
  f.proxy.listenPort = 32145; f.proxy.username = 'saved-user'; f.proxy.password = 'saved-password';
  await f.proxy.start();
  assert.equal(f.adapter.calls.at(-1).enabled, false);
  assert.equal(f.adapter.calls.at(-1).remote, undefined);
  assert.equal(f.proxy.port, 32145); assert.equal(f.proxy.server.listening, true);
  assert.equal(f.adapter.calls.at(-1).username, 'saved-user');
  const controller = new ClashProxy({ bridge: f.bridge, token: 'stable-local-api-token' });
  t.after(() => controller.close());
  controller.address = { port: 3211 }; controller.settings = { ...controller.settings, enabled: true, port: 32145 };
  f.proxy.configure({ enabled: true }); await f.proxy.flush();
  const config = JSON.parse(controller.profile());
  assert.equal(config.proxies[0].port, 32145); assert.equal(config.proxies[0].udp, true);
  assert.equal(config.proxies[0].server, '127.0.0.1');
  assert.equal(controller.status().transport, 'native-tailscale');
  assert.match(controller.status().subscriptionUrl, /^http:\/\/127\.0\.0\.1:3211\/clash\/.+\/config.yaml$/);
});

test('client uses only the paired host and credentials scoped to the current control session', async (t) => {
  const f = fixture(t); await f.proxy.start();
  f.proxy.receiveStatus({ nativeProxy: { v: 1, port: 40000, host: '203.0.113.5' } }, f.connection);
  f.proxy.configure({ enabled: true }); await f.proxy.flush();
  let desired = f.adapter.calls.at(-1);
  assert.equal(desired.remote.host, f.peer.pairing.host);
  assert.equal(desired.remote.session, f.connection.session);
  const oldPassword = desired.remote.password;
  f.connection.session = digest('new-control-session');
  await f.proxy.peerChanged();
  assert.equal(f.adapter.calls.at(-1).enabled, false, 'old endpoint is never reused for a new session');
  f.endpoint(); await f.proxy.flush(); desired = f.adapter.calls.at(-1);
  assert.notEqual(desired.remote.password, oldPassword);
  assert.equal(desired.remote.username, digest(`native-user:${f.connection.session}`).slice(0, 24));
});

test('host advertises native endpoint only after authorizing a fresh capable tailnet peer', async (t) => {
  const f = fixture(t, 'host');
  const unsupported = { ...f.connection, id: 'old', session: digest('old'), capabilities: {} };
  const special = { ...f.connection, id: 'spoof', session: digest('spoof'), device: { address: '127.0.0.1' } };
  f.peer.connections.add(unsupported); f.peer.connections.add(special);
  const gate = f.adapter.gate = deferred();
  f.proxy.configure({ sharing: true }); await tick();
  assert.equal(f.proxy.advertisement(f.connection), null);
  gate.resolve(); await f.proxy.flush();
  assert.deepEqual(f.adapter.calls.at(-1).sessions.map((row) => row.id), [f.connection.session]);
  assert.deepEqual(f.proxy.advertisement(f.connection), { v: 1, port: 32123 });
  assert.equal(f.proxy.advertisement(unsupported), null);
  f.setTime(27000); await f.proxy.reconcile(true);
  assert.deepEqual(f.adapter.calls.at(-1).sessions, [], 'stale control channels cannot renew native access');
});

test('revocation waits for the helper acknowledgement and supersedes an in-flight enable', async (t) => {
  const f = fixture(t, 'host'), gate = f.adapter.gate = deferred();
  f.proxy.configure({ sharing: true }); await tick();
  f.proxy.configure({ sharing: false });
  let revoked = false; const stopping = f.proxy.flush().then(() => { revoked = true; });
  await tick(); assert.equal(revoked, false);
  gate.resolve(); await stopping;
  assert.equal(f.adapter.state, null);
  assert.equal(f.proxy.advertisement(f.connection), null);
  assert.ok(f.adapter.closes.at(-1).epoch > f.adapter.calls[0].epoch);
});

test('unsupported remote fails closed and invalid native advertisements cannot route traffic', async (t) => {
  const f = fixture(t); await f.proxy.start();
  f.connection.capabilities = {}; f.proxy.configure({ enabled: true });
  f.endpoint(); await f.proxy.flush();
  assert.equal(f.adapter.calls.at(-1).enabled, false);
  assert.match(f.proxy.status().error, /A、B 更新/);
  f.connection.capabilities = { nativeProxy: 1 };
  for (const port of [0, 65536, '123', null]) {
    f.endpoint(port); await f.proxy.flush(); assert.equal(f.adapter.calls.at(-1).remote, undefined);
  }
  const other = { ...f.connection };
  f.proxy.receiveStatus({ nativeProxy: { v: 1, port: 40000 } }, other);
  await f.proxy.flush(); assert.equal(f.adapter.calls.at(-1).remote, undefined);
});

test('helper reset clears native readiness and rejects late replies from the retired helper', async (t) => {
  const f = fixture(t); await f.proxy.start(); f.endpoint(); f.proxy.configure({ enabled: true }); await f.proxy.flush();
  const gate = f.adapter.gate = deferred(); const updating = f.proxy.reconcile(true); await tick();
  f.adapter.emit('reset');
  gate.resolve(); await updating;
  assert.equal(f.proxy.server.listening, false); assert.equal(f.proxy.status().online, false);
  assert.equal(f.proxy.remoteEndpoint, null);
  f.connection.authenticated = false; await f.proxy.reconcile(true);
  assert.equal(f.adapter.calls.at(-1).enabled, false);
});

test('polling records only native proxy byte deltas and never reconfigures the data plane', async (t) => {
  const f = fixture(t, 'host'); f.proxy.configure({ sharing: true }); await f.proxy.flush();
  const calls = f.adapter.calls.length;
  f.adapter.state.uploadBytes = 2000; f.adapter.state.downloadBytes = 4000; f.adapter.state.connections = 2;
  Object.assign(f.adapter.state.sessions[0], { uploadBytes: 2000, downloadBytes: 4000, connections: 2 });
  await f.proxy.poll(); await f.proxy.poll();
  const state = f.proxy.status();
  assert.equal(f.adapter.calls.length, calls); assert.equal(state.uploadBytes, 2000); assert.equal(state.downloadBytes, 4000);
  assert.equal(state.clients[0].uploadBytesPerSecond, 1000); assert.equal(state.clients[0].downloadBytesPerSecond, 2000);
  assert.equal(state.clients[0].connections, 2);
  f.connection.authenticated = false;
  assert.equal(f.proxy.status().clients.length, 0); assert.equal(f.proxy.status().uploadBytesPerSecond, null);
});

test('Clash disable and forget do not acknowledge success before native authorization is revoked', async (t) => {
  const f = fixture(t, 'host');
  const controller = new ClashProxy({ bridge: f.bridge, token: 'local-token' });
  t.after(() => controller.close());
  controller.address = { port: 3211 };
  await controller.configure({ sharing: true });
  const gate = f.adapter.gate = deferred();
  let done = false; const disabling = controller.configure({ sharing: false }).then(() => { done = true; });
  await tick(); assert.equal(done, false); gate.resolve(); await disabling;
  assert.equal(f.adapter.state.enabled, false); assert.equal(controller.status().sharing, false);
  await controller.configure({ sharing: true });
  const nextGate = f.adapter.gate = deferred();
  done = false; const forgetting = controller.resetAuthorization().then(() => { done = true; });
  await tick(); assert.equal(done, false); nextGate.resolve(); await forgetting;
  assert.equal(f.adapter.state.enabled, false); assert.equal(controller.settings.pairing, null);
});

test('failed native configuration is retried with backoff instead of on every unrelated bridge update', async (t) => {
  const f = fixture(t, 'host'); let attempts = 0;
  f.adapter.nativeProxyConfigure = async () => { attempts++; throw new Error('synthetic bind failure'); };
  f.proxy.configure({ sharing: true }); await assert.rejects(f.proxy.flush(), /bind failure/);
  for (let i = 0; i < 100; i++) f.bridge.emit('state');
  await tick(); assert.equal(attempts, 1); assert.ok(f.proxy.retryTimer);
  f.proxy.configure({ sharing: false }); await f.proxy.flush();
  assert.equal(f.proxy.retryTimer, null, 'revocation cancels an old enable retry');
});

test('an adapter reset emitted before a rejected configure cannot trigger a tight respawn loop', async (t) => {
  const f = fixture(t, 'host'); let attempts = 0;
  f.adapter.nativeProxyConfigure = async () => { attempts++; f.adapter.emit('reset'); throw new Error('synthetic retired helper'); };
  f.proxy.configure({ sharing: true }); await assert.rejects(f.proxy.flush(), /retired helper/);
  for (let i = 0; i < 100; i++) f.bridge.emit('state');
  await tick(); assert.equal(attempts, 1); assert.ok(f.proxy.retryTimer);
  f.bridge.peer = null; await f.proxy.peerChanged();
  assert.equal(f.proxy.retryTimer, null); assert.equal(attempts, 1);
});

test('lease expiry is visible as waiting and is withdrawn from encrypted advertisements', async (t) => {
  const f = fixture(t, 'host'); const controller = new ClashProxy({ bridge: f.bridge, token: 'token' });
  t.after(() => controller.close());
  await controller.configure({ sharing: true });
  assert.equal(controller.status().state, 'ready');
  f.adapter.state.enabled = false; await f.proxy.poll();
  assert.equal(f.proxy.advertisement(f.connection), null);
  assert.equal(controller.status().state, 'waiting'); assert.equal(controller.status().online, false);
});

test('native counter recreation counts new bytes without underflow or re-counting old bytes', async (t) => {
  const f = fixture(t, 'host'); f.proxy.configure({ sharing: true }); await f.proxy.flush();
  f.adapter.state.uploadBytes = 5000; f.adapter.state.sessions[0].uploadBytes = 5000; await f.proxy.poll();
  f.adapter.state.uploadBytes = 500; f.adapter.state.sessions[0].uploadBytes = 500; await f.proxy.poll();
  assert.equal(f.proxy.status().uploadBytes, 5500); assert.equal(f.connection.proxyUploadBytes, 5500);
  await f.proxy.poll(); assert.equal(f.proxy.status().uploadBytes, 5500);
});

test('native status and close never launch a helper, while ambiguous configure or close failures retire it', async () => {
  const adapter = new EmbeddedNetwork(); let starts = 0, retired = 0;
  adapter.start = async () => { starts++; return adapter.child; };
  assert.equal(await adapter.nativeProxyStatus(), null);
  await adapter.nativeProxyClose({ epoch: 1 }); assert.equal(starts, 0);
  const child = adapter.child = {}; adapter.initialized.add(child);
  adapter.request = async () => { throw new Error('synthetic lost RPC reply'); };
  adapter.invalidate = (owner) => { assert.equal(owner, child); retired++; adapter.child = null; };
  await assert.rejects(adapter.nativeProxyConfigure({ epoch: 2 }), /lost RPC reply/);
  assert.equal(retired, 1);
  adapter.child = child;
  await assert.rejects(adapter.nativeProxyClose({ epoch: 3 }), /lost RPC reply/);
  assert.equal(retired, 2); assert.equal(starts, 1);
});

test('an explicit bind failure preserves the helper only after native-only revocation is acknowledged', async () => {
  for (const cleanup of ['ack', 'rejected', 'malformed', 'replaced']) {
    const adapter = new EmbeddedNetwork(), child = adapter.child = {};
    adapter.initialized.add(child); adapter.start = async () => child;
    let retired = 0; const calls = [];
    adapter.invalidate = (owner) => { assert.equal(owner, child); retired++; adapter.child = null; };
    adapter.request = async (method, params, owner) => {
      calls.push({ method, epoch: params.epoch }); assert.equal(owner, child);
      if (method === 'native-proxy-configure') throw Object.assign(new Error('local port occupied'), { rpcRejected: true });
      if (cleanup === 'rejected') throw new Error('cleanup failed');
      if (cleanup === 'malformed') return { epoch: 5 };
      if (cleanup === 'replaced') adapter.child = {};
      return { epoch: 5, enabled: false, listening: false, port: 0, connections: 0 };
    };
    await assert.rejects(adapter.nativeProxyConfigure({ epoch: 4 }), /port occupied/);
    assert.deepEqual(calls, [{ method: 'native-proxy-configure', epoch: 4 }, { method: 'native-proxy-close', epoch: 5 }]);
    assert.equal(retired, ['rejected', 'malformed'].includes(cleanup) ? 1 : 0);
    if (cleanup === 'ack') assert.equal(adapter.child, child, 'model/control helper remains alive');
    if (cleanup === 'replaced') assert.notEqual(adapter.child, child, 'late old-child error cannot kill replacement');
  }
});
