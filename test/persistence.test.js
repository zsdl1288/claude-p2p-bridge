import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Bridge } from '../src/bridge.js';
import { PersistentBridge } from '../src/persistent-bridge.js';
import { makePairing, encodeInvitation } from '../src/crypto.js';
import { validateSavedPairing } from '../src/pairing-store.js';
import { rejectUpgrade } from '../src/http-upgrade.js';

class MemoryStore {
  constructor(record = null, demo = true) { this.record = record; this.demo = demo; }
  async load() { return structuredClone(this.record); }
  async save(value) { this.record = validateSavedPairing(value, this.demo); return structuredClone(this.record); }
  async clear() { this.record = null; }
}
async function until(check, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for automatic pairing');
}
function make(store, options = {}) { return new PersistentBridge({ store, demo: true, restoreDelay: 30, ...options }); }
async function call(bridge, prompt) {
  let result;
  return new Promise((resolve, reject) => {
    bridge.run({ prompt }, (event) => {
      if (event.type === 'claude' && event.event.type === 'result') result = event.event.result;
      if (event.type === 'error') reject(new Error(event.message));
      if (event.type === 'done') event.exitCode === 0 ? resolve(result) : reject(new Error('Task failed'));
    });
  });
}

test('both sides preserve the same pairing across restart; A starts first and waits for B', { timeout: 20000 }, async (t) => {
  const hostStore = new MemoryStore(), clientStore = new MemoryStore();
  const bridges = []; t.after(async () => { for (const bridge of bridges) await bridge.close(); });
  let host = make(hostStore), client = make(clientStore); bridges.push(host, client);
  const first = await host.host({ workspace: process.cwd(), bridgePort: 0, profile: 'edit', maxTurns: 17, timeoutMs: 30000 });
  await client.join({ invitation: first.invitation });
  await until(() => host.status().online);
  assert.equal(client.status().pairing.saved, true);
  assert.equal(host.status().pairing.saved, true);
  const summary = { role: 'client', host: '127.0.0.1', port: host.peer.pairing.port, endpoint: `127.0.0.1:${host.peer.pairing.port}` };
  assert.deepEqual(client.status().pairing.summary, summary);
  assert.equal(client.status().pairing.valid, true);
  const original = structuredClone(hostStore.record);
  await Promise.all([client.close(), host.close()]);
  assert.deepEqual(hostStore.record, original, 'Exiting must not revoke pairing');
  client = make(clientStore); bridges.push(client); await client.start();
  await until(() => client.peer && !client.status().online);
  assert.equal(client.status().pairing.state, 'connecting');
  assert.equal(client.status().pairing.valid, true, 'An offline server does not invalidate the saved pairing');
  assert.deepEqual(client.status().pairing.summary, summary);
  host = make(hostStore); bridges.push(host); await host.start();
  await until(() => host.status().online && client.status().online && client.status().model.available);
  assert.equal(host.status().invitation, first.invitation, 'Restart must preserve the secret, room, address and port');
  assert.equal(host.status().config.profile, 'edit');
  assert.equal(host.status().config.maxTurns, 17);
  assert.equal(host.status().config.timeoutMs, 30000);
  assert.match(await call(client, '自动恢复后的调用'), /自动恢复后的调用/);
  assert.deepEqual(hostStore.record, original);
});

