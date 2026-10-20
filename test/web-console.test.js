import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { version } from '../src/version.js';

// Exercise the real browser controller with a small DOM surface. API responses
// are explicit snapshots, so role locks, page gates and payload separation can
// be checked without starting tsnet, Claude or Windows protection.
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
  elements.get('profile').value = 'read'; elements.get('model-id').value = 'claude-code';
  const calls = [], intervals = [];
  let snapshot = { instanceId: 'backend-first', revision: 1, identity: { loaded: true, role: null, locked: false, desiredOnline: false, canSwitchRole: true }, capabilities: { model: false, proxy: false }, model: {}, proxy: { guard: { supported: true } }, logs: [], network: { running: false, devices: [], addresses: [] } };
  let holdDisconnect = false, releaseDisconnect;
  let holdRoute, deferredRequest;
  const original = Object.fromEntries(['document', 'window', 'location', 'history', 'fetch', 'setInterval', 'setTimeout', 'clearTimeout'].map((key) => [key, globalThis[key]]));
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
  globalThis.setInterval = (callback) => { intervals.push(callback); return intervals.length; };
  globalThis.setTimeout = () => 1; globalThis.clearTimeout = () => {};
  globalThis.fetch = async (route, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ route, body });
    if (route === '/api/bootstrap') return Response.json({ token: 'test-token', api: 'http://127.0.0.1:3210', version });
    if (route === holdRoute) return new Promise((resolve, reject) => { deferredRequest = { resolve, reject, signal: options.signal }; });
    if (route === '/api/network/disconnect' && holdDisconnect) {
      const old = structuredClone(snapshot);
      return new Promise((resolve) => { releaseDisconnect = () => resolve(Response.json(old)); });
    }
    if (route === '/api/identity') {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, role: body.role, identity: { ...snapshot.identity, role: body.role }, capabilities: { model: false, proxy: false }, pairing: { saved: false }, model: { enabled: false, config: snapshot.model.config } };
    } else if (route === '/api/network/login') {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, identity: { ...snapshot.identity, locked: true, desiredOnline: true, canSwitchRole: false }, network: { running: true, addresses: ['100.101.102.103'], devices: [{ self: true, role: snapshot.role, name: '本机测试', address: '100.101.102.103', online: true }] } };
    } else if (route === '/api/network/disconnect') {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, online: false, identity: { ...snapshot.identity, locked: false, desiredOnline: false, canSwitchRole: true }, network: { ...snapshot.network, running: false } };
    } else if (route === '/api/host' || route === '/api/join') {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, capabilities: { model: true, proxy: true }, pairing: { saved: true }, ...(route === '/api/host' ? { invitation: 'p2pcc://pair/test' } : { invitation: null, online: true }) };
    } else if (route === '/api/model') {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, model: { enabled: body.enabled, available: body.enabled, config: body.enabled ? body : snapshot.model.config } };
    }
    return Response.json(structuredClone(snapshot));
  };
  try {
    await import(`../public/app.js?console-test=${Date.now()}`); await tick();
    assert.equal(button('api').disabled, true); assert.equal(button('proxy').disabled, true);
    assert.equal(element('network-login').disabled, true);
    assert.equal(element('settings-guard-disable').disabled, false, 'guard recovery stays usable before pairing');
    await element('tab-host').onclick();
    assert.equal(element('network-login').disabled, false);
    await element('network-login').onclick();
    assert.equal(element('tab-host').disabled, true); assert.equal(element('tab-client').disabled, true);
    element('bridge-port').value = '3211'; element('host-form').onsubmit({ preventDefault() {} }); await tick();
    assert.deepEqual(calls.find((call) => call.route === '/api/host').body, { bridgePort: 3211 });
    assert.equal(button('api').disabled, false); button('api').onclick();
    assert.equal(element('model-host-panel').hidden, false); assert.equal(element('model-client-panel').hidden, true);
    element('workspace').value = 'E:\\test'; element('model-timeout').value = '600'; element('model-turns').value = '30';
    element('model-form').onsubmit({ preventDefault() {} }); await tick();
    assert.equal(calls.find((call) => call.route === '/api/model').body.workspace, 'E:\\test');
    assert.equal(calls.some((call) => call.route === '/api/proxy'), false, 'model enable never mutates proxy');
    await element('network-disconnect').onclick();
    assert.equal(button('api').disabled, false, 'saved pairing still permits offline diagnostics');
    assert.equal(element('tab-client').disabled, false);
    await element('tab-client').onclick();
    assert.equal(element('connection').hidden, false); assert.equal(element('api').hidden, true);
    assert.equal(button('api').disabled, true); assert.equal(button('proxy').disabled, true);
    assert.equal(element('host-form').hidden, true); assert.equal(element('client-form').hidden, false);
    await element('network-login').onclick(); element('invitation').value = 'p2pcc://pair/test';
    element('client-form').onsubmit({ preventDefault() {} }); await tick(); button('api').onclick();
    assert.equal(element('model-host-panel').hidden, true); assert.equal(element('model-client-panel').hidden, false);
    snapshot = { ...snapshot, revision: snapshot.revision + 1, online: false, network: { ...snapshot.network, running: false } }; await intervals[0]();
    assert.equal(element('tab-host').disabled, true, 'transient loss does not unlock identity');
    assert.equal(button('api').disabled, false, 'transient loss keeps authorized pages accessible');

    const firstInstance = structuredClone(snapshot);
    holdDisconnect = true;
    const oldAction = element('network-disconnect').onclick(); await tick();
    assert.equal(typeof releaseDisconnect, 'function');
    snapshot = { ...snapshot, instanceId: 'backend-restarted', revision: 0, role: 'host', identity: { loaded: true, role: 'host', locked: false, desiredOnline: false, canSwitchRole: true }, capabilities: { model: false, proxy: false }, pairing: { saved: false } };
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

    snapshot = { ...restartedInstance, revision: 6, capabilities: { model: true, proxy: true }, model: { enabled: true, available: true }, network: { running: true, devices: [], addresses: [], message: '当前网络' }, identity: { ...restartedInstance.identity, desiredOnline: true, locked: true } };
    await intervals[0]();
    holdRoute = '/api/probe';
    const oldProbe = element('probe').onclick(); await tick();
    snapshot = { ...snapshot, instanceId: 'backend-probe-restarted', revision: 0 }; await intervals[0]();
    deferredRequest.resolve(Response.json({ available: true, message: '过期的 Claude 检测' })); await oldProbe;
    assert.equal(element('probe-result').textContent, '', 'a retired process cannot publish a Claude probe into the new process');

    holdRoute = '/api/tailscale';
    const oldRefresh = element('refresh-network').onclick(); await tick();
    snapshot = { ...snapshot, instanceId: 'backend-network-restarted', revision: 0, role: 'client', identity: { ...snapshot.identity, role: 'client' }, network: { ...snapshot.network, message: '新进程网络' } };
    await intervals[0]();
    deferredRequest.resolve(Response.json({ running: false, devices: [], addresses: [], message: '过期网络' })); await oldRefresh;
    assert.equal(element('network-status').textContent, '新进程网络', 'a late manual refresh cannot overwrite the new identity network');

    holdRoute = '/v1/chat/completions';
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

    snapshot = { ...snapshot, revision: 2, role: 'client', identity: { ...snapshot.identity, role: 'client' }, capabilities: { model: true, proxy: true }, model: { enabled: true, available: true }, controlConnectionId: 'first-control-session' };
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
    holdRoute = null;
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});
