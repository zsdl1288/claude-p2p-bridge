const route = '/api/proxy/refresh';
const identifier = (value) => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
const number = (value, maximum) => Number.isFinite(value) && value >= 0 && value <= maximum;
const labels = { direct: '直连', derp: '中继', 'peer-relay': '对等中继', unknown: '—' };
const phases = { before: '读取当前线路…', refreshing: '正在请求重新探测线路…', after: '正在观察探测后的线路…', completed: '刷新完成。' };
const reasons = {
  ready: '可刷新当前配对通道。', refreshed: '已重新探测线路。', cooldown: '线路刷新冷却中，请稍后再试。',
  'budget-exhausted': '最近 30 分钟的通道恢复次数已用完，请稍后再试。', unavailable: '当前通道暂不可刷新。',
  busy: '线路刷新正在进行。', 'model-busy': '模型任务正在执行或排队，请稍后刷新。',
  'speed-busy': '网络测速正在进行，请完成后再刷新。', 'recovery-busy': 'Bridge 正在恢复通道，请稍后刷新。',
  'network-stopped': '私有网络已停止，请连接后再刷新。', 'not-connected': '连接已授权的配对设备后可刷新线路。',
  unsupported: '所选 A 需升级到 1.2.1 后才能从 B 刷新线路。', 'target-changed': '配对连接已变化，请重新选择当前设备。',
  'helper-changed': '组网通道已变化，请稍后重试。', deadline: '线路观察已达到时限。',
  'user-cancelled': '本次线路刷新已停止。', closed: '线路刷新服务已关闭。',
  'control-unavailable': '当前配对控制通道不可用，请稍后再试。'
};
const safeReason = (value) => Object.hasOwn(reasons, value) ? value : 'unavailable';
const name = (value) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : '';

export function channelRouteText(value) {
  const path = value && Object.hasOwn(labels, value.path) ? value.path : 'unknown';
  const region = path === 'derp' && typeof value?.regionCode === 'string' && /^[a-z\d-]{1,16}$/i.test(value.regionCode) ? `（${value.regionCode}）` : '';
  const latency = number(value?.latencyMs, 120000) ? `${value.latencyMs.toFixed(1)} ms` : '—';
  return `${labels[path]}${region} · RTT ${latency}`;
}

function snapshotForView(value, role) {
  const targets = [], seen = new Set();
  for (const item of Array.isArray(value?.targets) ? value.targets : []) {
    if (targets.length === 16 || !identifier(item?.id) || seen.has(item.id) || item.role !== (role === 'client' ? 'host' : 'client')) continue;
    seen.add(item.id); targets.push({ id: item.id, name: name(item.name), supported: role === 'client' || item.supported === true });
  }
  const rawJob = value?.job;
  const job = identifier(rawJob?.id) && targets.some((item) => item.id === rawJob.targetId) && ['running', 'completed', 'failed'].includes(rawJob.state)
    ? { id: rawJob.id, targetId: rawJob.targetId, state: rawJob.state,
      phase: Object.hasOwn(phases, rawJob.phase) ? rawJob.phase : 'before', result: rawJob.result && typeof rawJob.result === 'object' ? {
        refreshed: rawJob.result.refreshed === true, reason: safeReason(rawJob.result.reason),
        before: rawJob.result.before, after: rawJob.result.after, changed: typeof rawJob.result.changed === 'boolean' ? rawJob.result.changed : null
      } : null } : null;
  return { connected: value?.connected === true, available: value?.available === true, busy: value?.busy === true,
    reason: safeReason(value?.reason), retryAfterMs: number(value?.retryAfterMs, 30 * 60 * 1000) ? value.retryAfterMs : 0, targets, job };
}