test('pause keeps credentials; resume reconnects; forgetting B revokes its listener and survives restart', { timeout: 20000 }, async (t) => {
  const hs = new MemoryStore(), cs = new MemoryStore();
  const host = make(hs), client = make(cs); const all = [host, client];
  t.after(async () => { for (const item of all) await item.close(); });
  const first = await host.host({ workspace: process.cwd(), bridgePort: 0 });
  await client.join({ invitation: first.invitation }); await until(() => host.status().online);
  await client.pause();
  assert.equal(client.status().pairing.state, 'paused'); assert.ok(cs.record);
  assert.equal(client.status().pairing.paused, true);
  assert.equal(client.status().pairing.valid, true);
  assert.deepEqual(client.status().pairing.summary, { role: 'client', host: '127.0.0.1', port: host.peer.pairing.port, endpoint: `127.0.0.1:${host.peer.pairing.port}` });
  await new Promise((resolve) => setTimeout(resolve, 100)); assert.equal(client.peer, null);
  await client.resume(); await until(() => host.status().online && client.status().online);
  await host.pause(); assert.equal(hs.record.invitation, first.invitation);
  await host.resume(); await until(() => host.status().online && client.status().online);
  await host.disconnect();
  assert.equal(hs.record, null); assert.equal(host.status().pairing.saved, false);
  await host.close();
  const restarted = make(hs); all.push(restarted); await restarted.start();
  await new Promise((resolve) => setTimeout(resolve, 100)); assert.equal(restarted.peer, undefined);
  await client.disconnect(); assert.equal(cs.record, null);
});

test('a revoked saved invitation becomes invalid without deleting it and a new invitation replaces it', { timeout: 10000 }, async (t) => {
  const host = make(new MemoryStore()), store = new MemoryStore();
  let client = make(store);
  const bridges = [host, client];
  t.after(async () => { for (const bridge of bridges) await bridge.close(); });
  const first = await host.host({ bridgePort: 0 });
  await client.join({ invitation: first.invitation });
  const original = structuredClone(store.record), port = host.peer.pairing.port;
  await client.close(); await host.disconnect();
  const replacement = await host.host({ bridgePort: port });
  assert.notEqual(replacement.invitation, first.invitation);
  client = make(store); bridges.push(client); await client.start();
  await until(() => client.status().pairing.state === 'invalid');
  assert.equal(client.status().pairing.valid, false);
  assert.equal(client.status().pairing.autoConnect, false);
  assert.deepEqual(store.record, original, 'Invalidation must retain credentials until explicit replacement or forgetting');
  assert.deepEqual(client.status().pairing.summary, { role: 'client', host: '127.0.0.1', port, endpoint: `127.0.0.1:${port}` });
  await until(() => client.peer.connections.size === 0);
  assert.equal(client.peer.reconnectTimer, null);
  await assert.rejects(client.resume(), /配对已失效/);
  await client.pause();
  assert.equal(client.status().pairing.state, 'invalid', 'Pause cannot erase an earlier explicit credential rejection');
  await client.join({ invitation: replacement.invitation });
  assert.equal(client.status().pairing.valid, true);
  assert.equal(client.status().pairing.state, 'connected');
  assert.equal(store.record.invitation, replacement.invitation);
});

