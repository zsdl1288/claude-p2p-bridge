import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { Bridge } from '../src/bridge.js';
import { createLocalServer } from '../src/server.js';
import { clashProfile } from '../src/clash-proxy.js';
import { NetworkGuard } from '../src/network-guard.js';

const token = 'clash-proxy-test-token';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Clash integration condition timed out'); await delay(10); }
}
function guardMock(enabled = false) {
  const calls = [];
  return { calls,
    async status() { calls.push('status'); return { supported: true, state: enabled ? 'enabled' : 'disabled', enabled, filterCount: enabled ? 4 : 0, expectedFilters: 4 }; },
    async enable() { calls.push('enable'); enabled = true; },
    async disable() { calls.push('disable'); enabled = false; }
  };
}
async function localApp(t, bridge, options = {}) {
  const app = createLocalServer({ port: 0, token, bridge, ...options });
  t.after(() => app.close());
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const request = (route, body) => fetch(`${base}${route}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { app, base, request };
}
async function paired(t, options = {}) {
  const host = new Bridge({ demo: true, proxyOptions: { allowPrivateTargets: true } }), client = new Bridge({ demo: true });
  const b = await localApp(t, host), a = await localApp(t, client, options);
  const hostInput = { workspace: process.cwd(), tailscaleIp: '127.0.0.1', bridgePort: 0, profile: 'read' };
  const { invitation } = await host.host(hostInput); await client.join({ invitation });
  await until(() => client.remoteSharing === false);
  return { host, client, a, b, hostInput, invitation };
}
async function enable({ a, b }) {
  assert.equal((await b.request('/api/proxy', { sharing: true })).status, 200);
  assert.equal((await a.request('/api/proxy', { enabled: true })).status, 200);
}
async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p2p-clash-test-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

test('generated complete Clash profile routes Internet and DNS through B without a direct fallback', () => {
  const config = clashProfile({ port: 12345, username: 'user', password: 'secret' });
  assert.equal(config.tun.enable, true); assert.equal(config.tun['strict-route'], true);
  assert.equal(config.tun['auto-route'], true); assert.equal(config['allow-lan'], false);
  assert.equal(config.ipv6, true); assert.equal(config.dns.ipv6, true);
  assert.deepEqual(config.proxies, [{ name: 'B 网络出口', type: 'socks5', server: '127.0.0.1', port: 12345, username: 'user', password: 'secret', udp: true }]);
  assert.equal(config.rules.at(-1), 'MATCH,B 网络出口');
  assert.equal(config['proxy-groups'], undefined);
  for (const resolver of [...config.dns.nameserver, ...config.dns['proxy-server-nameserver']]) assert.match(resolver, /#B 网络出口$/);
  assert.ok(config.rules.includes('PROCESS-NAME,bridge-net.exe,DIRECT'));
  assert.equal(config.rules.some((rule) => /^MATCH,DIRECT|^GEOIP,.*DIRECT/.test(rule)), false);
  assert.throws(() => clashProfile({ port: 0, username: 'user', password: 'secret' }), /尚未就绪/);
});

test('subscription URLs authenticate independently, reject cross-origin access and return full or node-only profiles', { timeout: 15000 }, async (t) => {
  const fixture = await paired(t); const { a } = fixture;
  const disabled = `${a.base}/clash/${a.app.proxy.subscriptionToken}/config.yaml`;
  assert.equal((await fetch(disabled)).status, 503);
  await enable(fixture);
  const status = await (await a.request('/api/proxy')).json();
  assert.equal(status.state, 'ready'); assert.equal(status.online, true); assert.ok(status.subscriptionUrl);
  const response = await fetch(status.subscriptionUrl); assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/yaml/); assert.equal(response.headers.get('cache-control'), 'no-store');
  const config = await response.json(); assert.equal(config.proxies[0].port, status.port); assert.equal(config.rules.at(-1), 'MATCH,B 网络出口');
  const nodes = await (await fetch(status.subscriptionUrl.replace('config.yaml', 'nodes.yaml'))).json();
  assert.deepEqual(nodes, { proxies: config.proxies });
  const invalid = status.subscriptionUrl.replace(a.app.proxy.subscriptionToken, 'a'.repeat(43)); assert.equal((await fetch(invalid)).status, 401);
  assert.equal((await fetch(status.subscriptionUrl, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await fetch(status.subscriptionUrl, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${a.base}/api/proxy`)).status, 401);
  assert.notEqual(a.app.proxy.subscriptionToken, token);
  assert.notEqual(config.proxies[0].password, a.app.proxy.subscriptionToken);
  assert.notEqual(config.proxies[0].password, token);
});

