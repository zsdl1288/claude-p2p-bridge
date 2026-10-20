// Optional integration check. Supply an existing, trusted Mihomo executable.
// No downloads, driver installation, system proxy, route or firewall changes.
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { once, EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/bridge.js';
import { clashProfile } from '../src/clash-proxy.js';
import { encodeSocksAddress, decodeSocksAddress } from '../src/network-proxy.js';
import { temporaryTestDirectory } from './test-support.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('node scripts/smoke-clash.mjs [--mihomo ABSOLUTE_PATH]\nChecks complete profiles, TCP/UDP forwarding, and B disconnect/recovery over loopback. TUN and DNS stay disabled for runtime checks.');
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
try {
  const profile = path.join(runtime, 'complete-profile.yaml');
  await writeFile(profile, JSON.stringify(clashProfile({ port: 12345, username: 'isolated-check', password: 'isolated-check-only' }), null, 2));
  // -t parses the unmodified complete profile; it does not start its TUN.
  const check = launch(['-t', '-f', profile, '-d', runtime]);
  const [code] = await once(check, 'close', { signal });
  assert.equal(code, 0, log); console.log('Complete JSON/YAML profile accepted by Mihomo: PASS');
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
  const port = await availablePort();
  const config = clashProfile({ port: a.networkProxy.port, username: a.networkProxy.username, password: a.networkProxy.password });
  // Runtime check uses only loopback, never Internet DNS or OS network changes.
  config.tun.enable = false; config.dns.enable = false; config['mixed-port'] = port;
  config['find-process-mode'] = 'off'; config.rules = ['MATCH,B 网络出口'];
  const file = path.join(runtime, 'loopback.yaml'); await writeFile(file, JSON.stringify(config, null, 2));
  launch(['-f', file, '-d', runtime]);
  await until(() => /mixed.*listening/i.test(log));
  async function checkTcp() {
    const payload = Buffer.from('mihomo-tcp-through-B');
    const tcp = await socks(port, 1, { host: '127.0.0.1', port: echo.address().port });
    try {
      tcp.socket.write(payload);
      assert.deepEqual(await tcp.reader.read(payload.length), payload);
    } finally { tcp.socket.destroy(); }
  }
  async function checkForwarding(phase) {
    await checkTcp();
    console.log(`${phase}: TCP through Mihomo -> authenticated A SOCKS -> independent B channel: PASS`);

    const udp = dgram.createSocket('udp4');
    let association;
    try {
      await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(0, '127.0.0.1', resolve); });
      association = await socks(port, 3, { host: '0.0.0.0', port: udp.address().port });
      const reply = once(udp, 'message', { signal });
      udp.send(Buffer.concat([Buffer.from([0, 0, 0]), encodeSocksAddress('127.0.0.1', udpEcho.address().port), Buffer.from('mihomo-udp-through-B')]), association.address.port, '127.0.0.1');
      const [packet] = await reply, address = decodeSocksAddress(packet, 3);
      assert.equal(packet.subarray(3 + address.bytes).toString(), 'mihomo-udp-through-B');
    } finally {
      association?.socket.destroy();
      udp.close();
    }
    assert.ok(a.networkProxy.uploadBytes > 0 && b.networkProxy.downloadBytes > 0);
    console.log(`${phase}: UDP through Mihomo -> authenticated A SOCKS -> independent B channel: PASS`);
  }

  await checkForwarding('Initial connection');
  await b.stopPeer(); await until(() => !a.peer.state.online && a.networkProxy.flows.size === 0);
  await assert.rejects(checkTcp);
  console.log('B disconnect revokes proxy flows and blocks new requests: PASS');

  const restored = await b.host({ workspace: root, tailscaleIp: '127.0.0.1', bridgePort: 0 });
  await a.join({ invitation: restored.invitation }); b.networkProxy.configure({ sharing: true }); b.broadcastProxyStatus();
  await until(() => a.remoteSharing === true && a.peer.state.online);
  await checkForwarding('B recovery');
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
