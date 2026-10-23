import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { channelRouteText, createChannelRefreshView } from '../public/channel-refresh.js';

function elements() {
  const items = new Map();
  return (id) => {
    if (!items.has(id)) items.set(id, { value: '', disabled: false, hidden: false, textContent: '', children: [],
      replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } });
    return items.get(id);
  };
}
const target = (id = 'current-B', role = 'host', supported = true) => ({ id, role, supported, name: `Device ${id}` });
const state = (overrides = {}) => ({ connected: true, available: true, busy: false, reason: 'ready', retryAfterMs: 0,
  targets: [target()], job: null, ...overrides });
const context = (overrides = {}) => ({ role: 'client', scope: 'current-instance/client/current-session', visible: true, ...overrides });
const job = (overrides = {}) => ({ id: 'refresh-job', targetId: 'current-B', state: 'running', phase: 'before', result: null, ...overrides });
function fixture(api = async () => Response.json(state())) {
  const $ = elements(), oldDocument = globalThis.document, calls = [], notices = [];
  let available = true;
  globalThis.document = { createElement: () => ({}) };
  const view = createChannelRefreshView({ api: async (...args) => { calls.push(args); return api(...args); }, $, available: () => available,
    toast: (...args) => notices.push(args) });
  return { $, view, calls, notices, setAvailable(value) { available = value; }, restore() { view.retire(); globalThis.document = oldDocument; } };
}

test('A refreshes its sole current B in one click without requiring a newer B capability', async () => {
  const f = fixture(async () => Response.json(state({ busy: true, available: false, job: job() })));
  try {
    f.view.update(state({ targets: [target('current-B', 'host', false)] }), context());
    assert.equal(f.$('channel-refresh-target').hidden, true);
    assert.equal(f.$('channel-refresh-start').disabled, false);
    await f.$('channel-refresh-start').onclick();
    assert.deepEqual(f.calls.map(([route, body]) => ({ route, body })), [{ route: '/api/proxy/refresh', body: { targetId: 'current-B' } }]);
    assert.equal(f.$('channel-refresh-start').disabled, true);
    assert.match(f.$('channel-refresh-status').textContent, /读取当前线路/);
    assert.equal(f.calls[0][3], true, 'Submitting is allowed to finish after the page closes; there is no cancellation API call');
  } finally { f.restore(); }
});

test('B requires explicit selection of a currently authorized, supported A and never refreshes itself', async () => {
  const targets = [target('old-A', 'client', false), target('current-A', 'client'), target('ignored-B', 'host')];
  const f = fixture(async () => Response.json(state({ targets, available: false, busy: true,
    job: job({ targetId: 'current-A', phase: 'refreshing' }) })));
  try {
    f.view.update(state({ targets }), context({ role: 'host' }));
    assert.equal(f.$('channel-refresh-target').hidden, false);
    assert.equal(f.$('channel-refresh-target').value, '');
    assert.equal(f.$('channel-refresh-start').disabled, true);
    assert.deepEqual(f.$('channel-refresh-target').children.map((item) => item.value), ['', 'old-A', 'current-A']);
    f.$('channel-refresh-target').value = 'old-A'; f.$('channel-refresh-target').onchange();
    assert.equal(f.$('channel-refresh-start').disabled, true); assert.match(f.$('channel-refresh-status').textContent, /升级到 1\.2\.1/);
    f.$('channel-refresh-target').value = 'current-A'; f.$('channel-refresh-target').onchange();
    assert.equal(f.$('channel-refresh-start').disabled, false);
    await f.$('channel-refresh-start').onclick();
    assert.deepEqual(f.calls[0][1], { targetId: 'current-A' });
    assert.match(f.$('channel-refresh-status').textContent, /Device current-A：正在请求重新探测/);
  } finally { f.restore(); }
});

