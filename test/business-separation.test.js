import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { Bridge } from '../src/bridge.js';
import { ChannelRecovery } from '../src/channel-recovery.js';
import { BridgePeer } from '../src/peer.js';
import { parseInvitation } from '../src/crypto.js';
import { randomUUID } from 'node:crypto';
import { encodeSocksAddress } from '../src/network-proxy.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out'); await delay(10); }
}
async function setup(t, configured = true) {
  const speedOptions = { phaseMs: 120, maxBytes: 1048576, pingMs: 100, handshakeMs: 1000, deadlineMs: 3000 };
  const host = new Bridge({ demo: true, speedOptions, proxyOptions: { allowPrivateTargets: true } });
  const client = new Bridge({ demo: true, speedOptions, cancelTimeoutMs: 40, responseTimeoutMs: 40 });
  t.after(async () => { await client.disconnect(); await host.disconnect(); await client.networkProxy.close(); await host.networkProxy.close(); });
  const state = await host.host({ bridgePort: 0, ...(configured ? { workspace: process.cwd() } : {}) });
  await client.join({ invitation: state.invitation });
  client.modelPeer.retryMs = 10;
  host.networkProxy.configure({ sharing: true }); host.broadcastProxyStatus();
  await client.networkProxy.start(); client.networkProxy.configure({ enabled: true });
  await until(() => client.remoteSharing === true);
  return { host, client, invitation: state.invitation };
}

for (const initiator of ['host', 'client']) test(`a real ${initiator}-initiated speed test preserves established proxy and model sessions`, { timeout: 10000 }, async (t) => {
  const { host, client, invitation } = await setup(t);
  const echo = await flow(t, client); await echo('before-speed');
  const control = client.peer.session, model = client.modelPeer.session;
  const tester = initiator === 'host' ? host : client;
  assert.equal(tester.channelSpeed.status().available, true);
  const job = tester.channelSpeed.start({ targetId: tester.channelSpeed.status().targets[0].id });
  await until(() => !tester.channelSpeed.status().busy);
  await until(() => !host.channelSpeed.status().busy && !client.channelSpeed.status().busy);
  for (const endpoint of [host, client]) {
    const final = endpoint.channelSpeed.status().job;
    assert.equal(final.id, job.id); assert.equal(final.state, 'completed');
    for (const direction of ['download', 'upload']) {
      const result = final.report[direction];
      assert.ok(result.receivedBytes > 0 && result.receivedBytes <= 1048576);
      assert.equal(result.limitReached, result.receivedBytes === 1048576);
      assert.equal(result.receivedBytes, host.channelSpeed.status().job.report[direction].receivedBytes);
      assert.equal(result.receivedBytes, client.channelSpeed.status().job.report[direction].receivedBytes);
    }
    assert.ok(final.report.latency === null || final.report.latency.samples.length <= 64);
    assert.ok(final.report.download.bytesPerSecond > 0); assert.ok(final.report.upload.bytesPerSecond > 0);
  }
  assert.equal(client.peer.session, control); assert.equal(client.modelPeer.session, model);
  assert.equal(host.invitation, invitation);
  await echo('after-speed');
});

test('B refreshes only its explicitly selected A while both proxy flows and model sessions stay paired', { timeout: 10000 }, async (t) => {
  const { host, client, invitation } = await setup(t);
  const firstTarget = host.channelRefresh.status().targets[0].id;
  const other = new Bridge({ demo: true });
  t.after(async () => { await other.disconnect(); await other.networkProxy.close(); });
  await other.join({ invitation });
  await other.networkProxy.start(); other.networkProxy.configure({ enabled: true });
  await until(() => other.remoteSharing === true);
  const echo = await flow(t, client), otherEcho = await flow(t, other);
  await echo('before-refresh'); await otherEcho('other-before-refresh');
  const control = client.peer.session, model = client.modelPeer.session, otherControl = other.peer.session;
  const counts = new Map();
  for (const bridge of [host, client, other]) {
    const child = { stdin: { writable: true } };
    counts.set(bridge, 0); bridge.demo = false;
    bridge.networkAdapter = { embedded: true, wantRunning: true, child, initialized: new Set([child]),
      async diagnostics() { return { available: false }; },
      async refreshTransport() { counts.set(bridge, counts.get(bridge) + 1); return { refreshed: true, reason: 'refreshed' }; },
      async channelProbe(params, captured) {
        assert.equal(captured, child); assert.equal(params.host, bridge.peer.pairing.host);
        return { outcome: 'reply', actualVia: counts.get(bridge) ? 'direct' : 'derp', latencySeconds: counts.get(bridge) ? 0.04 : 0.15,
          ...(counts.get(bridge) ? {} : { derpRegionId: 3 }) };
      },
    };
  }
  assert.equal(host.channelRefresh.status().available, true);
  const job = host.channelRefresh.start({ targetId: firstTarget });
  await until(() => !host.channelRefresh.status().busy && !client.channelRefresh.status().busy);
  assert.equal(host.channelRefresh.status().job.id, job.id);
  assert.equal(host.channelRefresh.status().job.state, 'completed');
  assert.deepEqual(host.channelRefresh.status().job.result, client.channelRefresh.status().job.result);
  assert.equal(counts.get(client), 1); assert.equal(counts.get(other), 0); assert.equal(counts.get(host), 0);
  assert.equal(client.peer.session, control); assert.equal(client.modelPeer.session, model); assert.equal(other.peer.session, otherControl);
  assert.equal(host.invitation, invitation);
  await echo('after-refresh'); await otherEcho('other-after-refresh');
});

