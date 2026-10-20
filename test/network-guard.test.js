import assert from 'node:assert/strict';
import test from 'node:test';
import { NetworkGuard, networkGuardArguments, networkGuardDiagnostics, networkGuardProfile } from '../src/network-guard.js';

test('guard commands cannot turn profile identifiers into shell commands or paths', () => {
  for (const id of ['', '../a', 'a b', 'a;whoami', 'A', '--disable', 'a\nstatus']) assert.throws(() => networkGuardArguments('enable', id));
  assert.throws(() => networkGuardArguments('enable;whoami', 'profile-a'));
  assert.deepEqual(networkGuardArguments('enable', 'profile-a'), ['--network-guard', 'elevate-enable', '--guard-id', 'profile-a']);
  assert.deepEqual(networkGuardArguments('verify', 'profile-a'), ['--network-guard', 'elevate-status', '--guard-id', 'profile-a']);
  assert.equal(networkGuardProfile('.bridge'), networkGuardProfile('.bridge'));
  assert.notEqual(networkGuardProfile('.bridge'), networkGuardProfile('.bridge-other'));
});

test('non-administrator status stays unknown and never requests automatic elevation', async () => {
  const actions = [];
  const guard = new NetworkGuard({ platform: 'win32', profileId: 'profile-a', execute: async (_command, args) => {
    actions.push(args[1]);
    const error = new Error('exit 1');
    error.stdout = JSON.stringify({ error: 'access denied', status: { supported: true, profileId: 'profile-a', state: 'unknown', enabled: false } });
    throw error;
  } });
  assert.equal((await guard.status()).state, 'unknown');
  assert.deepEqual(actions, ['status']);
});

test('guard waits for verified native state and uses a fixed hidden executable without shell', async () => {
  const calls = [];
  const execute = async (...args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ supported: true, profileId: 'profile-a', enabled: true, state: 'enabled', filterCount: 46, expectedFilters: 46 }) };
  };
  const guard = new NetworkGuard({ platform: 'win32', command: 'C:\\Trusted App\\bridge-net.exe', profileId: 'profile-a', execute });
  assert.equal((await guard.enable()).enabled, true);
  assert.equal(calls[0][0], 'C:\\Trusted App\\bridge-net.exe');
  assert.deepEqual(calls[0][1], ['--network-guard', 'elevate-enable', '--guard-id', 'profile-a']);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal('close' in guard, false);
});

test('guard refuses partial, inconsistent, wrong-profile or unverified enabled state', async () => {
  for (const result of [
    { enabled: false, state: 'partial' },
    { enabled: true, state: 'disabled' },
    { enabled: true, state: 'enabled', filterCount: 45, expectedFilters: 46 },
    { enabled: true, state: 'enabled', filterCount: 46, expectedFilters: 46, profileId: 'other' },
  ]) {
    const guard = new NetworkGuard({ platform: 'win32', profileId: 'profile-a', execute: async () => ({ stdout: JSON.stringify({ supported: true, profileId: 'profile-a', ...result }) }) });
    await assert.rejects(guard.enable());
  }
});

test('failed guard changes preserve verified partial rules and their full diagnostics', async () => {
  const status = { supported: true, profileId: 'profile-a', state: 'partial', enabled: false,
    filterCount: 46, expectedFilters: 46, issues: ['changed filter: out-v4-dns', 'verified 42 of 46 required filters'] };
  for (const action of ['enable', 'disable']) {
    const guard = new NetworkGuard({ platform: 'win32', profileId: 'profile-a', execute: async () => ({ stdout: JSON.stringify(status) }) });
    await assert.rejects(guard[action](), (error) => {
      assert.deepEqual(error.guardStatus, status);
      assert.match(error.message, /检测到 46 条过滤规则，预期 46 条/);
      assert.match(error.message, /verified 42 of 46 required filters/);
      assert.match(error.message, action === 'enable' ? /规则已存在但验证未通过/ : /规则仍存在，尚未恢复直连/);
      return true;
    });
    assert.equal(guard.mutating, false);
  }
});

test('brief guard diagnostics retain the verified count after many individual mismatches', () => {
  const status = { filterCount: 46, expectedFilters: 46,
    issues: [...Array.from({ length: 8 }, (_, index) => `changed filter: ${index}`), 'verified 38 of 46 required filters'] };
  const diagnostic = networkGuardDiagnostics(status);
  assert.match(diagnostic, /检测到 46 条过滤规则，预期 46 条/);
  assert.match(diagnostic, /verified 38 of 46 required filters/);
  assert.match(diagnostic, /changed filter: 0/);
  assert.doesNotMatch(diagnostic, /changed filter: 2/);
  assert.match(diagnostic, /另有 6 项诊断信息/);
  assert.equal(status.issues.length, 9);
});

