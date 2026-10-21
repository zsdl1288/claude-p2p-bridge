import test from 'node:test';
import assert from 'node:assert/strict';
import { probeReportForExport, probeReportText, createChannelProbeView } from '../public/channel-probe.js';

test('probe exports retain only results and never include status, identity, endpoints or raw diagnostic material', () => {
  const report = { v: 1, completed: true, startedAtUtc: '2026-10-21T00:00:00Z', targetRole: 'host',
    plannedProbes: 9, completedProbes: 2, replies: 1, endpoint: '203.0.113.1:1234', target: '100.100.100.100',
    token: 'private-token', notes: ['private-note'], results: [
      { type: 'TSMP', size: 0, outcome: 'reply', actualVia: 'direct', latencySeconds: 0.2, endpoint: 'private-endpoint', error: 'private-error' },
      { type: 'disco', size: 1200, outcome: 'timeout', actualVia: 'unknown', hostname: 'private-name' }
    ] };
  const exported = probeReportForExport(report), json = JSON.stringify(exported);
  for (const privateValue of ['private-', '203.0.113.1', '100.100.100.100']) assert.equal(json.includes(privateValue), false);
  assert.equal(exported.results[0].actualVia, 'unknown', 'TSMP must never invent its actual path');
  assert.equal(exported.results[1].outcome, 'timeout');
  const text = probeReportText(report); assert.match(text, /回复 1\/2/); assert.match(text, /200\.0/); assert.match(text, /不是.*丢包率|超时不是/);
  assert.equal(probeReportForExport(null), null);
});

test('a delayed start reply after a browser panel closes cancels exactly the job created by that panel', async () => {
  const elements = new Map();
  const $ = (id) => { if (!elements.has(id)) elements.set(id, { value: '', disabled: false, textContent: '', replaceChildren() {}, append() {} }); return elements.get(id); };
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({}) };
  const calls = []; let release;
  const api = async (route, body) => {
    calls.push({ route, body });
    if (body?.targetId) return new Promise((resolve) => { release = () => resolve(Response.json({ id: 'owned-late-job', state: 'running' })); });
    return Response.json({ available: true, targets: [{ id: 'paired-host', role: 'host' }], busy: false, job: null });
  };
  try {
    const view = createChannelProbeView({ api, $, available: () => true, toast: () => {} });
    await view.open(); assert.equal(calls.some((call) => call.body?.targetId), false, 'Opening never starts an active probe');
    const pending = $('channel-probe-start').onclick();
    assert.equal(typeof release, 'function'); view.close(); release(); await pending;
    assert.deepEqual(calls.filter((call) => call.route.endsWith('/cancel')).map((call) => call.body), [{ jobId: 'owned-late-job' }]);
  } finally { globalThis.document = previous; }
});