export function createChannelRefreshView({ api, $, available, toast }) {
  let snapshot = null, context = { role: null, scope: '', visible: false }, epoch = 0, pending = null, selectedId = '', localError = '', lastTargets = '';
  const button = $('channel-refresh-start'), select = $('channel-refresh-target'), output = $('channel-refresh-status');
  const busy = () => Boolean(pending) || snapshot?.busy === true;
  function target() {
    const targets = snapshot?.targets || [];
    return context.role === 'client' ? targets.length === 1 ? targets[0] : null : targets.find((item) => item.id === selectedId);
  }
  function canStart() {
    const selected = target();
    return context.visible && available() && snapshot?.connected && snapshot.available && !busy() &&
      snapshot.retryAfterMs === 0 && selected?.supported === true;
  }
  function render() {
    const host = context.role === 'host', targets = snapshot?.targets || [];
    $('channel-refresh-target-label').hidden = !host;
    select.hidden = !host;
    const serialized = JSON.stringify(targets);
    if (serialized !== lastTargets) {
      select.replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择要刷新线路的 A'; select.append(placeholder);
      for (const item of targets) {
        const option = document.createElement('option'); option.value = item.id;
        option.textContent = `${item.name || '已授权调用端'}${item.supported ? '' : '（需升级 1.2.1）'}`;
        select.append(option);
      }
      lastTargets = serialized;
    }
    if (!targets.some((item) => item.id === selectedId)) selectedId = '';
    select.value = selectedId; select.disabled = !context.visible || !available() || busy() || !targets.length;
    button.disabled = !canStart(); button.textContent = busy() ? '刷新线路中…' : '刷新线路';
    if (!context.visible) { output.textContent = ''; return; }
    if (pending) { output.textContent = '正在提交线路刷新请求…'; return; }
    if (!snapshot?.connected || !targets.length) { output.textContent = reasons['not-connected']; return; }
    if (localError && !snapshot.busy) { output.textContent = localError; return; }
    const job = snapshot.job, selected = target();
    if (job && (snapshot.busy || !selected || selected.id === job.targetId)) {
      const device = targets.find((item) => item.id === job.targetId), prefix = host ? `${device.name || '所选 A'}：` : '';
      if (job.state === 'running') { output.textContent = prefix + phases[job.phase]; return; }
      const result = job.result;
      let summary = reasons[result?.reason || 'unavailable'];
      if (job.state === 'completed' && result?.refreshed && result.reason === 'refreshed') {
        const path = result.after && Object.hasOwn(labels, result.after.path) ? result.after.path : 'unknown';
        summary = result.changed === false && path !== 'unknown' ? `已重新探测，仍为${labels[path]}。` :
          result.changed === true ? '已重新探测，线路信息已变化。' : '已重新探测，当前线路见下方结果。';
      } else if (result?.refreshed) summary = `已请求重新探测，后续观察未完成：${summary}`;
      const wait = Math.ceil(snapshot.retryAfterMs / 1000);
      const availability = wait ? ` 约 ${wait} 秒后可再次刷新。` : !snapshot.available && snapshot.reason !== 'ready' ? ` ${reasons[snapshot.reason]}` : '';
      output.textContent = `${prefix}${summary}${result ? ` 刷新前 ${channelRouteText(result.before)} → 刷新后 ${channelRouteText(result.after)}` : ''}${availability}`;
      return;
    }
    if (selected?.supported === false) { output.textContent = reasons.unsupported; return; }
    const wait = Math.ceil((snapshot.retryAfterMs || 0) / 1000);
    output.textContent = wait ? `约 ${wait} 秒后可再次刷新线路。` : snapshot.available ?
      host && !selected ? '先选择一台 A，再刷新该设备的 Bridge 通道。' : '重新探测当前 Bridge 通道，保留配对；不会操作 Clash 或 TUN。' : reasons[snapshot.reason];
  }
  function update(value, options = {}) {
    const next = { role: ['host', 'client'].includes(options.role) ? options.role : null,
      scope: typeof options.scope === 'string' ? options.scope : '', visible: options.visible === true };
    if (next.role !== context.role || next.scope !== context.scope || next.visible !== context.visible) {
      ++epoch; pending = null; selectedId = ''; localError = '';
    }
    context = next; snapshot = snapshotForView(value, next.role);
    if (pending && !snapshot.targets.some((item) => item.id === pending.targetId)) { ++epoch; pending = null; }
    render();
  }
  function retire() {
    ++epoch; pending = null; selectedId = ''; localError = ''; snapshot = null; context.visible = false; render();
  }
  select.onchange = () => { selectedId = select.value; localError = ''; render(); };
  button.onclick = async () => {
    if (!canStart()) return;
    const operation = pending = { epoch, targetId: target().id }; localError = ''; render();
    try {
      const value = await (await api(route, { targetId: operation.targetId }, undefined, true)).json();
      if (pending !== operation || epoch !== operation.epoch || !context.visible || !available() ||
          !snapshot?.targets.some((item) => item.id === operation.targetId)) return;
      const next = snapshotForView(value, context.role);
      if (!next.targets.some((item) => item.id === operation.targetId)) return;
      // A command reply may predate a newer status read. Its target list must
      // not re-authorize a device that disappeared while the POST was pending.
      next.targets = snapshot.targets; next.connected = snapshot.connected;
      if (next.job && snapshot.job && next.job.id === snapshot.job.id && snapshot.job.state !== 'running') {
        next.job = snapshot.job; next.busy = snapshot.busy; next.available = snapshot.available;
        next.reason = snapshot.reason; next.retryAfterMs = snapshot.retryAfterMs;
      }
      snapshot = next;
    } catch {
      if (pending === operation && epoch === operation.epoch && context.visible && available()) {
        localError = '刷新线路请求失败，请稍后重试。'; toast(localError, true);
      }
    } finally { if (pending === operation) { pending = null; render(); } }
  };
  render(); return { update, retire, busy };
}
