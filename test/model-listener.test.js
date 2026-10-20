import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createLocalServer } from '../src/server.js';

const token = 'model-listener-fixture-token';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const completion = { model: 'fixture-model', messages: [{ role: 'user', content: 'fixture only' }], stream: true };

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address()); });
  });
}
function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
}
async function until(check) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for model listener cancellation');
}
async function fixture(t, { port = 0 } = {}) {
  const state = { role: 'client', online: true, capabilities: { model: true } };
  const calls = [];
  let disconnected = 0;
  const bridge = {
    status() { return structuredClone(state); },
    async getModels() { return [{ id: 'fixture-model', name: 'Fixture' }]; },
    run(request, emit, signal) { const id = randomUUID(); calls.push({ request, emit, signal, id }); return id; },
    async disconnect() { disconnected++; },
  };
  const app = createLocalServer({ port, token, bridge });
  t.after(() => app.close());
  const address = await app.listen();
  const controlUrl = `http://127.0.0.1:${address.port}`;
  const request = (route, body, extra = {}) => fetch(`${controlUrl}${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const toggle = (enabled) => request('/api/model-api', { enabled });
  return { app, state, calls, request, toggle, controlUrl, get disconnected() { return disconnected; } };
}

test('model API defaults off, starts only on demand and releases its port when stopped', { timeout: 10000 }, async (t) => {
  const { app, request, toggle, controlUrl } = await fixture(t);
  assert.ok(app.modelServer instanceof http.Server);
  assert.equal(app.modelServer.listening, false);
  const initial = await (await request('/api/status')).json();
  assert.equal(initial.modelApi.enabled, false);
  assert.equal(initial.modelApi.listening, false);
  assert.equal((await request('/v1/models')).status, 404);
  assert.equal((await request('/v1/chat/completions', completion)).status, 404);
  assert.equal((await request('/api/model-test', completion)).status, 503);

  const start = await toggle(true);
  assert.equal(start.status, 200);
  const started = await start.json();
  assert.equal(started.role, 'client');
  assert.equal(started.modelApi.enabled, true);
  assert.equal(started.modelApi.listening, true);
  const modelPort = app.modelServer.address().port;
  assert.equal(started.modelApi.port, modelPort);
  assert.equal(started.modelApi.baseUrl, `http://127.0.0.1:${modelPort}/v1`);
  assert.notEqual(new URL(controlUrl).port, String(modelPort));
  const competitor = net.createServer();
  await assert.rejects(listen(competitor, modelPort), { code: 'EADDRINUSE' });
  assert.equal((await fetch(`http://127.0.0.1:${modelPort}/v1/models`)).status, 401);
  const models = await fetch(`http://127.0.0.1:${modelPort}/v1/models`, { headers });
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data[0].id, 'fixture-model');
  assert.equal((await request('/v1/models')).status, 404);
  assert.equal((await toggle(true)).status, 200);
  assert.equal(app.modelServer.address().port, modelPort);

  const stopped = await (await toggle(false)).json();
  assert.equal(stopped.modelApi.enabled, false);
  assert.equal(stopped.modelApi.listening, false);
  assert.equal(app.modelServer.listening, false);
  const replacement = net.createServer();
  t.after(() => close(replacement));
  await listen(replacement, modelPort);
  assert.equal((await fetch(`${controlUrl}/health`)).status, 200);
  assert.equal((await toggle(false)).status, 200);
});

test('listener control requires authentication and a model-capable A identity', async (t) => {
  const { app, state, toggle, request } = await fixture(t);
  assert.equal((await request('/api/model-api', { enabled: true }, { Authorization: '' })).status, 401);
  assert.equal(app.modelServer.listening, false);
  for (const identity of [
    { role: null, capabilities: { model: true } },
    { role: 'host', capabilities: { model: true } },
    { role: 'client', capabilities: { model: false } },
  ]) {
    Object.assign(state, identity);
    const response = await toggle(true);
    assert.ok(response.status >= 400);
    assert.equal(app.modelServer.listening, false);
  }
  Object.assign(state, { role: 'client', capabilities: { model: true } });
  for (const body of [{ enabled: 'true' }, {}, { enabled: true, unexpected: true }]) {
    assert.equal((await request('/api/model-api', body)).status, 400);
    assert.equal(app.modelServer.listening, false);
  }
  assert.equal((await toggle(true)).status, 200);
});

