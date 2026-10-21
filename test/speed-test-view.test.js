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
