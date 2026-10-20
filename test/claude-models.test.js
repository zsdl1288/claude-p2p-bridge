import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverClaudeModels, normalizeModels } from '../src/claude-models.js';

const modelRows = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', description: 'Default model' },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Long context', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] },
  { value: 'haiku', displayName: 'Haiku', description: 'Fast' }
];

async function fixture(t, action) {
  await mkdir('.bridge', { recursive: true });
  const directory = await mkdtemp(path.resolve('.bridge/claude-models-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const command = path.join(directory, 'cli.cjs');
  await writeFile(command, `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const input = [];
const lines = readline.createInterface({ input: process.stdin });
const send = (request_id, response, subtype = 'success') => console.log(JSON.stringify({ type: 'control_response', response: { subtype, request_id, response } }));
setInterval(() => {}, 1000);
lines.on('line', (line) => {
  const request = JSON.parse(line); input.push(request);
  fs.writeFileSync(path.join(__dirname, 'calls.json'), JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), input, nested: process.env.CLAUDECODE, simple: process.env.CLAUDE_CODE_SIMPLE }));
  ${action}
});
`);
  return { workspace: directory, claudeCommand: command };
}

async function calls(config) {
  for (let i = 0; i < 200; i++) {
    try { return JSON.parse(await readFile(path.join(config.workspace, 'calls.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('CLI fixture did not receive initialize');
}

test('normalization keeps CLI identifiers, filters disabled options and copies only model metadata', () => {
  const raw = [...modelRows, { value: 'blocked', displayName: 'Blocked', disabled: true }];
  raw[0] = { ...raw[0], account: { token: 'fixture-secret' }, apiKey: 'fixture-secret' };
  const result = normalizeModels(raw);
  assert.deepEqual(result.map(({ id }) => id), ['default', 'claude-fable-5-1[1m]', 'haiku']);
  assert.deepEqual(result[0], { id: 'default', name: 'Default', description: 'Default model', resolvedModel: 'claude-opus-5-5' });
  assert.deepEqual(normalizeModels(result), result);
  result[1].supportedEffortLevels.push('medium');
  assert.equal(raw[1].supportedEffortLevels.includes('medium'), false);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
});

test('normalization rejects malformed or ambiguous peer catalogs', () => {
  for (const raw of [null, {}, new Array(257).fill(modelRows[0]), [null], [{ id: '--settings=bad' }], [{ id: 'bad\nmodel' }],
    [{ id: 'good', name: 3 }], [{ id: 'good', supportsEffort: 'yes' }], [{ id: 'good', supportedEffortLevels: ['unknown'] }],
    [{ id: 'good', supportedEffortLevels: ['high', 'high'] }], [{ id: 'good' }, { value: 'good' }]]) {
    assert.throws(() => normalizeModels(raw), /目录无效/);
  }
  assert.deepEqual(normalizeModels([]), []);
  assert.equal(normalizeModels([{ id: 'arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-sonnet-v1:0' }]).length, 1);
});

test('demo discovery is clearly labeled and does not resolve a real CLI', async () => {
  const result = await discoverClaudeModels({ demo: true, claudeCommand: 'missing' });
  assert.deepEqual(result.map(({ id }) => id), ['default', 'sonnet', 'opus']);
  assert.ok(result.every(({ name, description }) => name.includes('演示') && description.includes('模拟')));
});

test('discovery initializes without a prompt, preserves safe auth flags and waits for child termination', { timeout: 10000 }, async (t) => {
  const oldNested = process.env.CLAUDECODE, oldSimple = process.env.CLAUDE_CODE_SIMPLE;
  process.env.CLAUDECODE = 'fixture-nested'; process.env.CLAUDE_CODE_SIMPLE = '1';
  t.after(() => {
    if (oldNested === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = oldNested;
    if (oldSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE; else process.env.CLAUDE_CODE_SIMPLE = oldSimple;
  });
  const config = await fixture(t, `send('unrelated-request', { models: [{ value: 'wrong' }] }); send(request.request_id, { account: { token: 'fixture-secret' }, models: ${JSON.stringify(modelRows)} });`);
  const result = await discoverClaudeModels(config);
  assert.deepEqual(result, normalizeModels(modelRows));
  const recorded = await calls(config);
  assert.equal(recorded.cwd, config.workspace);
  assert.equal(recorded.nested, undefined); assert.equal(recorded.simple, undefined);
  assert.equal(recorded.input.length, 1);
  assert.deepEqual(recorded.input[0].request, { subtype: 'initialize', hooks: {} });
  assert.equal(recorded.input[0].type, 'control_request');
  for (const flag of ['--safe-mode', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(recorded.args.includes(flag));
  assert.equal(recorded.args.includes('--bare'), false);
  assert.equal(recorded.args[recorded.args.indexOf('--tools') + 1], '');
  assert.equal(recorded.args[recorded.args.indexOf('--input-format') + 1], 'stream-json');
  assert.throws(() => process.kill(recorded.pid, 0));
});

test('discovery accepts a fragmented UTF-8 response and a final line without newline', { timeout: 10000 }, async (t) => {
  const config = await fixture(t, `const row = {value:'haiku',displayName:'中文模型',description:'测试'}; const output=Buffer.from(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models:[row]}}})); for (const byte of output) process.stdout.write(Buffer.from([byte])); process.exit(0);`);
  assert.equal((await discoverClaudeModels(config))[0].name, '中文模型');
});

test('discovery reports protocol and initialization failures without exposing account or stderr content', { timeout: 15000 }, async (t) => {
  for (const action of [
    `process.stderr.write('fixture-secret'); console.log('not json');`,
    `console.log(JSON.stringify({type:'control_response',response:{subtype:'success'}}));`,
    `console.log(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:request.request_id,error:'fixture-secret'}}));`,
    `send(request.request_id, { models: [] });`,
    `send(request.request_id, { models: [{ value: 'blocked', disabled: true }] });`,
    `process.stderr.write('fixture-secret'); process.exit(3);`
  ]) {
    const config = await fixture(t, action);
    await assert.rejects(discoverClaudeModels(config), (error) => !error.message.includes('fixture-secret'));
  }
});

test('discovery bounds incomplete stdout and stderr before returning', { timeout: 10000 }, async (t) => {
  for (const action of [
    `process.stdout.write('x'.repeat(1024*1024+1));`,
    `const chunk=Buffer.alloc(65536,'e'); function noisy(){while(process.stderr.write(chunk)){} process.stderr.once('drain',noisy);} noisy();`
  ]) {
    const config = await fixture(t, action);
    await assert.rejects(discoverClaudeModels(config), /超过/);
  }
});

test('aborting discovery tears down its initialized child and pre-aborted discovery never starts', { timeout: 10000 }, async (t) => {
  const config = await fixture(t, '');
  const controller = new AbortController();
  const pending = discoverClaudeModels(config, { signal: controller.signal });
  const assertion = assert.rejects(pending, { name: 'AbortError' });
  const recorded = await calls(config);
  controller.abort();
  await assertion;
  assert.throws(() => process.kill(recorded.pid, 0));
  await assert.rejects(discoverClaudeModels({ claudeCommand: 'missing' }, { signal: controller.signal }), { name: 'AbortError' });
});
