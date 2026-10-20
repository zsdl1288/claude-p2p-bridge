import test from 'node:test';
import assert from 'node:assert/strict';
import { modelInputLimit, modelUsage, normalizeChatRequest } from '../src/model-protocol.js';
import { modelError } from '../src/model-api.js';

const request = (extra = {}) => ({ model: 'claude-code', messages: [{ role: 'user', content: 'next step' }], ...extra });
const minimalTools = Array.from({ length: 128 }, (_, index) => ({ type: 'function', function: { name: `tool_${index}` } }));

test('normalization preserves dynamic provider model IDs without a fixed model allowlist', () => {
  for (const model of ['haiku', 'claude-opus-future-20261020', 'sonnet[1m]', 'provider/claude-new:preview[1m]']) {
    const canonical = normalizeChatRequest(request({ model }));
    assert.equal(canonical.model, model);
    assert.deepEqual(normalizeChatRequest(canonical), canonical);
  }
  // Membership is checked against B's live catalog by Bridge, while malformed
  // names must still fail before they can become a subprocess argument.
  for (const model of ['', ' --model', '--dangerously-skip-permissions', 'claude\n--unsafe', 'claude\0x', 1, {}, 'x'.repeat(1025)]) {
    assert.throws(() => normalizeChatRequest(request({ model })), (error) => error.status === 400, JSON.stringify(model));
  }
});

test('normalization remains idempotent across A, B and the CLI, including near-limit tool histories', () => {
  const body = request({ tools: minimalTools });
  body.messages[0].content = 'x'.repeat(modelInputLimit - Buffer.byteLength(JSON.stringify(body)) - 16000);
  const canonical = normalizeChatRequest(body);
  assert.ok(Buffer.byteLength(JSON.stringify(canonical)) <= modelInputLimit);
  assert.deepEqual(normalizeChatRequest(canonical), canonical);
  assert.deepEqual(normalizeChatRequest(normalizeChatRequest(canonical)), canonical);

  const tooLargeAfterDefaults = request({ tools: minimalTools });
  tooLargeAfterDefaults.messages[0].content = 'x'.repeat(modelInputLimit - Buffer.byteLength(JSON.stringify(tooLargeAfterDefaults)) - 1);
  assert.ok(Buffer.byteLength(JSON.stringify(tooLargeAfterDefaults)) < modelInputLimit);
  assert.throws(() => normalizeChatRequest(tooLargeAfterDefaults), (error) => error.status === 400 && /规范化模型请求/.test(error.message));
});

test('message identities and historical assistant refusals survive normalization without becoming user instructions', () => {
  const body = request({ messages: [
    { role: 'system', name: 'coordinator', content: [{ type: 'text', text: 'Policy' }] },
    { role: 'user', name: 'alice', content: 'Original request' },
    { role: 'assistant', content: null, refusal: 'I cannot help with the original request.' },
    { role: 'user', name: 'bob', content: [{ type: 'text', text: 'folder/' }, { type: 'text', text: 'file.txt' }] },
  ] });
  const canonical = normalizeChatRequest(body);
  assert.equal(canonical.messages[0].name, 'coordinator');
  assert.equal(canonical.messages[1].name, 'alice');
  assert.deepEqual(canonical.messages[2], body.messages[2]);
  assert.equal(canonical.messages[3].name, 'bob');
  assert.deepEqual(canonical.messages[3].content, body.messages[3].content);
  assert.deepEqual(normalizeChatRequest(canonical), canonical);
  assert.throws(() => normalizeChatRequest(request({ messages: [{ role: 'user', content: 'x', name: 'spaces are invalid' }] })), /messages.name/);
  assert.throws(() => normalizeChatRequest(request({ messages: [{ role: 'user', content: 'x', refusal: 'invalid role' }] })), /refusal/);
  assert.throws(() => normalizeChatRequest(request({ messages: [{ role: 'assistant', content: null, refusal: [{ type: 'text', text: 'invalid shape' }] }] })), /refusal/);
});

test('unsupported semantic fields are rejected instead of silently weakening the model contract', () => {
  for (const extra of [
    { max_tokens: 100, max_completion_tokens: 200 },
    { tools: [{ type: 'function', function: { name: 'strict_tool', strict: true } }] },
    { tools: [{ type: 'function', function: { name: 'invalid_tool', strict: 'false' } }] },
    { frequency_penalty: 1 }, { presence_penalty: 1 }, { logit_bias: { 100: -100 } },
    { web_search_options: {} }, { verbosity: 'low' }, { service_tier: 'priority' }, { store: true },
    { messages: [{ role: 'assistant', content: null, audio: { id: 'old_audio' } }] },
    { messages: [{ role: 'assistant', content: 'text', function_call: { name: 'legacy', arguments: '{}' } }] },
  ]) assert.throws(() => normalizeChatRequest(request(extra)), (error) => error.status === 400, JSON.stringify(extra));

  assert.doesNotThrow(() => normalizeChatRequest(request({ store: false, logprobs: false, tools: [{ type: 'function', function: { name: 'normal_tool', strict: false } }] })));
});

test('nullable optional fields and an SDK-serialized assistant history normalize to the same default request', () => {
  const messages = [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer', tool_calls: null, refusal: null }, { role: 'user', content: 'next step' }];
  const canonical = normalizeChatRequest(request({ messages, stream: null, n: null, max_tokens: null, max_completion_tokens: 200, temperature: null, top_p: null, reasoning_effort: null, parallel_tool_calls: null, stream_options: null }));
  assert.equal(canonical.max_completion_tokens, 200);
  assert.equal(canonical.parallel_tool_calls, true);
  assert.deepEqual(canonical.messages[1], { role: 'assistant', content: 'answer' });
  assert.deepEqual(normalizeChatRequest(canonical), canonical);
  assert.equal('max_tokens' in canonical, false);
  assert.equal('temperature' in canonical, false);
});

test('usage counters stay non-negative safe integers when upstream counters are malformed or overflow', () => {
  assert.deepEqual(modelUsage({ usage: { input_tokens: 17, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, output_tokens: 9 } }), { prompt_tokens: 25, completion_tokens: 9, total_tokens: 34 });
  assert.deepEqual(modelUsage({ usage: { input_tokens: -1, cache_read_input_tokens: '10', cache_creation_input_tokens: 1.5, output_tokens: Infinity } }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  const max = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(modelUsage({ usage: { input_tokens: max, cache_read_input_tokens: max, output_tokens: max } }), { prompt_tokens: max, completion_tokens: max, total_tokens: max });
});

test('model errors cannot produce invalid HTTP statuses or non-string OpenAI error fields', () => {
  assert.equal(modelError({ status: 0, message: 'A 端尚未连接 B 端' }).status, 503);
  assert.equal(modelError({ status: 700, message: 'bad upstream status' }).status, 502);
  assert.equal(modelError({ status: '499', message: 'string status' }).status, 502);
  assert.equal(modelError({ status: 409, message: 'busy', code: 'busy' }).body.error.code, 'busy');
  for (const error of [null, undefined, 'raw throw', { message: {}, code: {} }]) {
    const failure = modelError(error);
    assert.equal(failure.status, 502);
    assert.equal(typeof failure.body.error.message, 'string');
    assert.equal(typeof failure.body.error.code, 'string');
  }
});
