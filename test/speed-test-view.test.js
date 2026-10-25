import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeedTestView, speedReportForExport, speedMetric } from '../public/speed-test.js';

test('speed exports whitelist measurements and use received throughput with decimal display units', () => {
  const report = { v: 1, completed: false, startedAtUtc: '2026-10-21T00:00:00.000Z', finishedAtUtc: '2026-10-21T00:00:05.000Z',
    targetRole: 'host', jobId: 'private-job', session: 'private-session', ticket: 'private-token', address: '100.100.100.100', notes: ['private-note'],
    stopReason: 'private-error', latency: { samples: [10, 15, 20], minMs: 10, medianMs: 15, maxMs: 20, failedSamples: 2, endpoint: 'private-endpoint' },
    download: { receivedBytes: 1000000, durationMs: 1000, bytesPerSecond: 1000000, completion: 'partial', limitReached: false, sentBytes: 9000000 }, upload: null };
  const safe = speedReportForExport(report), json = JSON.stringify(safe);
  assert.equal(safe.download.receivedBytes, 1000000);
  assert.deepEqual(safe.latency.samples, [10, 15, 20]);
  assert.equal(safe.stopReason, 'speed-failed');
  for (const secret of ['private-', '100.100.100.100', 'sentBytes']) assert.equal(json.includes(secret), false);
  assert.deepEqual(speedMetric(safe.download), { primary: '8.00', secondary: 'Mbps · 1.00 MB/s · 部分结果' });
  assert.equal(speedMetric(null).primary, '—');
  assert.equal(speedMetric({ bytesPerSecond: 12, completion: 'failed' }).primary, '—');
});

function dom() {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, open: false, textContent: '', replaceChildren() {}, append() {},
      addEventListener() {}, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  return $;
}

const nativeUDP = (extra = {}) => ({ receivedBytes: 99000, durationMs: 1000, bytesPerSecond: 1, completion: 'complete', limitReached: false,
  sentBytes: 110000, sentPackets: 100, receivedPackets: 90, lostPackets: 0, lossPercent: 0, duplicatePackets: 3, outOfOrderPackets: 4,
  offeredBytesPerSecond: 6250000, packetBytes: 1100, ...extra });

const multiTCP = (extra = {}) => ({ receivedBytes: 4000000, durationMs: 2000, bytesPerSecond: 999999999, completion: 'complete', limitReached: false,
  streams: Array.from({ length: 4 }, (_, index) => ({ index, receivedBytes: 1000000, durationMs: 1000 + index * 250,
    completion: 'complete', limitReached: false, ticket: 'private-stream-ticket' })), ...extra });

const tcpRampStage = (index, extra = {}) => {
  const connections = [1, 2, 4, 8, 16][index], durationMs = [1000, 1000, 4000, 2000, 8000][index];
  return { index, connections, receivedBytes: connections * 1024, durationMs, bytesPerSecond: 9999999, completion: 'complete', limitReached: false,
    streams: Array.from({ length: connections }, (_, index) => ({ index, receivedBytes: 1024, durationMs, completion: 'complete', limitReached: false })), ...extra };
};
const tcpRamp = (stages, extra = {}) => ({ completion: 'complete', stages, bestStageIndex: 4, totalReceivedBytes: 999,
  stopReason: 'completed', ...extra });
const rampReport = (direction) => ({ v: 5, transport: 'native-tailscale', tcpMulti: { mode: 'adaptive', connectionCounts: [1, 2, 4, 8, 16], download: direction, upload: null },
  download: { receivedBytes: 192 * 1024 * 1024, durationMs: 1, bytesPerSecond: 999, completion: 'complete', limitReached: true } });
const plateauStage = (index, rate) => {
  const stage = tcpRampStage(index), durationMs = 1000, receivedBytes = rate * 16000;
  return { ...stage, receivedBytes, durationMs,
    streams: stage.streams.map((stream) => ({ ...stream, receivedBytes: receivedBytes / stage.connections, durationMs })) };
};
const plateauReport = (rates, extra = {}) => {
  const input = rampReport(tcpRamp(rates.map((rate, index) => plateauStage(index, rate)), { stopReason: 'plateau', ...extra }));
  input.v = 6; input.tcpMulti.earlyStop = { minimumGainPercent: 5, consecutiveStages: 2 }; return input;
};

