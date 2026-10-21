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
