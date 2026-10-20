import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/bridge.js';
import { createLocalServer } from '../src/server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const token = 'synthetic-model-api-test-token';
const model = 'claude-haiku-fixture-20261020';
const sonnetModel = 'claude-sonnet-fixture-20261020';
const opusModel = 'claude-opus-fixture-20261020';
const fixtureModels = [
  { id: model, name: 'Fixture Haiku', description: 'A fixture-only account model.' },
  { id: sonnetModel, name: 'Fixture Sonnet', description: 'Fixture Sonnet.' },
  { id: opusModel, name: 'Fixture Opus', description: 'Fixture Opus.' },
];
const tool = {
  type: 'function',
  function: {
    name: 'read_local_fixture',
    description: 'Read a fixture in the Harness execution directory on A.',
    parameters: { type: 'object', properties: { relativePath: { type: 'string' } }, required: ['relativePath'], additionalProperties: false },
  },
};

// This is a protocol fixture, not a Claude implementation. Running a real child
// process catches stdin/argv, cancellation, final-result and encrypted transport
// regressions without signing in to Claude or charging a subscription.
const fakeCli = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.290 (Claude Code)'); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(__dirname, 'calls.ndjson'), JSON.stringify({ args, input }) + '\n');
  const call = { name: 'read_local_fixture', arguments: JSON.stringify({ relativePath: 'harness-only.txt' }) };
  let decision = { content: 'fixture final response', tool_calls: [] };
  if (input.includes('MODEL_TOOL_ROUND')) {
    decision = input.includes('model-local-fixture-result:')
      ? { content: '文件内容：model-local-fixture-result: A-side only', tool_calls: [] }
      : { content: '', tool_calls: [call] };
  }
  if (input.includes('MODEL_BAD_UNKNOWN_TOOL')) decision.tool_calls = [{ ...call, name: 'not_offered_by_harness' }];
  if (input.includes('MODEL_BAD_JSONARGS')) decision.tool_calls = [{ ...call, arguments: '{broken' }];
  if (input.includes('MODEL_BAD_ARRAYARGS')) decision.tool_calls = [{ ...call, arguments: '[]' }];
  if (input.includes('MODEL_BAD_NONE')) decision.tool_calls = [call];
  if (input.includes('MODEL_BAD_FORCED')) decision.tool_calls = [{ ...call, name: 'other_offered_tool' }];
  if (input.includes('MODEL_BAD_PARALLEL')) decision.tool_calls = [call, call];
  if (input.includes('MODEL_ALPHA')) decision.content = 'A-one isolated response';
  if (input.includes('MODEL_BETA')) decision.content = 'A-two isolated response';
  const finish = () => {
    const result = { type: 'result', subtype: 'success', is_error: false, session_id: randomUUID(), num_turns: 2,
      usage: { input_tokens: 17, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      structured_output: decision };
    if (input.includes('MODEL_BAD_MISSING')) { delete result.structured_output; result.result = JSON.stringify(decision); }
    if (input.includes('MODEL_BAD_IS_ERROR')) { result.is_error = true; result.result = 'fixture provider error'; }
    if (input.includes('MODEL_BAD_SUBTYPE')) { result.subtype = 'error_max_structured_output_retries'; result.errors = ['fixture schema retries exhausted']; }
    if (input.includes('MODEL_BAD_SHAPE')) result.structured_output = { content: 42, tool_calls: [] };
    console.log(JSON.stringify(result));
  };
  if (input.includes('MODEL_SLOW')) setTimeout(finish, 30000);
  else finish();
});
`;

async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for model bridge condition');
}

async function setup(t, { join = true, clients = 1 } = {}) {
  await mkdir(path.join(root, '.bridge'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.bridge', 'model-api-test-'));
  const workspace = path.join(directory, 'B');
  const harnessDirectory = path.join(directory, 'A');
  await mkdir(workspace); await mkdir(harnessDirectory);
  const command = path.join(workspace, 'fake-cli.cjs');
  await writeFile(command, fakeCli);
  await writeFile(path.join(harnessDirectory, 'harness-only.txt'), 'model-local-fixture-result: A-side only');
  const catalog = { models: structuredClone(fixtureModels), error: null, probes: 0 };
  const host = new Bridge({ demo: true, modelCatalogProvider: async () => {
    ++catalog.probes;
    if (catalog.error) throw catalog.error;
    return structuredClone(catalog.models);
  } });
  const peers = [];
  const apps = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    await host.disconnect();
    await until(() => host.active.size === 0).catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const state = await host.host({ workspace, bridgePort: 0, profile: 'develop', maxTurns: 5, timeoutMs: 10000 });
  // Keep demo's loopback transport while selecting the production subprocess
  // runner. It must never execute demo-claude.js for these model API tests.
  host.config.demo = false;
  host.config.claudeCommand = command;
  for (let index = 0; index < clients; index++) {
    const bridge = new Bridge({ demo: true });
    const app = createLocalServer({ port: 0, token, bridge });
    apps.push(app);
    const address = await app.listen();
    peers.push({ bridge, url: `http://127.0.0.1:${address.port}` });
    if (join) await bridge.join({ invitation: state.invitation });
  }
  if (join) await until(() => host.status().connectedClients === clients && peers.every(({ bridge }) => bridge.status().online));
  const calls = async () => {
    try { return (await readFile(path.join(workspace, 'calls.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { host, peers, client: peers[0].bridge, url: peers[0].url, harnessDirectory, calls, catalog };
}

function request(url, route, body, headers = {}) {
  return fetch(`${url}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function completion(content = 'MODEL_PLAIN', extra = {}) {
  return { model, messages: [{ role: 'user', content }], stream: false, ...extra };
}

function readSse(text) {
  return text.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    return data ? [data === '[DONE]' ? '[DONE]' : JSON.parse(data)] : [];
  });
}

function assertModelError(body) {
  assert.equal(typeof body.error, 'object', JSON.stringify(body));
  assert.equal(typeof body.error.message, 'string', JSON.stringify(body));
  assert.ok(body.error.message.length > 0);
}

test('model API authenticates and reports that an unpaired A cannot discover B models', { timeout: 15000 }, async (t) => {
  const { url } = await setup(t, { join: false });
  assert.equal((await fetch(`${url}/v1/models`)).status, 401);
  assert.equal((await request(url, '/v1/models', undefined, { Authorization: 'Bearer incorrect' })).status, 401);
  const listing = await request(url, '/v1/models');
  assert.equal(listing.status, 503);
  const list = await listing.json();
  assertModelError(list);
  assert.equal('data' in list, false);
  const response = await request(url, '/v1/chat/completions', completion());
  assert.equal(response.status, 503);
  assertModelError(await response.json());
});

test('A discovers B account models and receives additions and removals across both encrypted connections', { timeout: 20000 }, async (t) => {
  const { peers, calls, catalog } = await setup(t, { clients: 2 });
  const initial = await request(peers[0].url, '/v1/models');
  assert.equal(initial.status, 200);
  const initialList = await initial.json();
  assert.equal(initialList.object, 'list');
  assert.deepEqual(initialList.data.map((entry) => entry.id).sort(), fixtureModels.map((entry) => entry.id).sort());
  assert.ok(initialList.data.every((entry) => entry.object === 'model'));
  assert.equal(initialList.data.some((entry) => ['claude-code', 'claude-code-sonnet', 'claude-code-opus'].includes(entry.id)), false);
  const newModel = 'vendor/claude-next-fixture:preview[1m]';
  catalog.models = [{ id: newModel, name: 'New account model', description: 'Added after pairing.' }];
  await peers[0].bridge.refreshModels();
  await until(() => peers.every(({ bridge }) => bridge.modelStatus().models?.some((entry) => entry.id === newModel)));
  for (const peer of peers) {
    const listing = await request(peer.url, '/v1/models');
    assert.equal(listing.status, 200);
    assert.deepEqual((await listing.json()).data.map((entry) => entry.id), [newModel]);
    const selected = await request(peer.url, '/v1/chat/completions', completion('MODEL_PLAIN', { model: newModel }));
    assert.equal(selected.status, 200);
    assert.equal((await selected.json()).model, newModel);
  }
  const removed = await request(peers[0].url, '/v1/chat/completions', completion('removed model', { model: sonnetModel }));
  assert.equal(removed.status, 400);
  assertModelError(await removed.json());
  const recorded = await calls();
  assert.equal(recorded.length, 2);
  assert.ok(recorded.every((entry) => entry.args[entry.args.indexOf('--model') + 1] === newModel));
});

test('catalog refresh failures surface as errors instead of advertising an empty or fixed model list', { timeout: 15000 }, async (t) => {
  const { host, client, url, catalog, calls } = await setup(t);
  assert.equal((await request(url, '/v1/models')).status, 200);
  catalog.error = new Error('Fixture model catalog authentication failure');
  await assert.rejects(host.refreshModels(), /catalog authentication failure/);
  await until(() => client.modelStatus().modelsState === 'error');
  const listing = await request(url, '/v1/models');
  assert.ok(listing.status >= 500);
  const body = await listing.json();
  assertModelError(body);
  assert.match(body.error.message, /catalog authentication failure/);
  assert.equal('data' in body, false);
  const blocked = await request(url, '/v1/chat/completions', completion());
  assert.ok(blocked.status >= 500);
  assertModelError(await blocked.json());
  assert.equal((await calls()).length, 0);
  catalog.error = null;
  await host.refreshModels();
  await until(() => client.modelStatus().modelsState === 'ready');
  assert.equal((await request(url, '/v1/models')).status, 200);
});

test('a model decision becomes a real Harness-side tool call, then returns the tool result to B', { timeout: 20000 }, async (t) => {
  const { url, calls, harnessDirectory, host } = await setup(t);
  const messages = [
    { role: 'system', content: 'System instructions from the Harness.' },
    { role: 'developer', content: 'Tools execute on A. Return the requested file content.' },
    { role: 'user', content: 'MODEL_TOOL_ROUND: read harness-only.txt on A.' },
  ];
  const first = await request(url, '/v1/chat/completions', completion('', { model: sonnetModel, messages, tools: [tool], tool_choice: 'required', max_completion_tokens: 1000, temperature: 0.2, top_p: 0.9, n: 1 }));
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.object, 'chat.completion');
  const choice = firstBody.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.role, 'assistant');
  assert.equal(choice.message.tool_calls.length, 1);
  const invocation = choice.message.tool_calls[0];
  assert.ok(invocation.id);
  assert.equal(invocation.type, 'function');
  assert.equal(invocation.function.name, tool.function.name);
  const args = JSON.parse(invocation.function.arguments);
  assert.deepEqual(args, { relativePath: 'harness-only.txt' });
  // Execute on A in the test's Harness fixture. B's workspace has no such file.
  const output = await readFile(path.join(harnessDirectory, args.relativePath), 'utf8');
  await assert.rejects(readFile(path.join(host.config.workspace, args.relativePath)), { code: 'ENOENT' });
  messages.push(choice.message, { role: 'tool', tool_call_id: invocation.id, content: output });
  const second = await request(url, '/v1/chat/completions', completion('', { model: sonnetModel, messages, tools: [tool], tool_choice: 'auto' }));
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.choices[0].finish_reason, 'stop');
  assert.match(secondBody.choices[0].message.content, /model-local-fixture-result: A-side only/);
  const recorded = await calls();
  assert.equal(recorded.length, 2);
  assert.match(recorded[1].input, new RegExp(invocation.id));
  assert.match(recorded[1].input, /model-local-fixture-result: A-side only/);
  for (const entry of recorded) {
    assert.equal(entry.args[entry.args.indexOf('--tools') + 1], '');
    assert.ok(entry.args.includes('--safe-mode'));
    assert.equal(entry.args.includes('--bare'), false);
    assert.equal(entry.args[entry.args.indexOf('--disallowedTools') + 1], 'mcp__*');
    assert.ok(entry.args.includes('--no-session-persistence'));
    assert.ok(entry.args.includes('--strict-mcp-config'));
    assert.deepEqual(JSON.parse(entry.args[entry.args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
    assert.equal(entry.args.includes('--resume'), false);
    assert.equal(entry.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(entry.args.includes('--allowedTools'), false);
    assert.ok(entry.args.includes('--json-schema'));
    JSON.parse(entry.args[entry.args.indexOf('--json-schema') + 1]);
    assert.equal(entry.args[entry.args.indexOf('--model') + 1], sonnetModel);
  }
});

test('buffered SSE contains standard deltas, finish reason, usage and one completion sentinel', { timeout: 15000 }, async (t) => {
  const { url } = await setup(t);
  const response = await request(url, '/v1/chat/completions', completion('MODEL_TOOL_ROUND', { stream: true, tools: [tool], stream_options: { include_usage: true } }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = readSse(await response.text());
  assert.equal(events.at(-1), '[DONE]');
  assert.equal(events.filter((entry) => entry === '[DONE]').length, 1);
  const chunks = events.filter((entry) => entry !== '[DONE]');
  assert.ok(chunks.every((chunk) => chunk.object === 'chat.completion.chunk'));
  assert.equal(new Set(chunks.map((chunk) => chunk.id)).size, 1);
  assert.ok(chunks.some((chunk) => chunk.choices[0]?.delta.role === 'assistant'));
  const deltas = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls || []);
  assert.ok(deltas.some((call) => call.function?.name === tool.function.name));
  assert.deepEqual(JSON.parse(deltas.map((call) => call.function?.arguments || '').join('')), { relativePath: 'harness-only.txt' });
  assert.ok(chunks.some((chunk) => chunk.choices[0]?.finish_reason === 'tool_calls'));
  const usage = chunks.find((chunk) => chunk.choices.length === 0 && chunk.usage);
  assert.ok(usage, JSON.stringify(chunks));
  assert.equal(typeof usage.usage.prompt_tokens, 'number');
  assert.equal(typeof usage.usage.completion_tokens, 'number');
});

test('text-only streaming forwards the selected account model and omits an unrequested usage frame', { timeout: 15000 }, async (t) => {
  const { url, calls } = await setup(t);
  const response = await request(url, '/v1/chat/completions', completion('MODEL_PLAIN', {
    model: opusModel, stream: true, max_tokens: 1024, tools: [tool], tool_choice: 'none',
  }));
  assert.equal(response.status, 200);
  const events = readSse(await response.text());
  assert.equal(events.at(-1), '[DONE]');
  const chunks = events.filter((entry) => entry !== '[DONE]');
  assert.equal(chunks.map((chunk) => chunk.choices[0]?.delta.content || '').join(''), 'fixture final response');
  assert.ok(chunks.some((chunk) => chunk.choices[0]?.finish_reason === 'stop'));
  assert.equal(chunks.some((chunk) => chunk.choices.length === 0), false);
  assert.equal(chunks.some((chunk) => chunk.choices[0]?.delta.tool_calls?.length), false);
  const [recorded] = await calls();
  assert.equal(recorded.args[recorded.args.indexOf('--model') + 1], opusModel);
});

test('invalid model inputs fail before dispatch and do not break the paired connection', { timeout: 15000 }, async (t) => {
  const { url, calls, client } = await setup(t);
  const cases = [
    completion('bad model', { model: 'not-a-bridge-model' }),
    completion('multiple choices', { n: 2 }),
    completion('not text', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/pic.png' } }] }] }),
    completion('audio', { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } }] }] }),
    completion('schema', { response_format: { type: 'json_schema', json_schema: { name: 'bad', schema: { type: 'object' } } } }),
    completion('invalid response format', { response_format: false }),
    completion('missing function name', { tools: [{ type: 'function', function: { parameters: { type: 'object' } } }] }),
    completion('numeric function name', { tools: [{ ...tool, function: { ...tool.function, name: 123 } }] }),
    completion('unknown required tool', { tools: [tool], tool_choice: { type: 'function', function: { name: 'absent' } } }),
    completion('orphan tool result', { messages: [{ role: 'tool', tool_call_id: 'missing', content: 'orphan' }] }),
    completion('numeric history call ID', { tools: [tool], messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 123, type: 'function', function: { name: tool.function.name, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 123, content: 'bad' },
    ] }),
    completion('numeric history function name', { tools: [tool], messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_old', type: 'function', function: { name: 123, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_old', content: 'bad' },
    ] }),
  ];
  for (const body of cases) {
    const response = await request(url, '/v1/chat/completions', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assertModelError(await response.json());
  }
  assert.equal((await calls()).length, 0);
  assert.equal(client.status().online, true);
});

test('missing, failed or invalid structured decisions are errors rather than successful assistant text', { timeout: 30000 }, async (t) => {
  const { url } = await setup(t);
  const cases = [
    ['MODEL_BAD_MISSING', {}],
    ['MODEL_BAD_IS_ERROR', {}],
    ['MODEL_BAD_SUBTYPE', {}],
    ['MODEL_BAD_SHAPE', {}],
    ['MODEL_BAD_UNKNOWN_TOOL', { tools: [tool] }],
    ['MODEL_BAD_JSONARGS', { tools: [tool] }],
    ['MODEL_BAD_ARRAYARGS', { tools: [tool] }],
    ['MODEL_BAD_REQUIRED', { tools: [tool], tool_choice: 'required' }],
    ['MODEL_BAD_NONE', { tools: [tool], tool_choice: 'none' }],
    ['MODEL_BAD_FORCED', { tools: [tool, { ...tool, function: { ...tool.function, name: 'other_offered_tool' } }], tool_choice: { type: 'function', function: { name: tool.function.name } } }],
    ['MODEL_BAD_PARALLEL', { tools: [tool], parallel_tool_calls: false }],
  ];
  for (const [label, extra] of cases) {
    const response = await request(url, '/v1/chat/completions', completion(label, extra));
    assert.equal(response.status, 502, label);
    assertModelError(await response.json());
  }
  const stream = await request(url, '/v1/chat/completions', completion('MODEL_BAD_MISSING', { stream: true }));
  assert.equal(stream.status, 200);
  const events = readSse(await stream.text());
  assert.ok(events.some((event) => typeof event.error?.message === 'string'));
  assert.equal(events.includes('[DONE]'), false);
  assert.equal(events.some((event) => event.choices?.some((choice) => choice.finish_reason === 'stop')), false);
});

test('model history larger than the legacy task prompt limit crosses the encrypted bridge', { timeout: 15000 }, async (t) => {
  const { url, calls, client } = await setup(t);
  const content = `MODEL_PLAIN ${'多轮模型历史'.repeat(18000)}`;
  assert.ok(Buffer.byteLength(content) > 180 * 1024);
  const accepted = await request(url, '/v1/chat/completions', completion(content));
  assert.equal(accepted.status, 200);
  assert.match((await accepted.json()).choices[0].message.content, /fixture final response/);
  assert.ok((await calls())[0].input.includes(content));
  const oversized = await request(url, '/v1/chat/completions', completion('x'.repeat(4 * 1024 * 1024)));
  assert.ok([400, 413].includes(oversized.status));
  assertModelError(await oversized.json());
  assert.equal(client.status().online, true);
  assert.equal((await calls()).length, 1);
});

test('model cancellation and two-A queuing isolate subprocesses and results', { timeout: 20000 }, async (t) => {
  const { host, peers, calls } = await setup(t, { clients: 2 });
  const [a, b] = peers;
  const first = request(a.url, '/v1/chat/completions', completion('MODEL_SLOW MODEL_ALPHA'));
  await until(async () => host.active.size === 1 && (await calls()).length === 1);
  const second = request(b.url, '/v1/chat/completions', completion('MODEL_BETA'));
  await until(() => host.queue.length === 1);
  const [firstId] = a.bridge.pending.keys();
  assert.ok(firstId);
  assert.equal((await request(a.url, `/v1/requests/${firstId}/cancel`, {})).status, 202);
  const cancelled = await first;
  assert.equal(cancelled.status, 499);
  assertModelError(await cancelled.json());
  const completed = await second;
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).choices[0].message.content, 'A-two isolated response');
  await until(() => host.active.size === 0 && host.queue.length === 0 && peers.every(({ bridge }) => bridge.pending.size === 0));
  const next = await request(a.url, '/v1/chat/completions', completion('MODEL_ALPHA'));
  assert.equal(next.status, 200);
  assert.equal((await next.json()).choices[0].message.content, 'A-one isolated response');
  assert.equal((await calls()).length, 3);
});

test('aborting the Harness HTTP stream terminates its B subprocess and releases the A slot', { timeout: 15000 }, async (t) => {
  const { host, client, url, calls } = await setup(t);
  const controller = new AbortController();
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(completion('MODEL_SLOW HTTP cancellation', { stream: true })), signal: controller.signal,
  });
  assert.equal(response.status, 200);
  await until(async () => host.active.size === 1 && (await calls()).length === 1);
  controller.abort();
  await assert.rejects(response.text(), { name: 'AbortError' });
  await until(() => host.active.size === 0 && client.pending.size === 0);
  const next = await request(url, '/v1/chat/completions', completion());
  assert.equal(next.status, 200);
  assert.equal((await next.json()).choices[0].finish_reason, 'stop');
  assert.equal((await calls()).length, 2);
});

test('a dropped model connection fails once and accepts a fresh request after reconnecting', { timeout: 20000 }, async (t) => {
  const { host, client, url, calls } = await setup(t);
  client.peer.retryMs = 50;
  const pending = request(url, '/v1/chat/completions', completion('MODEL_SLOW disconnect without replay'));
  await until(async () => host.active.size === 1 && (await calls()).length === 1);
  client.peer.ws.terminate();
  const failed = await pending;
  assert.equal(failed.status, 503);
  assertModelError(await failed.json());
  await until(() => host.active.size === 0 && client.status().online && host.status().online);
  const recovered = await request(url, '/v1/chat/completions', completion('MODEL_PLAIN fresh request'));
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).choices[0].finish_reason, 'stop');
  assert.equal((await calls()).length, 2);
});

test('an admission failure after an immediate error callback is handled once and cancels its request', { timeout: 10000 }, async (t) => {
  let aborted = false;
  const bridge = {
    async getModels() { return structuredClone(fixtureModels); },
    run(_request, emit, signal) {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      emit({ type: 'error', code: 'IMMEDIATE_FAILURE', message: 'Immediate provider admission failure' });
      throw new Error('Admission threw after reporting its failure');
    },
    async disconnect() {},
  };
  const app = createLocalServer({ port: 0, token, bridge });
  t.after(() => app.close());
  const address = await app.listen();
  const response = await request(`http://127.0.0.1:${address.port}`, '/v1/chat/completions', completion());
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /Admission threw/);
  assert.equal(aborted, true);
});
