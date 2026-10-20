import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { version } from '../src/version.js';

// Exercise the real browser controller with a small DOM surface. API responses
// are explicit snapshots, so role locks, page gates and payload separation can
// be checked without starting tsnet or Claude.
class Element {
  constructor(id = '') {
    this.id = id; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.className = '';
    this.children = []; this.dataset = {}; this.attributes = {}; this.elements = [];
    this.classList = { toggle: (name, enabled) => { const classes = new Set(this.className.split(' ').filter(Boolean)); if (enabled) classes.add(name); else classes.delete(name); this.className = [...classes].join(' '); } };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() {}
}

test('web console keeps identity, pairing, Claude and proxy flows separate', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], new Element(match[1])]));
  const nav = [...html.matchAll(/<button[^>]+data-page="([^"]+)"[^>]*>/g)].map((match) => {
    const item = new Element(); item.dataset.page = match[1]; item.disabled = /disabled/.test(match[0]); return item;
  });
  for (const form of html.matchAll(/<form id="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    elements.get(form[1]).elements = [...form[2].matchAll(/\bid="([^"]+)"/g)].map((match) => elements.get(match[1]));
  }
  for (const input of html.matchAll(/<(?:input|option)[^>]+id="([^"]+)"[^>]+value="([^"]*)"/g)) elements.get(input[1]).value = input[2];
  elements.get('profile').value = 'read';
  const availableModels = [{ id: 'future-sonnet-id', name: 'Sonnet Next', description: 'B 账号可用模型' }, { id: 'custom-opus-id', name: 'Opus Next' }];
  const readyModel = { enabled: true, available: true, modelsState: 'ready', models: availableModels };
  const diagnosticFixture = { available: true, source: 'embedded', scope: 'node', capturedAt: '2026-10-21T12:00:00Z',
    netstack: { counter_tcp_retransmits: 7, counter_tcp_fast_retransmit: 0 },
    transport: ['inbound', 'outbound'].flatMap((direction) => ['direct_ipv4', 'direct_ipv6', 'derp', 'peer_relay_ipv4', 'peer_relay_ipv6'].map((path) => ({ direction, path, bytes: 1024, packets: 1 }))) };
  let diagnosticSnapshot = diagnosticFixture;
  const calls = [], intervals = [], activeTimers = new Map();
  let snapshot = { instanceId: 'backend-first', revision: 1, identity: { loaded: true, role: null, locked: false, desiredOnline: false, canSwitchRole: true }, capabilities: { model: false, proxy: false }, model: {}, modelApi: { enabled: false, listening: false, port: 3210, baseUrl: 'http://127.0.0.1:3210/v1', error: null }, proxy: {}, logs: [], network: { running: false, devices: [], addresses: [] } };
  let holdDisconnect = false, releaseDisconnect;
  let holdRoute, deferredRequest;
  const original = Object.fromEntries(['document', 'window', 'location', 'history', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'].map((key) => [key, globalThis[key]]));
  const element = (id) => elements.get(id);
  const button = (name) => nav.find((item) => item.dataset.page === name);
  const tick = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
  globalThis.document = {
    getElementById: element, createElement: () => new Element(),
    querySelectorAll: (selector) => selector === '[data-page]' ? nav : nav.filter((item) => selector === `[data-page="${item.dataset.page}"]`),
    querySelector: (selector) => nav.find((item) => selector === `[data-page="${item.dataset.page}"]`)
  };
  globalThis.window = { addEventListener() {} }; globalThis.location = { hash: '' };
  globalThis.history = { replaceState(_a, _b, hash) { globalThis.location.hash = hash; } };
  globalThis.setInterval = (callback, delay) => { intervals.push(callback); const id = intervals.length; activeTimers.set(id, { callback, delay }); return id; };
  globalThis.clearInterval = (id) => activeTimers.delete(id);
  globalThis.setTimeout = () => 1; globalThis.clearTimeout = () => {};
  globalThis.fetch = async (route, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ route, body, method: options.method });
    if (route === '/api/bootstrap') return Response.json({ token: 'test-token', api: 'http://127.0.0.1:3210', version });
    if (route === holdRoute) return new Promise((resolve, reject) => { deferredRequest = { resolve, reject, signal: options.signal }; });
    if (route === '/api/network/diagnostics') return Response.json(diagnosticSnapshot);
    if (route === '/api/network/disconnect' && holdDisconnect) {
      const old = structuredClone(snapshot);
      return new Promise((resolve) => { releaseDisconnect = () => resolve(Response.json(old)); });
    }
    if (route === '/api/identity') {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, role: body.role, identity: { ...snapshot.identity, role: body.role }, capabilities: { model: false, proxy: false }, pairing: { saved: false }, model: { enabled: false, config: snapshot.model.config }, modelApi: { ...snapshot.modelApi, enabled: false, listening: false } };
    } else if (route === '/api/network/login') {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, identity: { ...snapshot.identity, locked: true, desiredOnline: true, canSwitchRole: false }, network: { running: true, addresses: ['100.101.102.103'], devices: [{ self: true, role: snapshot.role, name: '本机测试', address: '100.101.102.103', online: true }] } };
    } else if (route === '/api/network/disconnect') {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, online: false, identity: { ...snapshot.identity, locked: false, desiredOnline: false, canSwitchRole: true }, network: { ...snapshot.network, running: false } };
    } else if (route === '/api/host' || route === '/api/join') {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, capabilities: { model: true, proxy: true }, pairing: { saved: true }, ...(route === '/api/host' ? { invitation: 'p2pcc://pair/test' } : { invitation: null, online: true }) };
    } else if (route === '/api/model') {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, model: { enabled: body.enabled, available: body.enabled, config: body.enabled ? body : snapshot.model.config } };
    } else if (route === '/api/models/refresh') {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, model: { ...readyModel, models: [...availableModels].reverse() } };
    } else if (route === '/api/model-api') {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, modelApi: { ...snapshot.modelApi, enabled: body.enabled, listening: body.enabled } };
    }
    return Response.json(structuredClone(snapshot));
  };
  try {
    await import(`../public/app.js?console-test=${Date.now()}`); await tick();
    assert.equal(button('api').disabled, true); assert.equal(button('proxy').disabled, true);
    assert.equal(element('network-login').disabled, true);
    await element('tab-host').onclick();
    assert.equal(element('network-login').disabled, false);
    await element('network-login').onclick();
    assert.equal(element('tab-host').disabled, true); assert.equal(element('tab-client').disabled, true);
    element('bridge-port').value = '3211'; element('host-form').onsubmit({ preventDefault() {} }); await tick();
    assert.deepEqual(calls.find((call) => call.route === '/api/host').body, { bridgePort: 3211 });
    assert.equal(button('api').disabled, false); button('api').onclick();
    assert.equal(element('model-host-panel').hidden, false); assert.equal(element('model-client-panel').hidden, true);
    assert.equal(calls.some((call) => call.route === '/api/network/diagnostics'), false, 'normal initialization and pairing never request diagnostics');
    button('proxy').onclick();
    await element('network-diagnostics-open').onclick();
    assert.equal(element('network-diagnostics-panel').hidden, false, 'B opens the shared diagnostics panel');
    assert.equal(element('network-diagnostics-open').attributes['aria-expanded'], 'true');
    const firstDiagnosticsTimer = intervals.length;
    assert.equal(activeTimers.get(firstDiagnosticsTimer).delay, 2000);
    assert.equal(element('network-diagnostics-tcp').children[0].children[1].textContent, '7');
    assert.match(element('network-diagnostics-totals').children[0].textContent, /5.0 KiB · 5 包/);
    await intervals[0](); await intervals[1]();
    assert.equal(calls.filter((call) => call.route === '/api/network/diagnostics').length, 1, 'status polling does not create additional diagnostic reads');
    await activeTimers.get(firstDiagnosticsTimer).callback();
    assert.equal(calls.filter((call) => call.route === '/api/network/diagnostics').length, 2, 'the open panel updates on its own two-second timer');
    const sampledTime = element('network-diagnostics-time').textContent;
    const sampledPath = element('network-diagnostics-paths').children[0];
    holdRoute = '/api/network/diagnostics';
    const slowAutomaticRead = activeTimers.get(firstDiagnosticsTimer).callback(); await tick();
    assert.equal(element('network-diagnostics-tcp').children[0].children[1].textContent, '7', 'an in-flight automatic read retains the last TCP counters');
    assert.equal(element('network-diagnostics-time').textContent, sampledTime, 'an in-flight automatic read retains its sample time');
    assert.equal(element('network-diagnostics-paths').children[0], sampledPath, 'an in-flight automatic read does not rebuild the traffic rows');
    assert.match(element('network-diagnostics-status').textContent, /正在更新/);
    deferredRequest.resolve(Response.json(diagnosticFixture)); await slowAutomaticRead; holdRoute = null;
    diagnosticSnapshot = { available: false, message: '<img src=x onerror="fixture"> unavailable' };
    await element('network-diagnostics-refresh').onclick();
    assert.equal(element('network-diagnostics-status').textContent, diagnosticSnapshot.message, 'external diagnostic messages are plain text');
    assert.ok(element('network-diagnostics-tcp').children.every((item) => item.children[1].textContent === '—'));
    assert.equal(element('network-diagnostics-time').textContent, '—');
    diagnosticSnapshot = { available: true, netstack: { counter_tcp_retransmits: 0 } };
    await element('network-diagnostics-refresh').onclick();
    assert.equal(element('network-diagnostics-tcp').children[0].children[1].textContent, '0');
    assert.equal(element('network-diagnostics-tcp').children[1].children[1].textContent, '—');
    assert.match(element('network-diagnostics-totals').children[0].textContent, /— · — 包/);
    holdRoute = '/api/network/diagnostics';
    const closedDiagnostics = element('network-diagnostics-refresh').onclick(); await tick();
    const closedRead = deferredRequest;
    const diagnosticReads = calls.filter((call) => call.route === '/api/network/diagnostics').length;
    await activeTimers.get(firstDiagnosticsTimer).callback();
    await activeTimers.get(firstDiagnosticsTimer).callback();
    assert.equal(calls.filter((call) => call.route === '/api/network/diagnostics').length, diagnosticReads, 'slow reads skip timer ticks without overlapping or queueing requests');
    assert.equal(element('network-diagnostics-refresh').disabled, true);
    assert.equal(element('proxy-sharing').disabled, false, 'a diagnostic read does not block proxy controls');
    assert.equal(element('workspace').disabled, false, 'a diagnostic read does not block Claude configuration');
    element('network-diagnostics-close').onclick();
    assert.equal(activeTimers.has(firstDiagnosticsTimer), false);
    assert.equal(closedRead.signal.aborted, true);
    closedRead.resolve(Response.json(diagnosticFixture)); await closedDiagnostics;
    assert.equal(element('network-diagnostics-panel').hidden, true, 'a late response cannot reopen a closed diagnostic panel');
    await intervals[firstDiagnosticsTimer - 1]();
    assert.equal(calls.filter((call) => call.route === '/api/network/diagnostics').length, diagnosticReads, 'a retired timer cannot issue more reads');
    const failedDiagnostics = element('network-diagnostics-open').onclick(); await tick();
    deferredRequest.reject(new Error('synthetic diagnostics read failure')); await failedDiagnostics;
    assert.match(element('network-diagnostics-status').textContent, /synthetic diagnostics read failure/);
    assert.ok(element('network-diagnostics-tcp').children.every((item) => item.children[1].textContent === '—'));
    element('network-diagnostics-close').onclick(); holdRoute = null; diagnosticSnapshot = diagnosticFixture;
    assert.ok(calls.filter((call) => call.route === '/api/network/diagnostics').every((call) => call.method === 'GET' && call.body === undefined), 'diagnostics only makes authenticated GET reads');
    button('api').onclick();
    element('workspace').value = 'E:\\test'; element('model-timeout').value = '600'; element('model-turns').value = '30';
    element('model-form').onsubmit({ preventDefault() {} }); await tick();
    assert.equal(calls.find((call) => call.route === '/api/model').body.workspace, 'E:\\test');
    assert.equal(calls.some((call) => call.route === '/api/proxy'), false, 'model enable never mutates proxy');
    await element('network-disconnect').onclick();
    assert.equal(button('api').disabled, false, 'saved pairing still permits offline diagnostics');
    assert.equal(element('tab-client').disabled, false);
    button('proxy').onclick(); holdRoute = '/api/network/diagnostics';
    const previousRoleDiagnostics = element('network-diagnostics-open').onclick(); await tick();
    const previousRoleRead = deferredRequest;
    const previousRoleTimer = intervals.length;
    await element('tab-client').onclick();
    assert.equal(previousRoleRead.signal.aborted, true);
    assert.equal(activeTimers.has(previousRoleTimer), false, 'identity changes stop automatic diagnostic reads');
    previousRoleRead.resolve(Response.json(diagnosticFixture)); await previousRoleDiagnostics; holdRoute = null;
    assert.equal(element('network-diagnostics-panel').hidden, true, 'a late diagnostic response cannot cross an identity change');
    assert.equal(element('connection').hidden, false); assert.equal(element('api').hidden, true);
    assert.equal(button('api').disabled, true); assert.equal(button('proxy').disabled, true);
    assert.equal(element('host-form').hidden, true); assert.equal(element('client-form').hidden, false);
    await element('network-login').onclick(); element('invitation').value = 'p2pcc://pair/test';
    element('client-form').onsubmit({ preventDefault() {} }); await tick(); button('api').onclick();
    assert.equal(element('model-host-panel').hidden, true); assert.equal(element('model-client-panel').hidden, false);
    button('proxy').onclick(); await element('network-diagnostics-open').onclick();
    assert.equal(element('network-diagnostics-panel').hidden, false, 'A uses the same diagnostics panel');
    const navigatedDiagnosticsTimer = intervals.length;
    button('api').onclick();
    assert.equal(element('network-diagnostics-panel').hidden, true);
    assert.equal(activeTimers.has(navigatedDiagnosticsTimer), false, 'leaving the proxy page stops automatic diagnostic reads');
    snapshot = { ...snapshot, revision: snapshot.revision + 1, model: structuredClone(readyModel) }; await intervals[0]();
    assert.equal(element('model-test-submit').disabled, true, 'B readiness does not start the local model listener');
    await element('model-test-form').onsubmit({ preventDefault() {} });
    assert.equal(calls.some((call) => call.route === '/api/model-test'), false, 'disabled local API cannot submit a model test');
    element('model-api-toggle').onclick(); await tick();
    assert.deepEqual(calls.find((call) => call.route === '/api/model-api').body, { enabled: true });
    assert.equal(element('model-api-toggle').attributes['aria-pressed'], 'true');
    assert.equal(element('model-test-submit').disabled, false);
    assert.deepEqual(element('model-id').children.map((item) => item.value), availableModels.map((item) => item.id), 'the model picker contains B model IDs without fixed aliases');
    assert.equal(element('model-id').value, 'future-sonnet-id');
    element('model-id').value = 'custom-opus-id'; element('model-id').onchange();
    assert.match(element('api-example').textContent, /"model":"custom-opus-id"/, 'the copied example uses the current raw B model ID');
    await element('model-test-form').onsubmit({ preventDefault() {} });
    assert.equal(calls.find((call) => call.route === '/api/model-test').body.model, 'custom-opus-id', 'same-origin test calls use the selected B model');
    assert.equal(calls.some((call) => call.route === '/v1/chat/completions'), false, 'browser model tests stay on the management origin');
    snapshot = { ...snapshot, revision: snapshot.revision + 1, model: { ...readyModel, models: [], modelsState: 'loading' } }; await intervals[0]();
    assert.equal(element('model-test-submit').disabled, true);
    snapshot = { ...snapshot, revision: snapshot.revision + 1, model: structuredClone(readyModel) }; await intervals[0]();
    assert.equal(element('model-id').value, 'custom-opus-id', 'temporary loading without a cached list preserves the user selection');
    await element('refresh-models').onclick();
    assert.equal(calls.some((call) => call.route === '/api/models/refresh'), true);
    assert.equal(element('model-id').value, 'custom-opus-id', 'refreshing and reordering the catalogue preserves a valid selection');
    snapshot = { ...snapshot, revision: snapshot.revision + 1, model: { ...readyModel, models: [availableModels[0]] } }; await intervals[0]();
    assert.equal(element('model-id').value, 'future-sonnet-id', 'a removed model is replaced by the first current B model');
    snapshot = { ...snapshot, revision: snapshot.revision + 1, model: { ...readyModel, modelsState: 'loading' } }; await intervals[0]();
    assert.equal(element('model-test-submit').disabled, true); assert.match(element('model-list-status').textContent, /正在从 B 获取/);
    snapshot = { ...snapshot, revision: snapshot.revision + 1, model: { ...readyModel, modelsState: 'error', modelsError: '请重新登录 Claude' } }; await intervals[0]();
    assert.equal(element('model-id').disabled, true); assert.equal(element('copy-example').disabled, true);
    assert.match(element('model-list-status').textContent, /请重新登录 Claude/);
    snapshot = { ...snapshot, revision: snapshot.revision + 1, online: false, network: { ...snapshot.network, running: false } }; await intervals[0]();
    assert.equal(element('model-id').disabled, true); assert.equal(element('refresh-models').disabled, true);
    assert.match(element('model-list-status').textContent, /B 未连接/, 'offline cached models are not presented as available');
    assert.equal(element('tab-host').disabled, true, 'transient loss does not unlock identity');
    assert.equal(button('api').disabled, false, 'transient loss keeps authorized pages accessible');

    const firstInstance = structuredClone(snapshot);
    holdDisconnect = true;
    const oldAction = element('network-disconnect').onclick(); await tick();
    assert.equal(typeof releaseDisconnect, 'function');
    snapshot = { ...snapshot, instanceId: 'backend-restarted', revision: 0, role: 'host', identity: { loaded: true, role: 'host', locked: false, desiredOnline: false, canSwitchRole: true }, capabilities: { model: false, proxy: false }, pairing: { saved: false }, modelApi: { ...snapshot.modelApi, enabled: false, listening: false } };
    await intervals[0]();
    assert.equal(element('sidebar-identity').textContent, 'B · 服务端', 'restart accepts revision 0 without reloading the page');
    assert.equal(button('api').disabled, true);
    releaseDisconnect(); await oldAction;
    assert.equal(element('sidebar-identity').textContent, 'B · 服务端', 'late action response from the retired process cannot revive its identity');
    const restartedInstance = structuredClone(snapshot);
    snapshot = { ...firstInstance, revision: 9999 }; await intervals[0]();
    assert.equal(element('sidebar-identity').textContent, 'B · 服务端', 'retired instance cannot win by reporting a larger revision');
    assert.equal(button('api').disabled, true);
    snapshot = { ...restartedInstance, revision: 5 }; await intervals[0]();
    snapshot = { ...firstInstance, instanceId: restartedInstance.instanceId, revision: 4 }; await intervals[0]();
    assert.equal(element('sidebar-identity').textContent, 'B · 服务端', 'older revision from the current instance is still rejected');

    snapshot = { ...restartedInstance, revision: 6, capabilities: { model: true, proxy: true }, model: structuredClone(readyModel), network: { running: true, devices: [], addresses: [], message: '当前网络' }, identity: { ...restartedInstance.identity, desiredOnline: true, locked: true } };
    await intervals[0]();
    button('proxy').onclick(); holdRoute = '/api/network/diagnostics';
    const previousInstanceDiagnostics = element('network-diagnostics-open').onclick(); await tick();
    const previousInstanceRead = deferredRequest;
    const previousInstanceTimer = intervals.length;
    snapshot = { ...snapshot, instanceId: 'backend-diagnostics-restarted', revision: 0 }; await intervals[0]();
    assert.equal(previousInstanceRead.signal.aborted, true);
    assert.equal(activeTimers.has(previousInstanceTimer), false, 'a backend replacement stops the old diagnostic timer');
    previousInstanceRead.resolve(Response.json(diagnosticFixture)); await previousInstanceDiagnostics;
    assert.equal(element('network-diagnostics-panel').hidden, true, 'a late diagnostic response cannot cross a backend restart');
    button('api').onclick();
    holdRoute = '/api/probe';
    const oldProbe = element('probe').onclick(); await tick();
    snapshot = { ...snapshot, instanceId: 'backend-probe-restarted', revision: 0 }; await intervals[0]();
    deferredRequest.resolve(Response.json({ available: true, message: '过期的 Claude 检测' })); await oldProbe;
    assert.equal(element('probe-result').textContent, '', 'a retired process cannot publish a Claude probe into the new process');

    holdRoute = '/api/tailscale';
    const oldRefresh = element('refresh-network').onclick(); await tick();
    snapshot = { ...snapshot, instanceId: 'backend-network-restarted', revision: 0, role: 'client', online: true, identity: { ...snapshot.identity, role: 'client' }, network: { ...snapshot.network, message: '新进程网络' }, modelApi: { ...snapshot.modelApi, enabled: true, listening: true } };
    await intervals[0]();
    deferredRequest.resolve(Response.json({ running: false, devices: [], addresses: [], message: '过期网络' })); await oldRefresh;
    assert.equal(element('network-status').textContent, '新进程网络', 'a late manual refresh cannot overwrite the new identity network');

    holdRoute = '/api/model-test';
    const oldModelResult = element('model-test-form').onsubmit({ preventDefault() {} }); await tick();
    const firstModelRequest = deferredRequest;
    snapshot = { ...snapshot, instanceId: 'backend-model-restarted', revision: 0 }; await intervals[0]();
    assert.equal(firstModelRequest.signal.aborted, true);
    firstModelRequest.resolve(Response.json({ choices: [{ message: { content: '过期模型回复' } }] })); await oldModelResult;
    assert.equal(element('model-test-output').textContent, '', 'a completed old model request cannot publish into a restarted process');
    const oldModelError = element('model-test-form').onsubmit({ preventDefault() {} }); await tick();
    const secondModelRequest = deferredRequest;
    snapshot = { ...snapshot, revision: 1, role: 'host', identity: { ...snapshot.identity, role: 'host' }, capabilities: { model: false, proxy: false } }; await intervals[0]();
    secondModelRequest.reject(new DOMException('cancelled', 'AbortError')); await oldModelError;
    assert.equal(element('model-test-output').textContent, '', 'a cancelled model request cannot publish into a different role');

    snapshot = { ...snapshot, revision: 2, role: 'client', identity: { ...snapshot.identity, role: 'client' }, capabilities: { model: true, proxy: true }, model: structuredClone(readyModel), controlConnectionId: 'first-control-session' };
    await intervals[0]();
    const oldSessionResult = element('model-test-form').onsubmit({ preventDefault() {} }); await tick();
    const sessionRequest = deferredRequest;
    snapshot = { ...snapshot, revision: 3, controlConnectionId: 'replacement-control-session' }; await intervals[0]();
    assert.equal(sessionRequest.signal.aborted, true, 'reconnecting the same role retires requests authorized by the previous control session');
    sessionRequest.resolve(Response.json({ choices: [{ message: { content: '上一次连接的过期回复' } }] })); await oldSessionResult;
    assert.equal(element('model-test-output').textContent, '', 'an old session response cannot overwrite the newly connected state');

    const disabledModelResult = element('model-test-form').onsubmit({ preventDefault() {} }); await tick();
    const disabledRequest = deferredRequest;
    snapshot = { ...snapshot, revision: 4, model: { enabled: false, available: false } }; await intervals[0]();
    assert.equal(disabledRequest.signal.aborted, false, 'disabling only the model keeps its current-session error visible');
    disabledRequest.reject(new Error('B 已停用 Claude 服务')); await disabledModelResult;
    assert.equal(element('model-test-output').textContent, 'B 已停用 Claude 服务');
    snapshot = { ...snapshot, revision: 5, model: structuredClone(readyModel) }; await intervals[0]();
    const stoppedModelResult = element('model-test-form').onsubmit({ preventDefault() {} }); await tick();
    const stoppedRequest = deferredRequest;
    assert.equal(element('model-api-toggle').disabled, false, 'the local listener remains stoppable during a model test');
    element('model-api-toggle').onclick(); await tick();
    assert.equal(stoppedRequest.signal.aborted, true, 'stopping local API retires its active browser test');
    assert.deepEqual(calls.filter((call) => call.route === '/api/model-api').at(-1).body, { enabled: false });
    stoppedRequest.resolve(Response.json({ choices: [{ message: { content: '已停止 API 的过期回复' } }] })); await stoppedModelResult;
    assert.equal(element('model-test-submit').disabled, true);
    assert.doesNotMatch(element('model-test-output').textContent, /过期回复/);
    assert.equal(calls.some((call) => call.route === '/api/proxy'), false, 'local model API toggles never mutate proxy state');
    holdRoute = null;
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});