test('B sharing control broadcasts truthfully to A and model access remains independent', { timeout: 15000 }, async (t) => {
  const fixture = await paired(t), { a, b, client } = fixture;
  assert.equal((await a.request('/api/proxy', { enabled: true })).status, 200);
  let status = await (await a.request('/api/proxy')).json(); assert.equal(status.state, 'blocked'); assert.equal(status.sharing, false);
  assert.equal((await b.request('/api/proxy', { sharing: true })).status, 200);
  await until(() => client.remoteSharing === true);
  status = await (await a.request('/api/proxy')).json(); assert.equal(status.state, 'ready'); assert.equal(status.sharing, true);
  assert.equal((await b.request('/api/proxy', { sharing: false })).status, 200);
  await until(() => client.remoteSharing === false);
  status = await (await a.request('/api/proxy')).json(); assert.equal(status.state, 'blocked'); assert.equal(status.online, false);
  assert.equal(client.status().online, true);
  const events = [];
  client.run({ prompt: 'proxy permission does not grant model permission' }, (event) => events.push(event));
  await until(() => events.some((event) => event.type === 'done'));
  assert.ok(events.some((event) => event.type === 'done' && event.exitCode === 0));
  assert.equal((await a.request('/api/proxy', { sharing: true })).status, 400);
  assert.equal((await b.request('/api/proxy', { enabled: true })).status, 400);
  assert.equal((await a.request('/api/proxy', { enabled: 'yes' })).status, 400);
});

test('capacity rejections remain visible through both status APIs without blocking an online node', { timeout: 15000 }, async (t) => {
  const fixture = await paired(t), { host, client, a, b } = fixture;
  host.networkProxy.maxConnections = 3; host.networkProxy.maxPerSession = 1;
  client.networkProxy.maxConnections = 4; client.networkProxy.maxPerSession = 2;
  await enable(fixture); await until(() => client.remoteSharing === true);
  const targets = new Set();
  const target = net.createServer((socket) => {
    targets.add(socket); socket.on('error', () => {}); socket.on('close', () => targets.delete(socket));
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of targets) socket.destroy(); await new Promise((resolve) => target.close(resolve)); });
  const read = async (socket, count) => {
    for (;;) {
      const bytes = socket.read(count);
      if (bytes) return bytes;
      if (socket.destroyed || socket.readableEnded) throw new Error('SOCKS connection closed before reply');
      await once(socket, 'readable', { signal: AbortSignal.timeout(5000) });
    }
  };
  const socks = async () => {
    const proxy = client.networkProxy;
    const socket = net.createConnection({ host: '127.0.0.1', port: proxy.port });
    socket.on('error', () => {}); t.after(() => socket.destroy()); await once(socket, 'connect');
    socket.write(Buffer.from([5, 1, 2])); assert.deepEqual(await read(socket, 2), Buffer.from([5, 2]));
    const username = Buffer.from(proxy.username), password = Buffer.from(proxy.password);
    socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]));
    assert.deepEqual(await read(socket, 2), Buffer.from([1, 0]));
    const port = target.address().port;
    socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, port >> 8, port & 255]));
    return { socket, reply: await read(socket, 10) };
  };
  const first = await socks(); assert.equal(first.reply[1], 0);
  const rejected = await socks(); assert.equal(rejected.reply[1], 1);
  const capacityMessage = '代理连接数已达上限，请等待空闲连接释放后重试';
  const subscription = a.app.proxy.status().subscriptionUrl;
  for (const route of ['/api/status', '/api/proxy']) {
    const body = await (await a.request(route)).json(), proxy = route === '/api/status' ? body.proxy : body;
    assert.equal(proxy.connectionLimit, 2); assert.equal(proxy.sessionConnectionLimit, 2);
    assert.equal(proxy.lastError.code, 'PROXY_CAPACITY'); assert.equal(proxy.lastError.message, capacityMessage);
    assert.ok(Number.isFinite(Date.parse(proxy.lastError.at)));
    assert.equal(proxy.message, capacityMessage); assert.equal(proxy.online, true); assert.equal(proxy.state, 'ready');
    assert.equal(proxy.enabled, true); assert.equal(proxy.sharing, true); assert.equal(proxy.subscriptionUrl, subscription);
  }
  const hostStatus = await (await b.request('/api/proxy')).json();
  assert.equal(hostStatus.connectionLimit, 3); assert.equal(hostStatus.sessionConnectionLimit, 1);
  assert.equal((await fetch(subscription)).status, 200);
  first.socket.resume(); first.socket.end(); await until(() => host.networkProxy.flows.size === 0 && client.networkProxy.flows.size === 0);
  const recovered = await socks(); assert.equal(recovered.reply[1], 0);
  for (const route of ['/api/status', '/api/proxy']) {
    const body = await (await a.request(route)).json(), proxy = route === '/api/status' ? body.proxy : body;
    assert.equal(proxy.lastError, null); assert.equal(proxy.state, 'ready'); assert.equal(proxy.online, true);
    assert.match(proxy.message, /B 出口已连接/); assert.notEqual(proxy.message, capacityMessage);
  }
});