test('TCP plateau export validates the first stop, preserves small gains and historical all-stage reports', () => {
  const input = plateauReport([100, 103, 104]), safe = speedReportForExport(input);
  assert.equal(safe.tcpMulti.download.completion, 'complete');
  assert.equal(safe.tcpMulti.download.stopReason, 'plateau');
  assert.equal(safe.tcpMulti.download.bestStageIndex, 2);
  assert.equal(safe.tcpMulti.download.stages[2].connections, 4);
  assert.equal(safe.tcpMulti.download.stages[2].bytesPerSecond, 104 * 16000);
  assert.deepEqual(safe.tcpMulti.earlyStop, { minimumGainPercent: 5, consecutiveStages: 2 });
  assert.match(safe.notes.join(' '), /连续两次.*不足 5%/);
  // Exactly 5% resets the streak; two new flat stages can then finish all five.
  assert.equal(speedReportForExport(plateauReport([100, 100, 105, 105, 105], { stopReason: 'completed' })).tcpMulti.download.stopReason, 'completed');
  assert.equal(speedReportForExport(plateauReport([0, 0, 0, 0, 0], { stopReason: 'completed' })).tcpMulti.download.bestStageIndex, 0);
  assert.equal(speedReportForExport(plateauReport([100, 110, 112, 111])).tcpMulti.download.bestStageIndex, 2);
  for (const invalid of [plateauReport([100, 100]), plateauReport([100, 110, 120]),
    plateauReport([100, 103, 104, 150]), plateauReport([100, 103, 104], { stopReason: 'completed' }),
    plateauReport([100, 103, 104], { completion: 'partial' })]) {
    assert.equal(speedReportForExport(invalid).tcpMulti.download, null);
  }
  const pending = plateauReport([100, 103, 104], { completion: 'partial', stopReason: null });
  assert.equal(speedReportForExport(pending).tcpMulti.download.bestStageIndex, 2, 'Completed plateau prefix can await its final decision');
  pending.tcpMulti.download.stopReason = 'cancelled';
  assert.equal(speedReportForExport(pending).tcpMulti.download.completion, 'partial');
  pending.tcpMulti.download.stages[2].completion = 'partial';
  pending.tcpMulti.download.stages[2].streams[0].completion = 'partial';
  assert.equal(speedReportForExport(pending).tcpMulti.download.bestStageIndex, 1, 'Unconfirmed current stage cannot become the best');
  const legacy = plateauReport([100, 100, 100, 100, 100], { stopReason: 'completed' });
  legacy.v = 5; delete legacy.tcpMulti.earlyStop;
  assert.equal(speedReportForExport(legacy).tcpMulti.download.bestStageIndex, 0);
  input.tcpMulti.earlyStop.minimumGainPercent = 10;
  assert.equal(speedReportForExport(input).tcpMulti.download, null);
});

test('TCP plateau UI treats early completion as success and shows the measured stage count and true peak', async () => {
  const $ = dom(), old = globalThis.document;
  globalThis.document = { createElement: () => ({ append() {} }) };
  const report = plateauReport([100, 103, 104]);
  report.completed = true; report.tcpMulti.upload = structuredClone(report.tcpMulti.download);
  report.udp = { download: adaptiveDirection([adaptiveStage(0, 10, 1500, 1500)]), upload: adaptiveDirection([adaptiveStage(0, 10, 1500, 1500)]) };
  const snapshot = { transport: 'native-tailscale', available: true, busy: false, targets: [], job: { state: 'completed', report, progress: { phase: 'completed' } } };
  const view = createSpeedTestView({ api: async () => Response.json(snapshot), $, available: () => true, toast: () => {} });
  try {
    await $('speed-test-open').onclick();
    assert.equal($('speed-test-multi-download').textContent, '13.31');
    assert.match($('speed-test-multi-download-unit').textContent, /4 条连接.*提前结束.*已测 3\/5 档/);
    assert.doesNotMatch($('speed-test-multi-download-unit').textContent, /未完成|五档完成/);
    assert.match($('speed-test-status').textContent, /测速完成.*TCP 下载提升不足.*TCP 上传提升不足/);
    assert.equal($('speed-test-progress').value, 1);
    assert.match($('speed-test-scope').textContent, /连续两次.*不足 5%/);
    snapshot.job = null; await view.refresh();
    assert.match($('speed-test-scope').textContent, /连续两次.*不足 5%/);
  } finally { view.close(); globalThis.document = old; }
});

