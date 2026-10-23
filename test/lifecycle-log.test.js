import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLifecycleLog, safeError } from '../src/lifecycle-log.js';
import { EmbeddedNetwork } from '../src/embedded-network.js';
import { version } from '../src/version.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const mainUrl = pathToFileURL(path.join(root, 'src', 'main.js')).href;
const lifecycleUrl = pathToFileURL(path.join(root, 'src', 'lifecycle-log.js')).href;
const secret = 'SECRET_DO_NOT_LOG_token_proxy_203.0.113.4';
const base = path.join(root, '.bridge');
async function directory(t) {
  await mkdir(base, { recursive: true });
  const value = await mkdtemp(path.join(base, 'lifecycle-test-'));
  t.after(async () => {
    assert.equal(path.dirname(value), base);
    assert.match(path.basename(value), /^lifecycle-test-/);
    await rm(value, { recursive: true, force: true });
  });
  return value;
}
const logFile = (value) => path.join(value, 'diagnostics', 'lifecycle', 'runtime.jsonl');
async function records(value) { return (await readFile(logFile(value), 'utf8')).trim().split('\n').map(JSON.parse); }
async function runFixture(t, value, body, { env = {} } = {}) {
  const fixture = path.join(value, 'fixture.mjs');
  await writeFile(fixture, body);
  const child = spawn(process.execPath, [fixture], { cwd: root, windowsHide: true,
    env: { ...process.env, BRIDGE_LIFECYCLE_SESSION: 'fixture-session-1', BRIDGE_API_TOKEN: 'fixture-api-token', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output = (output + data).slice(-65536); });
  const timer = setTimeout(() => child.kill(), 15000);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const [code, signal] = await closed;
  clearTimeout(timer);
  return { code, signal, output };
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function mainFixture(value, port, action) {
  return `process.argv = [process.execPath, 'src/main.js', '--demo', '--data-dir', ${JSON.stringify(value)}, '--port', '${port - 1}'];
    await import(${JSON.stringify(mainUrl)});
    ${action}`;
}

test('API shutdown records its source, successful cleanup, and final process exit', { timeout: 20000 }, async (t) => {
  const value = await directory(t), port = await freePort();
  const result = await runFixture(t, value, mainFixture(value, port, `
    const response = await fetch('http://127.0.0.1:${port}/api/shutdown', { method: 'POST', headers: { Authorization: 'Bearer fixture-api-token', 'Content-Type': 'application/json' }, body: '{}' });
    if (response.status !== 200) process.exit(9);`));
  assert.equal(result.code, 0, result.output);
  const rows = await records(value);
  assert.equal(rows[0].event, 'startup'); assert.ok(rows.some((row) => row.event === 'ready'));
  assert.equal(rows.find((row) => row.event === 'shutdown-requested').reason, 'api-shutdown');
  assert.ok(rows.some((row) => row.event === 'shutdown-complete' && row.code === 0));
  assert.equal(rows.at(-1).event, 'exit'); assert.equal(rows.at(-1).shutdownSource, 'api-shutdown');
  assert.equal(rows.at(-1).code, 0);
  assert.ok(rows.every((row) => row.sessionId === 'fixture-session-1' && row.v === 1 && row.version === version && row.component === 'runtime'));
});

test('signal handlers retain the exact signal as the shutdown source', { timeout: 20000 }, async (t) => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const value = await directory(t), port = await freePort();
    // Windows TerminateProcess does not deliver POSIX signals. Emit the Node
    // signal event there; Unix exercises the actual OS delivery as well.
    const result = await runFixture(t, value, mainFixture(value, port,
      process.platform === 'win32' ? `process.emit('${signal}');` : `process.kill(process.pid, '${signal}');`));
    assert.equal(result.code, 0, result.output);
    const rows = await records(value);
    assert.equal(rows.at(-1).shutdownSource, `signal-${signal}`);
    assert.equal(rows.find((row) => row.event === 'shutdown-requested').reason, `signal-${signal}`);
  }
});

test('uncaught exceptions and unhandled rejections retain default fatal exit semantics and omit secrets', { timeout: 20000 }, async (t) => {
  for (const [reason, action] of [['uncaught-exception', `setImmediate(() => { throw new TypeError('${secret}'); });`],
    ['unhandled-rejection', `Promise.reject(Object.assign(new Error('${secret}'), { code: 'EIO' }));`]]) {
    const value = await directory(t), port = await freePort();
    const result = await runFixture(t, value, mainFixture(value, port, action));
    assert.equal(result.code, 1, result.output);
    const rows = await records(value), fatal = rows.find((row) => row.event === 'fatal');
    assert.equal(fatal.reason, reason); assert.ok(['TypeError', 'Error'].includes(fatal.errorName));
    assert.equal(rows.at(-1).event, 'exit'); assert.equal(rows.at(-1).reason, reason); assert.equal(rows.at(-1).code, 1);
    assert.equal(rows.some((row) => row.event === 'shutdown-requested'), false);
    assert.equal((await readFile(logFile(value), 'utf8')).includes(secret), false);
  }
});

