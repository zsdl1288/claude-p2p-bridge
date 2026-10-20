import { pages, uiState, allowedPage, deviceIdentity, deviceConnection } from './ui-state.js';

const $ = (id) => document.getElementById(id);
let token, apiBase, currentStatus, lastConfig, lastInvitation, selectedPeer, toastTimer, lastError;
let page = 'connection', actionBusy = false, proxyBusy = false, polling = false, networkPolling = false, localAvailable = false, modelTest, mutation = 0;
let proxyStatus = {};
const retiredInstances = new Set();
const roleName = (role) => role === 'host' ? 'B · 服务端' : role === 'client' ? 'A · 调用端' : '尚未选择身份';
const state = () => uiState(currentStatus, actionBusy || proxyBusy || !localAvailable);

function toast(message, error = false) {
  $('toast').textContent = message; $('toast').className = `toast${error ? ' error' : ''}`; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 8000 : 3000);
}
async function api(route, body, signal) {
  const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error?.message || data.error || `HTTP ${response.status}`); }
  return response;
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); }
  catch { toast('复制失败，请手动选择文本复制', true); }
}
function readInvitation(invitation) {
  if (!invitation.startsWith('p2pcc://pair/')) throw new Error('配对码无法解析');
  return JSON.parse(atob(invitation.slice('p2pcc://pair/'.length).replace(/-/g, '+').replace(/_/g, '/')));
}
function navigate(next, updateHash = true) {
  page = allowedPage(next, state());
  for (const [key, content] of Object.entries(pages)) {
    $(key).hidden = page !== key;
    for (const button of document.querySelectorAll(`[data-page="${key}"]`)) {
      button.classList.toggle('active', key === page);
      if (key === page) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    if (key === page) { $('page-title').textContent = content.title; $('page-description').textContent = content.description; $('breadcrumb-page').textContent = content.title; }
  }
  if (updateHash && location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
}
for (const button of document.querySelectorAll('[data-page]')) button.onclick = () => { if (!button.disabled) navigate(button.dataset.page); };
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));

async function action(route, body, message) {
  if (actionBusy || proxyBusy || !localAvailable) return;
  actionBusy = true; mutation++; render(currentStatus);
  try {
    const result = await (await api(route, body)).json(); mutation++;
    localAvailable = true; render({ ...result, proxy: result.proxy || currentStatus?.proxy });
    if (message) toast(message);
    await poll();
  } catch (error) { toast(error.message, true); await poll(); }
  finally { actionBusy = false; render(currentStatus); }
}
$('tab-client').onclick = () => action('/api/identity', { role: 'client' }, '本机身份已设为 A 调用端');
$('tab-host').onclick = () => action('/api/identity', { role: 'host' }, '本机身份已设为 B 服务端');
$('network-login').onclick = () => action('/api/network/login', {}, '私网连接已启动；首次使用请在浏览器完成授权');
$('network-disconnect').onclick = () => action('/api/network/disconnect', {}, '已退出私有网络，可切换身份；系统保护保持原状态');
$('host-form').onsubmit = (event) => {
  event.preventDefault();
  action('/api/host', { ...($('tailscale-ip').value ? { tailscaleIp: $('tailscale-ip').value } : {}), bridgePort: Number($('bridge-port').value) }, '服务身份已创建，请将配对码交给 A');
};
$('client-form').onsubmit = (event) => {
  event.preventDefault();
  const invitation = $('invitation').value.trim();
  if (selectedPeer) {
    try {
      const pair = readInvitation(invitation);
      if (pair.host !== selectedPeer) return toast('配对码与所选设备不一致，请选择正确的 B 或使用它的配对码', true);
    } catch { return toast('配对码无法解析', true); }
  }
  action('/api/join', { invitation }, '已保存配对，等待与 B 完成连接');
};
$('forget-pair').onclick = () => action('/api/disconnect', {}, '已撤销本机配对；重新授权后才能使用业务');
$('pause-pair').onclick = () => action('/api/pause', {}, '配对连接已暂停，保存的授权仍然保留');
$('resume-pair').onclick = () => action('/api/reconnect', {}, '正在恢复保存的配对连接');
$('copy-invite').onclick = () => copy(currentStatus?.invitation || '');
$('refresh-network').onclick = async () => {
  if (actionBusy || proxyBusy || !localAvailable) return;
  const revision = mutation;
  actionBusy = true; render(currentStatus);
  try { const network = await (await api('/api/tailscale')).json(); if (revision !== mutation) return; renderNetwork(network); await poll(); }
  catch (error) { if (revision === mutation) toast(error.message, true); }
  finally { actionBusy = false; render(currentStatus); }
};
$('quit-client').onclick = async () => { try { await api('/api/shutdown', {}); toast('客户端已退出，可关闭此页面'); } catch (error) { toast(error.message, true); } };

