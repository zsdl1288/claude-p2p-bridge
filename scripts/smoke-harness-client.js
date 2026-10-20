// Optional compatibility smoke; it never calls an external model or reads a
// real API token. Install the official Harness transport in an isolated fixture:
// npm install --prefix .bridge/harness-client-fixture --ignore-scripts --no-audit --no-fund --package-lock=false @earendil-works/pi-ai@1.1.0
// node scripts/smoke-harness-client.js [.bridge/harness-client-fixture]
// All generated state is beneath .bridge. The runner removes its own temporary
// state; the optional npm fixture can be removed after this command completes.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bridge } from '../src/bridge.js';
import { createLocalServer } from '../src/server.js';
import { temporaryTestDirectory } from './test-support.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = path.join(root, '.bridge');
const clientRoot = path.resolve(root, process.argv[2] || '.bridge/harness-client-fixture');
const piDirectory = path.join(clientRoot, 'node_modules', '@earendil-works', 'pi-ai');
let packageInfo;
try { packageInfo = JSON.parse(await readFile(path.join(piDirectory, 'package.json'), 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.log('SKIP: optional pi-ai fixture absent. See the install command in scripts/smoke-harness-client.js.');
  process.exit(0);
}
assert.equal(packageInfo.version, '1.1.0', 'Use the pinned Harness pi-ai 1.1.0 fixture.');
const resolvedFixtureRoot = await realpath(fixtureRoot);
assert.ok((await realpath(clientRoot)).startsWith(`${resolvedFixtureRoot}${path.sep}`), 'Client dependencies must be isolated under .bridge.');

// Harness applies this performance patch to its own pi-ai 1.1.0 dependency:
// https://github.com/deepseek-ai/deepseek-harness/blob/master/patches/%40earendil-works__pi-ai%401.1.0.patch
// Apply only that OpenAI transport hunk to this disposable fixture, preserving
// final argument parsing. No production dependency or Harness install is edited.
const piApi = path.join(piDirectory, 'dist', 'api', 'openai-completions.js');
assert.ok((await realpath(piApi)).startsWith(`${resolvedFixtureRoot}${path.sep}`), 'Do not patch linked dependencies outside .bridge.');
const source = await readFile(piApi, 'utf8');
const parseDelta = /(block\.partialArgs = \(block\.partialArgs \?\? ""\) \+ toolCall\.function\.arguments;\r?\n)[ \t]*block\.arguments = parseStreamingJson\(block\.partialArgs\);\r?\n/;
if (parseDelta.test(source)) await writeFile(piApi, source.replace(parseDelta, '$1'));
const { stream } = await import(pathToFileURL(piApi));
const { normalizeContext } = await import(pathToFileURL(path.join(piDirectory, 'dist', 'utils', 'transcript.js')));
const { default: OpenAI } = await import(pathToFileURL(path.join(clientRoot, 'node_modules', 'openai', 'index.mjs')));
const sdkVersion = JSON.parse(await readFile(path.join(clientRoot, 'node_modules', 'openai', 'package.json'), 'utf8')).version;

const temporary = await temporaryTestDirectory(fixtureRoot, 'harness-client-run-');
const directory = temporary.directory;
const host = new Bridge({ demo: true });
const client = new Bridge({ demo: true });
const token = 'synthetic-harness-client-smoke-token';
const app = createLocalServer({ port: 0, token, bridge: client });
const bDirectory = path.join(directory, 'B');
const aDirectory = path.join(directory, 'A');
try {
  await mkdir(bDirectory); await mkdir(aDirectory);
  const command = path.join(bDirectory, 'fake-cli.cjs');
  await writeFile(command, String.raw`
let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { text += chunk; });
process.stdin.on('end', () => {
  const decision = text.includes('A_ONLY_TOOL_RESULT')
    ? { content: 'ROUNDTRIP_OK: A_ONLY_TOOL_RESULT', tool_calls: [] }
    : { content: '', tool_calls: [{ name: 'read_harness_file', arguments: '{"relativePath":"a-only.txt"}' }] };
  const result = { type: 'result', subtype: 'success', is_error: false, session_id: '00000000-0000-4000-8000-000000000001',
    usage: { input_tokens: 17, output_tokens: 9 }, structured_output: decision };
  if (text.includes('HARNESS_CLIENT_BAD_RESULT')) delete result.structured_output;
  console.log(JSON.stringify(result));
});
`);
  await writeFile(path.join(aDirectory, 'a-only.txt'), 'A_ONLY_TOOL_RESULT');
  const until = async (check) => {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Bridge did not finish its local pairing.');
  };

  const address = await app.listen();
  const state = await host.host({ workspace: bDirectory, bridgePort: 0, timeoutMs: 10000, maxTurns: 5 });
  host.config.demo = false;
  host.config.claudeCommand = command;
  await client.join({ invitation: state.invitation });
  await until(() => host.status().online && client.status().online);
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  const payloads = [];
  const localOnlyFetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, new URL(baseURL).origin, 'The smoke must never access an external model endpoint.');
    if (request.method === 'POST') payloads.push(JSON.parse(await request.clone().text()));
    return fetch(request);
  };
  const model = {
    id: 'claude-code-sonnet', name: 'Local Bridge Fixture', api: 'openai-completions', provider: 'bridge-smoke',
    baseUrl: baseURL, input: ['text'], reasoning: true, contextWindow: 200000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const tools = [{ name: 'read_harness_file', description: 'Read a file on A.', parameters: {
    type: 'object', properties: { relativePath: { type: 'string' } }, required: ['relativePath'], additionalProperties: false,
  } }];
  const user = { role: 'user', content: 'HARNESS_CLIENT_TOOL_ROUND: read a-only.txt on A.', timestamp: Date.now() };
  const settings = { apiKey: token, maxTokens: 512, temperature: 0.2, reasoningEffort: 'low', fetch: localOnlyFetch, maxRetries: 0 };
  const consume = async (context, options = {}) => {
    const response = stream(model, normalizeContext(context), { ...settings, ...options });
    const events = [];
    for await (const event of response) events.push(event);
    return { events, result: await response.result() };
  };

  const first = await consume({ systemPrompt: 'Execute all requested tools in the Harness on A.', messages: [user], tools }, { toolChoice: 'required' });
  assert.equal(first.result.stopReason, 'toolUse', first.result.errorMessage);
  assert.ok(first.events.some((event) => event.type === 'toolcall_end'));
  const invocation = first.result.content.find((part) => part.type === 'toolCall');
  assert.equal(invocation.name, tools[0].name);
  assert.deepEqual(invocation.arguments, { relativePath: 'a-only.txt' });
  assert.equal(first.result.usage.input, 17);
  assert.equal(first.result.usage.output, 9);
  const wire = payloads[0];
  assert.equal(wire.messages[0].role, 'developer');
  assert.equal(wire.stream, true);
  assert.equal(wire.stream_options.include_usage, true);
  assert.equal(wire.max_completion_tokens, 512);
  assert.equal(wire.store, false);
  assert.equal(wire.tools[0].function.name, tools[0].name);
  assert.equal(wire.tool_choice, 'required');

  // This read is performed by the A fixture after the actual pi-ai parser has
  // completed the tool call. The B workspace contains no a-only.txt.
  const output = await readFile(path.join(aDirectory, invocation.arguments.relativePath), 'utf8');
  await assert.rejects(readFile(path.join(bDirectory, 'a-only.txt')), { code: 'ENOENT' });
  const toolResult = { role: 'toolResult', toolCallId: invocation.id, toolName: invocation.name,
    content: [{ type: 'text', text: output }], isError: false, timestamp: Date.now() };
  const second = await consume({ systemPrompt: 'Execute all requested tools in the Harness on A.', messages: [user, first.result, toolResult], tools });
  assert.equal(second.result.stopReason, 'stop', second.result.errorMessage);
  assert.equal(second.result.content.filter((part) => part.type === 'text').map((part) => part.text).join(''), 'ROUNDTRIP_OK: A_ONLY_TOOL_RESULT');
  assert.equal(payloads[1].messages.find((message) => message.role === 'tool').tool_call_id, invocation.id);
  console.log(`PASS: Harness pi-ai ${packageInfo.version} parses tool SSE, executes A fixture and replays its result for the next response.`);

  const invalid = { systemPrompt: '', messages: [{ role: 'user', content: 'HARNESS_CLIENT_BAD_RESULT', timestamp: Date.now() }], tools: [] };
  const failure = await consume(invalid);
  assert.equal(failure.result.stopReason, 'error');
  assert.ok(failure.events.some((event) => event.type === 'error'));
  assert.match(failure.result.errorMessage, /structured_output/);
  assert.equal(failure.events.some((event) => event.type === 'done'), false);
  console.log('PASS: pi-ai surfaces the bridge SSE error as a terminal error event without a successful completion.');

  const sdk = new OpenAI({ baseURL, apiKey: token, fetch: localOnlyFetch, maxRetries: 0 });
  await assert.rejects(async () => {
    const response = await sdk.chat.completions.create({ model: model.id, messages: [{ role: 'user', content: 'HARNESS_CLIENT_BAD_RESULT' }], stream: true });
    for await (const chunk of response) assert.equal(chunk.choices?.some((choice) => choice.finish_reason === 'stop'), false);
  }, /structured_output/);
  console.log(`PASS: official OpenAI Node SDK ${sdkVersion} throws on the bridge SSE error frame.`);
} finally {
  try { await app.close(); }
  finally {
    try { await host.disconnect(); }
    finally { await temporary.cleanup(); }
  }
}
