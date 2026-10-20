import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ApplicationBridge } from '../src/application-bridge.js';
import { validateApplication } from '../src/application-store.js';
import { validateSavedPairing } from '../src/pairing-store.js';
import { createLocalServer } from '../src/server.js';

class Pairings {
  constructor(record = null, demo = true) { this.record = record; this.demo = demo; }
  async load() { return structuredClone(this.record); }
  async save(value) { this.record = validateSavedPairing(value, this.demo); return structuredClone(this.record); }
  async clear() { this.record = null; }
}
class Preferences {
  constructor(record = null) { this.record = record; }
  async load() { return structuredClone(this.record); }
  async save(value) {
    if (this.fail) throw new Error('synthetic preferences write failure');
    this.record = validateApplication(value); return structuredClone(this.record);
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('identity condition timed out'); await sleep(10); } }
function make(t, options = {}) {
  const store = options.store || new Pairings(), applicationStore = options.applicationStore || new Preferences();
  const bridge = new ApplicationBridge({ demo: true, restoreDelay: 20, ...options, store, applicationStore });
  t.after(async () => { await bridge.close(); await bridge.networkProxy.close(); });
  return { bridge, store, applicationStore };
}
async function host(t, options = {}) {
  const fixture = make(t, options), { bridge } = fixture;
  await bridge.start(); await bridge.selectIdentity({ role: 'host' }); await bridge.loginNetwork();
  await bridge.host({ bridgePort: 0 }); return fixture;
}
function adapter() {
  const value = new EventEmitter(); value.calls = []; value.running = false;
  value.status = async () => ({ running: value.running, addresses: ['100.100.1.1'], hostname: 'test-node', peers: [] });
  value.login = async () => { value.calls.push('login'); value.running = true; return value.status(); };
  value.connect = async () => { value.calls.push('connect'); value.running = true; return value.status(); };
  value.disconnect = async () => { value.calls.push('disconnect'); value.running = false; return value.status(); };
  return value;
}

test('identity is chosen before networking; B pairing does not require Claude and business gates persist offline', async (t) => {
  const { bridge } = make(t); await bridge.start();
  assert.equal(bridge.status().identity.loaded, true);
  assert.deepEqual(bridge.status().capabilities, { model: false, proxy: false });
  await assert.rejects(bridge.loginNetwork(), /先选择/);
  await assert.rejects(bridge.host({ bridgePort: 0 }), /不是服务端/);
  await bridge.selectIdentity({ role: 'host' }); await bridge.loginNetwork();
  await assert.rejects(bridge.selectIdentity({ role: 'client' }), /锁定/);
  await assert.rejects(bridge.host({ workspace: process.cwd() }), /不接受 Claude/);
  await bridge.host({ bridgePort: 0 });
  assert.equal(bridge.status().model.configured, false);
  assert.equal(bridge.status().model.enabled, false);
  assert.deepEqual(bridge.status().capabilities, { model: true, proxy: true });
  const invitation = bridge.status().invitation;
  const disconnected = await bridge.disconnectNetwork();
  assert.equal(disconnected.identity.canSwitchRole, true);
  assert.equal(disconnected.network.devices[0].online, false);
  assert.equal(bridge.status().invitation, invitation);
  assert.equal(bridge.status().identity.canSwitchRole, true);
  assert.deepEqual(bridge.status().capabilities, { model: true, proxy: true });
  await assert.rejects(bridge.resume(), /主动断开/);
});

test('manual network down is durable and does not automatically reconnect after restart', async (t) => {
  const { bridge, store, applicationStore } = await host(t);
  const invitation = bridge.status().invitation;
  await bridge.disconnectNetwork(); await bridge.close();
  const restored = make(t, { store, applicationStore }).bridge; await restored.start();
  await sleep(70);
  assert.equal(restored.peer, undefined);
  assert.equal(restored.status().identity.desiredOnline, false);
  assert.equal(restored.status().identity.locked, false);
  assert.equal(restored.status().invitation, invitation);
  await restored.loginNetwork(); await until(() => restored.peer?.state.listening);
  assert.equal(restored.status().invitation, invitation);
  assert.equal(restored.status().identity.locked, true);
});