function renderDevices(container, devices, { selectable = false, empty = '暂无设备' } = {}) {
  container.replaceChildren();
  if (!devices.length) { const hint = document.createElement('p'); hint.className = 'empty'; hint.textContent = empty; container.append(hint); }
  const ordered = devices.slice().sort((a, b) => Number(Boolean(b.self)) - Number(Boolean(a.self)));
  for (const device of ordered) {
    const row = document.createElement('div'); row.className = `peer-row${device.self ? ' self' : ''}`;
    const name = document.createElement('strong'); name.textContent = device.name || '未命名设备';
    const identity = document.createElement('small'); identity.textContent = deviceIdentity(device) || '身份未确认'; name.append(identity);
    const address = document.createElement('code'); address.textContent = device.address || '尚未分配地址';
    const connection = document.createElement('span'); connection.textContent = deviceConnection(device);
    row.append(name, address, connection);
    if (selectable && !device.self) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = selectedPeer === device.address ? '已选择' : '选择为 B'; button.disabled = !state().canPair || !device.address;
      button.onclick = () => { selectedPeer = device.address; $('selected-peer').textContent = `已选择 ${device.name || device.address} · ${device.address}，请粘贴该设备的 B 配对码。`; renderNetwork(currentStatus.network); $('invitation').focus(); };
      row.append(button);
    }
    container.append(row);
  }
}
function renderNetwork(network) {
  if (!network) return;
  if (currentStatus) currentStatus.network = network;
  $('network-status').textContent = network.message || '正在读取私网状态';
  $('network-status').className = network.running ? 'network-ready' : 'network-pending';
  let authUrl;
  try { const url = new URL(network.authUrl); if (url.protocol === 'https:' && url.hostname === 'login.tailscale.com' && !url.port && !url.username && !url.password) authUrl = url.href; } catch {}
  $('network-auth-link').hidden = !authUrl;
  if (authUrl) $('network-auth-link').href = authUrl; else $('network-auth-link').removeAttribute('href');
  renderDevices($('peer-list'), network.devices || [], { selectable: state().role === 'client', empty: network.running ? '尚未发现其他设备，请刷新设备列表。' : '连接后显示本机及私有网络中的其他设备。' });
  const addresses = network.addresses || [];
  if (JSON.stringify(addresses) !== $('tailscale-ip').dataset.addresses) {
    const selected = $('tailscale-ip').value; $('tailscale-ip').replaceChildren();
    for (const address of addresses.length ? addresses : ['']) { const option = document.createElement('option'); option.value = address; option.textContent = address || '请先连接私有网络'; $('tailscale-ip').append(option); }
    if (addresses.includes(selected)) $('tailscale-ip').value = selected;
    $('tailscale-ip').dataset.addresses = JSON.stringify(addresses);
  }
}
function renderIdentity(status, ui) {
  const identity = status.identity || {};
  $('sidebar-identity').textContent = roleName(ui.role);
  $('identity-lock').textContent = ui.locked ? '身份已锁定' : ui.role ? '可切换身份' : '尚未选择';
  $('identity-message').textContent = identity.message || (ui.locked ? '请先退出私有网络，再切换身份。' : '选择身份后连接私有网络。');
  for (const role of ['client', 'host']) { const button = $(`tab-${role}`); button.classList.toggle('selected', ui.role === role); button.setAttribute('aria-pressed', String(ui.role === role)); button.disabled = !ui.canSelectRole; }
  $('network-login').disabled = !ui.canConnect;
  $('network-disconnect').disabled = !ui.canDisconnect;
  $('refresh-network').disabled = actionBusy || proxyBusy || !localAvailable || !ui.role || !identity.desiredOnline;
  $('host-form').hidden = ui.role !== 'host'; $('client-form').hidden = ui.role !== 'client'; $('choose-role-hint').hidden = Boolean(ui.role);
  $('pairing-heading').textContent = ui.role === 'host' ? '创建服务与配对码' : ui.role === 'client' ? '连接 B 服务端' : '设备配对';
  for (const id of ['host-form', 'client-form']) for (const input of $(id).elements) input.disabled = !ui.canPair;
  const saved = status.pairing?.saved || Boolean(status.invitation);
  $('forget-pair').hidden = !saved; $('forget-pair').disabled = actionBusy || proxyBusy || !localAvailable;
  $('pairing-note').textContent = status.pairing?.message || '配对仅授予设备连接权限；模型和网络共享需要分别开启。';
  $('pause-pair').hidden = !saved || status.pairing?.state === 'paused' || !identity.desiredOnline;
  $('resume-pair').hidden = !saved || status.online || !identity.desiredOnline;
  $('pause-pair').disabled = $('resume-pair').disabled = actionBusy || proxyBusy || !localAvailable;
  $('pairing-output').hidden = ui.role !== 'host' || !status.invitation;
  $('pairing-code').textContent = ui.role === 'host' ? status.invitation || '' : '';
  if (lastInvitation !== status.invitation) {
    let pairing;
    try { pairing = status.invitation ? readInvitation(status.invitation) : null; } catch {}
    $('bridge-port').value = pairing?.port || 3211;
    if (pairing?.host) $('tailscale-ip').value = pairing.host;
    lastInvitation = status.invitation;
  }
  $('create-pair').textContent = status.invitation ? '重新创建配对码（撤销原授权）' : '创建服务与配对码';
}