test('authenticated backlog hints only suggest a refresh until A explicitly requests it', { timeout: 10000 }, async (t) => {
  const { host, client, invitation } = await setup(t);
  const echo = await flow(t, client); await echo('before-suggestion');
  const control = client.peer.session, model = client.modelPeer.session;
  let now = 0, refreshes = 0, probes = 0;
  const child = { stdin: { writable: true } };
  client.channelRecovery.close(); client.demo = false;
  client.networkAdapter = { embedded: true, wantRunning: true, child, initialized: new Set([child]),
    async diagnostics() { return { available: true, netstack: { counter_tcp_timeouts: 0, counter_tcp_retransmits: 0 } }; },
    async refreshTransport() { refreshes++; return { refreshed: true, reason: 'refreshed' }; },
    async channelProbe() { probes++; return { outcome: 'reply', actualVia: 'direct', latencySeconds: 0.04 }; } };
  client.channelRecovery = new ChannelRecovery({ bridge: client, now: () => now });
  const connection = [...host.peer.connections][0];
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    assert.equal(host.peer.trySendHealthHint({ type: 'proxy-health', id, v: 1, windowMs: 30000, blockedFlows: 1,
      pendingBytes: 65536, oldestPendingMs: 10000, completedBytes: 0, tcpTimeouts: 3, tcpRetransmits: 32 }, connection), true);
    await until(() => client.channelRecovery.hint?.id === id); await client.channelRecovery.tick(); now += 5000;
  }
  assert.equal(client.channelRecovery.status().notice.phase, 'suggested');
  assert.equal(refreshes, 0); assert.equal(probes, 0, 'Background suggestions generate no active path probe');
  assert.equal(client.channelRecovery.status().attemptsInWindow, 0);
  await echo('while-suggesting');
  const job = client.channelRefresh.start({ targetId: client.channelRefresh.status().targets[0].id });
  await until(() => !client.channelRefresh.status().busy);
  assert.equal(client.channelRefresh.status().job.id, job.id); assert.equal(client.channelRefresh.status().job.state, 'completed');
  assert.equal(refreshes, 1); assert.equal(probes, 2, 'Before/after probes happen only after the explicit manual request');
  assert.equal(client.channelRecovery.status().notice, null);
  assert.equal(client.peer.session, control); assert.equal(client.modelPeer.session, model); assert.equal(host.invitation, invitation);
  await echo('after-requested-refresh');
});