test('B outage retains importable subscription, blocks local node and reconnects with a fresh session', { timeout: 15000 }, async (t) => {
  const fixture = await paired(t), { host, client, a, hostInput } = fixture; await enable(fixture);
  const subscription = a.app.proxy.status().subscriptionUrl, pairing = { ...host.peer.pairing }, session = client.peer.session;
  client.peer.retryMs = 30; await host.stopPeer(); await until(() => !client.peer.state.online);
  const state = await (await a.request('/api/proxy')).json(); assert.equal(state.state, 'blocked'); assert.equal(state.online, false);
  assert.equal((await fetch(subscription)).status, 200);
  const socket = net.createConnection({ host: '127.0.0.1', port: a.app.proxy.proxy.port }); socket.on('error', () => {}); t.after(() => socket.destroy());
  await once(socket, 'close');
  await host.host({ ...hostInput, bridgePort: pairing.port }, { pairing });
  await until(() => client.peer.state.online && client.remoteSharing === true);
  assert.notEqual(client.peer.session, session); assert.equal(a.app.proxy.status().state, 'ready');
  assert.equal(a.app.proxy.status().subscriptionUrl, subscription);
});

test('proxy settings restore stable port and credentials only for the explicitly authorized pairing', { timeout: 15000 }, async (t) => {
  const directory = await temporaryDirectory(t), fixture = await paired(t, { directory }), { a, invitation } = fixture;
  await enable(fixture);
  const original = a.app.proxy.status(), profile = JSON.parse(a.app.proxy.profile());
  const stored = JSON.parse(await readFile(path.join(directory, 'proxy-demo.json'), 'utf8'));
  assert.equal(stored.enabled, true); assert.equal(stored.port, original.port); assert.equal(stored.pairing.length, 43);
  assert.equal(JSON.stringify(stored).includes(profile.proxies[0].password), false);
  await a.app.close();
  const restoredClient = new Bridge({ demo: true }), restored = await localApp(t, restoredClient, { directory });
  assert.equal(restored.app.proxy.status().enabled, false);
  await restoredClient.join({ invitation });
  assert.equal(restored.app.proxy.status().enabled, true); assert.equal(restored.app.proxy.status().port, original.port);
  const restoredProfile = JSON.parse(restored.app.proxy.profile()); assert.deepEqual(restoredProfile.proxies, profile.proxies);
  const otherHost = new Bridge({ demo: true }); const other = await localApp(t, otherHost);
  const newPairing = await otherHost.host({ workspace: process.cwd(), tailscaleIp: '127.0.0.1', bridgePort: 0 });
  await restoredClient.join({ invitation: newPairing.invitation });
  assert.equal(restored.app.proxy.status().enabled, false);
  assert.throws(() => restored.app.proxy.profile(), /启用/);
  assert.equal((await other.request('/api/proxy')).status, 200);
});