test('TCP adaptive export selects the best confirmed stage and derives the single connection baseline', () => {
  const input = rampReport(tcpRamp(Array.from({ length: 5 }, (_, index) => tcpRampStage(index))));
  const safe = speedReportForExport(input);
  assert.equal(safe.tcpMulti.download.bestStageIndex, 3); assert.equal(safe.tcpMulti.download.stages[3].connections, 8);
  assert.equal(safe.download.bytesPerSecond, 1024); assert.equal(safe.tcpMulti.download.stages[3].bytesPerSecond, 4096);
  assert.equal(safe.tcpMulti.download.totalReceivedBytes, 31 * 1024);
  assert.equal(safe.maximumSeconds, 210); assert.equal(safe.maxBytesPerDirection, 1472 * 1024 * 1024);
  assert.equal(safe.tcpStageMaxBytes, 192 * 1024 * 1024); assert.equal(safe.tcpMultiMaxBytesPerDirection, 960 * 1024 * 1024);
  const tied = input.tcpMulti.download.stages.map((stage) => ({ ...stage, durationMs: stage.connections * 1000,
    streams: stage.streams.map((stream) => ({ ...stream, durationMs: stage.connections * 1000 })) }));
  assert.equal(speedReportForExport(rampReport(tcpRamp(tied))).tcpMulti.download.bestStageIndex, 0);
  const partial = structuredClone(input); partial.tcpMulti.download.completion = 'partial'; partial.tcpMulti.download.stopReason = 'cancelled';
  partial.tcpMulti.download.stages[4] = tcpRampStage(4, { receivedBytes: 0, durationMs: 0, bytesPerSecond: null, completion: 'partial',
    streams: Array.from({ length: 16 }, (_, index) => ({ index, receivedBytes: 0, durationMs: 0, completion: 'partial', limitReached: false })) });
  const kept = speedReportForExport(partial).tcpMulti.download;
  assert.equal(kept.bestStageIndex, 3); assert.equal(kept.stages[4].bytesPerSecond, null);
  for (const change of [value => value.stages[1].connections = 4, value => value.stages[1].index = 0,
    value => value.stages[2].streams.pop(), value => value.stages[4].completion = 'partial', value => value.stages.shift()]) {
    const invalid = structuredClone(input); change(invalid.tcpMulti.download);
    assert.equal(speedReportForExport(invalid).tcpMulti.download, null);
  }
});

test('TCP adaptive view keeps the confirmed peak while a later connection count is still running', async () => {
  const $ = dom(), old = globalThis.document;
  globalThis.document = { createElement: () => ({ append() {} }) };
  const stages = Array.from({ length: 4 }, (_, index) => tcpRampStage(index));
  const snapshot = { transport: 'native-tailscale', busy: true, available: false, targets: [], job: { id: 'ramp-job', state: 'running',
    progress: { phase: 'multi-download', stageIndex: 4, connections: 16, elapsedMs: 5000, durationMs: 10000, bytesPerSecond: 999999 },
    report: rampReport(tcpRamp(stages, { completion: 'partial', stopReason: null })) } };
  const view = createSpeedTestView({ api: async () => Response.json(snapshot), $, available: () => true, toast: () => {} });
  try {
    await $('speed-test-open').onclick();
    assert.equal($('speed-test-multi-download').textContent, '0.03');
    assert.match($('speed-test-multi-download-unit').textContent, /8 条连接.*4.00 倍.*未完成/);
    assert.match($('speed-test-status').textContent, /第 5\/5 档.*16 条连接/);
    assert.equal($('speed-test-progress').value, 4.5 / 5 / 4);
    assert.equal($('speed-test-tcp-stages').hidden, false);
    assert.match($('speed-test-scope').textContent, /210 秒.*2944 MiB/);
  } finally { view.close(); globalThis.document = old; }
});

