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

async function discoveryFixture(t) {
  await mkdir('.bridge', { recursive: true });
  const directory = await mkdtemp(path.resolve('.bridge/discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  const env = {
    PATH: '',
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local')
  };
  const create = async (...parts) => {
    const file = path.join(directory, ...parts);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '// CLI discovery fixture');
    return file;
  };
  return { directory, home, env, create, options: { env, home, windowsPath: [] } };
}

const nativeClaude = process.platform === 'win32' ? 'claude.exe' : 'claude';

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

test('CLI discovery gives an absolute PATH installation priority over the user installation', async (t) => {
  const config = await discoveryFixture(t);
  const command = await config.create('path-bin', nativeClaude);
  await config.create('home', '.local', 'bin', nativeClaude);
  config.env.PATH = path.dirname(command);
  assert.deepEqual(await resolveClaude('claude', config.options), { command, prefix: [] });
});

test('CLI discovery finds the user native installation without a PATH entry', async (t) => {
  const config = await discoveryFixture(t);
  const command = await config.create('home', '.local', 'bin', nativeClaude);
  assert.deepEqual(await resolveClaude('claude', config.options), { command, prefix: [] });
});

test('CLI discovery skips a directory named claude and continues searching PATH', async (t) => {
  const config = await discoveryFixture(t);
  await mkdir(path.join(config.directory, 'first-bin', nativeClaude), { recursive: true });
  const command = await config.create('second-bin', nativeClaude);
  config.env.PATH = [path.join(config.directory, 'first-bin'), path.dirname(command)].join(path.delimiter);
  assert.deepEqual(await resolveClaude('claude', config.options), { command, prefix: [] });
});

test('CLI discovery finds an npm installation without a PATH entry', { skip: process.platform !== 'win32' }, async (t) => {
  const config = await discoveryFixture(t);
  const cli = await config.create('home', 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  await config.create('home', 'AppData', 'Roaming', 'npm', 'claude.cmd');
  assert.deepEqual(await resolveClaude('claude', config.options), { command: process.execPath, prefix: [cli] });
});

test('CLI discovery honors an explicit npm prefix without a PATH entry', async (t) => {
  const config = await discoveryFixture(t);
  const cli = await config.create('npm-prefix', ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  config.env.NPM_CONFIG_PREFIX = path.join(config.directory, 'npm-prefix');
  assert.deepEqual(await resolveClaude('claude', config.options), { command: process.execPath, prefix: [cli] });
});

test('CLI discovery supports the legacy user-local npm installation', async (t) => {
  const config = await discoveryFixture(t);
  const cli = await config.create('home', '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  assert.deepEqual(await resolveClaude('claude', config.options), { command: process.execPath, prefix: [cli] });
});

test('CLI discovery preserves an explicit absolute JavaScript executable path', async (t) => {
  const config = await discoveryFixture(t);
  const cli = await config.create('explicit', 'custom-cli.cjs');
  assert.deepEqual(await resolveClaude(cli, config.options), { command: process.execPath, prefix: [cli] });
});

test('CLI discovery rejects an explicit relative executable path', async (t) => {
  const config = await discoveryFixture(t);
  const cli = await config.create('project', nativeClaude);
  await assert.rejects(resolveClaude(path.relative(process.cwd(), cli), config.options), /绝对路径/);
});

test('CLI discovery ignores empty and relative PATH entries instead of executing a project file', async (t) => {
  const config = await discoveryFixture(t);
  const projectCli = await config.create('project', nativeClaude);
  config.env.PATH = ['', '.', path.relative(process.cwd(), path.dirname(projectCli))].join(path.delimiter);
  await assert.rejects(resolveClaude('claude', config.options), /未自动定位到 Claude Code/);
});

test('CLI discovery reads a refreshed Windows PATH when the process PATH is stale', { skip: process.platform !== 'win32' }, async (t) => {
  const config = await discoveryFixture(t);
  const command = await config.create('fresh-bin', nativeClaude);
  config.options.windowsPath = [path.dirname(command)];
  assert.deepEqual(await resolveClaude('claude', config.options), { command, prefix: [] });
});

test('the process PATH keeps priority over a refreshed Windows PATH', { skip: process.platform !== 'win32' }, async (t) => {
  const config = await discoveryFixture(t);
  const command = await config.create('process-bin', nativeClaude);
  const refreshed = await config.create('fresh-bin', nativeClaude);
  config.env.PATH = path.dirname(command);
  config.options.windowsPath = [path.dirname(refreshed)];
  assert.deepEqual(await resolveClaude('claude', config.options), { command, prefix: [] });
});

test('CLI discovery finds the newest desktop-bundled Store CLI by semantic version', { skip: process.platform !== 'win32' }, async (t) => {
  const config = await discoveryFixture(t);
  const storeRoot = ['home', 'AppData', 'Local', 'Packages', 'AnthropicPBC.Claude_fixture', 'LocalCache', 'Roaming', 'Claude', 'claude-code'];
  await config.create(...storeRoot, '1.9.9', 'older-hash', nativeClaude);
  const command = await config.create(...storeRoot, '1.10.0', 'newer-hash', nativeClaude);
  assert.deepEqual(await resolveClaude('claude', config.options), { command, prefix: [] });
});

test('CLI discovery checks the user profile when LOCALAPPDATA is redirected', { skip: process.platform !== 'win32' }, async (t) => {
  const config = await discoveryFixture(t);
  config.env.LOCALAPPDATA = path.join(config.directory, 'sandbox', 'AppData', 'Local');
  await mkdir(config.env.LOCALAPPDATA, { recursive: true });
  const command = await config.create('home', 'AppData', 'Local', 'Packages', 'AnthropicPBC.Claude_fixture', 'LocalCache', 'Roaming', 'Claude', 'claude-code', '2.0.0', 'desktop-hash', nativeClaude);
  assert.deepEqual(await resolveClaude('claude', config.options), { command, prefix: [] });
});

test('CLI discovery finds the desktop-bundled CLI in roaming AppData', { skip: process.platform !== 'win32' }, async (t) => {
  const config = await discoveryFixture(t);
  const command = await config.create('home', 'AppData', 'Roaming', 'Claude', 'claude-code', '2.0.0', 'desktop-hash', nativeClaude);
  assert.deepEqual(await resolveClaude('claude', config.options), { command, prefix: [] });
});

test('CLI discovery does not execute the desktop VM CLI', { skip: process.platform !== 'win32' }, async (t) => {
  const config = await discoveryFixture(t);
  await config.create('home', 'AppData', 'Local', 'Packages', 'AnthropicPBC.Claude_fixture', 'LocalCache', 'Roaming', 'Claude', 'claude-code-vm', '99.0.0', 'vm-hash', nativeClaude);
  await assert.rejects(resolveClaude('claude', config.options), /未自动定位到 Claude Code/);
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