test('token loading and constructor failures are classified even before listening', { timeout: 20000 }, async (t) => {
  const tokenDir = await directory(t);
  await writeFile(path.join(tokenDir, 'api-token'), secret);
  const tokenResult = await runFixture(t, tokenDir, mainFixture(tokenDir, await freePort(), ''), { env: { BRIDGE_API_TOKEN: '' } });
  assert.equal(tokenResult.code, 1);
  const tokenRows = await records(tokenDir);
  assert.equal(tokenRows.find((row) => row.event === 'startup-failed').reason, 'token-load');
  assert.equal((await readFile(logFile(tokenDir), 'utf8')).includes(secret), false);
  const constructorDir = await directory(t);
  const constructorResult = await runFixture(t, constructorDir, mainFixture(constructorDir, await freePort(), ''), { env: { BRIDGE_NET_HELPER_ARGS: `${secret}{` } });
  assert.equal(constructorResult.code, 1);
  assert.equal((await records(constructorDir)).find((row) => row.event === 'startup-failed').reason, 'construction');
  assert.equal((await readFile(logFile(constructorDir), 'utf8')).includes(secret), false);
});

test('invalid CLI options log to the launcher-provided data directory before exit', { timeout: 10000 }, async (t) => {
  const value = await directory(t);
  const result = await runFixture(t, value, `process.argv = [process.execPath, 'src/main.js', '--invalid']; await import(${JSON.stringify(mainUrl)});`,
    { env: { BRIDGE_LIFECYCLE_DIRECTORY: value } });
  assert.equal(result.code, 1);
  const rows = await records(value);
  assert.equal(rows.find((row) => row.event === 'startup-failed').reason, 'invalid-options');
  assert.equal(rows.at(-1).event, 'exit');
  assert.ok(rows.every((row) => row.version === version));
});

test('an exit without a known request remains unknown even when its code is zero', { timeout: 10000 }, async (t) => {
  const value = await directory(t);
  const result = await runFixture(t, value, `import { installRuntimeLifecycle } from ${JSON.stringify(lifecycleUrl)};
    installRuntimeLifecycle({ directory: ${JSON.stringify(value)} }); process.exit(0);`);
  assert.equal(result.code, 0);
  assert.equal((await records(value)).at(-1).reason, 'unknown');
});

test('stack locations and error metadata use explicit allowlists and at most twelve source locations', () => {
  const location = pathToFileURL(path.join(root, 'src', 'main.js')).href;
  const error = { name: 'TypeError', code: 'EACCES', message: secret,
    stack: `${secret}\n${Array.from({ length: 20 }, (_, index) => `    at ${secret} (${location}:${index + 1}:2)`).join('\n')}\n    at ${secret} (file:///outside/secret.js:5:8)` };
  const safe = safeError(error);
  assert.equal(safe.errorName, 'TypeError'); assert.equal(safe.errorCode, 'EACCES'); assert.equal(safe.locations.length, 12);
  assert.deepEqual(safe.locations[0], { file: 'main.js', line: 1, column: 2 });
  assert.equal(JSON.stringify(safe).includes(secret), false);
  assert.deepEqual(safeError({ stack: `Error\n    at private (${pathToFileURL(path.join(root, 'src', `${secret}.js`)).href}:1:2)` }), {});
  assert.deepEqual(safeError({ name: secret, code: secret, stack: `${secret}\n    at fake (file:///outside/main.js:1:2)` }), {});
});

test('JSONL is bounded to 512 KiB with two backups and ignores arbitrary fields', async (t) => {
  const value = await directory(t), log = createLifecycleLog({ directory: value, sessionId: secret + '\n' });
  assert.match(log.sessionId, /^[a-zA-Z0-9-]{1,96}$/); assert.notEqual(log.sessionId, secret + '\n');
  const bytes = 512 * 1024;
  for (let round = 0; round < 4; round++) {
    await mkdir(path.dirname(logFile(value)), { recursive: true });
    // A full file always rotates before the next line, preserving whole JSONL
    // records in files created by the logger.
    await writeFile(logFile(value), JSON.stringify({ padding: 'x'.repeat(bytes - 15) }) + '\n');
    assert.equal(log.write('helper-exit', { code: 7, signal: null, ownerRequested: false, reason: secret, token: secret, message: secret }), true);
  }
  assert.deepEqual((await readdir(path.dirname(logFile(value)))).sort(), ['runtime.jsonl', 'runtime.jsonl.1', 'runtime.jsonl.2']);
  for (const name of await readdir(path.dirname(logFile(value)))) {
    const file = path.join(path.dirname(logFile(value)), name);
    assert.ok((await stat(file)).size <= bytes);
    for (const line of (await readFile(file, 'utf8')).trim().split('\n')) JSON.parse(line);
  }
  const rows = await records(value);
  assert.equal(rows[0].code, 7); assert.equal(rows[0].ownerRequested, false); assert.equal(rows[0].reason, undefined);
  assert.equal(JSON.stringify(rows).includes(secret), false);
  assert.equal(log.write(secret), false);
});

