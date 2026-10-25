// Real Go RPC + production JS pairing/API/subscriptions + Mihomo. Only the
// Tailnet backend is replaced by loopback sockets in a Go TEST binary.
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import path from 'node:path';
import { once, EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/bridge.js';
import { EmbeddedNetwork } from '../src/embedded-network.js';
import { createLocalServer } from '../src/server.js';
import { encodeSocksAddress, decodeSocksAddress } from '../src/network-proxy.js';
import { temporaryTestDirectory } from './test-support.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = process.argv[2];
if (process.argv.length !== 3 || !path.isAbsolute(fixture || '') || process.env.BRIDGE_NATIVE_RPC_FIXTURE !== '1') {
  throw new Error('Run python scripts/smoke-native-proxy.py (requires a private Go test fixture)');
}
const mihomo = path.join(root, '.tools/mihomo-test/binary/mihomo-windows-amd64-compatible.exe');
await access(fixture); await access(mihomo);
const temporary = await temporaryTestDirectory(path.join(root, '.cache'), 'native-mihomo-');
const token = 'isolated-native-proxy-smoke';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const signal = AbortSignal.timeout(360000), children = new Set(), sockets = new Set(), cleanup = [];
let log = '';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 12000, interval = 25) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    signal.throwIfAborted();
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await delay(interval);
  }
}
function launch(args) {
  const child = spawn(mihomo, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); child.on('error', () => {}); child.on('close', () => children.delete(child));
  child.stdout.on('data', (data) => { log += data; }); child.stderr.on('data', (data) => { log += data; });
  return child;
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
class Reader {
  constructor(socket) {
    this.buffer = Buffer.alloc(0); this.events = new EventEmitter();
    socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.events.emit('data'); });
    socket.on('error', () => {}); socket.on('close', () => { this.closed = true; this.events.emit('data'); });
  }
  async read(size) {
    while (this.buffer.length < size) {
      if (this.closed) throw new Error('SOCKS stream closed');
      await once(this.events, 'data', { signal });
    }
    const result = this.buffer.subarray(0, size); this.buffer = this.buffer.subarray(size); return result;
  }
}
async function socks(port, command, host, targetPort) {
  const socket = net.createConnection({ host: '127.0.0.1', port }); sockets.add(socket);
  socket.once('close', () => sockets.delete(socket)); const reader = new Reader(socket);
  try {
    await once(socket, 'connect', { signal });
    socket.write(Buffer.from([5, 1, 0])); assert.deepEqual(await reader.read(2), Buffer.from([5, 0]));
    socket.write(Buffer.concat([Buffer.from([5, command, 0]), encodeSocksAddress(host, targetPort)]));
    const head = await reader.read(4); assert.equal(head[1], 0, 'SOCKS request rejected');
    let tail;
    if (head[3] === 1) tail = await reader.read(6);
    else if (head[3] === 4) tail = await reader.read(18);
    else { const size = await reader.read(1); tail = Buffer.concat([size, await reader.read(size[0] + 2)]); }
    return { socket, reader, address: decodeSocksAddress(Buffer.concat([head.subarray(3), tail])) };
  } catch (error) { socket.destroy(); throw error; }
}
function fixtureNetwork(name) {
  return new EmbeddedNetwork({ directory: path.join(temporary.directory, name), command: fixture,
    args: ['-test.run=^TestNativeProxyRPCFixture$'], requestTimeoutMs: 5000 });
}
const aNetwork = fixtureNetwork('a'), bNetwork = fixtureNetwork('b'), cNetwork = fixtureNetwork('c');
const a = new Bridge({ demo: true, networkAdapter: aNetwork });
const b = new Bridge({ demo: true, networkAdapter: bNetwork });
const c = new Bridge({ demo: true, networkAdapter: cNetwork });
const aApp = createLocalServer({ port: 0, token, bridge: a, directory: path.join(temporary.directory, 'app-a') });
const bApp = createLocalServer({ port: 0, token, bridge: b, directory: path.join(temporary.directory, 'app-b') });
try {
  const aa = await aApp.listen(), ba = await bApp.listen();
  const api = async (side, body) => {
    const response = await fetch(`http://127.0.0.1:${side === 'a' ? aa.port : ba.port}/api/proxy`, {
      method: body ? 'POST' : 'GET', headers, signal, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const hostInput = { tailscaleIp: '127.0.0.1', bridgePort: 0 };
  const host = await b.host(hostInput); await a.join({ invitation: host.invitation });
  await api('b', { sharing: true }); await api('a', { enabled: true });
  await until(async () => (await api('a')).online, 'native endpoint available after authenticated pairing');
  const first = await api('a');
  // Fixture-only readiness: no real Tailnet is started by this test binary.
  aNetwork.wantRunning = true; bNetwork.wantRunning = true;
  const speedAPI = async (side, body, cancel = false) => {
    const response = await fetch(`http://127.0.0.1:${side === 'a' ? aa.port : ba.port}/api/proxy/speed-test${cancel ? '/cancel' : ''}`, {
      method: body ? 'POST' : 'GET', headers, signal, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  assert.equal(first.transport, 'native-tailscale');
  const subscriptionUrl = first.subscriptionUrl;
  assert.ok(subscriptionUrl.startsWith(`http://127.0.0.1:${aa.port}/clash/`));
  const response = await fetch(subscriptionUrl, { signal }); assert.equal(response.status, 200);
  const full = await response.json(); assert.equal(full.proxies[0].type, 'socks5'); assert.equal(full.proxies[0].udp, true);
  const fullPath = path.join(temporary.directory, 'complete.yaml'); await writeFile(fullPath, JSON.stringify(full));
  const check = launch(['-t', '-f', fullPath, '-d', temporary.directory]);
  assert.equal((await once(check, 'close', { signal }))[0], 0, log);
  console.log('PASS: unchanged subscription URL/API and complete profile accepted by Mihomo.');

  const echo = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); socket.pipe(socket);
  });
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => echo.close(resolve)));
  const udpEcho = dgram.createSocket('udp4');
  udpEcho.on('message', (data, info) => udpEcho.send(data, info.port, info.address));
  await new Promise((resolve) => udpEcho.bind(0, '127.0.0.1', resolve)); cleanup.push(() => udpEcho.close());
  const port = await freePort();
  const config = structuredClone(full); config.tun.enable = false; config.dns.enable = false;
  config['mixed-port'] = port; config['find-process-mode'] = 'off'; config.rules = [config.rules.at(-1)];
  const configPath = path.join(temporary.directory, 'loopback.yaml'); await writeFile(configPath, JSON.stringify(config));
  launch(['-f', configPath, '-d', temporary.directory]);
  await until(() => /mixed.*listening/i.test(log), 'Mihomo loopback listener');
  async function checkTcp(hold = false) {
    const connection = await socks(port, 1, '127.0.0.1', echo.address().port);
    const payload = Buffer.alloc(384 * 1024, 0x65); connection.socket.write(payload);
    assert.deepEqual(await connection.reader.read(payload.length), payload);
    if (!hold) connection.socket.destroy(); return connection;
  }
  async function checkUdp() {
    const socket = dgram.createSocket('udp4');
    await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
    let association;
    try {
      association = await socks(port, 3, '0.0.0.0', socket.address().port);
      for (const length of [0, 128, 1200, 8192]) {
        const payload = Buffer.alloc(length, 0x75); const reply = once(socket, 'message', { signal });
        socket.send(Buffer.concat([Buffer.from([0, 0, 0]), encodeSocksAddress('127.0.0.1', udpEcho.address().port), payload]), association.address.port, '127.0.0.1');
        const [packet] = await reply; const address = decodeSocksAddress(packet, 3);
        assert.deepEqual(packet.subarray(3 + address.bytes), payload);
      }
    } finally { association?.socket.destroy(); socket.close(); }
  }
  await checkTcp(); await checkUdp();
  console.log('PASS: real Mihomo -> authenticated Go SOCKS -> native TCP/UDP -> B egress (including fragmented-size UDP payload).');
  await until(async () => (await api('a')).uploadBytes > 0 && (await api('b')).downloadBytes > 0, 'native traffic metrics');
  const isolated = await checkTcp(true);
  await c.join({ invitation: host.invitation });
  await until(async () => (await api('b')).clients.length === 2, 'second paired client');
  await b.networkProxy.flush();
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  c.networkProxy.listenPort = occupied.address().port;
  const controlSession = c.peer.session;
  try {
    await assert.rejects(c.networkProxy.start());
    assert.ok(cNetwork.child && cNetwork.child.exitCode === null, 'known bind rejection must preserve the helper');
    assert.equal(c.peer.session, controlSession);
  } finally { await new Promise((resolve) => occupied.close(resolve)); }
  const keptChild = cNetwork.child;
  await c.networkProxy.start(); assert.equal(cNetwork.child, keptChild);
  console.log('PASS: occupied local SOCKS port revokes only native proxy state and preserves the helper/control session.');
  isolated.socket.write('still-alive'); assert.equal((await isolated.reader.read(11)).toString(), 'still-alive');
  await c.stopPeer();
  await until(async () => (await api('b')).clients.length === 1, 'second client removed');
  await b.networkProxy.flush();
  isolated.socket.write('not-revoked'); assert.equal((await isolated.reader.read(11)).toString(), 'not-revoked');
  isolated.socket.destroy();
  console.log('PASS: adding/removing another paired client preserves the first client\'s existing native flow.');
  const held = await checkTcp(true);
  await api('b', { sharing: false });
  await until(() => held.reader.closed, 'sharing stop closes an existing TCP flow');
  await assert.rejects(checkTcp);
  console.log('PASS: sharing-off acknowledgment revokes active and new native flows.');
  const speedReady = await speedAPI('a');
  assert.equal(speedReady.transport, 'native-tailscale'); assert.equal(speedReady.available, true, JSON.stringify(speedReady));
  const speedJob = await speedAPI('a', { targetId: speedReady.targets[0].id });
  await until(async () => !(await speedAPI('a')).busy, 'native adaptive TCP/UDP speed report', 220000);
  const measured = (await speedAPI('a')).job;
  assert.equal(measured.id, speedJob.id); assert.equal(measured.state, 'completed', JSON.stringify(measured));
  assert.equal(measured.report.v, 6); assert.equal(measured.report.transport, 'native-tailscale');
  assert.equal(measured.report.maximumSeconds, 210);
  assert.equal(measured.report.tcpMulti.mode, 'adaptive');
  assert.deepEqual(measured.report.tcpMulti.connectionCounts, [1, 2, 4, 8, 16]);
  assert.deepEqual(measured.report.tcpMulti.earlyStop, { minimumGainPercent: 5, consecutiveStages: 2 });
  for (const direction of ['download', 'upload']) {
    assert.ok(measured.report[direction].receivedBytes > 0);
    const multi = measured.report.tcpMulti[direction];
    assert.equal(multi.completion, 'complete'); assert.ok(multi.stages.length >= 3 && multi.stages.length <= 5);
    let priorBest = 0, stagnant = 0, plateau = false;
    for (const [index, stage] of multi.stages.entries()) {
      assert.equal(plateau, false, 'No stage may follow the first plateau');
      assert.equal(stage.index, index); assert.equal(stage.connections, [1, 2, 4, 8, 16][index]);
      assert.equal(stage.completion, 'complete'); assert.equal(stage.streams.length, stage.connections);
      assert.ok(stage.receivedBytes > 0 && stage.receivedBytes <= 192 * 1024 * 1024);
      assert.equal(stage.receivedBytes, stage.streams.reduce((sum, stream) => sum + stream.receivedBytes, 0));
      assert.equal(stage.bytesPerSecond, stage.receivedBytes * 1000 / stage.durationMs);
      stagnant = priorBest > 0 && stage.bytesPerSecond * 100 < priorBest * 105 ? stagnant + 1 : 0;
      plateau = stagnant >= 2 && index < 4;
      priorBest = Math.max(priorBest, stage.bytesPerSecond);
      for (const [streamIndex, stream] of stage.streams.entries()) {
        assert.equal(stream.index, streamIndex); assert.equal(stream.completion, 'complete');
        assert.ok(stream.receivedBytes > 0 && stream.durationMs <= stage.durationMs);
      }
    }
    assert.equal(multi.stopReason, plateau ? 'plateau' : 'completed');
    if (!plateau) assert.equal(multi.stages.length, 5);
    assert.equal(multi.totalReceivedBytes, multi.stages.reduce((sum, stage) => sum + stage.receivedBytes, 0));
    assert.ok(multi.totalReceivedBytes <= 960 * 1024 * 1024);
    assert.equal(measured.report[direction].bytesPerSecond, multi.stages[0].bytesPerSecond);
    const tcpBest = multi.stages.reduce((best, stage) => stage.bytesPerSecond > best.bytesPerSecond ? stage : best);
    assert.equal(multi.bestStageIndex, tcpBest.index);
    console.log(`  ${direction}: ${multi.stages.length}/5 TCP stages confirmed; stop=${multi.stopReason}; best ${(tcpBest.bytesPerSecond * 8 / 1e6).toFixed(2)} Mbps at ${tcpBest.connections} connections (isolated loopback only).`);
    const udp = measured.report.udp[direction];
    assert.equal(udp.mode, 'adaptive'); assert.equal(udp.completion, 'complete');
    assert.ok(udp.stages.length >= 1 && udp.stages.length <= 16);
    assert.equal(udp.rateCeilingBytesPerSecond, 125000000);
    assert.ok(udp.totalSentBytes <= 512 * 1024 * 1024);
    const confirmed = udp.stages.filter((stage) => stage.completion === 'complete');
    assert.ok(confirmed.length > 0);
    for (const stage of confirmed) {
      assert.ok(stage.sentPackets >= stage.receivedPackets);
      assert.equal(stage.lostPackets, stage.sentPackets - stage.receivedPackets);
      assert.ok(Number.isFinite(stage.lossPercent) && stage.lossPercent >= 0 && stage.lossPercent <= 100);
      assert.equal(stage.senderBytesPerSecond, stage.sentBytes * 1000 / stage.senderDurationMs);
      assert.equal(stage.bytesPerSecond, stage.receivedBytes * 1000 / stage.durationMs);
      assert.equal(stage.packetBytes, 1100);
    }
    const peak = confirmed.reduce((best, stage) => stage.bytesPerSecond > best.bytesPerSecond ? stage : best);
    assert.equal(udp.peakStageIndex, peak.index);
    const lowLoss = confirmed.filter((stage) => stage.lossPercent <= 1);
    assert.equal(udp.lowLossStageIndex, lowLoss.length ? lowLoss.reduce((best, stage) => stage.bytesPerSecond > best.bytesPerSecond ? stage : best).index : null);
    console.log(`  ${direction}: ${udp.stages.length} UDP stages; stop=${udp.stopReason}; peak=${(peak.bytesPerSecond * 8 / 1e6).toFixed(2)} Mbps, loss=${peak.lossPercent.toFixed(2)}% (isolated loopback only).`);
  }
  await until(async () => !(await speedAPI('b')).busy, 'host retains confirmed native speed report');
  const hostReport = (await speedAPI('b')).job.report;
  assert.deepEqual(hostReport.download, measured.report.download);
  assert.deepEqual(hostReport.upload, measured.report.upload);
  assert.deepEqual(hostReport.tcpMulti, measured.report.tcpMulti);
  assert.deepEqual(hostReport.udp, measured.report.udp);
  assert.equal((await api('b')).sharing, false);
  assert.equal((await api('a')).subscriptionUrl, subscriptionUrl);
  console.log('PASS: real RPC/API speed test completes adaptive TCP (including valid early stops)/UDP with sharing OFF, identical A/B reports and stable subscription.');
  await api('b', { sharing: true });
  await until(async () => (await api('a')).online, 'sharing resumed'); await checkTcp(); await checkUdp();
  assert.equal((await api('a')).subscriptionUrl, subscriptionUrl);
  console.log('PASS: sharing resume preserves subscription and native TCP/UDP forwarding.');
  await until(async () => (await speedAPI('b')).available, 'speed cooldown', 16000);
  const normalFlow = await checkTcp(true), readyAgain = await speedAPI('b');
  const cancelledSpeed = await speedAPI('b', { targetId: readyAgain.targets[0].id });
  await until(async () => {
    // Loopback can finish a 192 MiB stage between the UI's 500 ms samples.
    // Observe the native owner to cancel during an actual concurrent stage.
    const status = await aNetwork.nativeSpeedStatus({ id: cancelledSpeed.id, renew: false }, aNetwork.child).catch(() => null);
    const current = status?.metrics.tcpMulti.download.stages.at(-1);
    return status?.id === cancelledSpeed.id && !status.finished && status.phase === 'tcp-adaptive-download'
      && current?.connections >= 4 && current.completion === 'partial' && current.receivedBytes > 0;
  }, 'current native adaptive TCP stage begins before cancellation', 85000, 5);
  const retainedChild = aNetwork.child;
  await speedAPI('b', { jobId: cancelledSpeed.id }, true);
  await until(async () => !(await speedAPI('a')).busy && !(await speedAPI('b')).busy, 'native speed cancellation closes both owners');
  const cancelledOnA = (await speedAPI('a')).job;
  assert.equal(cancelledOnA.id, cancelledSpeed.id); assert.equal(cancelledOnA.state, 'cancelled');
  assert.notEqual(cancelledOnA.report.tcpMulti.download.bestStageIndex, null, 'Cancellation keeps previously completed TCP stages');
  assert.equal(aNetwork.child, retainedChild);
  normalFlow.socket.write('speed-cancel-keeps-proxy');
  assert.equal((await normalFlow.reader.read(24)).toString(), 'speed-cancel-keeps-proxy');
  normalFlow.socket.destroy(); await checkUdp();
  console.log('PASS: host-initiated cancellation during adaptive TCP preserves prior stages, existing Mihomo TCP/UDP forwarding and the same helper.');
  // Return to this loopback fixture's original offline intent before testing
  // helper replacement; the fixture intentionally has no real tsnet server.
  aNetwork.wantRunning = false; bNetwork.wantRunning = false;
  await a.stopPeer();
  await until(async () => !(await api('a')).online, 'pairing disconnected');
  await assert.rejects(checkTcp);
  await a.join({ invitation: host.invitation });
  await until(async () => (await api('a')).online, 'saved pairing reconnects with fresh native authorization');
  await checkTcp(); await checkUdp();
  assert.equal((await api('a')).subscriptionUrl, subscriptionUrl);
  console.log('PASS: same pairing reconnects with fresh native authorization; subscription stays stable.');
  const oldChild = aNetwork.child;
  const helperClosed = once(oldChild, 'close', { signal });
  // Production control sockets live in this helper and close with it. In this
  // isolated fixture the control plane is loopback, so simulate that close too.
  a.peer.clientConnection.ws.terminate();
  aNetwork.invalidate(oldChild, new Error('isolated helper restart check'), 'test-reset');
  await helperClosed;
  await until(async () => aNetwork.child && aNetwork.child !== oldChild && (await api('a')).online, 'native helper recreated after reset');
  await checkTcp(); await checkUdp();
  assert.equal((await api('a')).subscriptionUrl, subscriptionUrl);
  console.log('PASS: helper restart restores native transport with fresh pairing authorization and unchanged subscription.');
} finally {
  for (const socket of sockets) socket.destroy();
  await Promise.all([...children].map(async (child) => { const done = once(child, 'close').catch(() => {}); child.kill(); await done; }));
  await Promise.allSettled([aApp.close(), bApp.close(), c.disconnect()]);
  await c.networkProxy.close().catch(() => {});
  await Promise.allSettled([aNetwork.close(), bNetwork.close(), cNetwork.close()]);
  for (const stop of cleanup.reverse()) { try { await stop(); } catch {} }
  await writeFile(path.join(root, '.cache/native-mihomo-smoke.log'), log);
  await temporary.cleanup();
}