test('cooldown, shared recovery budget, active work, disconnection and unavailable UI all prevent submission', async () => {
  const f = fixture();
  try {
    for (const reason of ['cooldown', 'budget-exhausted', 'model-busy', 'speed-busy', 'recovery-busy', 'unsupported']) {
      f.view.update(state({ available: false, reason, retryAfterMs: reason === 'cooldown' ? 120000 : 0 }), context());
      assert.equal(f.$('channel-refresh-start').disabled, true, reason); await f.$('channel-refresh-start').onclick();
    }
    f.view.update(state({ connected: false, targets: [] }), context());
    assert.equal(f.$('channel-refresh-start').disabled, true);
    f.view.update(state({ targets: [target(), target('extra-B')] }), context());
    assert.equal(f.$('channel-refresh-start').disabled, true, 'A cannot guess between multiple B targets');
    f.view.update(state(), context()); f.setAvailable(false);
    await f.$('channel-refresh-start').onclick();
    assert.equal(f.calls.length, 0, 'A stale enabled button cannot submit after local availability changes');
    f.view.update(state({ retryAfterMs: 120000 }), context());
    assert.match(f.$('channel-refresh-status').textContent, /120 秒/);
  } finally { f.restore(); }
});

test('phase and truthful before/after results do not promise a route change or faster internet', () => {
  const f = fixture();
  try {
    for (const [phase, text] of [['before', '读取当前线路'], ['refreshing', '请求重新探测'], ['after', '观察探测后']]) {
      f.view.update(state({ available: false, busy: true, job: job({ phase }) }), context());
      assert.match(f.$('channel-refresh-status').textContent, new RegExp(text));
    }
    const result = { refreshed: true, reason: 'refreshed', changed: false,
      before: { path: 'direct', latencyMs: 86 }, after: { path: 'direct', latencyMs: 80.5 } };
    f.view.update(state({ available: false, reason: 'cooldown', retryAfterMs: 110000,
      job: job({ state: 'completed', phase: 'completed', result }) }), context());
    const message = f.$('channel-refresh-status').textContent;
    assert.match(message, /已重新探测，仍为直连/); assert.match(message, /刷新前 直连 · RTT 86\.0 ms → 刷新后 直连 · RTT 80\.5 ms/);
    assert.match(message, /110 秒/); assert.doesNotMatch(message, /提速|换线成功|已更换/);
    f.view.update(state({ job: job({ state: 'failed', result: { ...result, reason: 'deadline', after: { path: 'unknown', latencyMs: null } } }) }), context());
    assert.match(f.$('channel-refresh-status').textContent, /已请求重新探测，后续观察未完成/);
    assert.match(f.$('channel-refresh-status').textContent, /刷新后 — · RTT —/);
    assert.doesNotMatch(f.$('channel-refresh-status').textContent, /仍为直连/);
  } finally { f.restore(); }
});

test('retiring the page does not cancel an accepted action or let its late reply revive the old view', async () => {
  let complete;
  const f = fixture(() => new Promise((resolve) => { complete = () => resolve(Response.json(state({ busy: true, job: job() }))); }));
  try {
    f.view.update(state(), context());
    const request = f.$('channel-refresh-start').onclick();
    await f.$('channel-refresh-start').onclick();
    assert.equal(f.calls.length, 1);
    f.view.retire(); complete(); await request;
    assert.equal(f.view.busy(), false); assert.equal(f.$('channel-refresh-start').disabled, true);
    assert.equal(f.$('channel-refresh-status').textContent, '');
    assert.deepEqual(f.calls.map(([route]) => route), ['/api/proxy/refresh']);
  } finally { f.restore(); }
});

test('a late reply cannot replace a changed role, session or authorization target', async () => {
  for (const changed of ['role', 'scope', 'target']) {
    let complete;
    const f = fixture(() => new Promise((resolve) => { complete = () => resolve(Response.json(state({ busy: true, job: job() }))); }));
    try {
      f.view.update(state(), context()); const request = f.$('channel-refresh-start').onclick();
      const host = changed === 'role';
      f.view.update(state({ targets: [target('new-peer', host ? 'client' : 'host')] }), context({ role: host ? 'host' : 'client', scope: changed === 'scope' ? 'new-instance' : context().scope }));
      complete(); await request;
      assert.equal(f.view.busy(), false, changed);
      assert.equal(f.$('channel-refresh-target').hidden, !host, changed);
      assert.equal(f.$('channel-refresh-start').disabled, host, changed);
      assert.doesNotMatch(f.$('channel-refresh-status').textContent, /读取当前线路|current-B/);
      if (host) assert.equal(f.$('channel-refresh-target').value, '');
    } finally { f.restore(); }
  }
});

