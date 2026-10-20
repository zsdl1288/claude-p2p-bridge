import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runClaude, probeClaude, resolveClaude } from '../src/runner.js';

async function fixture(t, source) {
  await mkdir('.bridge', { recursive: true });
  const directory = await mkdtemp(path.resolve('.bridge/runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fake-cli.cjs');
  await writeFile(file, source);
  return { workspace: directory, claudeCommand: file, profile: 'read', timeoutMs: 10000, maxTurns: 1 };
}

test('stderr counts toward the total output limit and a noisy CLI is terminated', { timeout: 15000 }, async (t) => {
  const config = await fixture(t, "const chunk = Buffer.alloc(65536, 'e'); function write() { while (process.stderr.write(chunk)) {} process.stderr.once('drain', write); } process.stdin.resume(); write();");
  const events = [];
  await runClaude(config, { prompt: 'limit test' }, (event) => events.push(event), new AbortController().signal);
  assert.equal(events.filter((event) => event.type === 'done').length, 1);
  assert.match(events.find((event) => event.type === 'error')?.message || '', /16 MiB/);
  assert.equal(events.at(-1).cancelled, false);
});

test('CLI probing drains stderr and reports its diagnostic on failure', { timeout: 10000 }, async (t) => {
  const config = await fixture(t, "process.stderr.write('not logged in\\n' + 'x'.repeat(256 * 1024)); process.exitCode = 1;");
  const result = await probeClaude(config.claudeCommand);
  assert.equal(result.available, false);
  assert.match(result.message, /not logged in/);
  assert.notEqual(result.message, '版本检测超时');
});

test('CLI discovery ignores empty and relative PATH entries instead of executing a project file', async (t) => {
  const config = await fixture(t, '');
  await writeFile(path.join(config.workspace, process.platform === 'win32' ? 'claude.exe' : 'claude'), 'project file');
  const previous = process.env.PATH;
  const previousDirectory = process.cwd();
  try {
    process.chdir(config.workspace);
    process.env.PATH = ['', '.', 'relative-bin'].join(path.delimiter);
    await assert.rejects(resolveClaude(), /未找到 Claude Code/);
  } finally {
    process.chdir(previousDirectory);
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
  }
});

test('an incomplete stdout line is bounded before a newline arrives', { timeout: 10000 }, async (t) => {
  const config = await fixture(t, "process.stdout.write('x'.repeat(1024 * 1024 + 1)); process.stdin.resume(); setInterval(() => {}, 1000);");
  config.timeoutMs = 2000;
  const events = [];
  await runClaude(config, { prompt: 'bounded incomplete line' }, (event) => events.push(event), new AbortController().signal);
  assert.match(events.find((event) => event.type === 'error')?.message || '', /单行输出超过 1024 KiB/);
  assert.equal(events.at(-1).type, 'done');
});

test('CLI stdout rejects invalid UTF-8 instead of changing a structured response silently', { timeout: 10000 }, async (t) => {
  const config = await fixture(t, "process.stdout.write(Buffer.from([123,34,120,34,58,34,255,34,125,10])); process.stdin.resume(); setInterval(() => {}, 1000);");
  const events = [];
  await runClaude(config, { prompt: 'invalid output' }, (event) => events.push(event), new AbortController().signal);
  assert.match(events.find((event) => event.type === 'error')?.message || '', /有效的 UTF-8/);
  assert.equal(events.some((event) => event.type === 'claude'), false);
});

test('both pipes preserve fragmented UTF-8, CRLF and a final event without a newline', { timeout: 10000 }, async (t) => {
  const config = await fixture(t, "(async () => { for (const byte of Buffer.from('网络🔒提示')) { process.stderr.write(Buffer.from([byte])); await new Promise(r => setTimeout(r, 10)); } for (const byte of Buffer.from(JSON.stringify({type:'system', text:'中文🔒'})+'\\r\\n')) { process.stdout.write(Buffer.from([byte])); await new Promise(r => setTimeout(r, 2)); } process.stdout.write(JSON.stringify({type:'result', result:'ok'})); })();");
  const events = [];
  await runClaude(config, { prompt: 'fragmented stderr' }, (event) => events.push(event), new AbortController().signal);
  assert.equal(events.filter((event) => event.type === 'stderr').map((event) => event.text).join(''), '网络🔒提示');
  assert.equal(events.find((event) => event.type === 'claude' && event.event.type === 'system')?.event.text, '中文🔒');
  assert.equal(events.find((event) => event.type === 'claude' && event.event.type === 'result')?.event.result, 'ok');
  assert.equal(events.at(-1).exitCode, 0);
});

test('a consumer failing on started stops the process and completes once', { timeout: 10000 }, async (t) => {
  const config = await fixture(t, 'process.stdin.resume(); setInterval(() => {}, 1000);');
  const events = [];
  await runClaude(config, { prompt: 'broken initial callback' }, (event) => {
    events.push(event); if (event.type === 'started') throw new Error('fixture lost transport');
  }, new AbortController().signal);
  assert.equal(events.filter((event) => event.type === 'done').length, 1);
  assert.match(events.find((event) => event.type === 'error')?.message || '', /传输中断/);
});