$('model-form').onsubmit = (event) => {
  event.preventDefault();
  action('/api/model', { enabled: true, claudeCommand: $('claude-command').value.trim(), workspace: $('workspace').value.trim(), profile: $('profile').value, timeoutMs: Number($('model-timeout').value) * 1000, maxTurns: Number($('model-turns').value) }, 'Claude 模型配置已保存并启用');
};
$('model-disable').onclick = () => action('/api/model', { enabled: false }, 'Claude 服务已停止，网络共享保持原状态');
$('probe').onclick = async () => {
  if (actionBusy || proxyBusy) return;
  const revision = mutation;
  actionBusy = true; render(currentStatus);
  try { const result = await (await api('/api/probe', { claudeCommand: $('claude-command').value.trim() })).json(); if (revision !== mutation) return; $('probe-result').textContent = result.message; if (!result.available) toast(result.message, true); }
  catch (error) { if (revision === mutation) toast(error.message, true); }
  finally { actionBusy = false; render(currentStatus); }
};
$('copy-token').onclick = () => copy(token);
$('copy-url').onclick = () => copy(`${apiBase}/v1`);
$('copy-example').onclick = () => copy($('api-example').textContent);
function updateExample() {
  $('api-example').textContent = [`curl ${apiBase}/v1/chat/completions`, '  -H "Authorization: Bearer <API_TOKEN>"', '  -H "Content-Type: application/json"', `  -d '${JSON.stringify({ model: $('model-id').value, messages: [{ role: 'user', content: '你好' }], stream: false })}'`].join(' \\\n');
}
$('model-id').onchange = updateExample;
function renderModel(status, ui) {
  const model = status.model || {};
  const host = ui.role === 'host';
  $('model-heading').textContent = host ? 'B · Claude 服务配置' : 'A · 远端 Claude 调用';
  $('model-host-panel').hidden = !host; $('model-client-panel').hidden = ui.role !== 'client';
  const ready = model.available === true;
  $('model-state').textContent = ready ? 'Claude 服务可用' : model.enabled ? '等待 Claude 服务' : 'Claude 服务未启用';
  $('model-state').className = `proxy-badge${ready ? ' ready' : ''}`;
  $('model-message').textContent = model.message || 'Claude 服务由 B 单独开启。';
  for (const input of $('model-form').elements) input.disabled = actionBusy || proxyBusy || !localAvailable || !ui.model || !host;
  $('model-disable').disabled ||= !model.enabled;
  $('model-test-submit').disabled = actionBusy || proxyBusy || !localAvailable || !ui.model || ui.role !== 'client' || !ready || Boolean(modelTest);
  $('model-test-cancel').hidden = !modelTest;
  const config = model.config || {};
  if (JSON.stringify(config) !== lastConfig) {
    $('workspace').value = config.workspace || ''; $('claude-command').value = config.claudeCommand || 'claude'; $('profile').value = config.profile || 'read';
    $('model-timeout').value = (config.timeoutMs || 600000) / 1000; $('model-turns').value = config.maxTurns || 30;
    lastConfig = JSON.stringify(config);
  }
}
$('model-test-cancel').onclick = () => modelTest?.abort();
function retireModelTest() {
  const controller = modelTest; modelTest = null;
  controller?.abort(); $('model-test-output').textContent = '';
}
$('model-test-form').onsubmit = async (event) => {
  event.preventDefault();
  if (modelTest || $('model-test-submit').disabled) return;
  const controller = modelTest = new AbortController(); render(currentStatus);
  $('model-test-output').textContent = '等待 B 的 Claude 完成本轮回复…';
  try {
    const response = await api('/v1/chat/completions', { model: $('model-id').value, messages: [{ role: 'user', content: $('model-test-prompt').value }], stream: false }, controller.signal);
    const result = await response.json();
    if (modelTest !== controller) return;
    $('model-test-output').textContent = result.choices?.[0]?.message?.content || JSON.stringify(result.choices?.[0]?.message || result, null, 2);
  } catch (error) { if (modelTest === controller) $('model-test-output').textContent = error.name === 'AbortError' ? '本轮请求已取消，不会自动重发。' : error.message; }
  finally { if (modelTest === controller) { modelTest = null; await poll(); } }
};

