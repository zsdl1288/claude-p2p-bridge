import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { NativeSpeedTransport } from '../src/native-speed-transport.js';
import { ChannelSpeed } from '../src/channel-speed.js';
import { EmbeddedNetwork } from '../src/embedded-network.js';
import { Bridge } from '../src/bridge.js';
import { BridgePeer } from '../src/peer.js';
import { makePairing, randomId, SecureChannel } from '../src/crypto.js';
import WebSocket from 'ws';

const transfer = () => ({ receivedBytes: 110000, durationMs: 1000, completion: 'complete', limitReached: false });
const counts = [1, 2, 4, 8, 16];
const tcpStage = (index = 0, changes = {}) => {
  const connections = counts[index];
  return { index, connections, receivedBytes: connections * 100000, durationMs: 2000, bytesPerSecond: 999,
    completion: 'complete', limitReached: false,
    streams: Array.from({ length: connections }, (_, streamIndex) => ({ index: streamIndex, receivedBytes: 100000,
      durationMs: (streamIndex + 1) * 1000 / connections, completion: 'complete', limitReached: false })), ...changes };
};
const multi = (stages = counts.map((_, index) => tcpStage(index)), changes = {}) => {
  let bestStageIndex = null;
  for (const stage of stages) if (stage.completion === 'complete' &&
      (bestStageIndex === null || stage.receivedBytes / stage.durationMs > stages[bestStageIndex].receivedBytes / stages[bestStageIndex].durationMs)) bestStageIndex = stage.index;
  return { completion: stages.length === 5 && stages.every((stage) => stage.completion === 'complete') ? 'complete' : 'partial',
    stages, bestStageIndex, totalReceivedBytes: stages.reduce((sum, stage) => sum + stage.receivedBytes, 0),
    stopReason: stages.length === 5 && stages.every((stage) => stage.completion === 'complete') ? 'completed' : null, ...changes };
};
const tcpPlan = (download = multi(), upload = multi()) => ({ mode: 'adaptive', connectionCounts: [...counts], earlyStop: { minimumGainPercent: 5, consecutiveStages: 2 }, download, upload });
const rateStages = (rates) => rates.map((rate, index) => tcpStage(index, { receivedBytes: rate, durationMs: 1000,
  streams: Array.from({ length: counts[index] }, (_, streamIndex) => ({ index: streamIndex,
    receivedBytes: Math.floor(rate / counts[index]) + (streamIndex < rate % counts[index] ? 1 : 0), durationMs: 1000,
    completion: 'complete', limitReached: false })) }));
const baseline = (stage = tcpStage(0)) => ({ receivedBytes: stage.receivedBytes, durationMs: stage.durationMs,
  bytesPerSecond: 999, completion: stage.completion, limitReached: stage.limitReached });
const udpStage = (changes = {}) => ({ ...transfer(), index: 0, targetBytesPerSecond: 125000, senderDurationMs: 1000,
  senderBytesPerSecond: 999, targetReached: true, assessment: 'loss-limited', sentBytes: 220000, sentPackets: 200,
  receivedPackets: 100, lostPackets: 100, lossPercent: 1, duplicatePackets: 2, outOfOrderPackets: 3,
  offeredBytesPerSecond: 125000, packetBytes: 1100, ...changes });
