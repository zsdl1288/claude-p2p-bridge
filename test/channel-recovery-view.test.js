import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { channelRecoveryText } from '../public/channel-recovery.js';

const notice = (overrides = {}) => ({ id: 1, phase: 'suggested', ageMs: 0, result: null, ...overrides });
const proxy = (overrides = {}, refresh = {}) => ({ channelRecovery: { enabled: true, mode: 'notify', state: 'monitoring', cooldownMs: 0,
  lastReason: null, lastResult: null, notice: null, ...overrides }, channelRefresh: { busy: false, ...refresh } });

test('the production notify mode describes background observation and leaves refresh to the user', () => {
  assert.match(channelRecoveryText(proxy(), 'client'), /持续受阻时仅提示，由你点击“刷新线路”/);
  assert.match(channelRecoveryText(proxy({ notice: notice() }), 'client'), /通道持续受阻，建议点击“刷新线路”/);
  assert.match(channelRecoveryText(proxy({ notice: notice() }), 'client'), /不会自动刷新/);
  assert.doesNotMatch(channelRecoveryText(proxy(), 'client'), /自动恢复中|已切换|已提速|更快线路/);
});

test('only current bounded notice data can produce a suggestion', () => {
  for (const ageMs of [0, 300000]) assert.match(channelRecoveryText(proxy({ notice: notice({ ageMs }) }), 'client'), /建议点击/);
  for (const value of [notice({ id: 0 }), notice({ id: -1 }), notice({ id: 1.5 }), notice({ id: Number.MAX_SAFE_INTEGER + 1 }),
    notice({ id: '1' }), notice({ ageMs: -1 }), notice({ ageMs: 300001 }), notice({ ageMs: NaN }), notice({ ageMs: Infinity }),
    notice({ ageMs: '0' }), notice({ phase: 'private-token' }), notice({ phase: 'suggested', result: 'refreshed' }),
    notice({ result: 'private-error' }), {}]) {
    assert.doesNotMatch(channelRecoveryText(proxy({ notice: value }), 'client'), /建议点击|private-/);
  }
});

test('manual requests take precedence and do not masquerade as automatic suggestions or results', () => {
  for (const mode of ['notify', 'automatic']) {
    const value = proxy({ mode, notice: notice({ phase: mode === 'notify' ? 'suggested' : 'refreshed', result: mode === 'notify' ? null : 'refreshed' }) }, { busy: true });
    assert.match(channelRecoveryText(value, 'client'), /正在按请求刷新 Bridge 通道；后台监测暂缓/);
    assert.doesNotMatch(channelRecoveryText(value, 'client'), /建议点击|已重新探测/);
    assert.match(channelRecoveryText(value, 'host'), /已请求所选 A 刷新通道.*由对应 A 决定/);
  }
  assert.match(channelRecoveryText(proxy({ state: 'refreshing', lastReason: 'manual-refresh' }), 'client'), /按请求刷新/);
});

test('historical recovery fields cannot revive results from an earlier connection', () => {
  const old = proxy({ lastReason: 'download-stall', lastResult: 'refreshed', lastAttemptAgoMs: 0, lastRefreshAgoMs: 0, notice: null });
  assert.doesNotMatch(channelRecoveryText(old, 'client'), /已重新探测|建议点击|本次重新探测/);
  old.channelRecovery.state = 'cooldown'; old.channelRecovery.cooldownMs = 119500;
  assert.match(channelRecoveryText(old, 'client'), /共享冷却还需约 120 秒/);
  assert.doesNotMatch(channelRecoveryText(old, 'client'), /已重新探测/);
  old.channelRecovery.notice = notice({ phase: 'refreshed', result: 'refreshed' });
  assert.doesNotMatch(channelRecoveryText(old, 'client'), /已重新探测/, 'Notify mode cannot present an automatic result from a previous policy');
});