test('failed changes distinguish absent rules from an unreadable protection state', async () => {
  for (const { action, result, message } of [
    { action: 'enable', result: { state: 'disabled', filterCount: 0, expectedFilters: 46 }, message: /未检测到保护规则/ },
    { action: 'disable', result: { state: 'unknown' }, message: /关闭状态未验证，不能确认已恢复直连/ },
  ]) {
    const status = { supported: true, profileId: 'profile-a', enabled: false, ...result };
    const guard = new NetworkGuard({ platform: 'win32', profileId: 'profile-a', execute: async () => ({ stdout: JSON.stringify(status) }) });
    await assert.rejects(guard[action](), (error) => {
      assert.deepEqual(error.guardStatus, status);
      assert.match(error.message, message);
      return true;
    });
  }
});

test('guard never reports recovery while native filters remain or counts are unverified', async () => {
  for (const result of [
    { state: 'disabled', filterCount: 1, expectedFilters: 46 },
    { state: 'disabled', filterCount: -1, expectedFilters: 46 },
    { state: 'disabled', filterCount: 0 },
    { state: 'disabled', filterCount: 0, expectedFilters: 0 },
    { state: 'partial', filterCount: 0, expectedFilters: 46 },
    { state: 'enabled', enabled: true, filterCount: 46, expectedFilters: 46, supported: false },
    { state: 'unsupported', supported: true },
    { state: 'unknown', issues: 'access denied' },
  ]) {
    const guard = new NetworkGuard({ platform: 'win32', profileId: 'profile-a', execute: async () => ({ stdout: JSON.stringify({ supported: true, profileId: 'profile-a', enabled: false, ...result }) }) });
    await assert.rejects(guard.status());
    await assert.rejects(guard.disable());
  }
  for (const result of [null, [], 42, 'disabled']) {
    const guard = new NetworkGuard({ platform: 'win32', profileId: 'profile-a', execute: async () => ({ stdout: JSON.stringify(result) }) });
    await assert.rejects(guard.status(), /状态校验失败/);
  }
  const guard = new NetworkGuard({ platform: 'win32', profileId: 'profile-a', execute: async () => ({ stdout: JSON.stringify({ supported: true, profileId: 'profile-a', enabled: false, state: 'disabled', filterCount: 0, expectedFilters: 46 }) }) });
  assert.equal((await guard.disable()).state, 'disabled');
});

test('guard validates diagnostics before preserving a native unknown error status', async () => {
  const guard = new NetworkGuard({ platform: 'win32', profileId: 'profile-a', execute: async () => {
    const error = new Error('exit 1');
    error.stdout = JSON.stringify({ error: 'access denied', status: { supported: true, profileId: 'profile-a', enabled: false, state: 'unknown', issues: 'not an array' } });
    throw error;
  } });
  await assert.rejects(guard.status(), /无效诊断信息/);
});

test('guard cancellation reports failure and never schedules automatic removal', async () => {
  const actions = [];
  const guard = new NetworkGuard({ platform: 'win32', profileId: 'profile-a', execute: async (_command, args) => {
    actions.push(args[1]);
    const error = new Error('exit 1');
    error.stdout = JSON.stringify({ error: 'administrator authorization was cancelled' });
    throw error;
  } });
  await assert.rejects(guard.enable(), /cancelled/);
  assert.deepEqual(actions, ['elevate-enable']);
});

test('stopping status helpers preserves explicit administrator operations and protection', async () => {
  const calls = [];
  let finishVerification;
  const disabled = { supported: true, profileId: 'profile-a', enabled: false, state: 'disabled', filterCount: 0, expectedFilters: 46 };
  const guard = new NetworkGuard({ platform: 'win32', profileId: 'profile-a', execute: async (_command, args, options) => {
    calls.push(args[1]);
    if (args[1] === 'status') return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('status cancelled')), { once: true });
    });
    assert.equal(options.signal, undefined);
    return new Promise((resolve) => { finishVerification = () => resolve({ stdout: JSON.stringify(disabled) }); });
  } });
  const firstStatus = assert.rejects(guard.status(), /status cancelled/);
  const secondStatus = assert.rejects(guard.status(), /status cancelled/);
  const verification = guard.verify();
  guard.cancelStatus();
  await Promise.all([firstStatus, secondStatus]);
  assert.equal(guard.mutating, true);
  finishVerification();
  assert.equal((await verification).state, 'disabled');
  assert.deepEqual(calls, ['status', 'status', 'elevate-status']);
  assert.equal(guard.statusCalls.size, 0);
  guard.execute = async () => ({ stdout: JSON.stringify(disabled) });
  assert.equal((await guard.status()).state, 'disabled');
});