const udp = (stages = [udpStage()], changes = {}) => {
  let peakStageIndex = null, lowLossStageIndex = null;
  for (const stage of stages) {
    if (stage.completion !== 'complete') continue;
    const rate = stage.receivedBytes / stage.durationMs;
    if (peakStageIndex === null || rate > stages[peakStageIndex].receivedBytes / stages[peakStageIndex].durationMs) peakStageIndex = stage.index;
    if (stage.sentPackets > 0 && (stage.sentPackets - stage.receivedPackets) / stage.sentPackets <= 0.01 &&
        (lowLossStageIndex === null || rate > stages[lowLossStageIndex].receivedBytes / stages[lowLossStageIndex].durationMs)) lowLossStageIndex = stage.index;
  }
  return { mode: 'adaptive', completion: peakStageIndex === null ? 'partial' : 'complete', stages, lowLossStageIndex, peakStageIndex,
    stopReason: peakStageIndex === null ? null : 'loss-limited', lowerBound: false,
    totalSentBytes: stages.reduce((sum, stage) => sum + (stage.sentBytes ?? 0), 0),
    totalReceivedBytes: stages.reduce((sum, stage) => sum + stage.receivedBytes, 0),
    rateCeilingBytesPerSecond: 125000000, lossThresholdPercent: 1, minimumSenderRatio: 0.85, ...changes };
};
const metrics = () => ({ completed: true, latency: { samples: [10, 20], failedSamples: 0 }, download: baseline(), upload: baseline(),
  tcpMulti: tcpPlan(), udp: { download: udp(), upload: udp() }, stopReason: null, ticket: 'secret-ticket' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function fixture(role = 'client', changes = {}) {
  const calls = [], sent = [], child = { stdin: { writable: true } };
  const connection = { id: 'target', authenticated: true, session: randomId(32), capabilities: { nativeSpeed: 5, speedTest: 2 }, device: { address: '100.80.1.2' } };
  const peer = { role, pairing: { host: '100.90.1.2' }, connections: new Set([connection]), dialResource: {},
    clientConnection: role === 'client' ? connection : null, isConnected(c) { return this.connections.has(c); },
    trySendSpeedMessage(message, target) { sent.push({ message, target }); return true; } };
  const value = (id, finished = false) => ({ protocolVersion: 5, id, finished, port: 38181, phase: finished ? 'completed' : 'waiting', metrics: finished ? metrics() : { completed: false } });
  const adapter = { embedded: true, child, initialized: new WeakSet([child]), wantRunning: true,
    start() { throw Error('must never start'); },
    async nativeSpeedPrepare(params, owner) { calls.push({ method: 'prepare', params, owner }); return value(params.id); },
    async nativeSpeedStart(params, owner) { calls.push({ method: 'start', params, owner }); return value(params.id); },
    async nativeSpeedStatus(params, owner) { calls.push({ method: 'status', params, owner }); return value(params.id, true); },
    async nativeSpeedCancel(params, owner) { calls.push({ method: 'cancel', params, owner }); return value(params.id, true); }, ...changes };
  const bridge = Object.assign(new EventEmitter(), { peer, networkAdapter: adapter, intentOnline: true, pending: new Map(), active: new Map(), queue: [],
    channelRecovery: {}, networkProxy: { sharing: false, enabled: false } });
  const transport = new NativeSpeedTransport({ bridge, sleep: async () => {} });
  const controller = new ChannelSpeed({ bridge, transport });
  const offer = (id, extra = {}) => ({ type: 'speed-offer', v: 6, id, session: connection.session, ticket: randomId(32), port: 38181, ...extra });
  const start = () => controller.start({ targetId: connection.id });
  return { calls, sent, child, connection, peer, adapter, bridge, transport, controller, offer, start, value };
}

test('native speed negotiates v6 and uses paired B through native RPC with sharing off', async () => {
  const f = fixture(); const job = f.start();
  assert.equal(f.sent[0].message.v, 6); assert.equal(f.calls.length, 0);
  f.controller.onMessage(f.offer(job.id, { host: '8.8.8.8' }), f.connection);
  await f.controller.running;
  assert.deepEqual(f.calls.map((call) => call.method), ['start', 'status', 'cancel']);
  assert.equal(f.calls[0].params.host, f.peer.pairing.host); assert.equal(f.calls[0].params.session, f.connection.session);
  assert.equal(f.calls[0].params.protocolVersion, 5);
  assert.equal(f.calls[1].params.renew, true); assert.equal(f.calls[0].owner, f.child);
  assert.ok(f.calls[2].params.epoch > f.calls[0].params.epoch);
  const state = f.controller.status(), { report } = state.job;
  assert.equal(state.transport, 'native-tailscale'); assert.equal(report.v, 6); assert.equal(report.completed, true);
  assert.equal(report.tcpMaxBytesPerDirection, 192 * 1024 * 1024); assert.equal(report.udpMaxBytesPerDirection, 512 * 1024 * 1024);
  assert.equal(report.tcpSecondsPerDirection, 10); assert.equal(report.udpSecondsPerDirection, 30);
  assert.equal(report.tcpMultiMaxBytesPerDirection, 960 * 1024 * 1024); assert.equal(report.tcpMultiSecondsPerDirection, 50);
  assert.equal(report.tcpStageMaxBytes, 192 * 1024 * 1024); assert.equal(report.tcpStageSeconds, 10);
  assert.deepEqual(report.tcpMulti.connectionCounts, counts); assert.equal(report.tcpMulti.download.bestStageIndex, 4);
  assert.deepEqual(report.tcpMulti.earlyStop, { minimumGainPercent: 5, consecutiveStages: 2 });
  assert.equal(Object.hasOwn(report.tcpMulti.download.stages[0].streams[0], 'bytesPerSecond'), false);
  assert.equal(report.udpBudgetIsSoft, true);
  assert.equal(report.maximumSeconds, 210); assert.equal(report.maxBytesPerDirection, 1472 * 1024 * 1024);
  assert.equal(report.udp.download.stages[0].bytesPerSecond, 110000); assert.equal(report.udp.download.stages[0].lossPercent, 50);
  assert.equal(report.latency.medianMs, 15); assert.equal(JSON.stringify(report).includes('secret-ticket'), false);
  assert.equal(f.bridge.networkProxy.enabled, false); assert.equal(f.bridge.networkProxy.sharing, false);
});

test('native mode never falls back to websocket capability and validates endpoint before starting', async () => {
  const f = fixture(); delete f.connection.capabilities.nativeSpeed;
  assert.equal(f.controller.status().reason, 'unsupported'); assert.throws(f.start, { code: 'speed-unsupported' });
  f.connection.capabilities.nativeSpeed = 1;
  assert.equal(f.controller.status().reason, 'unsupported'); assert.throws(f.start, { code: 'speed-unsupported' });
  f.connection.capabilities.nativeSpeed = 2;
  assert.equal(f.controller.status().reason, 'unsupported'); assert.throws(f.start, { code: 'speed-unsupported' });
  f.connection.capabilities.nativeSpeed = 3;
  assert.equal(f.controller.status().reason, 'unsupported'); assert.throws(f.start, { code: 'speed-unsupported' });
  f.connection.capabilities.nativeSpeed = 4;
  assert.equal(f.controller.status().reason, 'unsupported'); assert.throws(f.start, { code: 'speed-unsupported' });
  f.connection.capabilities.nativeSpeed = 5; const job = f.start();
  for (const extra of [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }, { port: 0 }, { port: 65536 }, { port: '1234' }, { session: 'old' }]) f.controller.onMessage(f.offer(job.id, extra), f.connection);
  assert.equal(f.calls.length, 0); f.controller.cancel(); await f.controller.running;
  const native = new Bridge({ networkAdapter: { embedded: true } });
  assert.equal(native.speedTransport.native, true); native.networkProxy.close();
});

test('TCP connection stages use separate common windows and derive the single-connection baseline', async () => {
  const pending = deferred(), f = fixture(); let polls = 0;
  f.adapter.nativeSpeedStatus = async ({ id }) => ++polls === 1 ? { ...f.value(id), phase: 'tcp-adaptive-download', metrics: metrics() } : pending.promise;
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await flush();
  const { progress, report } = f.controller.status().job;
  assert.equal(progress.phase, 'multi-download'); assert.equal(progress.protocol, 'tcp'); assert.equal(progress.durationMs, 10000);
  assert.equal(progress.maxBytes, 192 * 1024 * 1024); assert.equal(progress.bytes, 1600000); assert.equal(progress.bytesPerSecond, 800000);
  assert.equal(progress.stageIndex, 4); assert.equal(progress.connections, 16); assert.equal(progress.stageCount, 5);
  assert.equal(report.download.bytesPerSecond, 50000); assert.equal(report.tcpMulti.download.stages[0].bytesPerSecond, 50000);
  assert.equal(report.tcpMulti.download.bestStageIndex, 4);
  const stage = tcpStage(4), sumOfStreamRates = stage.streams.reduce((sum, stream) => sum + stream.receivedBytes * 1000 / stream.durationMs, 0);
  assert.notEqual(report.tcpMulti.download.stages[4].bytesPerSecond, sumOfStreamRates);
  pending.resolve(f.value(job.id, true)); await f.controller.running;
  assert.equal(f.controller.status().job.report.completed, true);
});

test('TCP stage validation rejects false counts, totals, windows, maxima and premature completion', async () => {
  const bad = [multi([tcpStage(0)], { completion: 'complete', stopReason: 'completed' })];
  let value = multi(); value.stages[2].streams.pop(); bad.push(value);
  value = multi(); value.stages[2].streams[3].index = 2; bad.push(value);
  value = multi(); value.stages[2].receivedBytes++; bad.push(value);
  value = multi(); value.stages[2].durationMs = 999; bad.push(value);
  value = multi(); value.stages[2].connections = 8; bad.push(value);
  value = multi(); value.stages[2].index = 3; bad.push(value);
  value = multi(); value.stages[2].streams[3].completion = 'partial'; bad.push(value);
  value = multi(); value.bestStageIndex = 0; bad.push(value);
  value = multi(); value.totalReceivedBytes++; bad.push(value);
  value = multi(); value.stages[2].receivedBytes = 192 * 1024 * 1024 + 1;
  value.stages[2].streams[0].receivedBytes = value.stages[2].receivedBytes - 300000; bad.push(value);
  value = multi(); value.stages.pop(); bad.push(value);
  value = multi(); value.stages[1].completion = 'partial'; value.completion = 'partial'; value.stopReason = 'failed'; bad.push(value);
  for (const download of bad) {
    const f = fixture(); f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(), tcpMulti: tcpPlan(download) } });
    const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
    assert.equal(f.controller.status().job.report.completed, false); assert.equal(f.controller.status().job.report.tcpMulti.download, null);
  }
  for (const tcpMulti of [undefined, { ...tcpPlan(), connectionCounts: [1, 2, 4, 8] }, tcpPlan(multi(), null)]) {
    const f = fixture(); f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(), tcpMulti } });
    const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
    assert.equal(f.controller.status().job.report.completed, false);
  }
});