test('network protection startup, settings recovery, status reads and close never mutate system rules', { timeout: 15000 }, async (t) => {
  const directory = await temporaryDirectory(t), guard = guardMock(true);
  const fixture = await paired(t, { directory, proxyGuard: guard }), { a } = fixture;
  assert.deepEqual(guard.calls, ['status']); await enable(fixture);
  let status = await (await a.request('/api/proxy')).json(); assert.equal(status.guard.active, true);
  assert.equal(guard.calls.some((call) => call !== 'status'), false);
  await a.app.close(); assert.equal(guard.calls.some((call) => call !== 'status'), false);
  const restored = await localApp(t, new Bridge({ demo: true }), { directory, proxyGuard: guard });
  status = await (await restored.request('/api/proxy')).json(); assert.equal(status.guard.active, true);
  assert.equal(guard.calls.some((call) => call !== 'status'), false);
});

test('an unavailable protected TUN stays active and requests an explicit refresh without changing rules', async (t) => {
  const calls = [];
  const guard = {
    async status() { calls.push('status'); return { supported: true, state: 'enabled', enabled: true, tunName: 'Mihomo', tunReady: false }; },
    async enable() { calls.push('enable'); },
    async disable() { calls.push('disable'); }
  };
  const { app, request } = await localApp(t, new Bridge({ demo: true }), { proxyGuard: guard });
  const status = await (await request('/api/proxy')).json();
  assert.equal(status.guard.active, true); assert.equal(status.guard.tunReady, false);
  assert.match(status.guard.message, /仍在阻断/); assert.match(status.guard.message, /Mihomo/);
  assert.match(status.guard.message, /启用 \/ 刷新系统保护/);
  await app.proxy.refreshGuard(); await app.close();
  assert.equal(calls.every((call) => call === 'status'), true);
});

test('a ready Mihomo TUN reports its actual name without requiring ClaudeBridgeTun', async (t) => {
  const guard = {
    async status() { return { supported: true, state: 'enabled', enabled: true, verified: true, tunName: 'Mihomo', tunReady: true }; }
  };
  const { request } = await localApp(t, new Bridge({ demo: true }), { proxyGuard: guard });
  const status = await (await request('/api/proxy')).json();
  assert.equal(status.guard.active, true); assert.equal(status.guard.tunReady, true);
  assert.match(status.guard.message, /系统保护已验证启用（Mihomo）/);
  assert.doesNotMatch(status.guard.message, /ClaudeBridgeTun|请开启|请启动/);
});

test('a restored occupied SOCKS port blocks visibly and never silently chooses another port', { timeout: 15000 }, async (t) => {
  const directory = await temporaryDirectory(t), fixture = await paired(t, { directory });
  await enable(fixture); const originalPort = fixture.a.app.proxy.status().port; await fixture.a.app.close();
  const conflict = net.createServer();
  await new Promise((resolve) => conflict.listen(originalPort, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => conflict.close(() => resolve())));
  const client = new Bridge({ demo: true }), restored = await localApp(t, client, { directory });
  await client.join({ invitation: fixture.invitation });
  const status = restored.app.proxy.status();
  assert.equal(status.state, 'blocked'); assert.equal(status.online, false); assert.equal(status.port, originalPort);
  assert.equal(status.subscriptionUrl, ''); assert.match(status.message, /监听失败/);
  assert.equal(client.networkProxy.server, null);
  await new Promise((resolve) => conflict.close(resolve));
  const retry = await restored.request('/api/proxy', { enabled: true }); assert.equal(retry.status, 200);
  assert.equal((await retry.json()).port, originalPort);
});