test('switching roles revokes the old pairing and proxy authorization while retaining disabled Claude configuration', async (t) => {
  const fixture = await host(t), { bridge, store } = fixture;
  const app = createLocalServer({ port: 0, token: 'identity-test-token', bridge });
  t.after(() => app.close()); await app.listen();
  await bridge.configureModel({ enabled: true, workspace: process.cwd(), profile: 'read' });
  await app.proxy.configure({ sharing: true });
  const oldInvitation = bridge.status().invitation, oldRevision = bridge.status().revision;
  await bridge.disconnectNetwork(); await bridge.selectIdentity({ role: 'client' });
  assert.equal(store.record, null);
  assert.equal(bridge.status().identity.role, 'client');
  assert.equal(bridge.status().pairing.saved, false);
  assert.deepEqual(bridge.status().capabilities, { model: false, proxy: false });
  assert.equal(app.proxy.settings.sharing, false); assert.equal(app.proxy.settings.enabled, false);
  assert.equal(app.proxy.settings.pairing, null);
  assert.equal(bridge.modelPreferences.config.workspace, process.cwd());
  assert.equal(bridge.modelPreferences.enabled, false);
  assert.ok(bridge.status().revision > oldRevision);
  await bridge.selectIdentity({ role: 'host' }); await bridge.loginNetwork(); await bridge.host({ bridgePort: 0 });
  assert.notEqual(bridge.status().invitation, oldInvitation);
  assert.equal(bridge.status().model.enabled, false);
  assert.equal(bridge.status().model.configured, true);
});

test('a transient route failure never unlocks identity', async (t) => {
  const network = adapter();
  const { bridge } = make(t, { demo: false, networkAdapter: network, networkProvider: () => network.status() });
  await bridge.start(); await bridge.selectIdentity({ role: 'host' }); await bridge.loginNetwork();
  network.running = false; await bridge.networkInfo(true);
  assert.equal(bridge.status().identity.state, 'reconnecting');
  assert.equal(bridge.status().identity.locked, true);
  await assert.rejects(bridge.selectIdentity({ role: 'client' }), /锁定/);
  await bridge.disconnectNetwork();
  assert.equal(bridge.status().identity.canSwitchRole, true);
});

test('an identity commit excludes concurrent login and a second role selection', async (t) => {
  const { bridge, applicationStore } = make(t); await bridge.start();
  await bridge.selectIdentity({ role: 'host' });
  const gate = Promise.withResolvers(), save = applicationStore.save.bind(applicationStore); let entered = false;
  applicationStore.save = async (record) => {
    if (record.role === 'client') { entered = true; await gate.promise; }
    return save(record);
  };
  t.after(() => gate.resolve());
  const changing = bridge.selectIdentity({ role: 'client' }); await until(() => entered);
  const attempts = Promise.allSettled([bridge.loginNetwork(), bridge.selectIdentity({ role: 'host' })]);
  await sleep(0);
  const during = bridge.status();
  gate.resolve(); const selected = await changing;
  const results = await attempts;
  assert.equal(during.identity.desiredOnline, false);
  assert.equal(during.identity.canSwitchRole, false);
  for (const result of results) { assert.equal(result.status, 'rejected'); assert.match(result.reason.message, /正在切换/); }
  assert.equal(selected.identity.canSwitchRole, true);
  assert.equal(selected.identity.state, 'disconnected');
  assert.equal(bridge.status().identity.role, 'client');
  assert.equal(bridge.status().identity.desiredOnline, false);
  assert.equal(applicationStore.record.role, 'client');
  assert.equal(applicationStore.record.desiredOnline, false);
  await bridge.loginNetwork();
  assert.equal(bridge.status().identity.desiredOnline, true);
});

test('a failed identity commit releases its exclusion and retains the previous offline identity', async (t) => {
  const { bridge, applicationStore } = make(t); await bridge.start();
  await bridge.selectIdentity({ role: 'host' });
  applicationStore.fail = true;
  await assert.rejects(bridge.selectIdentity({ role: 'client' }), /preferences write failure/);
  assert.equal(bridge.status().identity.role, 'host');
  assert.equal(bridge.status().identity.canSwitchRole, true);
  assert.equal(applicationStore.record.role, 'host');
  applicationStore.fail = false;
  await bridge.loginNetwork();
  assert.equal(bridge.status().identity.role, 'host');
  assert.equal(bridge.status().identity.desiredOnline, true);
});