for (const status of [403, 409, 503]) test(`HTTP ${status} remains retryable and never invalidates saved credentials`, { timeout: 5000 }, async (t) => {
  const server = http.createServer(); let attempts = 0;
  server.on('upgrade', (_request, socket) => { ++attempts; rejectUpgrade(socket, status, 'Temporarily unavailable'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const invitation = encodeInvitation(makePairing('127.0.0.1', server.address().port, { allowLoopback: true }));
  const store = new MemoryStore({ v: 2, mode: 'demo', role: 'client', invitation });
  const client = make(store);
  t.after(async () => { await client.close(); await new Promise((resolve) => server.close(resolve)); });
  await client.start(); await until(() => client.peer); client.peer.retryMs = 20;
  await until(() => attempts >= 2);
  assert.equal(client.status().pairing.state, 'connecting');
  assert.equal(client.status().pairing.valid, true);
  assert.equal(client.status().pairing.saved, true);
  assert.equal(store.record.invitation, invitation);
});

test('a queued pause supersedes an earlier resume or activation and cannot restart itself', { timeout: 10000 }, async (t) => {
  const store = new MemoryStore();
  const bridge = make(store);
  t.after(() => bridge.close());
  const config = { workspace: process.cwd(), bridgePort: 0 };
  await bridge.host(config);
  for (const action of ['resume', 'host']) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    bridge.enqueue(() => gate);
    const opening = action === 'host' ? bridge.host(config) : bridge.resume();
    const pausing = bridge.pause();
    await Promise.resolve(); release();
    await Promise.all([opening, pausing]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(bridge.status().pairing.state, 'paused', action);
    assert.equal(bridge.peer, null, action);
    assert.equal(bridge.restoreTimer, null, action);
    assert.ok(store.record, 'Pausing must retain the saved pairing');
  }
});

test('failed forgetting remains paused when it was queued behind resume', { timeout: 10000 }, async (t) => {
  const store = new MemoryStore();
  const bridge = make(store); t.after(() => bridge.close());
  await bridge.host({ workspace: process.cwd(), bridgePort: 0 });
  store.clear = async () => { throw new Error('fixture delete failed'); };
  let release;
  bridge.enqueue(() => new Promise((resolve) => { release = resolve; }));
  const opening = bridge.resume();
  const forgetting = assert.rejects(bridge.disconnect(), /未能删除/);
  await Promise.resolve(); await Promise.resolve(); release();
  await Promise.all([opening, forgetting]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(bridge.paused, true);
  assert.equal(bridge.peer, null);
  assert.equal(bridge.restoreTimer, null);
  assert.ok(store.record);
});

test('forgetting during pending network startup cannot resurrect saved credentials or open a listener', { timeout: 10000 }, async (t) => {
  const pair = makePairing('100.100.1.2', 3211);
  const store = new MemoryStore({ v: 1, mode: 'tailscale', role: 'client', invitation: encodeInvitation(pair) });
  let entered = false, dialed = false, release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const bridge = new PersistentBridge({ store, restoreDelay: 20, networkProvider: async () => ({ running: true, addresses: ['100.100.1.3'] }),
    networkAdapter: { async connect() { entered = true; await waiting; }, async dial() { dialed = true; throw new Error('must not dial'); } } });
  t.after(() => bridge.close()); await bridge.start(); await until(() => entered);
  const forgotten = bridge.disconnect(); release(); await forgotten;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(bridge.peer, null); assert.equal(store.record, null); assert.equal(dialed, false);
});

test('saved host waits for the network and restores without interactive login', { timeout: 10000 }, async (t) => {
  const pair = makePairing('100.100.1.2', 3211);
  const record = { v: 1, mode: 'tailscale', role: 'host', invitation: encodeInvitation(pair),
    config: { workspace: process.cwd(), profile: 'read', claudeCommand: 'claude', timeoutMs: 600000, maxTurns: 30 } };
  const store = new MemoryStore(validateSavedPairing(record, false));
  let online = false, starts = 0, listeners = 0, logins = 0;
  const bridge = new PersistentBridge({ store, restoreDelay: 20,
    networkProvider: async () => ({ running: online, addresses: online ? ['100.100.1.2'] : [] }),
    networkAdapter: { async connect() { ++starts; }, async login() { ++logins; }, async listen() { ++listeners; return { id: 'saved-listener' }; }, async release() {} } });
  t.after(() => bridge.close()); await bridge.start();
  await until(() => starts > 0); assert.equal(listeners, 0); assert.equal(bridge.status().pairing.state, 'waiting-network');
  online = true; await until(() => bridge.peer?.state.listening);
  assert.equal(bridge.status().invitation, record.invitation); assert.equal(listeners, 1); assert.equal(logins, 0);
});

test('failed credential write closes the new service; corrupt saved data can be explicitly forgotten', async (t) => {
  const store = new MemoryStore(); store.save = async () => { throw new Error('disk write failed'); };
  const bridge = make(store); t.after(() => bridge.close());
  await assert.rejects(bridge.host({ workspace: process.cwd(), bridgePort: 0 }), /disk write failed/);
  assert.equal(bridge.status().pairing.saved, false); assert.equal(bridge.peer, null); assert.equal(store.record, null);
  const corrupt = new MemoryStore(); corrupt.load = async () => { throw new Error('cannot decrypt saved pairing'); };
  const other = make(corrupt); t.after(() => other.close()); await other.start();
  assert.equal(other.status().pairing.state, 'error'); assert.equal(other.peer, undefined);
  await other.disconnect(); assert.equal(other.status().pairing.state, 'none');
});

class ResettingNetwork extends EventEmitter {
  constructor() { super(); this.generation = 0; this.listeners = 0; this.logins = 0; this.connections = 0; }
  async connect() { ++this.connections; if (this.connectGate) { const gate = this.connectGate; this.connectGate = null; await gate; } }
  async login() { ++this.logins; throw new Error('Recovery must never open interactive login'); }
  async listen({ targetPort }) {
    this.targetPort = targetPort; ++this.listeners;
    if (this.failNextListen) { this.failNextListen = false; this.reset(); throw new Error('helper failed while creating listener'); }
    return { id: 'listener', generation: this.generation };
  }
  async release(resource) { if (resource.generation === this.generation) this.targetPort = null; }
  reset() { ++this.generation; this.targetPort = null; this.emit('reset', new Error('simulated helper crash')); }
  blockNextConnect() { return new Promise((resolve) => { this.connectGate = new Promise((release) => { resolve(release); }); }); }
}
async function resetFixture(t) {
  const network = new ResettingNetwork();
  const store = new MemoryStore(null, false);
  const host = new PersistentBridge({ store, restoreDelay: 20, networkAdapter: network,
    networkProvider: async () => ({ running: true, addresses: ['100.100.1.2'] }) });
  const client = new Bridge({ networkProvider: async () => ({ running: true, addresses: ['100.100.1.3'] }),
    networkAdapter: { async dial() { if (!network.targetPort) throw new Error('B not available'); return { id: 'dial', port: network.targetPort }; }, async release() {} } });
  t.after(async () => { await client.disconnect(); await host.close(); });
  const { invitation } = await host.host({ workspace: process.cwd(), bridgePort: 3211 });
  await client.join({ invitation }); client.peer.retryMs = 20;
  await until(() => host.status().online);
  return { host, client, store, network, invitation };
}

test('a restarted network helper recreates B listener and A reconnects using the original pairing', { timeout: 12000 }, async (t) => {
  const { host, client, store, network, invitation } = await resetFixture(t);
  const original = structuredClone(store.record), previousPeer = host.peer;
  network.reset();
  await until(() => host.peer !== previousPeer && network.listeners === 2 && host.status().online && client.status().online);
  assert.equal(host.status().invitation, invitation);
  assert.deepEqual(store.record, original);
  assert.equal(network.logins, 0);
  assert.ok(network.connections > 0);
  assert.equal(network.listenerCount('reset'), 1);
  // A second helper failure while the replacement listener is still being
  // created must not strand a saved B without a pending recovery timer.
  network.failNextListen = true; network.reset();
  await until(() => network.listeners === 4 && host.status().online && client.status().online);
  assert.equal(host.status().invitation, invitation);
  await host.close();
  assert.equal(network.listenerCount('reset'), 0);
});

test('B recovers a helper reset while its first pairing is still being saved', { timeout: 10000 }, async (t) => {
  const network = new ResettingNetwork(), store = new MemoryStore(null, false);
  const saving = Promise.withResolvers(), releaseSave = Promise.withResolvers();
  const save = store.save.bind(store);
  store.save = async (record) => { saving.resolve(); await releaseSave.promise; return save(record); };
  const host = new PersistentBridge({ store, restoreDelay: 20, networkAdapter: network,
    networkProvider: async () => ({ running: true, addresses: ['100.100.1.2'] }) });
  t.after(async () => { releaseSave.resolve(); await host.close(); });
  const opening = host.host({ workspace: process.cwd(), bridgePort: 3211 });
  await saving.promise;
  const previousPeer = host.peer;
  assert.equal(network.listeners, 1);
  network.reset();
  assert.equal(network.targetPort, null);
  releaseSave.resolve();
  const { invitation } = await opening;
  await until(() => host.peer !== previousPeer && network.listeners === 2 && host.peer?.state.listening, 1500);
  assert.equal(host.status().invitation, invitation);
  assert.equal(store.record.invitation, invitation);
  assert.ok(network.targetPort);
  assert.equal(network.logins, 0);
});

test('stopping B supersedes recovery of a reset during its first pairing save', { timeout: 10000 }, async (t) => {
  for (const action of ['pause', 'disconnect', 'close']) await t.test(action, async (t) => {
    const network = new ResettingNetwork(), store = new MemoryStore(null, false);
    const saving = Promise.withResolvers(), releaseSave = Promise.withResolvers();
    const save = store.save.bind(store);
    store.save = async (record) => { saving.resolve(); await releaseSave.promise; return save(record); };
    const host = new PersistentBridge({ store, restoreDelay: 20, networkAdapter: network,
      networkProvider: async () => ({ running: true, addresses: ['100.100.1.2'] }) });
    t.after(async () => { releaseSave.resolve(); await host.close(); });
    const opening = host.host({ workspace: process.cwd(), bridgePort: 3211 });
    await saving.promise; network.reset();
    const stopping = host[action]();
    await Promise.resolve();
    releaseSave.resolve();
    await Promise.all([opening, stopping]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(host.peer, null);
    assert.equal(network.listeners, 1, 'A cancelled recovery must not allocate a replacement listener');
    assert.equal(host.restoreTimer, null);
    if (action === 'disconnect') assert.equal(store.record, null);
    else assert.ok(store.record, 'Pause and exit must preserve the committed pairing');
  });
});

test('pause, forget and close supersede network-reset recovery without resurrecting B', { timeout: 12000 }, async (t) => {
  const { host, store, network } = await resetFixture(t);
  let release = await network.blockNextConnect();
  network.reset(); await until(() => network.connections === 1);
  const pause = host.pause(); release(); await pause;
  assert.equal(host.peer, null); assert.ok(store.record);
  network.reset(); await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(network.listeners, 1);
  await host.resume(); await until(() => network.listeners === 2 && host.status().online);
  release = await network.blockNextConnect();
  const before = network.connections;
  network.reset(); await until(() => network.connections > before);
  const forgotten = host.disconnect(); release(); await forgotten;
  assert.equal(host.peer, null); assert.equal(store.record, null);
  network.reset(); await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(network.listeners, 2);
  await host.close(); network.reset();
  assert.equal(host.peer, null); assert.equal(network.listenerCount('reset'), 0);
});

test('pause, forget and close retire a saved A even when its network dial completes afterwards', { timeout: 10000 }, async (t) => {
  for (const action of ['pause', 'disconnect', 'close']) await t.test(action, async (t) => {
    const pair = makePairing('100.100.1.2', 3211);
    const original = { v: 1, mode: 'tailscale', role: 'client', invitation: encodeInvitation(pair) };
    const store = new MemoryStore(original, false);
    let releaseDial, entered, released = 0;
    const dialing = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { releaseDial = resolve; });
    const network = new EventEmitter();
    network.connect = async () => {};
    network.dial = async () => { entered(); await gate; return { id: 'late-client-proxy', port: 3211 }; };
    network.release = async () => { ++released; };
    const bridge = new PersistentBridge({ store, networkAdapter: network, restoreDelay: 10,
      networkProvider: async () => ({ running: true, addresses: ['100.100.1.3'] }) });
    t.after(() => bridge.close());
    await bridge.start(); await dialing;
    const peer = bridge.peer;
    await bridge[action]();
    releaseDial(); await until(() => released === 1);
    network.emit('reset', new Error('network returned after stop'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bridge.peer, null);
    assert.equal(peer.connections.size, 0);
    assert.equal(peer.reconnectTimer, null);
    assert.deepEqual(store.record, action === 'disconnect' ? null : original);
    if (action === 'pause') assert.equal(bridge.status().pairing.state, 'paused');
    await bridge.close();
    assert.equal(network.listenerCount('reset'), 0);
  });
});