test('a model port conflict leaves management and bridge connections running and allows retry', { timeout: 10000 }, async (t) => {
  const blocker = net.createServer();
  t.after(() => close(blocker));
  const occupied = await listen(blocker);
  const fixtureState = await fixture(t, { port: occupied.port });
  const { app, request, toggle, controlUrl } = fixtureState;
  const failure = await toggle(true);
  assert.ok(failure.status >= 400);
  const status = await (await request('/api/status')).json();
  assert.equal(status.modelApi.enabled, false);
  assert.equal(status.modelApi.listening, false);
  assert.ok(status.modelApi.error);
  assert.equal(status.online, true);
  assert.equal(fixtureState.disconnected, 0);
  assert.equal((await fetch(`${controlUrl}/health`)).status, 200);
  await close(blocker);
  assert.equal((await toggle(true)).status, 200);
  assert.equal(app.modelServer.address().port, occupied.port);
  assert.equal(Boolean((await (await request('/api/status')).json()).modelApi.error), false);
});

test('stopping the API cancels model and UI model-test requests while an independent task continues', { timeout: 10000 }, async (t) => {
  const fixtureState = await fixture(t);
  const { app, calls, toggle, request } = fixtureState;
  assert.equal((await toggle(true)).status, 200);
  const task = await request('/v1/run', { prompt: 'independent task' });
  const model = await fetch(`http://127.0.0.1:${app.modelServer.address().port}/v1/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(completion),
  });
  const uiModel = await request('/api/model-test', completion);
  assert.equal(model.status, 200);
  assert.equal(uiModel.status, 200);
  const modelClosed = assert.rejects(model.text());
  const uiClosed = assert.rejects(uiModel.text());
  assert.equal(calls.length, 3);
  const [taskCall, modelCall, uiCall] = calls;
  assert.equal((await toggle(false)).status, 200);
  await Promise.all([modelClosed, uiClosed]);
  await until(() => modelCall.signal.aborted && uiCall.signal.aborted);
  assert.equal(taskCall.signal.aborted, false);
  assert.equal(fixtureState.disconnected, 0);
  taskCall.emit({ type: 'claude', event: { type: 'result', result: 'task survived' } });
  taskCall.emit({ type: 'done', exitCode: 0, cancelled: false });
  assert.match(await task.text(), /task survived/);
  assert.equal((await request('/api/status')).status, 200);
  assert.equal((await request('/api/model-test', completion)).status, 503);
});

test('a slow UI model-test upload is closed on stop and cannot resume after the API restarts', { timeout: 10000 }, async (t) => {
  const { app, calls, toggle, request, controlUrl } = await fixture(t);
  const run = app.bridge.run;
  app.bridge.run = (body, emit, signal) => {
    const id = run(body, emit, signal);
    emit({ type: 'claude', event: { type: 'result', subtype: 'success', is_error: false,
      structured_output: { content: 'fresh fixture response', tool_calls: [] } } });
    emit({ type: 'done', exitCode: 0, cancelled: false });
    return id;
  };
  assert.equal((await toggle(true)).status, 200);
  const body = JSON.stringify(completion);
  let incoming;
  const arrived = new Promise((resolve) => {
    app.server.once('request', (req) => { incoming = req; resolve(); });
  });
  let upload;
  const outcome = new Promise((resolve) => {
    upload = http.request(`${controlUrl}/api/model-test`, {
      method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); res.once('end', () => resolve({ status: res.statusCode })); });
    upload.on('error', (error) => resolve({ error }));
    upload.write(body.slice(0, 1));
  });
  t.after(() => upload.destroy());
  await arrived;
  // Let the request handler enter body reading; the declared body is still
  // incomplete, so it cannot have reached model admission yet.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(incoming.complete, false);
  assert.equal(calls.length, 0);
  assert.equal((await toggle(false)).status, 200);
  assert.equal((await toggle(true)).status, 200);
  upload.end(body.slice(1));
  assert.ok((await outcome).error, 'the old upload must end with a closed connection');
  assert.equal(calls.length, 0);
  const fresh = await request('/api/model-test', { ...completion, stream: false });
  assert.equal(fresh.status, 200);
  assert.equal((await fresh.json()).choices[0].message.content, 'fresh fixture response');
  assert.equal(calls.length, 1);
});

test('stopping during model discovery prevents the old request from running after a restart', { timeout: 10000 }, async (t) => {
  const { app, calls, toggle, request } = await fixture(t);
  let finishDiscovery;
  let discoveryStarted;
  const started = new Promise((resolve) => { discoveryStarted = resolve; });
  app.bridge.getModels = () => {
    discoveryStarted();
    return new Promise((resolve) => { finishDiscovery = resolve; });
  };
  assert.equal((await toggle(true)).status, 200);
  const oldRequest = request('/api/model-test', completion);
  const oldClosed = assert.rejects(oldRequest);
  await started;
  assert.equal((await toggle(false)).status, 200);
  assert.equal((await toggle(true)).status, 200);
  finishDiscovery([{ id: 'fixture-model', name: 'Fixture' }]);
  await oldClosed;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
  assert.equal((await request('/api/status')).status, 200);
});