test('TCP best stage uses actual speed, retains all five attempts and chooses fewer connections on ties', async () => {
  for (const [durations, expectedBest] of [[[2000, 2000, 2000, 10000, 10000], 2], [[1000, 1000, 1000, 2000, 4000], 2]]) {
    const stages = counts.map((_, index) => tcpStage(index, { durationMs: durations[index] }));
    const f = fixture(); f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(),
      download: baseline(stages[0]), tcpMulti: tcpPlan(multi(stages)) } });
    const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
    const report = f.controller.status().job.report;
    assert.equal(report.completed, true); assert.equal(report.tcpMulti.download.stages.length, 5);
    assert.equal(report.tcpMulti.download.bestStageIndex, expectedBest);
    assert.equal(report.tcpMulti.download.stages[expectedBest].connections, counts[expectedBest]);
    assert.equal(report.download.bytesPerSecond, report.tcpMulti.download.stages[0].bytesPerSecond);
  }
});

test('TCP plateau completes a confirmed prefix and keeps small improvements in the actual best result', async () => {
  for (const [rates, best] of [[[100000, 104000, 108000], 2], [[100000, 100000, 90000], 0],
    [[100000, 105000, 108000, 108000], 2], [[0, 100000, 100000, 100000], 1]]) {
    const stages = rateStages(rates), download = multi(stages, { completion: 'complete', stopReason: 'plateau' });
    const f = fixture(); f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(),
      download: baseline(stages[0]), tcpMulti: tcpPlan(download) } });
    const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
    const report = f.controller.status().job.report;
    assert.equal(report.completed, true, JSON.stringify(rates)); assert.equal(report.tcpMulti.download.stopReason, 'plateau');
    assert.equal(report.tcpMulti.download.stages.length, rates.length); assert.equal(report.tcpMulti.download.bestStageIndex, best);
    assert.equal(report.tcpMulti.download.stages[best].bytesPerSecond, rates[best]);
  }
});