test('cancelling an A speed test releases only its speed connection and preserves the pairing', { timeout: 10000 }, async (t) => {
  const { host, client, invitation } = await setup(t);
  const echo = await flow(t, client); await echo('before-cancel');
  const control = client.peer.session, model = client.modelPeer.session;
  const accepted = new Promise((resolve) => {
    const changed = () => { if (host.channelSpeed.status().busy) { host.off('state', changed); resolve(); } };
    host.on('state', changed);
  });
  const job = client.channelSpeed.start({ targetId: client.channelSpeed.status().targets[0].id });
  await accepted;
  client.channelSpeed.cancel(job.id);
  await until(() => !client.channelSpeed.status().busy && !host.channelSpeed.status().busy);
  assert.equal(client.channelSpeed.status().job.state, 'cancelled');
  assert.equal(client.peer.session, control); assert.equal(client.modelPeer.session, model); assert.equal(host.invitation, invitation);
  await echo('after-cancel');
});
async function flow(t, client) {
  const sockets = new Set();
  const echo = net.createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); socket.pipe(socket); });
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const socket = net.createConnection({ host: '127.0.0.1', port: client.networkProxy.port });
  let buffer = Buffer.alloc(0); socket.on('data', (data) => { buffer = Buffer.concat([buffer, data]); }); socket.on('error', () => {});
  t.after(async () => { socket.destroy(); for (const item of sockets) item.destroy(); await new Promise((resolve) => echo.close(resolve)); });
  async function read(count) { await until(() => buffer.length >= count); const result = buffer.subarray(0, count); buffer = buffer.subarray(count); return result; }
  await once(socket, 'connect'); socket.write(Buffer.from([5, 1, 2])); assert.deepEqual(await read(2), Buffer.from([5, 2]));
  const user = Buffer.from(client.networkProxy.username), password = Buffer.from(client.networkProxy.password);
  socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password])); assert.deepEqual(await read(2), Buffer.from([1, 0]));
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), encodeSocksAddress('127.0.0.1', echo.address().port)])); assert.equal((await read(10))[1], 0);
  return async (payload) => { socket.write(payload); assert.equal((await read(Buffer.byteLength(payload))).toString(), payload); };
}

for (const trigger of ['model disabled', 'cancellation timeout', 'response timeout']) test(`network streams and control session survive ${trigger}`, { timeout: 15000 }, async (t) => {
  const { host, client } = await setup(t);
  const echo = await flow(t, client);
  await echo('before');
  const control = client.status().controlConnectionId, model = client.status().connectionId;
  if (trigger === 'model disabled') {
    await host.configureModel({ enabled: false });
    await until(() => client.status().model.enabled === false);
  } else {
    host.handleRun = () => {};
    if (trigger === 'cancellation timeout') client.responseTimeoutMs = 10000;
    const controller = new AbortController();
    const events = [];
    await new Promise((resolve) => {
      client.run({ prompt: 'never reply' }, (event) => { events.push(event); if (event.type === 'done') resolve(); }, controller.signal);
      if (trigger === 'cancellation timeout') controller.abort();
    });
    assert.equal(events.find((event) => event.type === 'error')?.code, trigger === 'cancellation timeout' ? 'CANCEL_TIMEOUT' : 'RESPONSE_TIMEOUT');
    await until(() => client.status().model.online && client.status().connectionId !== model);
  }
  assert.equal(client.status().online, true);
  assert.equal(client.status().controlConnectionId, control);
  await echo('after');
  const devices = host.networkProxy.status().clients;
  assert.equal(devices.length, 1); assert.equal(devices[0].usingProxy, true); assert.equal(devices[0].connections, 1);
});

test('B identity and proxy work without a Claude workspace; discovery reveals no configuration or credentials', { timeout: 15000 }, async (t) => {
  const { host, client, invitation } = await setup(t, false);
  assert.equal(host.status().model.configured, false); assert.equal(host.status().config, null);
  const echo = await flow(t, client); await echo('proxy without Claude');
  const pairing = parseInvitation(invitation, { allowLoopback: true });
  const info = await (await fetch(`http://${pairing.host}:${pairing.port}/bridge-info`)).json();
  assert.deepEqual(Object.keys(info).sort(), ['name', 'protocol', 'role']); assert.equal(info.role, 'host');
  const legacyId = randomUUID(), rejected = [];
  client.peer.on('message', (msg) => { if (msg.id === legacyId && msg.type === 'event') rejected.push(msg.event); });
  client.peer.send({ type: 'run', id: legacyId, request: { prompt: 'legacy control-channel task' } });
  await until(() => rejected.some((event) => event.type === 'done'));
  assert.equal(rejected.find((event) => event.type === 'error')?.code, 'MODEL_CHANNEL_REQUIRED');
  assert.equal(host.active.size, 0);
  const unauthorized = new BridgePeer({ role: 'client', channel: 'model', pairing, allowLoopback: true, parentSession: 'fake-control' });
  t.after(() => unauthorized.close());
  await assert.rejects(unauthorized.connect());
  assert.equal(host.modelPeer.connections.size, 1, 'A model channel needs an active, authenticated control session');
  const draft = await host.prepareModel({ enabled: false, workspace: 'Z:/missing-claude-folder', profile: 'read' });
  assert.equal(draft.enabled, false); assert.match(draft.config.workspace, /missing-claude-folder/);
  assert.equal(host.config, undefined, 'Preparing configuration must not mutate live business state');
  await assert.rejects(host.prepareModel({ ...draft.config, enabled: true }));
});