test('four-connection TCP export uses one shared receive window and preserves individual stream confirmation', () => {
  const input = { v: 4, transport: 'native-tailscale', tcpMulti: { connections: 4, download: multiTCP(), upload: null } };
  const safe = speedReportForExport(input), metric = safe.tcpMulti.download;
  assert.equal(metric.bytesPerSecond, 2000000, 'Aggregate must divide total bytes by common duration, never add individual stream rates');
  assert.equal(metric.streams.length, 4); assert.equal(safe.maximumSeconds, 150);
  assert.equal(safe.maxBytesPerDirection, 1216 * 1024 * 1024); assert.equal(safe.tcpMultiMaxBytesPerDirection, 512 * 1024 * 1024);
  assert.equal(JSON.stringify(safe).includes('private-'), false);
  assert.equal(speedReportForExport({ ...input, completed: true }).completed, false, 'An incomplete or invalid six-stage report cannot claim completion');
  for (const change of [value => value.receivedBytes++, value => value.streams[3].index = 2,
    value => value.streams[3].completion = 'partial', value => value.durationMs = 500,
    value => { value.streams[3].durationMs = 0; value.streams[3].receivedBytes = 0; value.receivedBytes -= 1000000; }, value => value.streams.pop()]) {
    const invalid = structuredClone(input); change(invalid.tcpMulti.download);
    assert.equal(speedReportForExport(invalid).tcpMulti.download, null);
  }
  const partial = multiTCP({ completion: 'partial' }); partial.streams[3].completion = 'partial';
  input.tcpMulti.download = partial;
  assert.equal(speedReportForExport(input).tcpMulti.download.completion, 'partial');
  input.tcpMulti.download = multiTCP({ receivedBytes: 0, durationMs: 0, completion: 'partial',
    streams: Array.from({ length: 4 }, (_, index) => ({ index, receivedBytes: 0, durationMs: 0, completion: 'partial', limitReached: false })) });
  assert.equal(speedReportForExport(input).tcpMulti.download.bytesPerSecond, null);
});

test('TCP UI compares single and four-connection rates without mixing live progress or showing partial ratios', async () => {
  const $ = dom(), old = globalThis.document;
  globalThis.document = { createElement: () => ({}) };
  const snapshot = { transport: 'native-tailscale', busy: true, available: false, targets: [], job: { id: 'multi-job', state: 'running',
    progress: { phase: 'multi-download', elapsedMs: 5000, durationMs: 10000, bytesPerSecond: 3000000 },
    report: { v: 4, transport: 'native-tailscale', download: { receivedBytes: 1000000, durationMs: 1000, bytesPerSecond: 1000000, completion: 'complete', limitReached: false },
      tcpMulti: { connections: 4, download: multiTCP(), upload: null } } } };
  const view = createSpeedTestView({ api: async () => Response.json(snapshot), $, available: () => true, toast: () => {} });
  try {
    await $('speed-test-open').onclick();
    assert.equal($('speed-test-download').textContent, '8.00');
    assert.equal($('speed-test-multi-download').textContent, '24.00');
    assert.equal($('speed-test-tcp-multi').hidden, false);
    assert.equal($('speed-test-progress').value, 2.5 / 6);
    assert.match($('speed-test-status').textContent, /TCP 四连接/);
    assert.doesNotMatch($('speed-test-multi-download-unit').textContent, /倍/);
    snapshot.busy = false; snapshot.job.state = 'completed'; await view.refresh();
    assert.equal($('speed-test-multi-download').textContent, '16.00');
    assert.match($('speed-test-multi-download-unit').textContent, /单连接的 2.00 倍/);
    assert.match($('speed-test-scope').textContent, /150 秒.*2432 MiB/);
  } finally { view.close(); globalThis.document = old; }
});