test('a delayed command reply cannot re-add another revoked device or rewind its completed job', async () => {
  let complete;
  const targets = [target('current-A', 'client'), target('revoked-A', 'client')];
  const f = fixture(() => new Promise((resolve) => { complete = () => resolve(Response.json(state({ targets, busy: true,
    available: false, job: job({ targetId: 'current-A' }) }))); }));
  try {
    const host = context({ role: 'host' });
    f.view.update(state({ targets }), host);
    f.$('channel-refresh-target').value = 'current-A'; f.$('channel-refresh-target').onchange();
    const request = f.$('channel-refresh-start').onclick();
    f.view.update(state({ targets: targets.slice(0, 1), job: job({ targetId: 'current-A', state: 'completed', phase: 'completed',
      result: { refreshed: true, reason: 'refreshed', changed: false, before: { path: 'direct' }, after: { path: 'direct' } } }) }), host);
    complete(); await request;
    assert.deepEqual(f.$('channel-refresh-target').children.map((item) => item.value), ['', 'current-A']);
    assert.equal(f.view.busy(), false);
    assert.match(f.$('channel-refresh-status').textContent, /已重新探测，仍为直连/);
    assert.doesNotMatch(f.$('channel-refresh-status').textContent, /读取当前线路|revoked-A/);
  } finally { f.restore(); }
});

test('only whitelisted route and error text is rendered, while device names stay plain text', async () => {
  assert.equal(channelRouteText({ path: 'derp', regionCode: 'sfo', latencyMs: 264.3 }), '中继（sfo） · RTT 264.3 ms');
  assert.equal(channelRouteText({ path: 'private-endpoint', regionCode: 'private-token', latencyMs: 'private-ip' }), '— · RTT —');
  assert.equal(channelRouteText({ path: 'derp', regionCode: '<script>bad', latencyMs: -1 }), '中继 · RTT —');
  const f = fixture(async () => { throw new Error('private-server-token'); });
  try {
    f.view.update(state({ message: 'private-status-message', reason: 'private-raw-reason' }), context());
    await f.$('channel-refresh-start').onclick();
    assert.deepEqual(f.notices, [['刷新线路请求失败，请稍后重试。', true]]);
    assert.equal(f.$('channel-refresh-status').textContent, '刷新线路请求失败，请稍后重试。');
    f.view.retire();
    f.view.update(state({ targets: [{ ...target('A', 'client'), name: '<img src=x onerror=alert(1)>\u0000' }],
      job: job({ targetId: 'A', state: 'failed', result: { refreshed: false, reason: 'private-result-error',
        before: { path: 'private-ip', latencyMs: null }, after: { path: 'unknown', latencyMs: null } } }) }), context({ role: 'host' }));
    assert.equal(f.$('channel-refresh-target').children[1].textContent, '<img src=x onerror=alert(1)>');
    assert.doesNotMatch(f.$('channel-refresh-status').textContent, /private-/);
  } finally { f.restore(); }
});

test('refresh controls are present only in the proxy page and their module uses the normal app status feed', async () => {
  const [html, app, module] = await Promise.all(['index.html', 'app.js', 'channel-refresh.js'].map((file) => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8')));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  const proxy = html.slice(html.indexOf('<section id="proxy"'), html.indexOf('<section id="activity"'));
  for (const match of module.matchAll(/\$\('([^']+)'\)/g)) assert.match(proxy, new RegExp(`id="${match[1]}"`));
  assert.match(app, /channelRefreshView\.update\(currentStatus\?\.proxy\?\.channelRefresh/);
  assert.doesNotMatch(module, /setInterval|innerHTML|\/cancel|fetch\(/);
});