test('TCP gains of exactly five percent reset plateau history and five stages take completed precedence', async () => {
  for (const rates of [[100000, 104000, 109200, 110000, 110000], [0, 0, 0, 0, 0]]) {
    const stages = rateStages(rates), f = fixture();
    f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(),
      download: baseline(stages[0]), tcpMulti: tcpPlan(multi(stages)) } });
    const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
    assert.equal(f.controller.status().job.report.completed, true, JSON.stringify(rates));
    assert.equal(f.controller.status().job.report.tcpMulti.download.stopReason, 'completed');
  }
});

test('TCP rejects forged plateaus, continuation after the first trigger and changed early-stop rules', async () => {
  const cases = [
    multi(rateStages([100000, 100000]), { completion: 'complete', stopReason: 'plateau' }),
    multi(rateStages([100000, 105000, 110250]), { completion: 'complete', stopReason: 'plateau' }),
    multi(rateStages([0, 0, 0]), { completion: 'complete', stopReason: 'plateau' }),
    multi(rateStages([100000, 104000, 108000, 200000]), { completion: 'complete', stopReason: 'plateau' }),
    multi(rateStages([100000, 104000, 108000, 200000, 400000])),
    multi(rateStages([100000, 110000, 120000, 120000, 120000]), { completion: 'complete', stopReason: 'plateau' }),
  ];
  const incomplete = rateStages([100000, 104000, 108000]); incomplete[2].completion = 'partial';
  incomplete[2].streams.forEach((stream) => { stream.completion = 'partial'; });
  cases.push(multi(incomplete, { completion: 'complete', stopReason: 'plateau' }));
  for (const download of cases) {
    const f = fixture(); f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(),
      download: baseline(download.stages[0]), tcpMulti: tcpPlan(download) } });
    const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
    assert.equal(f.controller.status().job.report.completed, false); assert.equal(f.controller.status().job.report.tcpMulti.download, null);
  }
  for (const earlyStop of [undefined, { minimumGainPercent: 10, consecutiveStages: 2 }, { minimumGainPercent: 5, consecutiveStages: 3 }]) {
    const f = fixture(); f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(), tcpMulti: { ...tcpPlan(), earlyStop } } });
    const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
    assert.equal(f.controller.status().job.report.completed, false);
  }
});

test('TCP partial or cancelled results never become plateau completions just because a prefix looks flat', async () => {
  const stages = rateStages([100000, 104000, 108000]); stages[2].completion = 'partial';
  stages[2].streams.forEach((stream) => { stream.completion = 'partial'; });
  const f = fixture(); f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(), completed: false,
    stopReason: 'user-cancelled', download: baseline(stages[0]), tcpMulti: tcpPlan(multi(stages, { stopReason: 'cancelled' })) } });
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
  const report = f.controller.status().job.report;
  assert.equal(report.completed, false); assert.equal(report.tcpMulti.download.completion, 'partial');
  assert.equal(report.tcpMulti.download.stopReason, 'cancelled'); assert.equal(report.tcpMulti.download.bestStageIndex, 1);
});

test('TCP progress restarts the current-stage clock when connections increase', async () => {
  const f = fixture(), first = deferred(), second = deferred(), third = deferred(), last = deferred(), replies = [first, second, third, last];
  let now = 100; f.transport.now = () => now; f.adapter.nativeSpeedStatus = () => replies.shift().promise;
  const empty = (index) => tcpStage(index, { receivedBytes: 0, durationMs: 0, completion: 'partial',
    streams: Array.from({ length: counts[index] }, (_, streamIndex) => ({ index: streamIndex, receivedBytes: 0, durationMs: 0, completion: 'partial', limitReached: false })) });
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await flush();
  first.resolve({ ...f.value(job.id), phase: 'tcp-adaptive-download', metrics: { completed: false,
    download: baseline(empty(0)), tcpMulti: tcpPlan(multi([empty(0)]), null) } }); await flush();
  now = 3100;
  const advanced = { ...f.value(job.id), phase: 'tcp-adaptive-download', metrics: { completed: false,
    download: baseline(), tcpMulti: tcpPlan(multi([tcpStage(0), empty(1)]), null) } };
  second.resolve(advanced); await flush();
  assert.equal(f.controller.status().job.progress.stageIndex, 1); assert.equal(f.controller.status().job.progress.connections, 2);
  assert.equal(f.controller.status().job.progress.elapsedMs, 0);
  now += 1000; third.resolve(advanced); await flush();
  assert.equal(f.controller.status().job.progress.elapsedMs, 1000); assert.equal(f.controller.status().job.progress.durationMs, 10000);
  assert.equal(f.controller.status().job.report.tcpMulti.download.bestStageIndex, 0);
  f.controller.cancel(); last.resolve(f.value(job.id)); await f.controller.running;
});

test('earlier complete progress cannot conceal malformed final stages or an inconsistent baseline', async () => {
  for (const corrupt of [{ tcpMulti: undefined }, { tcpMulti: { ...tcpPlan(), connectionCounts: [1, 4, 16] } },
    { download: { ...baseline(), receivedBytes: 999 } }]) {
    const f = fixture();
    f.transport.client = async ({ onProgress }) => {
      onProgress({ ...metrics(), phase: 'multi-upload', protocol: 'tcp' });
      return { ...metrics(), ...corrupt };
    };
    const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
    const report = f.controller.status().job.report;
    assert.equal(report.tcpMulti.download.stages[0].receivedBytes, 100000);
    assert.equal(report.download.receivedBytes, 100000, 'The public baseline is always derived from stage zero');
    assert.equal(report.completed, false); assert.equal(report.stopReason, 'transport-failed');
  }
});