const adaptiveStage = (index, targetMbps, sent, received, extra = {}) => ({ ...nativeUDP(), index,
  targetBytesPerSecond: targetMbps * 1e6 / 8, offeredBytesPerSecond: targetMbps * 1e6 / 8,
  sentPackets: sent, sentBytes: sent === null ? null : sent * 1100, receivedPackets: received, receivedBytes: received * 1100,
  durationMs: 1500, senderDurationMs: sent === null ? null : 1500, senderBytesPerSecond: 999,
  lostPackets: sent === null ? null : sent - received, lossPercent: sent === null ? null : (sent - received) * 100 / sent,
  duplicatePackets: 0, outOfOrderPackets: 0, targetReached: true, assessment: 'passed', ...extra });
const adaptiveDirection = (stages, extra = {}) => ({ mode: 'adaptive', completion: 'complete', stages,
  lowLossStageIndex: 99, peakStageIndex: 99, stopReason: 'loss-limited', totalSentBytes: 999, totalReceivedBytes: 999, ...extra });

test('adaptive reports recompute best/peak from confirmed received stages and keep their corresponding losses', () => {
  const stages = [adaptiveStage(0, 10, 1500, 1500), adaptiveStage(1, 20, 3000, 2700),
    adaptiveStage(2, 100, null, 10000, { completion: 'partial', ticket: 'private-stage-ticket' })];
  const input = { v: 3, transport: 'native-tailscale', udp: { download: adaptiveDirection(stages, { completion: 'partial', stopReason: 'cancelled' }) } };
  const safe = speedReportForExport(input), udp = safe.udp.download;
  assert.equal(safe.maximumSeconds, 120); assert.equal(safe.maxBytesPerDirection, 704 * 1024 * 1024);
  assert.equal(safe.udpMaxBytesPerDirection, 512 * 1024 * 1024);
  assert.equal(udp.lowLossStageIndex, 0); assert.equal(udp.peakStageIndex, 1);
  assert.equal(udp.stages[0].bytesPerSecond, 1100000);
  assert.equal(udp.stages[1].bytesPerSecond, 1980000); assert.equal(udp.stages[1].lossPercent, 10);
  assert.equal(udp.stages[1].senderBytesPerSecond, 2200000);
  assert.equal(udp.stages[2].senderBytesPerSecond, null); assert.equal(udp.stages[2].lossPercent, null);
  assert.equal(udp.totalSentBytes, 4950000); assert.equal(Object.hasOwn(udp, 'bytesPerSecond'), false);
  assert.equal(JSON.stringify(safe).includes('private-'), false);
  const constrained = speedReportForExport({ v: 3, transport: 'native-tailscale', udp: { download:
    adaptiveDirection([adaptiveStage(0, 20, 1500, 1500)], { stopReason: 'sender-limited' }) } }).udp.download;
  assert.equal(constrained.lowLossStageIndex, 0, 'A sender-limited stage still proves its actual low-loss rate');
  assert.equal(constrained.lowerBound, true); assert.equal(constrained.stages[0].assessment, 'sender-limited');
  const slow = speedReportForExport({ v: 3, transport: 'native-tailscale', udp: { download:
    adaptiveDirection([adaptiveStage(0, 0.25, 42, 42)], { stopReason: 'loss-limited' }) } }).udp.download;
  assert.equal(slow.stages[0].targetBytesPerSecond, 31250);
  const placeholder = structuredClone(input); placeholder.udp.download.stages[2] = adaptiveStage(2, 100, null, 0,
    { completion: 'partial', durationMs: 0, bytesPerSecond: null });
  const waiting = speedReportForExport(placeholder).udp.download;
  assert.equal(waiting.peakStageIndex, 1); assert.equal(waiting.lowLossStageIndex, 0);
  assert.equal(waiting.stages[2].bytesPerSecond, null, 'An unmeasured new stage must preserve history without showing zero bandwidth');
  const invalid = structuredClone(input); invalid.udp.download.stages[0].index = 7;
  assert.equal(speedReportForExport(invalid).udp.download, null);
});

