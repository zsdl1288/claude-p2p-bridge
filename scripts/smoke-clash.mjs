// Optional integration check. Supply an existing, trusted Mihomo executable.
// No downloads, driver installation, system proxy, route or firewall changes.
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import tls from 'node:tls';
import { once, EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/bridge.js';
import { clashProfile } from '../src/clash-proxy.js';
import { encodeSocksAddress, decodeSocksAddress } from '../src/network-proxy.js';
import { temporaryTestDirectory } from './test-support.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('node scripts/smoke-clash.mjs [--mihomo ABSOLUTE_PATH]\nChecks complete profiles, TCP/UDP forwarding, and Claude-only DNS/HTTP/TLS routing and disconnect behavior over loopback. TUN stays disabled; DNS uses isolated random ports.');
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== '--mihomo' || !path.isAbsolute(args[1]))) throw new Error('Expected --mihomo with an absolute executable path');
const executable = args[1] || path.join(root, '.tools', 'mihomo-test', 'binary', 'mihomo-windows-amd64-compatible.exe');
try { await access(executable); } catch { throw new Error('Mihomo executable unavailable; supply --mihomo ABSOLUTE_PATH. This script does not download it.'); }
const temporary = await temporaryTestDirectory(path.join(root, '.cache'), 'mihomo-smoke-');
const runtime = temporary.directory;
const resources = [], clients = [], children = new Set();
const signal = AbortSignal.timeout(30000);
const b = new Bridge({ demo: true, proxyOptions: { allowPrivateTargets: true } }), a = new Bridge({ demo: true });
let log = '';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) { signal.throwIfAborted(); if (Date.now() > end) throw new Error(`Mihomo did not become ready: ${log}`); await delay(10); }
}
function launch(args) {
  const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout.on('data', (data) => { log += data.toString(); }); child.stderr.on('data', (data) => { log += data.toString(); });
  child.on('error', () => {}); child.on('close', () => children.delete(child));
  return child;
}
class Reader {
  constructor(socket) {
    this.buffer = Buffer.alloc(0); this.events = new EventEmitter();
    socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.events.emit('data'); });
    socket.on('error', () => {}); socket.on('close', () => { this.closed = true; this.events.emit('data'); });
  }
  async read(size) {
    while (this.buffer.length < size) { if (this.closed) throw new Error('SOCKS stream closed before reply'); await once(this.events, 'data', { signal }); }
    const data = this.buffer.subarray(0, size); this.buffer = this.buffer.subarray(size); return data;
  }
}
async function socks(port, command, target) {
  const socket = net.createConnection({ host: '127.0.0.1', port }); clients.push(socket); const reader = new Reader(socket); await once(socket, 'connect', { signal });
  socket.write(Buffer.from([5, 1, 0])); assert.deepEqual(await reader.read(2), Buffer.from([5, 0]));
  socket.write(Buffer.concat([Buffer.from([5, command, 0]), encodeSocksAddress(target.host, target.port)]));
  const head = await reader.read(4); assert.equal(head[1], 0);
  let tail;
  if (head[3] === 1) tail = await reader.read(6);
  else if (head[3] === 4) tail = await reader.read(18);
  else { const length = await reader.read(1); tail = Buffer.concat([length, await reader.read(length[0] + 2)]); }
  return { socket, reader, address: decodeSocksAddress(Buffer.concat([head.subarray(3), tail])) };
}
async function availablePort() {
  const reserve = net.createServer();
  await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
  const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve)); return port;
}
function dnsNameEnd(packet, offset) {
  while (packet[offset]) { if ((packet[offset] & 0xc0) === 0xc0) return offset + 2; offset += packet[offset] + 1; }
  return offset + 1;
}
async function syntheticDns() {
  const socket = dgram.createSocket('udp4'), queries = [];
  resources.push(() => socket.close());
  socket.on('message', (packet, info) => {
    const end = dnsNameEnd(packet, 12), type = packet.readUInt16BE(end);
    let offset = 12; const labels = [];
    while (packet[offset]) { const size = packet[offset++]; labels.push(packet.subarray(offset, offset += size).toString()); }
    queries.push({ host: labels.join('.'), type });
    const header = Buffer.alloc(12); packet.copy(header, 0, 0, 2); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 4);
    // All synthetic ordinary names resolve to the reachable local targets.
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]);
    if (type === 1) header.writeUInt16BE(1, 6);
    socket.send(Buffer.concat([header, packet.subarray(12, end + 4), ...(type === 1 ? [answer] : [])]), info.port, info.address);
  });
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
  return { port: socket.address().port, queries };
}
async function dnsA(port, host) {
  const socket = dgram.createSocket('udp4');
  try {
    const header = Buffer.alloc(12); header.writeUInt16BE(Date.now() & 0xffff, 0); header.writeUInt16BE(0x0100, 2); header.writeUInt16BE(1, 4);
    const name = Buffer.concat([...host.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0, 0, 1, 0, 1])]);
    const received = once(socket, 'message', { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    socket.send(Buffer.concat([header, name]), port, '127.0.0.1');
    const [packet] = await received; assert.equal(packet.readUInt16BE(0), header.readUInt16BE(0)); assert.equal(packet.readUInt16BE(2) & 15, 0);
    let offset = 12; const addresses = [];
    for (let i = 0; i < packet.readUInt16BE(4); ++i) offset = dnsNameEnd(packet, offset) + 4;
    for (let i = 0; i < packet.readUInt16BE(6); ++i) {
      offset = dnsNameEnd(packet, offset);
      const type = packet.readUInt16BE(offset), size = packet.readUInt16BE(offset + 8); offset += 10;
      if (type === 1 && size === 4) addresses.push([...packet.subarray(offset, offset + size)].join('.'));
      offset += size;
    }
    assert.equal(addresses.length, 1, `Expected one synthetic A record for ${host}`); return addresses[0];
  } finally { socket.close(); }
}
// Public test-only certificate/key from Go's crypto/tls example fixture. Trust
// checks are disabled only on these isolated clients; no OS trust is changed.
const testTls = {
  cert: `-----BEGIN CERTIFICATE-----
MIIBhTCCASugAwIBAgIQIRi6zePL6mKjOipn+dNuaTAKBggqhkjOPQQDAjASMRAw
DgYDVQQKEwdBY21lIENvMB4XDTE3MTAyMDE5NDMwNloXDTE4MTAyMDE5NDMwNlow
EjEQMA4GA1UEChMHQWNtZSBDbzBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABD0d
7VNhbWvZLWPuj/RtHFjvtJBEwOkhbN/BnnE8rnZR8+sbwnc/KhCk3FhnpHZnQz7B
5aETbbIgmuvewdjvSBSjYzBhMA4GA1UdDwEB/wQEAwICpDATBgNVHSUEDDAKBggr
BgEFBQcDATAPBgNVHRMBAf8EBTADAQH/MCkGA1UdEQQiMCCCDmxvY2FsaG9zdDo1
NDUzgg4xMjcuMC4wLjE6NTQ1MzAKBggqhkjOPQQDAgNIADBFAiEA2zpJEPQyz6/l
Wf86aX6PepsntZv2GYlA5UpabfT2EZICICpJ5h/iI+i341gBmLiAFQOyTDT+/wQc
6MF9+Yw1Yy0t
-----END CERTIFICATE-----`,
  key: `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIIrYSSNQFaA2Hwf1duRSxKtLYX5CB04fSeQ6tF1aY/PuoAoGCCqGSM49
AwEHoUQDQgAEPR3tU2Fta9ktY+6P9G0cWO+0kETA6SFs38GecTyudlHz6xvCdz8q
EKTcWGekdmdDPsHloRNtsiCa697B2O9IFA==
-----END EC PRIVATE KEY-----`,
};
const syntheticReply = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nsynthetic');
async function syntheticTarget(secure) {
  const state = { accepted: 0, requests: [], sockets: new Set() };
  const handle = (socket) => {
    let request = '';
    socket.on('data', (data) => {
      request += data.toString();
      if (!request.includes('\r\n\r\n') || socket.writableEnded) return;
      state.requests.push({ path: request.split(' ')[1], viaB: b.networkProxy.flows.size > 0 });
      socket.end(syntheticReply);
    });
    socket.on('error', () => {});
  };
  const server = secure ? tls.createServer(testTls, handle) : net.createServer(handle);
  server.on('connection', (socket) => {
    ++state.accepted; state.sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => state.sockets.delete(socket));
  });
  server.on('tlsClientError', () => {});
  resources.push(async () => { for (const socket of state.sockets) socket.destroy(); if (server.listening) await new Promise((resolve) => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { ...state, get accepted() { return state.accepted; }, port: server.address().port, secure };
}
async function syntheticRequest(port, host, target, requestPath, dialHost = host) {
  const channel = await socks(port, 1, { host: dialHost, port: target.port });
  let socket = channel.socket, reader = channel.reader;
  try {
    if (target.secure) {
      socket = tls.connect({ socket, servername: host, rejectUnauthorized: false }); clients.push(socket);
      await once(socket, 'secureConnect', { signal }); reader = new Reader(socket);
    }
    socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    assert.deepEqual(await reader.read(syntheticReply.length), syntheticReply);
  } finally { socket.destroy(); }
}
try {
  const profile = path.join(runtime, 'complete-profile.yaml');
  await writeFile(profile, JSON.stringify(clashProfile({ port: 12345, username: 'isolated-check', password: 'isolated-check-only' }), null, 2));
  // -t parses the unmodified complete profile; it does not start its TUN.
  const check = launch(['-t', '-f', profile, '-d', runtime]);
  const [code] = await once(check, 'close', { signal });
  assert.equal(code, 0, log); console.log('Complete JSON/YAML profile accepted by Mihomo: PASS');
  const claudeProfile = path.join(runtime, 'complete-claude-profile.yaml');
  await writeFile(claudeProfile, JSON.stringify(clashProfile({ port: 12345, username: 'isolated-check', password: 'isolated-check-only', scope: 'claude' }), null, 2));
  const claudeCheck = launch(['-t', '-f', claudeProfile, '-d', runtime]);
  const [claudeCode] = await once(claudeCheck, 'close', { signal });
  assert.equal(claudeCode, 0, log); console.log('Complete Claude-only JSON/YAML profile accepted by Mihomo: PASS');
  const host = await b.host({ workspace: root, tailscaleIp: '127.0.0.1', bridgePort: 0 });
  await a.join({ invitation: host.invitation }); b.networkProxy.configure({ sharing: true }); b.broadcastProxyStatus();
  await until(() => a.remoteSharing === true); await a.networkProxy.start(); a.networkProxy.configure({ enabled: true });
  const echoSockets = new Set();
  const echo = net.createServer((socket) => { echoSockets.add(socket); socket.on('close', () => echoSockets.delete(socket)); socket.on('error', () => {}); socket.pipe(socket); });
  resources.push(async () => { for (const socket of echoSockets) socket.destroy(); if (echo.listening) await new Promise((resolve) => echo.close(resolve)); });
  await new Promise((resolve, reject) => { echo.once('error', reject); echo.listen(0, '127.0.0.1', resolve); });
  const udpEcho = dgram.createSocket('udp4'); resources.push(() => udpEcho.close());
  udpEcho.on('message', (data, info) => udpEcho.send(data, info.port, info.address));
  await new Promise((resolve, reject) => { udpEcho.once('error', reject); udpEcho.bind(0, '127.0.0.1', resolve); });
  const reserve = net.createServer();
  await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
  const port = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
  const config = clashProfile({ port: a.networkProxy.port, username: a.networkProxy.username, password: a.networkProxy.password });
  // Runtime check uses only loopback, never Internet DNS or OS network changes.
  config.tun.enable = false; config.dns.enable = false; config['mixed-port'] = port;
  config['find-process-mode'] = 'off'; config.rules = ['MATCH,B 网络出口'];
  const file = path.join(runtime, 'loopback.yaml'); await writeFile(file, JSON.stringify(config, null, 2));
  launch(['-f', file, '-d', runtime]);
  await until(() => /mixed.*listening/i.test(log));
  const tcp = await socks(port, 1, { host: '127.0.0.1', port: echo.address().port });
  tcp.socket.write('mihomo-tcp-through-B'); assert.equal((await tcp.reader.read(20)).toString(), 'mihomo-tcp-through-B'); tcp.socket.destroy();
  console.log('TCP through Mihomo -> authenticated A SOCKS -> independent B channel: PASS');
  const udp = dgram.createSocket('udp4'); resources.push(() => udp.close());
  await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(0, '127.0.0.1', resolve); });
  const association = await socks(port, 3, { host: '0.0.0.0', port: udp.address().port });
  const reply = once(udp, 'message', { signal });
  udp.send(Buffer.concat([Buffer.from([0, 0, 0]), encodeSocksAddress('127.0.0.1', udpEcho.address().port), Buffer.from('mihomo-udp-through-B')]), association.address.port, '127.0.0.1');
  const [packet] = await reply, address = decodeSocksAddress(packet, 3);
  assert.equal(packet.subarray(3 + address.bytes).toString(), 'mihomo-udp-through-B');
  assert.ok(a.networkProxy.uploadBytes > 0 && b.networkProxy.downloadBytes > 0);
  console.log('UDP through Mihomo -> authenticated A SOCKS -> independent B channel: PASS');
  await b.stopPeer(); await until(() => !a.peer.state.online);
  assert.equal(a.networkProxy.flows.size, 0); console.log('B disconnect revokes proxy flows: PASS');

  async function reconnect() {
    const restored = await b.host({ workspace: root, tailscaleIp: '127.0.0.1', bridgePort: 0 });
    await a.join({ invitation: restored.invitation }); b.networkProxy.configure({ sharing: true }); b.broadcastProxyStatus();
    await until(() => a.remoteSharing === true && a.peer.state.online);
  }
  await reconnect();
  const domains = ['api.anthropic.com', 'claude.ai', 'claude.app'];
  b.networkProxy.resolve = async (host) => {
    assert.ok(domains.includes(host), `Unexpected external DNS request: ${host}`);
    return [{ address: '127.0.0.1', family: 4 }];
  };
  const selective = clashProfile({ port: a.networkProxy.port, username: a.networkProxy.username, password: a.networkProxy.password, scope: 'claude' });
  const originalRules = [...selective.rules], originalFilter = [...selective.dns['fake-ip-filter']], selectivePort = await availablePort();
  const directDns = await syntheticDns(), proxyDns = await syntheticDns(), dnsPort = await availablePort();
  // Preserve production rule order, DNS policy keys, and fake-IP filtering.
  // Only resolver transport addresses and listening ports become loopback.
  selective.tun.enable = false; selective.dns.listen = `127.0.0.1:${dnsPort}`;
  const localResolvers = (upstreams, port) => upstreams.map((upstream) => {
    const marker = upstream.indexOf('#');
    return `udp://127.0.0.1:${port}${marker === -1 ? '' : upstream.slice(marker)}`;
  });
  selective.dns.nameserver = localResolvers(selective.dns.nameserver, directDns.port);
  selective.dns['proxy-server-nameserver'] = localResolvers(selective.dns['proxy-server-nameserver'], directDns.port);
  selective.dns['nameserver-policy'] = Object.fromEntries(Object.entries(selective.dns['nameserver-policy']).map(([host, upstreams]) => [host, localResolvers(upstreams, proxyDns.port)]));
  selective['mixed-port'] = selectivePort; selective['find-process-mode'] = 'off';
  assert.deepEqual(selective.rules, originalRules);
  assert.deepEqual(selective.dns['fake-ip-filter'], originalFilter);
  // Each running core needs its own fake-IP cache; sharing its directory would
  // lock cache.db and prevent reverse mappings from being retained.
  const selectiveRuntime = path.join(runtime, 'selective'); await mkdir(selectiveRuntime);
  const selectiveFile = path.join(selectiveRuntime, 'claude-loopback.yaml'); await writeFile(selectiveFile, JSON.stringify(selective, null, 2));
  const logStart = log.length; launch(['-f', selectiveFile, '-d', selectiveRuntime]);
  await until(() => /mixed.*listening/i.test(log.slice(logStart)));
  const httpTarget = await syntheticTarget(false), tlsTarget = await syntheticTarget(true);
  const nonce = Date.now(), beforeName = `before-${nonce}.ordinary.example`;
  assert.equal(await dnsA(dnsPort, beforeName), '127.0.0.1');
  assert.ok(directDns.queries.some(({ host, type }) => host === beforeName && type === 1), 'Ordinary DNS must reach the direct upstream');
  const fakeAddresses = Object.fromEntries(await Promise.all(domains.map(async (host) => {
    const address = await dnsA(dnsPort, host); assert.match(address, /^198\.18\./, `${host} must retain fake-IP protection`); return [host, address];
  })));
  console.log('Live isolated DNS returns real ordinary addresses and fake IPs for Claude including claude.app: PASS');
  async function expectRoute(host, target, requestPath, viaB, dialHost = host) {
    await until(() => a.networkProxy.flows.size === 0 && b.networkProxy.flows.size === 0);
    const index = target.requests.length, uploaded = a.networkProxy.uploadBytes;
    await syntheticRequest(selectivePort, host, target, requestPath, dialHost);
    assert.deepEqual(target.requests[index], { path: requestPath, viaB });
    if (viaB) assert.ok(a.networkProxy.uploadBytes > uploaded, 'Claude traffic must cross A/B');
    else assert.equal(a.networkProxy.uploadBytes, uploaded, 'Ordinary traffic must stay DIRECT');
    await until(() => a.networkProxy.flows.size === 0 && b.networkProxy.flows.size === 0);
  }
  await expectRoute('claude.ai', httpTarget, '/claude-http', true, fakeAddresses['claude.ai']);
  await expectRoute('api.anthropic.com', tlsTarget, '/claude-tls', true, fakeAddresses['api.anthropic.com']);
  await expectRoute('claude.app', httpTarget, '/claude-app-http', true, fakeAddresses['claude.app']);
  await expectRoute('ordinary.example', httpTarget, '/ordinary-http', false);
  await expectRoute('ordinary.example', tlsTarget, '/ordinary-tls', false);
  console.log('Unmodified Claude-only rules route HTTP/TLS Claude domains through B and ordinary domains DIRECT: PASS');
  await b.stopPeer(); await until(() => !a.peer.state.online && a.networkProxy.flows.size === 0);
  const offlineName = `offline-${nonce}.ordinary.example`, previousQueries = directDns.queries.length;
  assert.equal(await dnsA(dnsPort, offlineName), '127.0.0.1');
  assert.ok(directDns.queries.slice(previousQueries).some(({ host, type }) => host === offlineName && type === 1), 'An uncached ordinary DNS query must still reach DIRECT while B is offline');
  for (const host of domains) assert.equal(await dnsA(dnsPort, host), fakeAddresses[host], 'B offline must retain Claude fake-IP mapping');
  console.log('B offline preserves Claude fake IPs and uncached ordinary DNS still reaches its direct upstream: PASS');
  const accepted = [httpTarget.accepted, tlsTarget.accepted], requests = [httpTarget.requests.length, tlsTarget.requests.length];
  await assert.rejects(() => syntheticRequest(selectivePort, 'claude.ai', httpTarget, '/must-not-arrive-http', fakeAddresses['claude.ai']));
  await assert.rejects(() => syntheticRequest(selectivePort, 'api.anthropic.com', tlsTarget, '/must-not-arrive-tls', fakeAddresses['api.anthropic.com']));
  await delay(100);
  assert.deepEqual([httpTarget.accepted, tlsTarget.accepted], accepted, 'Blocked Claude requests must not reach either target via direct fallback');
  assert.deepEqual([httpTarget.requests.length, tlsTarget.requests.length], requests);
  await expectRoute('ordinary.example', httpTarget, '/offline-ordinary-http', false);
  await expectRoute('ordinary.example', tlsTarget, '/offline-ordinary-tls', false);
  console.log('B offline blocks Claude without direct fallback while ordinary HTTP/TLS stays reachable: PASS');
  await reconnect();
  await expectRoute('claude.ai', httpTarget, '/restored-claude-http', true, fakeAddresses['claude.ai']);
  await expectRoute('api.anthropic.com', tlsTarget, '/restored-claude-tls', true, fakeAddresses['api.anthropic.com']);
  await expectRoute('claude.app', httpTarget, '/restored-claude-app-http', true, fakeAddresses['claude.app']);
  console.log('B recovery restores new Claude HTTP/TLS requests: PASS');
} finally {
  try {
    for (const socket of clients) socket.destroy();
    const stops = [...children].map(async (child) => { const closed = once(child, 'close').catch(() => {}); child.kill(); await closed; });
    await Promise.all(stops);
    await a.networkProxy.close(); await b.networkProxy.close(); await a.disconnect(); await b.disconnect();
    for (const close of resources.reverse()) { try { await close(); } catch {} }
    const logFile = path.join(root, '.cache', 'mihomo-smoke.log');
    await writeFile(logFile, log);
    console.log(`Isolated test log: ${logFile}`);
  } finally { await temporary.cleanup(); }
}