test('TCP placeholders remain unknown and cancelled faster partial stages never replace the best complete stage', async () => {
  const pending = deferred(), f = fixture(); let polls = 0;
  const empty = tcpStage(1, { receivedBytes: 0, durationMs: 0, completion: 'partial',
    streams: Array.from({ length: 2 }, (_, index) => ({ index, receivedBytes: 0, durationMs: 0, completion: 'partial', limitReached: false })) });
  f.adapter.nativeSpeedStatus = async ({ id }) => ++polls === 1 ? { ...f.value(id), phase: 'tcp-adaptive-upload', metrics: { completed: false,
    download: baseline(), upload: baseline(), tcpMulti: tcpPlan(multi(), multi([tcpStage(0), empty])) } } : pending.promise;
  const partial = tcpStage(1, { completion: 'partial', receivedBytes: 2000000,
    streams: Array.from({ length: 2 }, (_, index) => ({ index, receivedBytes: 1000000, durationMs: 1500, completion: 'partial', limitReached: false })) });
  partial.streams[0].ticket = 'private-stream-ticket';
  f.adapter.nativeSpeedCancel = async ({ id }) => ({ ...f.value(id, true), metrics: { completed: false,
    download: baseline(), upload: baseline(), tcpMulti: tcpPlan(multi(), multi([tcpStage(0), partial], { stopReason: 'cancelled' })) } });
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await flush();
  assert.equal(f.controller.status().job.progress.phase, 'multi-upload'); assert.equal(f.controller.status().job.progress.connections, 2);
  assert.equal(Object.hasOwn(f.controller.status().job.progress, 'bytesPerSecond'), false);
  assert.equal(f.controller.status().job.report.tcpMulti.upload.stages[1].bytesPerSecond, null);
  f.controller.cancel(); pending.resolve(f.value(job.id)); await f.controller.running;
  const report = f.controller.status().job.report;
  assert.equal(report.tcpMulti.upload.completion, 'partial'); assert.equal(report.tcpMulti.upload.stages[1].receivedBytes, 2000000);
  assert.equal(report.tcpMulti.upload.stages[1].bytesPerSecond, 1000000); assert.equal(report.tcpMulti.upload.bestStageIndex, 0);
  assert.equal(report.completed, false); assert.equal(JSON.stringify(report).includes('private-stream-ticket'), false);
});

test('host waits for actual native reservation, binds authenticated A address, and offers no host', async () => {
  const prepared = deferred(), f = fixture('host');
  f.adapter.nativeSpeedPrepare = (params, owner) => { f.calls.push({ method: 'prepare', params, owner }); return prepared.promise; };
  const job = f.start(); await flush(); assert.equal(f.sent.length, 0);
  assert.equal(f.calls[0].params.peerIP, f.connection.device.address);
  prepared.resolve(f.value(job.id)); await f.controller.running;
  const offer = f.sent.find((entry) => entry.message.type === 'speed-offer').message;
  assert.deepEqual(Object.keys(offer).sort(), ['id', 'port', 'session', 'ticket', 'type', 'v']); assert.equal(offer.port, 38181);
});

test('cancel during prepare retains busy until receipt and blocks a late offer or reservation revival', async () => {
  const prepared = deferred(), cancelled = deferred(), f = fixture('host');
  f.adapter.nativeSpeedPrepare = (params) => { f.calls.push({ method: 'prepare', params }); return prepared.promise; };
  f.adapter.nativeSpeedCancel = (params) => { f.calls.push({ method: 'cancel', params }); return cancelled.promise; };
  const job = f.start(); f.controller.cancel();
  assert.equal(f.controller.status().busy, true); assert.ok(f.calls[1].params.epoch > f.calls[0].params.epoch);
  prepared.resolve(f.value(job.id)); await flush(); assert.equal(f.controller.status().busy, true);
  cancelled.resolve(f.value(job.id, true)); await f.controller.running;
  assert.equal(f.controller.status().job.state, 'cancelled'); assert.equal(f.sent.some(({ message }) => message.type === 'speed-offer'), false);
  assert.equal(f.calls.some(({ method }) => method === 'status'), false);
});

test('session replacement cancels only benchmark and never renews a late status reply', async () => {
  const pending = deferred(), f = fixture();
  f.adapter.nativeSpeedStatus = (params) => { f.calls.push({ method: 'status', params }); return pending.promise; };
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await flush();
  assert.equal(f.calls.filter(({ method }) => method === 'status').length, 1);
  f.connection.session = 'replaced'; f.bridge.emit('state'); pending.resolve(f.value(job.id)); await f.controller.running;
  assert.equal(f.controller.status().job.report.stopReason, 'target-changed');
  assert.equal(f.calls.filter(({ method }) => method === 'status').length, 1);
  assert.equal(f.adapter.child, f.child); assert.equal(f.peer.isConnected(f.connection), true);
});