function formatBytes(value) {
  const bytes = Number(value) || 0;
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;
}
function renderProxy(proxy = {}, ui = state()) {
  proxyStatus = proxy;
  const host = ui.role === 'host', ready = proxy.state === 'ready' && proxy.online === true;
  $('proxy-heading').textContent = host ? 'B · 共享本机网络' : 'A · 通过 B 上网';
  $('proxy-state').textContent = host ? proxy.sharing ? '网络共享已开启' : '网络共享已关闭' : ready ? 'B 出口已连接' : !proxy.enabled ? '本地节点未启用' : '等待 B · 拒绝直连回退';
  $('proxy-state').className = `proxy-badge${host ? proxy.sharing ? ' ready' : '' : ready ? ' ready' : proxy.enabled ? ' blocked' : ''}`;
  $('proxy-message').textContent = proxy.message || '模型服务和网络代理独立运行。';
  $('proxy-host-panel').hidden = !host; $('proxy-client-panel').hidden = ui.role !== 'client';
  $('proxy-sharing').textContent = proxy.sharing ? '停止共享本机网络' : '开启共享本机网络';
  $('proxy-sharing').disabled = actionBusy || proxyBusy || !localAvailable || !ui.proxy || !host;
  $('proxy-enable').textContent = proxy.enabled ? '关闭本地 Clash 节点' : '启用本地 Clash 节点';
  $('proxy-enable').disabled = actionBusy || proxyBusy || !localAvailable || !ui.proxy || ui.role !== 'client';
  $('proxy-subscription').value = proxy.subscriptionUrl || ''; $('copy-subscription').disabled = actionBusy || proxyBusy || !localAvailable || !proxy.subscriptionUrl;
  renderDevices($('proxy-device-list'), proxy.devices || [], { empty: '等待本机与已配对 B 的连接状态。' });
  $('proxy-clients').replaceChildren();
  const clients = proxy.clients || [];
  if (!clients.length) { const hint = document.createElement('p'); hint.className = 'empty'; hint.textContent = '尚无已配对的 A 连接。私网在线设备不等同于共享使用者。'; $('proxy-clients').append(hint); }
  for (const client of clients) {
    const row = document.createElement('div'); row.className = 'peer-row proxy-client-row';
    const name = document.createElement('strong'); name.textContent = client.name || client.address || '已配对调用端';
    const address = document.createElement('code'); address.textContent = client.address || client.id || '';
    const use = document.createElement('span'); use.textContent = !client.online ? '离线' : client.usingProxy ? `正在使用共享 · ${client.connections || 0} 个连接` : '已配对在线 · 未使用共享';
    const traffic = document.createElement('small'); traffic.textContent = `上传 ${formatBytes(client.uploadBytes)} · 下载 ${formatBytes(client.downloadBytes)}`;
    row.append(name, address, use, traffic); $('proxy-clients').append(row);
  }
  const guard = proxy.guard || {}, unknown = guard.state === 'unknown' || guard.verification === 'unknown';
  const guardMessage = `${unknown ? '保护状态未验证，请检查或明确关闭' : guard.active ? '系统保护已验证生效' : '系统保护未启用'}${guard.message ? ` · ${guard.message}` : ''}`;
  $('proxy-guard-state').textContent = $('settings-guard-state').textContent = guardMessage;
  const unavailable = actionBusy || proxyBusy || !localAvailable || !guard.supported;
  $('proxy-guard').disabled = unavailable || ui.role !== 'client' || !ui.proxy || !proxy.enabled;
  for (const id of ['proxy-guard-verify', 'proxy-guard-disable', 'settings-guard-verify', 'settings-guard-disable']) $(id).disabled = unavailable;
  $('proxy-detail').textContent = `${host ? '共享出口' : '本地节点'} · 活跃连接 ${proxy.connections || 0} · 上传 ${formatBytes(proxy.uploadBytes)} · 下载 ${formatBytes(proxy.downloadBytes)}`;
}
async function proxyAction(route, body) {
  if (actionBusy || proxyBusy || !localAvailable) return;
  const instance = currentStatus?.instanceId;
  proxyBusy = true; mutation++; render(currentStatus);
  try {
    const result = await (await api(route, body)).json(); mutation++;
    if (instance && currentStatus?.instanceId !== instance) { await poll(); return; }
    if (result.proxy) render(result); else { currentStatus.proxy = result; render(currentStatus); }
    toast(proxyStatus.message || '设置已更新');
  } catch (error) { toast(error.message, true); await poll(); }
  finally { proxyBusy = false; render(currentStatus); }
}
$('proxy-sharing').onclick = () => proxyAction('/api/proxy', { sharing: !proxyStatus.sharing });
$('proxy-enable').onclick = () => proxyAction('/api/proxy', { enabled: !proxyStatus.enabled });
$('proxy-guard').onclick = () => proxyAction('/api/proxy/guard', { enabled: true });
for (const id of ['proxy-guard-verify', 'settings-guard-verify']) $(id).onclick = () => proxyAction('/api/proxy/guard/verify', {});
for (const id of ['proxy-guard-disable', 'settings-guard-disable']) $(id).onclick = () => proxyAction('/api/proxy/guard', { enabled: false });
$('copy-subscription').onclick = () => { if (proxyStatus.subscriptionUrl) copy(proxyStatus.subscriptionUrl); };

