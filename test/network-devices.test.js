import test from 'node:test';
import assert from 'node:assert/strict';
import { networkDevices, summarizeTailscale } from '../src/tailscale.js';
import { Bridge } from '../src/bridge.js';
import { PersistentBridge } from '../src/persistent-bridge.js';
import { makePairing, encodeInvitation } from '../src/crypto.js';

const network = {
  running: true, hostname: 'bridge-local', addresses: ['100.100.1.1'],
  peers: [
    { name: 'duplicate self', address: '100.100.1.1', online: true },
    { name: 'paired B', address: '100.100.1.2', online: false },
    { name: 'unpaired node', address: '100.100.1.3', online: true, role: 'host' }
  ]
};

test('device list includes one local node first and distinguishes known roles from unrelated nodes', () => {
  const devices = networkDevices(network, { role: 'client', serverAddress: '100.100.1.2' });
  assert.equal(devices.length, 3);
  assert.deepEqual(devices[0], { name: 'bridge-local', address: '100.100.1.1', online: true, self: true, role: 'client', path: 'local' });
  assert.equal(devices[1].role, 'host'); assert.equal(devices[1].online, false);
  assert.equal(devices[2].role, null); assert.equal(devices[2].self, false);
  assert.equal(network.peers[0].self, undefined);
  const idle = networkDevices({ hostname: 'bridge-local', addresses: [], peers: [], running: false });
  assert.equal(idle.length, 1); assert.equal(idle[0].self, true); assert.equal(idle[0].address, ''); assert.equal(idle[0].online, false);
});

test('local service role updates immediately in cached network status when B starts and stops', async (t) => {
  const bridge = new Bridge({ demo: true });
  t.after(async () => { await bridge.disconnect(); await bridge.networkProxy.close(); });
  assert.equal((await bridge.networkInfo()).devices[0].role, null);
  const cached = bridge.network;
  await bridge.host({ workspace: process.cwd(), tailscaleIp: '127.0.0.1', bridgePort: 0 });
  const hostNetwork = bridge.status().network;
  assert.equal(hostNetwork.devices[0].role, 'host'); assert.equal(hostNetwork.devices[0].self, true);
  await bridge.disconnect();
  assert.equal(bridge.status().network.devices[0].role, null);
  assert.equal(hostNetwork.devices[0].role, 'host');
  assert.equal(cached.devices, undefined);
});

test('a paused saved A identifies its own role and paired B without connecting or changing the network cache', async (t) => {
  let reads = 0;
  const saved = { v: 1, mode: 'tailscale', role: 'client', invitation: encodeInvitation(makePairing('100.100.1.2', 3211)) };
  const bridge = new PersistentBridge({ store: { async load() { return saved; }, async clear() {} }, networkProvider: async () => { reads++; return network; } });
  bridge.paused = true;
  t.after(async () => { await bridge.close(); await bridge.networkProxy.close(); });
  await bridge.start();
  const restored = await bridge.networkInfo();
  assert.equal(restored.devices[0].role, 'client'); assert.equal(restored.devices[1].role, 'host');
  await bridge.disconnect();
  const forgotten = await bridge.networkInfo();
  assert.equal(reads, 1);
  assert.equal(forgotten.devices[0].role, null); assert.equal(forgotten.devices[1].role, null);
});

test('system Tailscale exposes other devices with the same path and online semantics as the embedded core', () => {
  const value = summarizeTailscale({ BackendState: 'Running', TailscaleIPs: ['100.100.1.1'], Self: { HostName: 'local' }, Peer: {
    a: { HostName: 'B', TailscaleIPs: ['fd7a:115c:a1e0::1', '100.100.1.2'], Online: true, CurAddr: '203.0.113.1:41641' },
    b: { HostName: 'old', TailscaleIPs: ['100.100.1.3'], Online: false },
    c: { HostName: 'unrelated address', TailscaleIPs: ['192.168.1.1'], Online: true }
  } }, { Tailscale: [{ family: 'IPv4', address: '100.100.1.1' }] });
  assert.deepEqual(value.peers.map(({ name, online, path }) => ({ name, online, path })), [
    { name: 'B', online: true, path: 'direct' }, { name: 'old', online: false, path: 'unknown' }
  ]);
  assert.equal(networkDevices(value)[0].name, 'local');
});