test('an identity change stops advertising business access before old credentials finish clearing', async (t) => {
  const { bridge, store } = await host(t); await bridge.disconnectNetwork();
  const gate = Promise.withResolvers(), clear = store.clear.bind(store); let entered = false;
  store.clear = async () => { entered = true; await gate.promise; return clear(); };
  t.after(() => gate.resolve());
  const changing = bridge.selectIdentity({ role: 'client' }); await until(() => entered);
  assert.ok(store.record, 'The old authorization is deliberately still being cleared');
  assert.equal(bridge.status().identity.state, 'switching');
  assert.deepEqual(bridge.status().capabilities, { model: false, proxy: false });
  assert.equal(bridge.status().pairing.ready, false);
  assert.throws(() => bridge.requireBusiness('proxy'), /正在切换/);
  await assert.rejects(bridge.configureModel({ enabled: false }), /正在切换/);
  await assert.rejects(bridge.host({ bridgePort: 0 }), /正在切换/);
  gate.resolve(); await changing;
  assert.equal(store.record, null);
  assert.deepEqual(bridge.status().capabilities, { model: false, proxy: false });
});

test('late network polls cannot overwrite a completed disconnect or subsequent login', async (t) => {
  const network = adapter();
  const { bridge } = make(t, { demo: false, networkAdapter: network, networkProvider: () => network.status() });
  await bridge.start(); await bridge.selectIdentity({ role: 'client' }); await bridge.loginNetwork();
  for (const online of [false, true]) {
    const stale = await network.status(), gate = Promise.withResolvers(); let entered = false;
    bridge.networkProvider = async () => { entered = true; await gate.promise; return stale; };
    const polling = bridge.networkInfo(true); await until(() => entered);
    try {
      if (online) await bridge.loginNetwork(); else await bridge.disconnectNetwork();
    } finally { gate.resolve(); }
    assert.equal((await polling).running, online);
    assert.equal(bridge.status().network.running, online);
    assert.equal(bridge.status().network.devices[0].online, online);
    assert.equal(bridge.status().identity.locked, online);
  }
});

test('shutdown rejects both new and already preparing Claude configuration changes', async (t) => {
  const { bridge, applicationStore } = await host(t);
  const gate = Promise.withResolvers(); let entered = false;
  const prepare = bridge.prepareModel.bind(bridge);
  bridge.prepareModel = async (input) => { entered = true; await gate.promise; return prepare(input); };
  const rejected = assert.rejects(bridge.configureModel({ enabled: true, workspace: process.cwd() }), /正在退出/);
  await until(() => entered);
  const closing = bridge.close(); gate.resolve(); await rejected; await closing;
  assert.equal(applicationStore.record.model.enabled, false);
  assert.equal(bridge.modelPreferences.enabled, false);
  await assert.rejects(bridge.configureModel({ enabled: true, workspace: process.cwd() }), /正在退出/);
});

test('network-down supersedes an in-flight login and cannot be followed by a queued role change until down finishes', async (t) => {
  const network = adapter(), gate = Promise.withResolvers(); let entered = false;
  network.login = async () => { network.calls.push('login'); entered = true; await gate.promise; network.running = true; return network.status(); };
  t.after(() => gate.resolve());
  const { bridge, applicationStore } = make(t, { demo: false, networkAdapter: network, networkProvider: () => network.status() });
  await bridge.start(); await bridge.selectIdentity({ role: 'host' });
  const up = bridge.loginNetwork(); await until(() => entered);
  const down = bridge.disconnectNetwork();
  await assert.rejects(bridge.selectIdentity({ role: 'client' }), /锁定/);
  gate.resolve(); await Promise.all([up, down]);
  assert.deepEqual(network.calls, ['login', 'disconnect']);
  assert.equal(bridge.status().identity.desiredOnline, false);
  assert.equal(bridge.status().identity.locked, false);
  assert.equal(applicationStore.record.desiredOnline, false);
  await sleep(60); assert.equal(network.running, false);
});

test('queued host activation cannot reopen a listener after explicit network-down', async (t) => {
  const { bridge, store } = make(t); await bridge.start();
  await bridge.selectIdentity({ role: 'host' }); await bridge.loginNetwork();
  const gate = Promise.withResolvers(); t.after(() => gate.resolve());
  bridge.enqueue(() => gate.promise);
  const opening = bridge.host({ bridgePort: 0 });
  const rejected = assert.rejects(opening, /取消|改变|连接/);
  await sleep(20); const down = bridge.disconnectNetwork(); gate.resolve();
  await rejected; await down; await sleep(40);
  assert.equal(bridge.peer, null); assert.equal(store.record, null);
  assert.equal(bridge.status().identity.canSwitchRole, true);
});

