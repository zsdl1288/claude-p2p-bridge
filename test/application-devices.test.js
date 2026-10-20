import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { ApplicationBridge } from '../src/application-bridge.js';
import { validateApplication } from '../src/application-store.js';
import { ClashProxy } from '../src/clash-proxy.js';
import { encodeInvitation, makePairing } from '../src/crypto.js';

const own = '100.100.10.1', firstB = '100.100.10.2', secondB = '100.100.10.3';
const peers = [
  { name: 'B one', address: firstB, online: true, path: 'direct' },
  { name: 'B two', address: secondB, online: true, path: 'relay', role: 'host' }
];
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(check) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw new Error('Device integration timed out'); await pause(); } }

async function fixture(t, { paired = false, handler = (_req, res) => res.end(JSON.stringify({ role: 'host', protocol: 1, name: 'Read-only B' })), delayedAddress = null } = {}) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const record = paired ? { v: 2, mode: 'tailscale', role: 'client', invitation: encodeInvitation(makePairing(firstB, 3211)) } : null;
  const store = { async load() { return structuredClone(record); }, async clear() {} };
  const applicationStore = {
    value: { v: 1, role: 'client', desiredOnline: false, locked: false, model: { enabled: false, config: null } },
    async load() { return structuredClone(this.value); }, async save(value) { this.value = validateApplication(value); return structuredClone(this.value); }
  };
  const adapter = new EventEmitter(), deferred = Promise.withResolvers();
  adapter.running = false; adapter.dials = []; adapter.releases = [];
  adapter.status = async () => ({ running: adapter.running, addresses: [own], hostname: 'This A', peers: structuredClone(peers) });
  adapter.login = async () => { adapter.running = true; return adapter.status(); };
  adapter.disconnect = async () => { adapter.running = false; return adapter.status(); };
  adapter.dial = async (input) => {
    adapter.dials.push(input);
    if (input.host === delayedAddress) return deferred.promise;
    return { id: input.host, port: server.address().port };
  };
  adapter.release = async (resource) => { adapter.releases.push(resource); };
  const bridge = new ApplicationBridge({ store, applicationStore, networkAdapter: adapter, networkProvider: () => adapter.status() });
  t.after(async () => {
    deferred.resolve({ id: delayedAddress, port: server.address()?.port || 1 });
    await bridge.close(); await bridge.networkProxy.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  });
  await bridge.start();
  return { bridge, adapter, server, deferred };
}

test('read-only role discovery updates device labels without pairing or unlocking either business', async (t) => {
  const responseGate = Promise.withResolvers(); t.after(() => responseGate.resolve());
  const { bridge, adapter } = await fixture(t, { handler: async (_req, res) => {
    await responseGate.promise; res.end(JSON.stringify({ role: 'host', protocol: 1, name: 'Found B' }));
  } });
  await bridge.loginNetwork();
  const immediate = await bridge.networkInfo(true);
  assert.equal(immediate.devices.find((device) => device.address === secondB).role, null, 'An unverified role claimed in the peer list must be ignored');
  assert.deepEqual(bridge.status().capabilities, { model: false, proxy: false });
  await until(() => adapter.dials.length === 2);
  responseGate.resolve(); await bridge.discovering;
  const discovered = bridge.status().network.devices;
  assert.equal(discovered[0].self, true); assert.equal(discovered[0].role, 'client');
  assert.deepEqual(discovered.slice(1).map((device) => device.role), ['host', 'host']);
  assert.equal(bridge.status().pairing.saved, false); assert.equal(bridge.peer, undefined);
  assert.deepEqual(bridge.status().capabilities, { model: false, proxy: false });
  await assert.rejects(bridge.configureModel({ enabled: true, workspace: process.cwd() }), /配对|创建服务身份/);
  const proxy = new ClashProxy({ bridge, token: 'devices-integration-token' }); t.after(() => proxy.close());
  await assert.rejects(proxy.configure({ enabled: true }), /配对|创建服务身份/);
  assert.equal(bridge.networkProxy.enabled, false); assert.equal(bridge.networkProxy.sharing, false);
});

test('A proxy lists only this computer and its paired B even when discovery labels other B devices', async (t) => {
  const { bridge, adapter } = await fixture(t, { paired: true });
  bridge.network = await adapter.status();
  bridge.network.running = true;
  for (const address of [firstB, secondB]) bridge.discovery.roles.set(address, { role: 'host', name: 'Found B', at: Date.now() });
  const all = bridge.networkStatus().devices;
  assert.equal(all.filter((device) => device.role === 'host').length, 2);
  const proxy = new ClashProxy({ bridge, token: 'devices-paired-token' }); t.after(() => proxy.close());
  const visible = proxy.status().devices;
  assert.deepEqual(visible.map((device) => device.address), [own, firstB]);
  assert.equal(visible[0].self, true); assert.equal(visible[1].self, false); assert.equal(visible[1].role, 'host');
  assert.equal(visible[1].online, false, 'A visible private node does not imply an authenticated bridge connection');
  assert.equal(bridge.status().pairing.saved, true); assert.equal(bridge.peer, undefined);
});

test('private network down clears discovered roles and releases a late allocation without publishing it', async (t) => {
  let requests = 0;
  const { bridge, adapter, server, deferred } = await fixture(t, { delayedAddress: secondB, handler: (_req, res) => {
    requests++; res.end(JSON.stringify({ role: 'host', protocol: 1, name: 'Found B' }));
  } });
  await bridge.loginNetwork(); await bridge.networkInfo(true);
  await until(() => adapter.dials.length === 2 && bridge.discovery.roles.size === 1);
  const discovering = bridge.discovering;
  await bridge.disconnectNetwork();
  assert.equal(bridge.discovery.roles.size, 0);
  assert.equal(bridge.status().identity.desiredOnline, false); assert.equal(bridge.status().identity.canSwitchRole, true);
  deferred.resolve({ id: 'late-after-down', port: server.address().port });
  await discovering; await until(() => adapter.releases.length === 2);
  assert.equal(requests, 1, 'A late allocation must be released without querying the node after network down');
  assert.equal(bridge.discovery.roles.size, 0);
  assert.ok(bridge.status().network.devices.filter((device) => !device.self).every((device) => device.role === null));
  assert.deepEqual(bridge.status().capabilities, { model: false, proxy: false });
});
