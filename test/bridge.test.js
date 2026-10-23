import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { Bridge } from '../src/bridge.js';
import { createLocalServer } from '../src/server.js';
import { encodeInvitation, parseInvitation, digest } from '../src/crypto.js';
import { validateRequest } from '../src/runner.js';

async function until(check, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for condition');
}
async function setup(t, { join = true } = {}) {
  // Loopback exercises exactly the production encrypted socket protocol, without
  // asserting that a Tailscale tunnel or cross-city network exists on the test PC.
  const host = new Bridge({ demo: true });
  const client = new Bridge({ demo: true });
  const app = createLocalServer({ port: 0, token: 'test-local-token', bridge: client });
  t.after(async () => { await app.close(); await host.disconnect(); });
  const local = await app.listen();
  const state = await host.host({ tailscaleIp: '127.0.0.1', bridgePort: 0, workspace: process.cwd(), profile: 'read' });
  if (join) {
    await client.join({ invitation: state.invitation });
    await until(() => host.status().online && client.status().online);
  }
  return { host, client, state, url: `http://127.0.0.1:${local.port}`, wire: `http://127.0.0.1:${state.config.bridgePort}` };
}
function call(url, route, body, extra = {}) { return fetch(`${url}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer test-local-token', 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }

test('channel monitoring follows peer lifecycle without leaving timers or resetting the recovery budget', async (t) => {
  const timers = new Set();
  const bridge = new Bridge({ demo: true, recoveryOptions: {
    setIntervalFn: () => { const timer = { unref() {} }; timers.add(timer); return timer; },
    clearIntervalFn: (timer) => timers.delete(timer)
  } });
  t.after(async () => { await bridge.disconnect(); await bridge.networkProxy.close(); });
  assert.equal(timers.size, 0);
  const first = await bridge.host({ tailscaleIp: '127.0.0.1', bridgePort: 0 });
  assert.equal(timers.size, 1);
  bridge.channelRecovery.attempts.push(performance.now());
  await bridge.disconnect(); assert.equal(timers.size, 0);
  assert.equal(bridge.channelRecovery.status().attemptsInWindow, 1);
  await bridge.host({ tailscaleIp: '127.0.0.1', bridgePort: 0 });
  assert.equal(timers.size, 1); assert.equal(bridge.channelRecovery.status().attemptsInWindow, 1);
  assert.equal(first.channelRecovery.enabled, false, 'Loopback demo never enables transport refresh');
  assert.equal(first.channelRecovery.mode, 'notify', 'The application defaults to user-controlled refresh suggestions');
  await bridge.networkProxy.close(); assert.equal(timers.size, 0);
  bridge.channelRecovery.start(); assert.equal(timers.size, 0, 'A closed application cannot restart monitoring');
});

test('network diagnostics only forwards an embedded snapshot and never polls or changes network state', async () => {
  const snapshot = { available: true, source: 'embedded', scope: 'node', capturedAt: '2026-10-20T12:34:56Z',
    netstack: { counter_tcp_retransmits: 3 }, transport: [] };
  let reads = 0, polls = 0;
  const adapter = { embedded: true, async diagnostics() { reads++; return snapshot; } };
  const bridge = new Bridge({ networkAdapter: adapter, networkProvider: async () => { polls++; throw new Error('Must not poll network status'); } });
  const network = { running: false, backendState: 'Stopped', addresses: [] };
  bridge.network = network; const generation = bridge.networkGeneration;
  let events = 0; bridge.on('state', () => events++);
  assert.equal(await bridge.networkDiagnostics(), snapshot);
  assert.equal(bridge.network, network); assert.equal(bridge.networkGeneration, generation);
  assert.equal(reads, 1); assert.equal(polls, 0); assert.equal(events, 0);
  for (const options of [{}, { demo: true, networkAdapter: adapter }, { networkAdapter: { embedded: true } }, { networkAdapter: { diagnostics: adapter.diagnostics } }]) {
    const unavailable = await new Bridge(options).networkDiagnostics();
    assert.equal(unavailable.available, false); assert.equal(unavailable.scope, 'node');
    assert.deepEqual(unavailable.netstack, {}); assert.deepEqual(unavailable.transport, []);
  }
  assert.equal(reads, 1);
});

test('opt-in flow diagnostics adds only a read-only projection without mutating the native snapshot or API authorization', async (t) => {
  const native = Object.freeze({ available: true, source: 'embedded', scope: 'node', capturedAt: '2026-10-20T12:34:56Z', netstack: {}, transport: [] });
  let reads = 0;
  const bridge = new Bridge({ networkAdapter: { embedded: true, async diagnostics() { reads++; return native; } },
    networkProvider: () => { throw new Error('Must not poll or connect'); }, proxyOptions: { diagnosticsEnabled: true } });
  const app = createLocalServer({ port: 0, token: 'private-flow-fixture-token', bridge });
  t.after(() => app.close());
  const address = await app.listen(), url = `http://127.0.0.1:${address.port}/api/network/diagnostics`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer wrong-token' } })).status, 401);
  assert.equal(reads, 0);
  const before = bridge.status(); let events = 0; bridge.on('state', () => events++);
  const response = await fetch(url, { headers: { Authorization: 'Bearer private-flow-fixture-token' } });
  assert.equal(response.status, 200);
  const combined = await response.json();
  assert.deepEqual(combined, { ...native, proxyFlows: { scope: 'process', activeCount: 0, truncated: 0, active: [], closed: [] } });
  assert.equal(Object.hasOwn(native, 'proxyFlows'), false); assert.equal(reads, 1); assert.equal(events, 0);
  assert.deepEqual(bridge.status(), before);
});