test('network-down cancels an activation already waiting for its listener before committing pairing', async (t) => {
  const { bridge, store } = make(t); await bridge.start();
  await bridge.selectIdentity({ role: 'host' }); await bridge.loginNetwork();
  const gate = Promise.withResolvers(), attach = bridge.attach.bind(bridge); let entered = false;
  bridge.attach = async (...args) => { entered = true; await gate.promise; return attach(...args); };
  t.after(() => gate.resolve());
  const opening = bridge.host({ bridgePort: 0 });
  const rejected = assert.rejects(opening, /取消|改变|连接/);
  await until(() => entered);
  const down = bridge.disconnectNetwork(); gate.resolve();
  await rejected; await down;
  assert.equal(store.record, null);
  assert.equal(bridge.peer, null);
  assert.equal(bridge.status().identity.canSwitchRole, true);
});

test('shutdown cancels an in-flight pairing before it can save newly created authorization', async (t) => {
  const { bridge, store } = make(t); await bridge.start();
  await bridge.selectIdentity({ role: 'host' }); await bridge.loginNetwork();
  const gate = Promise.withResolvers(), attach = bridge.attach.bind(bridge); let entered = false;
  bridge.attach = async (...args) => { entered = true; await gate.promise; return attach(...args); };
  t.after(() => gate.resolve());
  const opening = bridge.host({ bridgePort: 0 });
  const rejected = assert.rejects(opening, /正在退出/);
  await until(() => entered);
  const closing = bridge.close(); gate.resolve();
  await rejected; await closing;
  assert.equal(store.record, null);
  assert.equal(bridge.peer, null);
});

test('failed network-down keeps the role locked and can be retried without losing login or pairing', async (t) => {
  const network = adapter(), normalDown = network.disconnect;
  network.disconnect = async () => { throw new Error('synthetic network down failure'); };
  const { bridge, applicationStore } = make(t, { demo: false, networkAdapter: network, networkProvider: () => network.status() });
  await bridge.start(); await bridge.selectIdentity({ role: 'client' }); await bridge.loginNetwork();
  await assert.rejects(bridge.disconnectNetwork(), /synthetic network down failure/);
  assert.equal(bridge.status().identity.locked, true);
  assert.equal(applicationStore.record.desiredOnline, false);
  await assert.rejects(bridge.selectIdentity({ role: 'host' }), /锁定/);
  network.disconnect = normalDown; await bridge.disconnectNetwork();
  assert.equal(bridge.status().identity.locked, false);
});

test('a failed durable stop still closes runtime networking but refuses to unlock identity', async (t) => {
  const network = adapter();
  const { bridge, applicationStore } = make(t, { demo: false, networkAdapter: network, networkProvider: () => network.status() });
  await bridge.start(); await bridge.selectIdentity({ role: 'client' }); await bridge.loginNetwork();
  applicationStore.fail = true;
  await assert.rejects(bridge.disconnectNetwork(), /停止状态无法保存/);
  assert.equal(network.running, false);
  assert.equal(bridge.status().identity.locked, true);
  await assert.rejects(bridge.selectIdentity({ role: 'host' }), /锁定/);
  applicationStore.fail = false; await bridge.disconnectNetwork();
  assert.equal(bridge.status().identity.canSwitchRole, true);
});

test('a failed login preference commit reports an error without starting the network', async (t) => {
  const network = adapter();
  const { bridge, applicationStore } = make(t, { demo: false, networkAdapter: network, networkProvider: () => network.status() });
  await bridge.start(); await bridge.selectIdentity({ role: 'client' });
  applicationStore.fail = true;
  await assert.rejects(bridge.loginNetwork(), /synthetic preferences write failure/);
  assert.deepEqual(network.calls, []);
  assert.equal(bridge.status().identity.state, 'error');
  assert.match(bridge.status().identity.error, /write failure/);
  applicationStore.fail = false; await bridge.disconnectNetwork();
  assert.equal(bridge.status().identity.canSwitchRole, true);
});

test('down cancels login waiting for startup and rejects a new login until down completes', async (t) => {
  const network = adapter(), loading = Promise.withResolvers(), stopping = Promise.withResolvers();
  const applicationStore = new Preferences({ v: 1, role: 'client', desiredOnline: false, locked: false, model: { enabled: false, config: null } });
  applicationStore.load = async () => { await loading.promise; return structuredClone(applicationStore.record); };
  let entered = false;
  network.disconnect = async () => { network.calls.push('disconnect'); entered = true; await stopping.promise; network.running = false; return network.status(); };
  t.after(() => { loading.resolve(); stopping.resolve(); });
  const { bridge } = make(t, { demo: false, applicationStore, networkAdapter: network, networkProvider: () => network.status() });
  const up = assert.rejects(bridge.loginNetwork(), /正在退出/);
  const down = bridge.disconnectNetwork(); loading.resolve(); await up;
  await until(() => entered);
  await assert.rejects(bridge.loginNetwork(), /正在退出/);
  assert.equal(bridge.disconnectNetwork(), down);
  stopping.resolve(); await down;
  assert.deepEqual(network.calls, ['disconnect']);
  assert.equal(applicationStore.record.desiredOnline, false);
  assert.equal(applicationStore.record.locked, false);
});

