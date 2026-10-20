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

const token = 'clash-proxy-test-token';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Clash integration condition timed out'); await delay(10); }
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
  assert.equal(config.sniffer, undefined); assert.equal(config.dns['nameserver-policy'], undefined);
  assert.deepEqual(clashProfile({ port: 12345, username: 'user', password: 'secret', scope: 'all' }), config);
  for (const resolver of [...config.dns.nameserver, ...config.dns['proxy-server-nameserver']]) assert.match(resolver, /#B 网络出口$/);
  assert.ok(config.rules.includes('PROCESS-NAME,bridge-net.exe,DIRECT'));
  assert.equal(config.rules.some((rule) => /^MATCH,DIRECT|^GEOIP,.*DIRECT/.test(rule)), false);
  assert.throws(() => clashProfile({ port: 0, username: 'user', password: 'secret' }), /尚未就绪/);
});

test('Claude-only profile pins service, content and telemetry traffic to B while ordinary traffic and DNS stay direct', () => {
  const config = clashProfile({ port: 12345, username: 'user', password: 'secret', scope: 'claude' });
  const suffixes = ['claude.ai', 'claude.com', 'claude.app', 'anthropic.com', 'claudeusercontent.com', 'claudemcpcontent.com'];
  const telemetry = ['http-intake.logs.us5.datadoghq.com', 'browser-intake-us5-datadoghq.com'];
  const loopback = config.rules.indexOf('IP-CIDR,127.0.0.0/8,DIRECT,no-resolve');
  const helper = config.rules.indexOf('PROCESS-NAME,bridge-net.exe,DIRECT');
  for (const domain of suffixes) {
    const index = config.rules.indexOf(`DOMAIN-SUFFIX,${domain},B 网络出口`);
    assert.ok(index >= 0 && index < helper && index < loopback, 'Claude domains must be matched before process and address direct exceptions');
  }
  for (const domain of telemetry) {
    const index = config.rules.indexOf(`DOMAIN,${domain},B 网络出口`);
    assert.ok(index >= 0 && index < helper && index < loopback);
  }
  assert.equal(config.rules.at(-1), 'MATCH,DIRECT');
  assert.equal(config.rules.filter((rule) => rule.endsWith(',B 网络出口')).length, suffixes.length + telemetry.length);
  assert.equal(config.rules.some((rule) => /github|npmjs|googleapis|cloudflare|jsdelivr|DOMAIN-SUFFIX,datadoghq/u.test(rule)), false);
  assert.equal(config['proxy-groups'], undefined); assert.equal(config['rule-providers'], undefined);
  assert.deepEqual(config.dns.nameserver, ['223.5.5.5#DIRECT', '119.29.29.29#DIRECT']);
  assert.deepEqual(config.dns['proxy-server-nameserver'], config.dns.nameserver);
  assert.equal(config.dns['fake-ip-filter-mode'], 'whitelist');
  assert.deepEqual(config.dns['fake-ip-filter'].sort(), [...suffixes.map((domain) => `+.${domain}`), ...telemetry].sort());
  for (const resolver of [...config.dns.nameserver, ...config.dns['proxy-server-nameserver']]) assert.match(resolver, /#DIRECT$/);
  assert.deepEqual(Object.keys(config.dns['nameserver-policy']).sort(), [...suffixes.map((domain) => `+.${domain}`), ...telemetry].sort());
  for (const resolvers of Object.values(config.dns['nameserver-policy'])) {
    assert.ok(resolvers.length > 0); for (const resolver of resolvers) assert.match(resolver, /#B 网络出口$/);
  }
  assert.equal(config.dns.fallback, undefined); assert.equal(config.dns['fallback-filter'], undefined);
  assert.equal(config.sniffer.enable, true); assert.equal(config.sniffer['parse-pure-ip'], true);
  assert.equal(config.sniffer['override-destination'], true);
  assert.deepEqual(Object.keys(config.sniffer.sniff).sort(), ['HTTP', 'QUIC', 'TLS']);
  assert.equal(config.tun.enable, true); assert.equal(config.tun['strict-route'], true);
  const system = clashProfile({ port: 12345, username: 'user', password: 'secret', system: true, scope: 'claude' });
  assert.ok(system.rules.indexOf('DOMAIN-SUFFIX,claude.app,B 网络出口') < system.rules.indexOf('PROCESS-NAME,tailscaled.exe,DIRECT'));
  assert.ok(system.rules.includes('IP-CIDR,100.64.0.0/10,DIRECT,no-resolve'));
  assert.throws(() => clashProfile({ port: 12345, username: 'user', password: 'secret', scope: 'unknown' }), /配置范围/);
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

test('Claude subscription uses the existing local authorization and remains available when B is offline', { timeout: 15000 }, async (t) => {
  const fixture = await paired(t), { host, client, a } = fixture;
  assert.equal(a.app.proxy.status().claudeSubscriptionUrl, '');
  await enable(fixture);
  const status = await (await a.request('/api/status')).json(), url = status.proxy.claudeSubscriptionUrl;
  assert.equal(url, status.proxy.subscriptionUrl.replace('/config.yaml', '/claude.yaml'));
  const response = await fetch(url); assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/yaml/);
  const config = await response.json();
  assert.equal(config.rules.at(-1), 'MATCH,DIRECT');
  assert.ok(config.rules.includes('DOMAIN-SUFFIX,anthropic.com,B 网络出口'));
  const full = await (await fetch(status.proxy.subscriptionUrl)).json();
  assert.deepEqual(config.proxies, full.proxies); assert.equal(full.rules.at(-1), 'MATCH,B 网络出口');
  assert.equal((await fetch(url.replace(a.app.proxy.subscriptionToken, 'a'.repeat(43)))).status, 401);
  assert.equal((await fetch(url, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  await host.stopPeer(); await until(() => !client.peer.state.online);
  const offline = await (await a.request('/api/proxy')).json();
  assert.equal(offline.state, 'blocked'); assert.equal(offline.claudeSubscriptionUrl, url);
  const retained = await fetch(url); assert.equal(retained.status, 200);
  assert.deepEqual((await retained.json()).rules, config.rules);
});

test('proxy status has no system protection state and removed protection APIs are unavailable', async (t) => {
  const { app, request } = await localApp(t, new Bridge({ demo: true }));
  assert.equal(Object.hasOwn(app.proxy.status(), 'guard'), false);
  const proxy = await (await request('/api/proxy')).json();
  assert.equal(Object.hasOwn(proxy, 'guard'), false);
  const status = await (await request('/api/status')).json();
  assert.equal(Object.hasOwn(status.proxy, 'guard'), false);
  assert.equal((await request('/api/proxy/guard', { enabled: true })).status, 404);
  assert.equal((await request('/api/proxy/guard/verify', {})).status, 404);
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
  const app = createLocalServer({ port: 0, token, bridge });
  const restore = app.proxy.restore.bind(app.proxy);
  app.proxy.restore = async (address) => { await loading.promise; return restore(address); };
  t.after(async () => { loading.resolve(); await app.close(); });
  const listening = app.listen(); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status, 503);
  const change = fetch(`${base}/api/host`, { method: 'POST', headers, body: '{}' });
  await delay(30); assert.equal(mutations, 0);
  loading.resolve(); await listening;
  assert.equal((await change).status, 200); assert.equal(mutations, 1);
  assert.equal((await fetch(`${base}/health`)).status, 200);
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