test('adaptive view displays best and peak separately with a per-stage table and bounded-stop explanation', async () => {
  const $ = dom(), old = globalThis.document;
  globalThis.document = { createElement: () => ({ children: [], append(child) { this.children.push(child); } }) };
  const snapshot = { transport: 'native-tailscale', busy: false, available: true, targets: [],
    job: { id: 'adaptive-job', state: 'completed', progress: { phase: 'completed' }, report: { v: 3, transport: 'native-tailscale', completed: true,
      udp: { download: adaptiveDirection([adaptiveStage(0, 10, 1500, 1500), adaptiveStage(1, 20, 3000, 2700)]),
        upload: adaptiveDirection([adaptiveStage(0, 20, 1500, 1500)], { stopReason: 'sender-limited' }) } } } };
  const view = createSpeedTestView({ api: async () => Response.json(snapshot), $, available: () => true, toast: () => {} });
  try {
    await $('speed-test-open').onclick();
    assert.equal($('speed-test-udp-download').textContent, '8.80');
    assert.match($('speed-test-udp-download-unit').textContent, /低丢包最佳.*0.00%.*峰值 15.84 Mbps.*10.00%/);
    assert.match($('speed-test-udp-upload-unit').textContent, /发送端未达到目标.*已测下界/);
    assert.equal($('speed-test-udp-stages').hidden, false);
    assert.match($('speed-test-scope').textContent, /120 秒.*1408 MiB/);
    snapshot.busy = true; snapshot.job.state = 'running'; snapshot.job.progress = { phase: 'udp-upload', elapsedMs: 20000, durationMs: 30000,
      stageIndex: 2, targetBytesPerSecond: 12500000, senderBytesPerSecond: 10000000 };
    await view.refresh();
    assert.match($('speed-test-status').textContent, /第 3 档.*目标 100.00 Mbps.*实发 80.00 Mbps/);
  } finally { view.close(); globalThis.document = old; }
});

test('native reports separate TCP and UDP, recompute received rates/loss and exclude private fields', () => {
  const report = speedReportForExport({ v: 2, transport: 'native-tailscale',
    download: { receivedBytes: 2000000, durationMs: 1000, bytesPerSecond: 999, completion: 'complete', limitReached: false },
    udp: { download: nativeUDP({ ticket: 'private-token', address: 'private-address' }), upload: nativeUDP({ completion: 'partial', lostPackets: null, lossPercent: null }) } });
  assert.equal(report.download.bytesPerSecond, 2000000);
  assert.equal(report.udp.download.bytesPerSecond, 99000);
  assert.equal(report.udp.download.lostPackets, 10);
  assert.equal(report.udp.download.lossPercent, 10);
  assert.equal(report.udp.upload.lossPercent, null);
  assert.equal(report.udp.download.duplicatePackets, 3);
  assert.equal(report.udp.download.outOfOrderPackets, 4);
  assert.equal(JSON.stringify(report).includes('private-'), false);
  assert.match(report.notes.join(' '), /不代表 UDP 最大带宽/);
  assert.equal(speedReportForExport({ v: 2, transport: 'legacy-websocket' }), null);
  assert.equal(speedReportForExport({ v: 2, transport: 'native-tailscale', udp: { download: nativeUDP({ sentPackets: 89 }) } }).udp.download, null);
  assert.equal(speedReportForExport({ v: 2, transport: 'native-tailscale', udp: { download: nativeUDP({ sentPackets: null, sentBytes: null, completion: 'partial', lostPackets: null, lossPercent: null }) } }).udp.download.lossPercent, null);
});