test('linked directories, final files, hard links, and backup paths cannot redirect log writes', async (t) => {
  const value = await directory(t), outside = path.join(value, 'outside');
  await mkdir(outside);
  const data = path.join(value, 'data'); await mkdir(data);
  const junction = path.join(data, 'diagnostics');
  try { await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('This account cannot create test links'); return; } throw error; }
  assert.equal(createLifecycleLog({ directory: data }).write('startup'), false);
  assert.deepEqual(await readdir(outside), []);
  await unlink(junction);
  await mkdir(path.dirname(logFile(data)), { recursive: true });
  const target = path.join(outside, 'target'); await writeFile(target, secret);
  // Hard links are rejected on Windows too, where ordinary file symlink
  // creation may require an extra OS privilege.
  await link(target, logFile(data));
  assert.equal(createLifecycleLog({ directory: data }).write('startup'), false);
  assert.equal(await readFile(target, 'utf8'), secret); await unlink(logFile(data));
  await mkdir(logFile(data));
  assert.equal(createLifecycleLog({ directory: data }).write('startup'), false);
  await rmdir(logFile(data));
  await link(target, `${logFile(data)}.1`);
  assert.equal(createLifecycleLog({ directory: data }).write('startup'), false);
  assert.equal(await readFile(target, 'utf8'), secret);
  await unlink(`${logFile(data)}.1`);
  const ancestor = path.join(value, 'ancestor');
  await symlink(data, ancestor, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(createLifecycleLog({ directory: path.join(ancestor, 'nested') }).write('startup'), false);
  await assert.rejects(access(path.join(data, 'nested')));
  await unlink(ancestor);
});

test('an unwritable existing log fails closed without changing file contents', async (t) => {
  const value = await directory(t), file = logFile(value);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'original');
  await chmod(file, 0o444);
  try {
    assert.equal(createLifecycleLog({ directory: value }).write('ready'), false);
    assert.equal(await readFile(file, 'utf8'), 'original');
  } finally { await chmod(file, 0o600); }
});

test('logging failure leaves a child application running and cannot change its exit code', { timeout: 10000 }, async (t) => {
  const value = await directory(t);
  await writeFile(path.join(value, 'diagnostics'), 'blocks-directory-creation');
  const result = await runFixture(t, value, `import { installRuntimeLifecycle } from ${JSON.stringify(lifecycleUrl)};
    const log = installRuntimeLifecycle({ directory: ${JSON.stringify(value)} });
    if (log.write('ready') !== false) process.exit(9); process.exit(6);`);
  assert.equal(result.code, 6);
  assert.equal(await readFile(path.join(value, 'diagnostics'), 'utf8'), 'blocks-directory-creation');
});

async function helperFixture(t, value, extra = '') {
  const fixture = path.join(value, 'helper.mjs');
  await writeFile(fixture, `import { createInterface } from 'node:readline';
    createInterface({ input: process.stdin }).on('line', (line) => {
      const { id, method } = JSON.parse(line);
      if (method === 'hang') return;
      if (method === 'exit') { process.stderr.write('${secret}'); process.exit(0); }
      process.stdout.write(JSON.stringify({ id, result: {} }) + '\\n');
    }); ${extra}`);
  const core = new EmbeddedNetwork({ directory: value, command: process.execPath, args: [fixture], requestTimeoutMs: 100, shutdownTimeoutMs: 100 });
  t.after(() => core.close());
  return core;
}

test('helper exit zero without an owner request is distinguished from a deliberate stop and restart', { timeout: 10000 }, async (t) => {
  const value = await directory(t), core = await helperFixture(t, value);
  await core.start(); const first = core.child, exited = once(first, 'exit');
  await assert.rejects(core.call('exit')); await exited;
  await core.start(); const second = core.child, closed = once(second, 'close');
  await core.close(); await closed;
  const rows = await records(value);
  assert.ok(rows.some((row) => row.event === 'helper-restart'));
  const firstExit = rows.find((row) => row.event === 'helper-exit' && row.childPid === first.pid);
  assert.equal(firstExit.code, 0); assert.equal(firstExit.ownerRequested, false); assert.equal(firstExit.reason, 'child-exit');
  const secondExit = rows.find((row) => row.event === 'helper-exit' && row.childPid === second.pid);
  assert.equal(secondExit.ownerRequested, true); assert.equal(secondExit.reason, 'owner-close');
  assert.equal((await readFile(logFile(value), 'utf8')).includes(secret), false);
});

test('fatal helper timeouts record the kill and retirement reason without request content', { timeout: 10000 }, async (t) => {
  const value = await directory(t), core = await helperFixture(t, value);
  await core.start(); const child = core.child, exited = once(child, 'exit');
  await assert.rejects(core.call('hang', { private: secret }), /超时/); await exited;
  const rows = await records(value);
  assert.ok(rows.some((row) => row.event === 'helper-timeout-kill' && row.reason === 'request-timeout' && row.ownerRequested));
  assert.ok(rows.some((row) => row.event === 'helper-retired' && row.reason === 'request-timeout'));
  assert.equal(rows.find((row) => row.event === 'helper-exit').reason, 'request-timeout');
  assert.equal((await readFile(logFile(value), 'utf8')).includes(secret), false);
});