test('system protection mutations require explicit authenticated requests', { timeout: 15000 }, async (t) => {
  const guard = guardMock(), fixture = await paired(t, { proxyGuard: guard }), { a } = fixture;
  assert.equal((await a.request('/api/proxy/guard', { enabled: true })).status, 400);
  await enable(fixture);
  assert.equal((await fetch(`${a.base}/api/proxy/guard`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' })).status, 401);
  assert.equal(guard.calls.includes('enable'), false);
  const enabled = await a.request('/api/proxy/guard', { enabled: true }); assert.equal(enabled.status, 200); assert.equal((await enabled.json()).guard.active, true);
  const disabled = await a.request('/api/proxy/guard', { enabled: false }); assert.equal(disabled.status, 200); assert.equal((await disabled.json()).guard.active, false);
  assert.equal(guard.calls.filter((call) => call === 'enable').length, 1); assert.equal(guard.calls.filter((call) => call === 'disable').length, 1);
});

test('explicit protection verification accepts no extra input and needs authentication but no pairing', { timeout: 15000 }, async (t) => {
  const calls = [];
  const guard = {
    async status() { calls.push('status'); return { supported: true, enabled: false, state: 'unknown' }; },
    async verify() { calls.push('verify'); return { supported: true, enabled: true, state: 'enabled', verified: true, tunReady: true, filterCount: 4, expectedFilters: 4 }; }
  };
  const fixture = await localApp(t, new Bridge({ demo: true }), { proxyGuard: guard });
  assert.equal(fixture.app.proxy.status().guard.state, 'unknown');
  assert.equal(fixture.app.proxy.status().guard.active, false);
  assert.equal((await fetch(`${fixture.base}/api/proxy/guard/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fixture.request('/api/proxy/guard/verify', { enabled: true })).status, 400);
  assert.equal(calls.includes('verify'), false);
  const checksBefore = calls.filter((call) => call === 'status').length;
  const response = await fixture.request('/api/proxy/guard/verify', {}); assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.guard.state, 'enabled'); assert.equal(result.guard.verified, true); assert.equal(result.guard.active, true);
  assert.equal(calls.filter((call) => call === 'verify').length, 1);
  assert.equal(calls.filter((call) => call === 'status').length, checksBefore);
});

test('explicit enable preserves verified native result even when ordinary status is unknown', { timeout: 15000 }, async (t) => {
  const calls = [];
  const guard = {
    async status() { calls.push('status'); return { supported: true, enabled: false, state: 'unknown' }; },
    async enable() { calls.push('enable'); return { supported: true, enabled: true, state: 'enabled', verified: true, tunReady: true, filterCount: 4, expectedFilters: 4 }; }
  };
  const fixture = await paired(t, { proxyGuard: guard }); await enable(fixture);
  const before = calls.filter((call) => call === 'status').length;
  const response = await fixture.a.request('/api/proxy/guard', { enabled: true }); assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.guard.state, 'enabled'); assert.equal(result.guard.active, true); assert.equal(result.guard.verified, true);
  assert.equal(calls.filter((call) => call === 'enable').length, 1);
  assert.equal(calls.filter((call) => call === 'status').length, before);
});

test('partial enable keeps administrator diagnostics and ignores an older unknown poll', { timeout: 15000 }, async (t) => {
  const stale = Promise.withResolvers();
  const unknown = { supported: true, profileId: 'profile-a', state: 'unknown', enabled: false };
  const partial = { supported: true, profileId: 'profile-a', state: 'partial', enabled: false,
    filterCount: 46, expectedFilters: 46, issues: ['changed filter: out-v4-dns', 'verified 42 of 46 required filters'] };
  let reads = 0;
  const guard = new NetworkGuard({ platform: 'win32', profileId: 'profile-a', execute: async (_command, args) => {
    if (args[1] === 'status') return ++reads === 2 ? stale.promise : { stdout: JSON.stringify(unknown) };
    assert.equal(args[1], 'elevate-enable');
    return { stdout: JSON.stringify(partial) };
  } });
  const fixture = await paired(t, { proxyGuard: guard }); await enable(fixture);
  const poll = fixture.a.app.proxy.refreshGuard();
  assert.equal(reads, 2);
  const response = await fixture.a.request('/api/proxy/guard', { enabled: true });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /verified 42 of 46 required filters/);
  assert.equal(reads, 2);
  const result = fixture.a.app.proxy.status().guard;
  assert.equal(result.state, 'partial'); assert.equal(result.active, false);
  assert.equal(result.filterCount, 46); assert.equal(result.expectedFilters, 46);
  assert.deepEqual(result.issues, partial.issues);
  assert.match(result.message, /不能保证完整阻断/);
  assert.match(result.message, /verified 42 of 46 required filters/);
  stale.resolve({ stdout: JSON.stringify(unknown) }); await poll;
  assert.equal(fixture.a.app.proxy.status().guard.state, 'partial');
  // A genuinely later failed read is still unknown, never a verified removal.
  await fixture.a.app.proxy.refreshGuard();
  assert.equal(fixture.a.app.proxy.status().guard.state, 'unknown');
  assert.equal(fixture.a.app.proxy.status().guard.active, false);
});

test('partial disable keeps remaining rules visible without claiming restored access', async (t) => {
  const calls = [];
  const partial = { supported: true, profileId: 'profile-a', state: 'partial', enabled: false,
    filterCount: 1, expectedFilters: 46, issues: ['verified 1 of 46 required filters'] };
  const guard = new NetworkGuard({ platform: 'win32', profileId: 'profile-a', execute: async (_command, args) => {
    calls.push(args[1]);
    return { stdout: JSON.stringify(args[1] === 'status'
      ? { supported: true, profileId: 'profile-a', state: 'unknown', enabled: false } : partial) };
  } });
  const { app, request } = await localApp(t, new Bridge({ demo: true }), { proxyGuard: guard });
  const response = await request('/api/proxy/guard', { enabled: false });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /规则仍存在，尚未恢复直连/);
  assert.equal(app.proxy.status().guard.state, 'partial');
  assert.equal(app.proxy.status().guard.active, false);
  assert.equal(app.proxy.status().guard.filterCount, 1);
  assert.deepEqual(calls, ['status', 'elevate-disable']);
});

test('explicit protection verification reports partial rules without enabling protection', async (t) => {
  const guard = {
    async status() { return { supported: true, enabled: false, state: 'unknown' }; },
    async verify() { return { supported: true, enabled: false, state: 'partial', filterCount: 46, expectedFilters: 46,
      issues: ['verified 42 of 46 required filters'] }; }
  };
  const { request } = await localApp(t, new Bridge({ demo: true }), { proxyGuard: guard });
  const response = await request('/api/proxy/guard/verify', {});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.guard.state, 'partial'); assert.equal(result.guard.active, false);
  assert.match(result.guard.message, /verified 42 of 46 required filters/);
});

test('explicit protection disable remains available without any saved or active pairing', { timeout: 15000 }, async (t) => {
  const calls = [];
  const guard = {
    async status() { calls.push('status'); return { supported: true, enabled: false, state: 'unknown' }; },
    async disable() { calls.push('disable'); return { supported: true, enabled: false, state: 'disabled', verified: true, filterCount: 0, expectedFilters: 4 }; }
  };
  const bridge = new Bridge({ demo: true }), fixture = await localApp(t, bridge, { proxyGuard: guard });
  assert.equal(bridge.peer, undefined);
  const response = await fixture.request('/api/proxy/guard', { enabled: false }); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.guard.active, false); assert.equal(result.guard.state, 'disabled'); assert.equal(result.guard.verified, true);
  assert.deepEqual(calls, ['status', 'disable']);
});

test('concurrent guard polls share a read and cannot overwrite a newer authorized result', async (t) => {
  const stale = Promise.withResolvers();
  let reads = 0;
  const disabled = { supported: true, enabled: false, state: 'disabled' };
  const verified = { supported: true, enabled: true, state: 'enabled', verified: true };
  const guard = { status() { return ++reads === 1 ? Promise.resolve(disabled) : stale.promise; }, async verify() { return verified; } };
  const { app } = await localApp(t, new Bridge({ demo: true }), { proxyGuard: guard });
  const polls = Array.from({ length: 8 }, () => app.proxy.refreshGuard());
  assert.equal(reads, 2);
  await app.proxy.verifyGuard({});
  stale.resolve({ supported: true, enabled: false, state: 'unknown' });
  await Promise.all(polls);
  assert.equal(app.proxy.status().guard.active, true);
  assert.equal(app.proxy.status().guard.verified, true);
});

test('polls during an authorized guard operation do not start competing status helpers', async (t) => {
  const verifying = Promise.withResolvers();
  let reads = 0, started = false;
  const guard = {
    async status() { reads++; return { supported: true, enabled: false, state: 'unknown' }; },
    verify() { started = true; return verifying.promise; }
  };
  const { app } = await localApp(t, new Bridge({ demo: true }), { proxyGuard: guard });
  const operation = app.proxy.verifyGuard({}); await until(() => started);
  await Promise.all(Array.from({ length: 8 }, () => app.proxy.refreshGuard()));
  assert.equal(reads, 1);
  verifying.resolve({ supported: true, enabled: true, state: 'enabled', verified: true });
  assert.equal((await operation).guard.active, true);
});

test('an enabled saved node with no stable port is rejected without opening a random listener', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(path.join(directory, 'proxy-demo.json'), JSON.stringify({ v: 1, enabled: true, sharing: false, port: 0, pairing: 'a'.repeat(43) }));
  const { app } = await localApp(t, new Bridge({ demo: true }), { directory });
  assert.equal(Boolean(app.proxy.proxy.server?.listening), false);
  assert.equal(app.proxy.status().enabled, false);
  assert.match(app.proxy.status().message, /配置无法恢复/);
});

test('local APIs wait for proxy restoration before accepting state changes', async (t) => {
  const loading = Promise.withResolvers(); let mutations = 0;
  const bridge = new Bridge({ demo: true }); bridge.host = async () => { mutations++; return {}; };
  const app = createLocalServer({ port: 0, token, bridge, proxyGuard: { status: () => loading.promise } });
  t.after(async () => { loading.resolve({ enabled: false, state: 'disabled' }); await app.close(); });
  const listening = app.listen(); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status, 503);
  const change = fetch(`${base}/api/host`, { method: 'POST', headers, body: '{}' });
  await delay(30); assert.equal(mutations, 0);
  loading.resolve({ enabled: false, state: 'disabled' }); await listening;
  assert.equal((await change).status, 200); assert.equal(mutations, 1);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('authenticated early shutdown cancels only guard reads and leaves no listener behind', async (t) => {
  const loading = Promise.withResolvers(); let cancelled = 0, stopped;
  const guard = { status: () => loading.promise, cancelStatus() { cancelled++; loading.resolve({ enabled: false, state: 'disabled' }); } };
  const app = createLocalServer({ port: 0, token, bridge: new Bridge({ demo: true }), proxyGuard: guard, onShutdown: () => { stopped = app.close(); } });
  t.after(() => app.close());
  const listening = app.listen().then(() => null, (error) => error);
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/api/shutdown`, { method: 'POST', headers, body: '{}' })).status, 200);
  await until(() => Boolean(stopped)); await stopped;
  assert.match((await listening).message, /退出/);
  assert.equal(cancelled, 1); assert.equal(app.server.listening, false);
  assert.equal(Boolean(app.proxy.proxy.server?.listening), false);
});

test('closing waits for a pending node start and then releases the newly opened port', async (t) => {
  const fixture = await paired(t), { a, client } = fixture;
  const starting = Promise.withResolvers(); let started = false;
  const originalStart = client.networkProxy.start.bind(client.networkProxy);
  client.networkProxy.start = async () => { started = true; await starting.promise; return originalStart(); };
  const configuring = a.app.proxy.configure({ enabled: true }); await until(() => started);
  const closing = a.app.close(); starting.resolve();
  await configuring; await closing;
  assert.equal(Boolean(client.networkProxy.server?.listening), false);
  await assert.rejects(a.app.proxy.configure({ enabled: true }), /退出/);
});