test('native UDP progress occupies its own phase and never overwrites TCP measurements', async () => {
  const $ = dom(), old = globalThis.document;
  globalThis.document = { createElement: () => ({}) };
  const snapshot = { transport: 'native-tailscale', busy: true, available: false, targets: [],
    job: { id: 'native-job', state: 'running', progress: { phase: 'udp-download', elapsedMs: 4000, durationMs: 8000, bytesPerSecond: 6250000 },
      report: { v: 2, transport: 'native-tailscale', download: { receivedBytes: 2000000, durationMs: 1000, bytesPerSecond: 2000000, completion: 'complete', limitReached: false },
        udp: { download: nativeUDP() } } } };
  const view = createSpeedTestView({ api: async () => Response.json(snapshot), $, available: () => true, toast: () => {} });
  try {
    await $('speed-test-open').onclick();
    assert.equal($('speed-test-download').textContent, '16.00');
    assert.equal($('speed-test-udp-download').textContent, '0.79');
    assert.match($('speed-test-udp-download-unit').textContent, /丢包 10.00%.*目标发送 50 Mbps/);
    assert.equal($('speed-test-progress').value, 0.625);
    assert.match($('speed-test-status').textContent, /UDP/);
    assert.equal($('speed-test-udp').hidden, false);
    snapshot.job.progress = { phase: 'udp-upload', elapsedMs: 8000, durationMs: 8000 };
    await view.refresh();
    assert.match($('speed-test-status').textContent, /整组最多 60 秒/);
    assert.doesNotMatch($('speed-test-status').textContent, /最多 5 秒/);
    assert.ok($('speed-test-progress').value < 1);
  } finally { view.close(); globalThis.document = old; }
});

test('opening a speed window does not start traffic; delayed starts after closing cancel only that job', async () => {
  const $ = dom(), old = globalThis.document;
  globalThis.document = { createElement: () => ({}) };
  const calls = []; let release;
  const api = async (route, body) => {
    calls.push({ route, body });
    if (body?.targetId) return new Promise((resolve) => { release = () => resolve(Response.json({ id: 'owned-late-job', state: 'running' })); });
    return Response.json({ available: true, targets: [{ id: 'paired-host', role: 'host', supported: true }], busy: false, job: null });
  };
  const view = createSpeedTestView({ api, $, available: () => true, toast: () => {} });
  try {
    await $('speed-test-open').onclick();
    assert.equal(calls.some((call) => call.body?.targetId), false);
    const pending = $('speed-test-start').onclick();
    assert.equal(typeof release, 'function');
    const before = calls.length; await view.refresh();
    assert.equal(calls.length, before, 'Status reads during a start cannot overwrite its eventual new job');
    view.close(); release(); await pending;
    assert.deepEqual(calls.filter((call) => call.route.endsWith('/cancel')).map((call) => call.body), [{ jobId: 'owned-late-job' }]);
  } finally { view.close(); globalThis.document = old; }
});

test('unsupported peers cannot start; closing an observer window leaves remote tests running', async () => {
  const $ = dom(), old = globalThis.document;
  globalThis.document = { createElement: () => ({}) };
  const calls = [];
  let value = { available: true, targets: [{ id: 'old-peer', role: 'client', supported: false }], busy: false, job: null };
  const api = async (route, body) => { calls.push({ route, body }); return Response.json(value); };
  const view = createSpeedTestView({ api, $, available: () => true, toast: () => {} });
  try {
    await $('speed-test-open').onclick();
    assert.equal($('speed-test-start').disabled, true);
    assert.match($('speed-test-status').textContent, /升级/);
    value = { ...value, busy: true, job: { id: 'remote-job', state: 'running', progress: { phase: 'download', bytesPerSecond: 2000000 } } };
    await view.refresh();
    assert.equal($('speed-test-download').textContent, '16.00');
    assert.equal($('speed-test-upload').textContent, '—');
    view.close();
    assert.equal(calls.some((call) => call.route.endsWith('/cancel')), false);
  } finally { view.close(); globalThis.document = old; }
});


