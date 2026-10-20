import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalServer, getApiToken } from '../src/server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const id = '00000000-0000-4000-8000-000000000001';
const headers = { Authorization: 'Bearer server-fixture-token', 'Content-Type': 'application/json' };
async function fixture(t, overrides = {}) {
  const dispatched = [];
  const bridge = {
    async getModels() { return [{ id: 'claude-code', name: 'Fixture account model' }]; },
    run(request, emit) {
      dispatched.push(request);
      emit({ type: 'claude', event: { type: 'result', is_error: false, result: 'immediate task result' } });
      emit({ type: 'done', exitCode: 0, cancelled: false });
      return id;
    }, async close() {}, ...overrides
  };
  const app = createLocalServer({ port: 0, token: 'server-fixture-token', bridge });
  t.after(() => app.close().catch(() => {}));
  const address = await app.listen();
  return { app, url: `http://127.0.0.1:${address.port}`, dispatched };
}

test('the browser entry point and its role-state module are served together', async (t) => {
  const { url } = await fixture(t);
  const script = await fetch(`${url}/app.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /from '\.\/ui-state\.js'/);
  const state = await fetch(`${url}/ui-state.js`);
  assert.equal(state.status, 200);
  assert.match(state.headers.get('content-type'), /javascript/);
  assert.match(await state.text(), /export function uiState/);
});

test('task and model endpoints cannot silently exchange execution modes', async (t) => {
  const { url, dispatched } = await fixture(t);
  const response = await fetch(`${url}/v1/run`, { method: 'POST', headers, body: JSON.stringify({ kind: 'model', model: 'claude-code', messages: [{ role: 'user', content: 'wrong endpoint' }], stream: false }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /chat\/completions/);
  const invalidStream = await fetch(`${url}/v1/run`, { method: 'POST', headers, body: '{"prompt":"test","stream":"false"}' });
  assert.equal(invalidStream.status, 400);
  assert.equal(dispatched.length, 0);
});

test('task responses handle synchronous completion without missing headers, IDs or cleanup', async (t) => {
  const { url } = await fixture(t);
  const result = await (await fetch(`${url}/v1/run`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'test', stream: false }) })).json();
  assert.equal(result.requestId, id);
  assert.equal(result.success, true);
  assert.equal(result.result.result, 'immediate task result');
  const stream = await fetch(`${url}/v1/run`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'test' }) });
  assert.equal(stream.headers.get('x-request-id'), id);
  const text = await stream.text();
  assert.match(text, /event: claude/);
  assert.match(text, /event: done/);
});

test('task completion without a result is reported as failure', async (t) => {
  const { url } = await fixture(t, { run(_request, emit) { emit({ type: 'done', exitCode: 0, cancelled: false }); return id; } });
  const result = await (await fetch(`${url}/v1/run`, { method: 'POST', headers, body: '{"prompt":"test","stream":false}' })).json();
  assert.equal(result.success, false);
  assert.equal(result.errors[0].code, 'CLAUDE_NO_RESULT');
});

test('a missing cancellation acknowledgement is a cancelled model request, not a provider failure', async (t) => {
  const { url } = await fixture(t, { run(_request, emit) {
    emit({ type: 'error', code: 'CANCEL_TIMEOUT', message: 'synthetic cancellation confirmation timeout' });
    emit({ type: 'done', exitCode: null, cancelled: true });
    return id;
  } });
  const response = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'claude-code', messages: [{ role: 'user', content: 'cancel test' }] }) });
  assert.equal(response.status, 499);
  assert.equal((await response.json()).error.code, 'CANCEL_TIMEOUT');
});

test('invalid JSON, UTF-8 and non-object bodies fail before dispatch with the correct error shape', async (t) => {
  const { url, dispatched } = await fixture(t);
  for (const route of ['/v1/run', '/v1/chat/completions']) {
    for (const body of ['null', '[]', 'false', '42', '"text"', '{broken', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]) {
      const response = await fetch(`${url}${route}`, { method: 'POST', headers, body });
      assert.equal(response.status, 400);
      const error = (await response.json()).error;
      assert.equal(typeof (route.endsWith('completions') ? error.message : error), 'string');
    }
  }
  assert.equal(dispatched.length, 0);
  for (const route of ['/v1/models', '/v1/chat/completions', '/v1/responses', '/v1/messages']) {
    const unauthorized = await fetch(`${url}${route}`);
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error.type, 'authentication_error');
    const crossOrigin = await fetch(`${url}${route}`, { headers: { ...headers, Origin: 'https://example.invalid' } });
    assert.equal(crossOrigin.status, 403);
    assert.equal(typeof (await crossOrigin.json()).error.message, 'string');
  }
});

test('closing remains idempotent and releases the HTTP port when bridge cleanup fails', async (t) => {
  let calls = 0;
  const { app, url } = await fixture(t, { async close() { calls++; throw new Error('synthetic bridge cleanup failure'); } });
  const first = app.close();
  assert.equal(app.close(), first);
  await assert.rejects(first, /synthetic bridge cleanup failure/);
  assert.equal(calls, 1);
  assert.equal(app.server.listening, false);
  await assert.rejects(fetch(`${url}/health`));
});

test('concurrent API-token initialization shares one credential and never overwrites corrupt state', async (t) => {
  await mkdir(path.join(root, '.bridge'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.bridge', 'server-token-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokens = await Promise.all(Array.from({ length: 20 }, () => getApiToken(directory)));
  assert.equal(new Set(tokens).size, 1);
  assert.equal((await readFile(path.join(directory, 'api-token'), 'utf8')).trim(), tokens[0]);
  await writeFile(path.join(directory, 'api-token'), 'broken fixture');
  await assert.rejects(getApiToken(directory), /API Token 文件无效/);
  assert.equal(await readFile(path.join(directory, 'api-token'), 'utf8'), 'broken fixture');
});

test('a token reader waits for an in-progress initial write but leaves an abandoned file untouched', async (t) => {
  await mkdir(path.join(root, '.bridge'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.bridge', 'server-token-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'api-token');
  await writeFile(file, '');
  const writer = new Promise((resolve, reject) => setTimeout(() => writeFile(file, 'a'.repeat(43)).then(resolve, reject), 60));
  assert.equal(await getApiToken(directory), 'a'.repeat(43));
  await writer;
  await writeFile(file, '');
  await assert.rejects(getApiToken(directory), /API Token 文件无效/);
  assert.equal(await readFile(file, 'utf8'), '');
});