test('native progress separates phase duration from measured elapsed time and preserves final partial bytes', async () => {
  const pending = deferred(), f = fixture(); let polls = 0;
  f.adapter.nativeSpeedStatus = async ({ id }) => {
    if (++polls > 1) return pending.promise;
    return { ...f.value(id), phase: 'udp-download', metrics: { ...metrics(), completed: false,
      udp: { download: udp([udpStage({ durationMs: 2345, completion: 'partial', assessment: 'incomplete', lostPackets: null, lossPercent: null })]), upload: null } } };
  };
  f.adapter.nativeSpeedCancel = async ({ id }) => ({ ...f.value(id, true), metrics: { completed: false,
    udp: { download: udp([udpStage({ receivedPackets: 150, receivedBytes: 165000, completion: 'partial', assessment: 'incomplete', lostPackets: null, lossPercent: null })]) } } });
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await flush();
  const { progress } = f.controller.status().job;
  assert.equal(progress.phase, 'udp-download'); assert.equal(progress.stageElapsedMs, 2345); assert.equal(progress.durationMs, 30000);
  assert.equal(progress.stageIndex, 0); assert.equal(progress.targetBytesPerSecond, 125000);
  assert.equal(progress.maxBytes, 512 * 1024 * 1024); assert.equal(progress.protocol, 'udp');
  f.controller.cancel(); pending.resolve(f.value(job.id)); await f.controller.running;
  const report = f.controller.status().job.report;
  assert.equal(report.udp.download.totalReceivedBytes, 165000); assert.equal(report.udp.download.stages[0].bytesPerSecond, 165000);
  assert.equal(report.udp.download.stages[0].lossPercent, null); assert.equal(report.completed, false);
});

test('sending-side progress uses elapsed time while unconfirmed receive throughput remains unknown', async () => {
  const f = fixture(), first = deferred(), second = deferred(), last = deferred(), replies = [first, second, last];
  let now = 100;
  f.transport.now = () => now;
  f.adapter.nativeSpeedStatus = () => replies.shift().promise;
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await flush();
  const empty = tcpStage(0, { receivedBytes: 0, durationMs: 0, completion: 'partial',
    streams: [{ index: 0, receivedBytes: 0, durationMs: 0, completion: 'partial', limitReached: false }] });
  const unconfirmed = { ...f.value(job.id), phase: 'tcp-adaptive-upload', metrics: { completed: false,
    upload: baseline(empty), tcpMulti: tcpPlan(null, multi([empty])) } };
  first.resolve(unconfirmed); await flush();
  assert.equal(f.controller.status().job.progress.elapsedMs, 0);
  now += 2500; second.resolve(unconfirmed); await flush();
  const { progress, report } = f.controller.status().job;
  assert.equal(progress.phase, 'multi-upload'); assert.equal(progress.elapsedMs, 2500); assert.equal(progress.durationMs, 10000);
  assert.equal(progress.maxBytes, 192 * 1024 * 1024);
  assert.equal(Object.hasOwn(progress, 'bytes'), false); assert.equal(Object.hasOwn(progress, 'bytesPerSecond'), false);
  assert.equal(report.upload.bytesPerSecond, null, 'UI phase time must never fabricate receiver measurements');
  f.controller.cancel(); last.resolve(f.value(job.id)); await f.controller.running;
});

test('an unconfirmed cancel stops renewals and waits the lease without killing business transports', async () => {
  const f = fixture('host'), lease = deferred(); const sleeps = [];
  f.transport.sleep = (ms) => { sleeps.push(ms); return lease.promise; };
  f.adapter.nativeSpeedCancel = async () => { throw Error('cancel-timeout'); };
  const job = f.start(); await flush(); f.controller.cancel(); await flush();
  assert.equal(f.controller.status().busy, true); assert.ok(sleeps.includes(5000));
  lease.resolve(); await f.controller.running;
  assert.equal(f.controller.status().job.report.stopReason, 'user-cancelled');
  assert.equal(f.calls.some(({ method }) => method === 'status'), false); assert.equal(f.adapter.child, f.child);
  assert.equal(job.report.completed, false);
});

test('native reports reject inconsistent or missing UDP counters instead of claiming success', async () => {
  for (const broken of [{ receivedPackets: 201 }, { receivedBytes: 1 }, { lostPackets: 99 }, { packetBytes: 1200 }, { offeredBytesPerSecond: 1 }, { lostPackets: null, lossPercent: null }]) {
    const f = fixture(); f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(), udp: { download: udp([udpStage(broken)]), upload: udp() } } });
    const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
    assert.equal(f.controller.status().job.report.completed, false); assert.equal(f.controller.status().job.report.udp.download, null);
  }
  const f = fixture(); f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(), completed: false,
    udp: { download: udp([udpStage({ completion: 'partial', assessment: 'incomplete', targetReached: false,
      sentBytes: null, sentPackets: null, senderDurationMs: null, senderBytesPerSecond: null, lostPackets: null, lossPercent: null })]), upload: null } } });
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
  assert.equal(f.controller.status().job.report.udp.download.totalReceivedBytes, 110000);
  assert.equal(f.controller.status().job.report.udp.download.stages[0].sentPackets, null);
  assert.equal(f.controller.status().job.report.udp.download.stages[0].lossPercent, null); assert.equal(f.controller.status().job.report.udp.upload, null);
});

test('malformed native status fails the test even when cleanup receipt describes a user cancellation', async () => {
  const f = fixture(); f.adapter.nativeSpeedStatus = async () => ({ protocolVersion: 5, id: 'foreign', finished: true });
  f.adapter.nativeSpeedCancel = async ({ id }) => ({ ...f.value(id, true), metrics: { completed: false, stopReason: 'user-cancelled' } });
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
  assert.equal(f.controller.status().job.state, 'failed');
  assert.equal(f.controller.status().job.report.stopReason, 'transport-failed');
});