test('automatic test mode reports accepted work and failures without claiming a faster path', () => {
  assert.match(channelRecoveryText(proxy({ mode: 'automatic', notice: notice({ phase: 'refreshing' }) }), 'client'), /正在重新探测当前 Bridge 通道/);
  const done = channelRecoveryText(proxy({ mode: 'automatic', state: 'cooldown', cooldownMs: 2000,
    notice: notice({ phase: 'refreshed', result: 'refreshed' }) }), 'client');
  assert.match(done, /已重新探测，继续观察实际流量/); assert.match(done, /共享冷却还需约 2 秒/);
  assert.doesNotMatch(done, /提速|已切换|更快|备用线路/);
  for (const result of [null, 'cooldown', 'unavailable', 'busy']) {
    assert.match(channelRecoveryText(proxy({ mode: 'automatic', notice: notice({ phase: 'failed', result }) }), 'client'), /本次重新探测未完成，继续观察实际流量/);
  }
  for (const value of [notice(), notice({ phase: 'refreshing', result: 'busy' }), notice({ phase: 'refreshed', result: null }), notice({ phase: 'failed', result: 'refreshed' })]) {
    assert.doesNotMatch(channelRecoveryText(proxy({ mode: 'automatic', notice: value }), 'client'), /已重新探测|本次重新探测未完成|建议点击/);
  }
});

test('B only describes shared channel monitoring and never displays an A automatic result as its own', () => {
  for (const mode of ['notify', 'automatic']) {
    const text = channelRecoveryText(proxy({ mode, notice: notice({ phase: 'refreshed', result: 'refreshed' }) }), 'host');
    assert.match(text, /后台监测共享通道；由对应 A 决定刷新/);
    assert.doesNotMatch(text, /已重新探测|正在重新探测|建议点击/);
  }
  assert.match(channelRecoveryText(proxy({ state: 'waiting' }), 'host'), /等待共享启用、流量或任务空闲/);
  assert.match(channelRecoveryText(proxy({ enabled: false }), 'host'), /未启用.*由对应 A 决定/);
});

test('disabled, unavailable, waiting and budget states do not invent progress or numeric countdowns', () => {
  assert.equal(channelRecoveryText(proxy({ enabled: false, notice: notice() }), 'client'), '后台监测：未启用。');
  assert.match(channelRecoveryText(proxy({ state: 'waiting' }), 'client'), /等待连接、代理流量或任务空闲/);
  assert.match(channelRecoveryText(proxy({ state: 'budget-exhausted' }), 'client'), /通道恢复额度暂时用完/);
  assert.equal(channelRecoveryText(proxy({ notice: notice() }), 'client', { available: false }), '后台监测：本地服务不可用，等待状态更新。');
  for (const cooldownMs of [-1, 120001, NaN, Infinity, '120000', null]) {
    assert.doesNotMatch(channelRecoveryText(proxy({ state: 'cooldown', cooldownMs }), 'client'), /\d|NaN|Infinity/);
  }
  for (const role of [null, undefined, 'private-role']) assert.equal(channelRecoveryText(proxy({ notice: notice() }), role), '后台监测：—');
});

test('unknown and malicious status values render fixed text without raw error details', () => {
  const malicious = '<img src=x onerror=alert(1)>private-api-token';
  for (const value of [null, {}, { channelRecovery: {} }, proxy({ mode: malicious }), proxy({ state: malicious }), proxy({ enabled: 'true' })]) {
    const text = channelRecoveryText(value, 'client');
    assert.equal(text, '后台监测：状态暂不可用。'); assert.doesNotMatch(text, /private-|<img/);
  }
  const value = proxy({ lastReason: malicious, lastResult: malicious, message: malicious,
    notice: notice({ phase: 'failed', result: malicious }) });
  assert.doesNotMatch(channelRecoveryText(value, 'client'), /private-|<img|api-token/);
});

test('the separate background notice uses normal status rendering without new timers, requests or UI mode switches', async () => {
  const [html, app, module] = await Promise.all(['index.html', 'app.js', 'channel-recovery.js'].map((file) => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8')));
  const proxyPage = html.slice(html.indexOf('<section id="proxy"'), html.indexOf('<section id="activity"'));
  assert.match(proxyPage, /id="channel-recovery-status"[^>]*role="status"/);
  assert.match(proxyPage, /id="channel-refresh-status"/);
  assert.match(app, /\$\('channel-recovery-status'\)\.textContent = channelRecoveryText\(proxy, ui\.role, \{ available: localAvailable \}\)/);
  assert.doesNotMatch(app, /proxy\.recoveryMessage/);
  assert.doesNotMatch(module, /setInterval|setTimeout|fetch\(|innerHTML|toast\(|\/api\/|\.lastResult/);
  assert.doesNotMatch(proxyPage, /id="(?:recovery-mode|channel-recovery-toggle)"/);
});