test('startup completes an interrupted down instead of re-enrolling or reconnecting the node', async (t) => {
  const network = adapter(); network.running = true;
  const applicationStore = new Preferences({ v: 1, role: 'client', desiredOnline: false, locked: true, model: { enabled: false, config: null } });
  const { bridge } = make(t, { demo: false, applicationStore, networkAdapter: network, networkProvider: () => network.status() });
  await bridge.start(); await until(() => bridge.status().identity.canSwitchRole);
  assert.deepEqual(network.calls, ['disconnect']);
  assert.equal(applicationStore.record.locked, false);
  assert.equal(bridge.status().identity.desiredOnline, false);
});

test('old pairing and Claude settings migrate in place without changing the invitation', async (t) => {
  const first = await host(t);
  await first.bridge.configureModel({ enabled: true, workspace: process.cwd(), maxTurns: 17, profile: 'edit' });
  // Model configuration formerly lived in the DPAPI host record.
  const record = { ...first.store.record, v: 1, config: first.bridge.config };
  const original = first.bridge.status().invitation; await first.bridge.close();
  const store = new Pairings(record), applicationStore = new Preferences();
  const { bridge } = make(t, { store, applicationStore }); await bridge.start();
  await until(() => bridge.peer?.state.listening);
  assert.equal(bridge.status().invitation, original);
  assert.equal(bridge.status().identity.role, 'host');
  assert.equal(bridge.status().identity.locked, true);
  assert.equal(bridge.status().model.enabled, true);
  assert.equal(bridge.status().model.config.maxTurns, 17);
  assert.equal(applicationStore.record.role, 'host');
  assert.equal(store.record.invitation, original);
});

test('B restores its saved address when another local private address is listed first', async (t) => {
  const network = adapter();
  network.status = async () => ({ running: network.running, addresses: ['100.100.1.1', '100.100.1.2'], hostname: 'test-node', peers: [] });
  network.listen = async () => ({ id: 'isolated-listener' });
  network.release = async () => {};
  const options = { demo: false, networkAdapter: network, networkProvider: () => network.status() };
  const first = make(t, { ...options, store: new Pairings(null, false) }); await first.bridge.start();
  await first.bridge.selectIdentity({ role: 'host' }); await first.bridge.loginNetwork();
  await first.bridge.host({ tailscaleIp: '100.100.1.2', bridgePort: 3211 });
  const invitation = first.bridge.status().invitation;
  await first.bridge.close();
  const { bridge } = make(t, { ...options, store: first.store, applicationStore: first.applicationStore });
  await bridge.start(); bridge.cancelRestore(); await bridge.restore(bridge.generation);
  assert.equal(bridge.peer?.state.listening, true, bridge.restoreMessage);
  assert.equal(bridge.peer.pairing.host, '100.100.1.2');
  assert.equal(bridge.status().invitation, invitation);
  assert.equal(bridge.status().model.configured, false);
});

test('recreating a B pairing never embeds Claude configuration in its credentials', async (t) => {
  const { bridge, store } = await host(t);
  await bridge.configureModel({ enabled: true, workspace: process.cwd(), profile: 'read' });
  await bridge.host({ bridgePort: 0 });
  assert.equal(store.record.v, 2);
  assert.equal(Object.hasOwn(store.record, 'config'), false);
  await bridge.configureModel({ enabled: false });
  assert.equal(bridge.status().model.enabled, false);
  assert.equal(Object.hasOwn(store.record, 'config'), false);
});

test('model/proxy entry points are gated before identity selection', async (t) => {
  const { bridge } = make(t); await bridge.start();
  const app = createLocalServer({ port: 0, token: 'identity-api-token', bridge }); t.after(() => app.close());
  const address = await app.listen();
  const post = (route, body) => fetch(`http://127.0.0.1:${address.port}${route}`, { method: 'POST', headers: { Authorization: 'Bearer identity-api-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/network/login', {})).status, 409);
  assert.equal((await post('/api/model', { enabled: true, workspace: process.cwd() })).status, 409);
  assert.equal((await post('/api/proxy', { enabled: true })).status, 409);
  const selection = await post('/api/identity', { role: 'host' }); assert.equal(selection.status, 200);
  assert.equal((await selection.json()).identity.role, 'host');
});