test('request validation fixes the B-side workspace, tools and process arguments', () => {
  assert.throws(() => validateRequest({ prompt: '' }));
  assert.throws(() => validateRequest({ prompt: 'ok', model: '--dangerously-skip-permissions' }));
  assert.throws(() => validateRequest({ prompt: 'ok', sessionId: '../../credentials' }));
  assert.deepEqual(validateRequest({ prompt: 'ok', workspace: 'C:\\', profile: 'develop', args: ['unsafe'] }), { prompt: 'ok' });
});

test('local API is unchanged: auth, JSON result, session resume, SSE and cancellation', { timeout: 20000 }, async (t) => {
  const { host, client, url, wire } = await setup(t);
  assert.equal(client.status().mode, 'tailscale');
  assert.equal(client.status().transport, 'loopback-demo');
  assert.equal(client.status().network.installed, false);
  assert.equal((await fetch(`${url}/v1/status`)).status, 401);
  assert.equal((await call(url, '/v1/status', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${url}/api/bootstrap`)).status, 401);
  const network = await (await call(url, '/api/tailscale')).json();
  assert.equal(network.demo, true);
  assert.equal(network.running, false);
  // The network-facing B listener must never serve controls or return local tokens.
  for (const route of ['/api/bootstrap', '/v1/status', '/']) assert.equal((await fetch(`${wire}${route}`)).status, 404);
  const response = await call(url, '/v1/run', { prompt: '远程 API 测试', stream: false });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true, JSON.stringify(result));
  assert.match(result.result.result, /远程 API 测试/);
  assert.match(result.sessionId, /^[a-f0-9-]{36}$/i);
  const resumed = await (await call(url, '/v1/run', { prompt: '继续', sessionId: result.sessionId, stream: false })).json();
  assert.equal(resumed.sessionId, result.sessionId);
  const unknown = await (await call(url, '/v1/run', { prompt: 'hello', sessionId: '00000000-0000-4000-8000-000000000000', stream: false })).json();
  assert.equal(unknown.success, false);
  assert.match(unknown.errors[0].message, /不属于当前配对/);
  const streaming = await call(url, '/v1/run', { prompt: '[slow] cancellation', stream: true });
  assert.match(streaming.headers.get('content-type'), /text\/event-stream/);
  const id = streaming.headers.get('x-request-id');
  await until(() => host.active.size === 1);
  assert.equal((await call(url, '/v1/run', { prompt: 'another' })).status, 409);
  assert.equal((await call(url, `/v1/requests/${id}/cancel`, {})).status, 202);
  const text = await streaming.text();
  assert.match(text, /event: started/);
  assert.match(text, /"cancelled":true/);
  await until(() => host.active.size === 0 && client.pending.size === 0);
});

test('encrypted direct socket carries large Unicode frames without a signaling or relay server', { timeout: 15000 }, async (t) => {
  const { host, client, url } = await setup(t);
  const packets = [];
  host.peer.ws.on('message', (raw) => packets.push(raw.toString()));
  const received = once(host.peer, 'message');
  const payload = { type: 'large-protocol-test', content: '中文直连🔒'.repeat(60000) };
  client.peer.send(payload);
  assert.deepEqual((await received)[0], payload);
  assert.ok(packets.every((packet) => !packet.includes('中文直连')));
  const result = await (await call(url, '/v1/run', { prompt: '没有公网中转的调用', stream: false })).json();
  assert.equal(result.success, true, JSON.stringify(result));
});

test('a disconnected task fails once, then the direct connection recovers without replaying it', { timeout: 20000 }, async (t) => {
  const { host, client, url } = await setup(t);
  client.peer.retryMs = 50;
  const streaming = await call(url, '/v1/run', { prompt: '[slow] do not replay', stream: true });
  const id = streaming.headers.get('x-request-id');
  await until(() => host.active.size === 1);
  client.peer.ws.terminate();
  const text = await streaming.text();
  assert.match(text, /PEER_DISCONNECTED/);
  assert.match(text, /"cancelled":true/);
  await until(() => host.status().online && client.status().model.online && host.active.size === 0);
  const recovered = await (await call(url, '/v1/run', { prompt: 'after reconnect', stream: false })).json();
  assert.equal(recovered.success, true, JSON.stringify(recovered));
  assert.equal(host.logs.filter((entry) => entry.message === `开始任务 ${id.slice(0, 8)}`).length, 1);
});

test('invalid secrets are rejected; multiple A can join until the bounded limit; revoking B closes all', { timeout: 15000 }, async (t) => {
  const { host, client, state, wire } = await setup(t, { join: false });
  const other = new Bridge({ demo: true });
  t.after(() => other.disconnect());
  const pair = parseInvitation(state.invitation, { allowLoopback: true });
  await assert.rejects(client.join({ invitation: encodeInvitation({ ...pair, secret: 'a'.repeat(43) }) }), /401/);
  assert.equal(host.status().online, false);
  host.peer.maxClients = 1;
  await client.join({ invitation: state.invitation });
  await assert.rejects(other.join({ invitation: state.invitation }), /409/);
  host.peer.maxClients = 2;
  await other.join({ invitation: state.invitation });
  await until(() => host.status().connectedClients === 2);
  assert.equal(client.status().online, true);
  await host.disconnect();
  await until(() => !client.status().online && !other.status().online);
  await assert.rejects(fetch(wire));
  await client.disconnect();
});

test('knowing the upgrade token does not bypass encrypted mutual authentication', { timeout: 10000 }, async (t) => {
  const { host, state } = await setup(t, { join: false });
  const pair = parseInvitation(state.invitation, { allowLoopback: true });
  const ws = new WebSocket(`ws://${pair.host}:${pair.port}/bridge/${pair.room}`, { headers: { Authorization: `Bearer ${digest(`p2pcc-v2:${pair.room}:${pair.secret}`)}` } });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ kind: 'message', body: { type: 'run', prompt: 'must not execute' } }));
  await closed;
  assert.equal(host.status().online, false);
  assert.equal(host.active.size, 0);
});

test('production setup requires local Tailscale and never falls back to arbitrary network addresses', async () => {
  const bridge = new Bridge({ networkProvider: async () => ({ installed: false, running: false, addresses: [], message: '请先安装 Tailscale' }) });
  await assert.rejects(bridge.host({ tailscaleIp: '0.0.0.0', workspace: process.cwd() }), /Tailscale/);
  assert.equal(bridge.peer, undefined);
  const fake = new Bridge({ networkProvider: async () => ({ installed: true, running: true, addresses: ['100.100.1.2'] }) });
  await assert.rejects(fake.host({ tailscaleIp: '100.100.1.3', workspace: process.cwd() }), /本机/);
  const demoPair = new Bridge({ demo: true });
  await assert.rejects(demoPair.join({ invitation: encodeInvitation({ v: 2, mode: 'tailscale', host: '100.100.1.1', port: 3211, room: 'x'.repeat(24), secret: 'y'.repeat(43) }) }), /演示模式/);
});

test('completion releases the A busy state before consumers submit their next request', { timeout: 15000 }, async (t) => {
  const { client } = await setup(t);
  let firstId, secondId, failure;
  await new Promise((resolve) => {
    firstId = client.run({ prompt: 'first' }, (event) => {
      if (event.type !== 'done') return;
      try {
        secondId = client.run({ prompt: 'immediate next' }, (next) => {
          if (next.type === 'error') failure = next.message;
          if (next.type === 'done') resolve();
        });
      } catch (error) { failure = error.message; resolve(); }
    });
  });
  assert.equal(failure, undefined);
  assert.notEqual(firstId, secondId);
  assert.equal(client.pending.size, 0);
});

test('aborted requests and failing consumers cannot leave tasks or corrupt the paired channel', { timeout: 15000 }, async (t) => {
  const { host, client } = await setup(t);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => client.run({ prompt: 'must not run' }, () => {}, controller.signal), { name: 'AbortError' });
  assert.equal(host.active.size, 0); assert.equal(client.pending.size, 0);
  client.run({ prompt: '[slow] broken consumer' }, () => { throw new Error('consumer failed'); });
  await until(() => host.logs.some((entry) => entry.message.startsWith('开始任务 ')));
  await until(() => client.pending.size === 0 && host.active.size === 0);
  assert.equal(client.status().online, true);
  let completions = 0;
  client.run({ prompt: '[slow] disconnect cleanup' }, (event) => {
    if (event.type === 'error') throw new Error('failed error consumer');
    if (event.type === 'done') ++completions;
  });
  await client.disconnect();
  assert.equal(client.pending.size, 0);
  assert.equal(client.status().online, false);
  assert.equal(client.status().config, null);
  assert.equal(completions, 0);
});

for (const trigger of ['cancellation', 'response timeout']) test(`an unresponsive B cannot retain its A connection after ${trigger}`, { timeout: 10000 }, async (t) => {
  const { host, client, state } = await setup(t);
  const other = new Bridge({ demo: true }); t.after(() => other.disconnect());
  await other.join({ invitation: state.invitation });
  const originalRun = host.handleRun;
  host.handleRun = () => {}; // An old/misbehaving B accepts the wire but never replies.
  client.cancelTimeoutMs = 40; client.modelPeer.retryMs = 20;
  const originalResponseTimeout = client.responseTimeoutMs;
  if (trigger === 'response timeout') client.responseTimeoutMs = 40;
  const oldConnection = client.status().connectionId;
  const events = []; let immediateSubmissionError;
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const controller = new AbortController();
  client.run({ prompt: 'cancel an unresponsive task' }, (event) => {
    events.push(event);
    if (event.type === 'done') {
      try { client.run({ prompt: 'must not reuse an unconfirmed connection' }, () => {}); }
      catch (error) { immediateSubmissionError = error.message; }
      finished();
    }
  }, controller.signal);
  if (trigger === 'cancellation') controller.abort();
  await done;
  assert.equal(client.pending.size, 0);
  assert.equal(events.filter((event) => event.type === 'done').length, 1);
  assert.equal(events.at(-1).cancelled, true);
  assert.equal(events.find((event) => event.type === 'error')?.code, trigger === 'cancellation' ? 'CANCEL_TIMEOUT' : 'RESPONSE_TIMEOUT');
  assert.match(immediateSubmissionError || '', /尚未连接/);
  assert.equal(client.status().online, true, 'Model timeouts keep the independent control channel online');
  assert.equal(other.status().online, true, 'Only the cancelling A may be reconnected');
  host.handleRun = originalRun;
  client.responseTimeoutMs = originalResponseTimeout;
  await until(() => client.status().model.online && client.status().connectionId !== oldConnection);
  await new Promise((resolve) => {
    client.run({ prompt: 'fresh request after cancellation recovery' }, (event) => {
      assert.notEqual(event.type, 'error', event.message);
      if (event.type === 'done') resolve();
    });
  });
});

test('switching B to A removes the previous B execution configuration from status', { timeout: 10000 }, async (t) => {
  const { host, client, state } = await setup(t, { join: false });
  await client.host({ workspace: process.cwd(), bridgePort: 0, profile: 'develop' });
  assert.equal(client.status().config.profile, 'develop');
  await client.join({ invitation: state.invitation });
  assert.equal(client.status().role, 'client');
  assert.equal(client.status().config, null);
  await until(() => host.status().online);
});