test('an older native helper is cancelled and reported unsupported without running the old protocol', async () => {
  const f = fixture(); f.adapter.nativeSpeedStart = async ({ id }) => ({ ...f.value(id), protocolVersion: undefined });
  f.adapter.nativeSpeedCancel = async ({ id }) => ({ id, finished: true, metrics: metrics() });
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
  const report = f.controller.status().job.report;
  assert.equal(report.stopReason, 'unsupported'); assert.equal(report.completed, false); assert.equal(report.download, null);
  assert.equal(report.udp.download, null); assert.equal(f.calls.some(({ method }) => method === 'status'), false);
});

test('adaptive reports select low-loss and peak stages from consistent measured goodput', async () => {
  const stages = [udpStage({ receivedPackets: 200, receivedBytes: 220000, lostPackets: 0, lossPercent: 0, assessment: 'passed' }),
    udpStage({ index: 1, targetBytesPerSecond: 1250000, offeredBytesPerSecond: 1250000, sentPackets: 2000, sentBytes: 2200000,
      receivedPackets: 1500, receivedBytes: 1650000, lostPackets: 500, lossPercent: 25 })];
  const f = fixture(); f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(), udp: { download: udp(stages), upload: udp() } } });
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
  const report = f.controller.status().job.report.udp.download;
  assert.equal(report.lowLossStageIndex, 0); assert.equal(report.peakStageIndex, 1);
  assert.equal(report.stages[0].senderBytesPerSecond, 220000); assert.equal(report.stages[1].senderBytesPerSecond, 2200000);
  assert.equal(report.stages[1].bytesPerSecond, 1650000); assert.equal(report.stages[1].lossPercent, 25);
  assert.equal(Object.hasOwn(report, 'bytesPerSecond'), false, 'An adaptive direction has no misleading aggregate bandwidth');
});

test('weak paths may refine the initial one-Mbps stage down to quarter-Mbps', async () => {
  const stages = [udpStage(), udpStage({ index: 1, targetBytesPerSecond: 62500, offeredBytesPerSecond: 62500 }),
    udpStage({ index: 2, targetBytesPerSecond: 31250, offeredBytesPerSecond: 31250, receivedPackets: 200, receivedBytes: 220000,
      lostPackets: 0, lossPercent: 0, assessment: 'passed' })];
  const f = fixture(); f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(), udp: { download: udp(stages), upload: udp() } } });
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
  assert.equal(f.controller.status().job.report.completed, true);
  assert.equal(f.controller.status().job.report.udp.download.lowLossStageIndex, 2);
  assert.equal(f.controller.status().job.report.udp.download.stages[2].targetBytesPerSecond, 31250);
});

test('adaptive stage progress does not reset direction time or invent throughput for new stages', async () => {
  const f = fixture(), first = deferred(), second = deferred(), third = deferred(), last = deferred(), replies = [first, second, third, last];
  let now = 100;
  f.transport.now = () => now; f.adapter.nativeSpeedStatus = () => replies.shift().promise;
  const pendingStage = (index) => udpStage({ index, receivedBytes: 0, receivedPackets: 0, durationMs: 0, completion: 'partial',
    sentBytes: null, sentPackets: null, senderDurationMs: null, senderBytesPerSecond: null, lostPackets: null, lossPercent: null,
    duplicatePackets: 0, outOfOrderPackets: 0, targetReached: false, assessment: 'incomplete' });
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await flush();
  first.resolve({ ...f.value(job.id), phase: 'udp-upload', metrics: { completed: false, udp: { upload: udp([pendingStage(0)]) } } }); await flush();
  assert.equal(f.controller.status().job.report.udp.upload.stages[0].bytesPerSecond, null);
  now = 2100;
  const advanced = { ...f.value(job.id), phase: 'udp-upload', metrics: { completed: false,
    udp: { upload: udp([udpStage(), pendingStage(1)], { completion: 'partial', stopReason: null }) } } };
  second.resolve(advanced); await flush();
  assert.equal(f.controller.status().job.progress.elapsedMs, 2000); assert.equal(f.controller.status().job.progress.stageElapsedMs, 0);
  now = 3100; third.resolve(advanced); await flush();
  const progress = f.controller.status().job.progress;
  assert.equal(progress.stageIndex, 1); assert.equal(progress.stageCount, 2); assert.equal(progress.elapsedMs, 3000); assert.equal(progress.stageElapsedMs, 1000);
  assert.equal(Object.hasOwn(progress, 'bytesPerSecond'), false); assert.equal(Object.hasOwn(progress, 'senderBytesPerSecond'), false);
  f.controller.cancel(); last.resolve(f.value(job.id)); await f.controller.running;
});

test('cancelled adaptive reports retain measured stages but exclude faster unconfirmed stages from summaries', async () => {
  const stages = [udpStage({ receivedPackets: 200, receivedBytes: 220000, lostPackets: 0, lossPercent: 0, assessment: 'passed' }),
    udpStage({ index: 1, targetBytesPerSecond: 1250000, offeredBytesPerSecond: 1250000, receivedBytes: 1100000, receivedPackets: 1000,
      completion: 'partial', assessment: 'incomplete', targetReached: false, sentBytes: null, sentPackets: null,
      senderDurationMs: null, senderBytesPerSecond: null, lostPackets: null, lossPercent: null })];
  const f = fixture(); f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(), completed: false, stopReason: 'user-cancelled',
    udp: { download: udp(stages, { completion: 'partial', stopReason: 'cancelled' }), upload: null } } });
  const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
  const report = f.controller.status().job.report.udp.download;
  assert.equal(report.lowLossStageIndex, 0); assert.equal(report.peakStageIndex, 0);
  assert.equal(report.stages[1].bytesPerSecond, 1100000); assert.equal(report.stages[1].lossPercent, null);
  assert.equal(report.totalSentBytes, 220000); assert.equal(report.totalReceivedBytes, 1320000);
});