function render(status) {
  if (!status) return;
  const previousInstance = currentStatus?.instanceId, instance = status.instanceId;
  if (instance && retiredInstances.has(instance)) return;
  if (instance === previousInstance && Number.isSafeInteger(status.revision) && Number.isSafeInteger(currentStatus?.revision) && status.revision < currentStatus.revision) return;
  if (instance && previousInstance && instance !== previousInstance) {
    retiredInstances.add(previousInstance);
    if (retiredInstances.size > 8) retiredInstances.delete(retiredInstances.values().next().value);
    ++mutation;
    retireModelTest(); $('probe-result').textContent = '';
  }
  const previousRole = currentStatus?.identity?.role || currentStatus?.role;
  const previousConnection = currentStatus?.controlConnectionId;
  currentStatus = status;
  const ui = state();
  if (previousRole && previousRole !== ui.role) { ++mutation; selectedPeer = null; $('invitation').value = ''; lastConfig = undefined; retireModelTest(); $('probe-result').textContent = ''; navigate('connection'); }
  for (const key of ['api', 'proxy']) { const button = document.querySelector(`[data-page="${key}"]`); button.disabled = !ui[key === 'api' ? 'model' : 'proxy']; button.title = button.disabled ? '完成设备配对后可用' : ''; }
  if (!ui.model || ui.role !== 'client' || previousConnection !== status.controlConnectionId) retireModelTest();
  $('top-dot').classList.toggle('online', Boolean(status.online));
  $('top-status').textContent = !localAvailable ? '本地服务不可用' : status.online ? `${roleName(ui.role)} · ${ui.role === 'host' ? `${status.connectedClients || 0} 个 A 已连接` : 'B 已连接'}` : status.pairing?.message || status.identity?.message || '设备尚未配对';
  $('mode').textContent = status.demo ? 'DEMO / 本机模拟' : 'TAILSCALE MODE'; $('mode').classList.toggle('demo', status.demo);
  renderNetwork(status.network); renderIdentity(status, ui); renderModel(status, ui); renderProxy(status.proxy, ui); navigate(page);
  $('logs').replaceChildren();
  for (const log of status.logs || []) { const row = document.createElement('div'); row.className = 'log'; const time = document.createElement('time'); time.textContent = new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false }); const message = document.createElement('span'); message.textContent = log.message; row.append(time, message); $('logs').append(row); }
  if (!status.logs?.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '暂无运行记录。'; $('logs').append(empty); }
  if (status.error && lastError !== status.error) toast(status.error, true); lastError = status.error;
}
async function poll() {
  if (polling) return;
  polling = true;
  const revision = mutation;
  try { const result = await (await api('/api/status')).json(); if (revision !== mutation) return; localAvailable = true; render(result); }
  catch (error) {
    if (revision !== mutation) return;
    localAvailable = false; modelTest?.abort(); render(currentStatus);
    $('top-status').textContent = `本地服务不可用：${error.message}`; $('top-dot').classList.remove('online');
    $('proxy-message').textContent = '无法读取本地代理状态，请检查后台客户端。';
    $('proxy-guard-state').textContent = $('settings-guard-state').textContent = '无法读取保护状态；此前已启用的持久保护仍需明确关闭。';
  } finally { polling = false; }
}
async function pollNetwork() {
  if (networkPolling || actionBusy || proxyBusy || !localAvailable || !currentStatus?.identity?.desiredOnline) return;
  networkPolling = true;
  const revision = mutation;
  try {
    const network = await (await api('/api/tailscale')).json();
    if (revision !== mutation || !currentStatus?.identity?.desiredOnline) return;
    renderNetwork(network); await poll();
  } catch (error) { if (revision === mutation) $('network-status').textContent = error.message; }
  finally { networkPolling = false; }
}
async function init() {
  try {
    const response = await fetch('/api/bootstrap', { headers: { 'X-Bridge-UI': '1' } });
    if (!response.ok) throw new Error('初始化失败');
    const boot = await response.json(); token = boot.token; apiBase = boot.api;
    $('app-version').textContent = `EMBEDDED BRIDGE / v${boot.version}`; $('api-base-url').textContent = `${apiBase}/v1`;
    updateExample(); await poll(); navigate(location.hash.slice(1) || 'connection');
    setInterval(poll, 2000);
    setInterval(pollNetwork, 5000);
  } catch (error) { toast(error.message, true); }
}
init();