test('twenty-second reports retain the higher byte cap and loaded RTT samples without fabricating latency', () => {
  const samples = Array.from({ length: 64 }, (_, i) => i + 100);
  const input = { v: 1, completed: true, stopReason: 'receiver-timeout', latency: { samples, minMs: 0, medianMs: 0, maxMs: 0, failedSamples: 1 },
    download: { receivedBytes: 256 * 1024 * 1024, durationMs: 20000, bytesPerSecond: 256 * 1024 * 1024 / 20, completion: 'complete', limitReached: true },
    upload: { receivedBytes: 256 * 1024 * 1024 + 1, durationMs: 20000, bytesPerSecond: 1, completion: 'complete', limitReached: true } };
  const report = speedReportForExport(input);
  assert.equal(report.maximumSeconds, 60);
  assert.equal(report.maxBytesPerDirection, 256 * 1024 * 1024);
  assert.equal(report.download.receivedBytes, 256 * 1024 * 1024);
  assert.equal(report.upload, null);
  assert.equal(report.latency.samples.length, 64);
  assert.equal(report.latency.medianMs, 131.5);
  assert.equal(report.latency.failedSamples, 0);
  assert.equal(report.stopReason, 'receiver-timeout');
  assert.match(report.notes.join(' '), /20 秒.*传输负载/);
  const empty = speedReportForExport({ v: 1, latency: { samples: [], failedSamples: 10, medianMs: 0, minMs: 0, maxMs: 0 } });
  assert.deepEqual(empty.latency, { samples: [], minMs: null, medianMs: null, maxMs: null, failedSamples: 10 });
});

test('upload acknowledgement shows a bounded wait, loaded RTT and real partial results', async () => {
  const $ = dom(), old = globalThis.document;
  globalThis.document = { createElement: () => ({}) };
  const download = { receivedBytes: 2000000, durationMs: 20000, bytesPerSecond: 100000, completion: 'complete', limitReached: false };
  let value = { available: false, targets: [{ id: 'new-peer', role: 'host', supported: true }], busy: true,
    job: { id: 'remote-job', state: 'running', progress: { phase: 'upload', elapsedMs: 20000, durationMs: 20000, bytes: 125000,
      maxBytes: 256 * 1024 * 1024, bytesPerSecond: 6250, waitingForReceiver: true, confirmationRemainingMs: 2100 },
    report: { v: 1, latency: { samples: [264, 280, 290], failedSamples: 0 }, download } } };
  const view = createSpeedTestView({ api: async () => Response.json(value), $, available: () => true, toast: () => {} });
  try {
    await $('speed-test-open').onclick();
    assert.equal($('speed-test-latency').textContent, '280.0');
    assert.match($('speed-test-latency-unit').textContent, /传输中采样.*3 个样本/);
    assert.match($('speed-test-status').textContent, /上传阶段等待接收端确认（最多 3 秒）/);
    assert.equal($('speed-test-progress').value, 0.99);
    assert.equal($('speed-test-cancel').disabled, false);
    assert.equal($('speed-test-download').textContent, '0.80');
    assert.match($('speed-test-upload-unit').textContent, /测速中/);
    value = { ...value, busy: false, available: true, job: { ...value.job, state: 'failed', report: { ...value.job.report,
      finishedAtUtc: '2026-10-21T00:00:25.000Z', completed: false, stopReason: 'receiver-timeout',
      upload: { receivedBytes: 125000, durationMs: 25000, bytesPerSecond: 5000, completion: 'partial', limitReached: false } } } };
    await view.refresh();
    assert.match($('speed-test-status').textContent, /上传测速未完成：接收端确认超时/);
    assert.equal($('speed-test-upload').textContent, '0.04');
    assert.match($('speed-test-upload-unit').textContent, /部分结果/);
    assert.equal($('speed-test-cancel').disabled, true);
    assert.equal($('speed-test-export').disabled, false);
    value.job.report.upload = null;
    await view.refresh();
    assert.equal($('speed-test-upload').textContent, '—', 'Missing receiver confirmation is not a zero-speed measurement');
    value.job.report.latency = { samples: [], failedSamples: 12, medianMs: 0 };
    await view.refresh();
    assert.equal($('speed-test-latency').textContent, '—', 'Missing RTT replies are not shown as zero latency');
  } finally { view.close(); globalThis.document = old; }
});