test('the adaptive native watchdog permits 210 seconds without changing legacy limits', async () => {
  const f = fixture(); let budget, deadline;
  f.controller.setTimeoutFn = (fn, ms) => { deadline = fn; budget = ms; return { unref() {} }; };
  f.controller.clearTimeoutFn = () => {};
  f.start(); assert.equal(budget, 210000); deadline(); await f.controller.running;
  assert.equal(f.controller.status().job.report.stopReason, 'deadline'); assert.equal(f.calls.length, 0);
});

test('normal adaptive budget and ceiling stops remain successful measured lower bounds', async () => {
  for (const stopReason of ['rate-ceiling', 'byte-budget', 'time-budget', 'sender-limited']) {
    const stage = stopReason === 'rate-ceiling' ? udpStage({ targetBytesPerSecond: 125000000, offeredBytesPerSecond: 125000000,
      sentPackets: 100000, sentBytes: 110000000, receivedPackets: 100000, receivedBytes: 110000000,
      lostPackets: 0, lossPercent: 0, assessment: 'passed' }) : stopReason === 'sender-limited' ?
      udpStage({ targetBytesPerSecond: 1250000, offeredBytesPerSecond: 1250000, targetReached: false, assessment: 'sender-limited' }) : udpStage();
    const f = fixture(); f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(),
      udp: { download: udp([stage], { stopReason, lowerBound: true }), upload: udp() } } });
    const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
    assert.equal(f.controller.status().job.report.completed, true, stopReason);
    assert.equal(f.controller.status().job.report.udp.download.lowerBound, true);
  }
});

test('adaptive summaries reject fabricated indices, totals, thresholds and stage assessments', async () => {
  const cases = [udp(undefined, { lowLossStageIndex: 0 }), udp(undefined, { peakStageIndex: null }),
    udp(undefined, { totalSentBytes: 0 }), udp(undefined, { totalReceivedBytes: 0 }), udp(undefined, { minimumSenderRatio: 0.1 }),
    udp(undefined, { stopReason: 'sender-limited', lowerBound: true }), udp(undefined, { stopReason: 'rate-ceiling', lowerBound: true }),
    udp(undefined, { lowerBound: true }), udp([udpStage({ assessment: 'passed' })]),
    udp([udpStage({ targetReached: false })]), udp([udpStage({ index: 1 })]),
    udp(Array.from({ length: 17 }, (_, index) => udpStage({ index })))];
  for (const download of cases) {
    const f = fixture(); f.adapter.nativeSpeedStatus = async ({ id }) => ({ ...f.value(id, true), metrics: { ...metrics(), udp: { download, upload: udp() } } });
    const job = f.start(); f.controller.onMessage(f.offer(job.id), f.connection); await f.controller.running;
    assert.equal(f.controller.status().job.report.completed, false); assert.equal(f.controller.status().job.report.udp.download, null);
  }
});

test('native speed RPCs never launch helpers, reject replacement owners, and time out without retirement', async () => {
  const adapter = new EmbeddedNetwork({ requestTimeoutMs: 5 }); let killed = 0;
  adapter.start = () => { throw Error('must-not-launch'); };
  for (const method of ['nativeSpeedPrepare', 'nativeSpeedStart', 'nativeSpeedStatus', 'nativeSpeedCancel']) await assert.rejects(adapter[method]({ id: 'x' }));
  const child = { stdin: { writable: true, write() {} }, kill() { killed++; } };
  adapter.child = child; adapter.wantRunning = true; adapter.initialized.add(child);
  for (const method of ['nativeSpeedPrepare', 'nativeSpeedStart', 'nativeSpeedStatus', 'nativeSpeedCancel']) await assert.rejects(adapter[method]({ id: 'x' }, child), /超时/);
  assert.equal(killed, 0); assert.equal(adapter.child, child); assert.equal(adapter.pending.size, 0);
  await assert.rejects(adapter.nativeSpeedStart({}, {}), /尚未就绪/);
});

test('v6 encrypted control admits only a current session ticket and bounded port', () => {
  const pairing = makePairing('100.90.1.2'), peer = new BridgePeer({ role: 'host', pairing, capabilities: { nativeSpeed: 5 } });
  const packets = [], connection = { session: randomId(32), authenticated: true, sendSequence: 0,
    crypto: new SecureChannel(pairing.secret, pairing.room, 'host'),
    ws: { readyState: WebSocket.OPEN, bufferedAmount: 0, send(packet) { packets.push(JSON.parse(packet)); } } };
  peer.connections.add(connection); assert.deepEqual(peer.capabilities, { nativeSpeed: 5 });
  const offer = { type: 'speed-offer', v: 6, id: randomUUID(), session: connection.session, ticket: randomId(32), port: 32123 };
  assert.equal(peer.trySendSpeedMessage(offer, connection), true);
  const decoder = new SecureChannel(pairing.secret, pairing.room, 'client'); assert.deepEqual(decoder.open(packets[0]).body, offer);
  for (const change of [{ port: 0 }, { port: 65536 }, { host: '8.8.8.8' }, { session: 'old' }, { ticket: 'old' }, { v: 1 }]) {
    assert.equal(peer.trySendSpeedMessage({ ...offer, ...change }, connection), false);
  }
});
