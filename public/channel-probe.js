const route = '/api/network/diagnostics/channel-probe';
const outcomes = new Set(['reply', 'timeout', 'cancelled', 'busy', 'unavailable', 'probe-error', 'invalid-request', 'invalid-result', 'rpc-gap']);
const paths = { direct: '直连', derp: 'DERP 中继', 'peer-relay': '节点中继', unknown: '未知' };
const reasons = { 'not-connected': '等待当前配对设备上线', 'model-busy': '请等待模型任务结束',
  'recovery-busy': '请等待通道刷新结束', unavailable: '当前网络组件尚未就绪', cooldown: '探测冷却中',
  'helper-unavailable': '当前网络组件尚未就绪', busy: '已有探测正在运行' };

// Export the report projection only, never the containing status or job.
export function probeReportForExport(report) {
  if (!report || !Array.isArray(report.results)) return null;
  const output = {};
  for (const key of ['v', 'completed', 'startedAtUtc', 'finishedAtUtc', 'targetRole', 'plannedProbes', 'completedProbes', 'replies', 'maximumSeconds', 'helperUnchanged', 'stopReason']) {
    if (['string', 'number', 'boolean'].includes(typeof report[key]) || report[key] === null) output[key] = report[key];
  }
  output.results = report.results.slice(0, 9).filter((row) => row &&
    ((row.type === 'TSMP' && row.size === 0) || (row.type === 'disco' && [128, 1200].includes(row.size)))).map((row) => {
    const result = { type: row.type, size: row.size, outcome: outcomes.has(row.outcome) ? row.outcome : 'invalid-result',
      actualVia: row.type === 'TSMP' || !Object.hasOwn(paths, row.actualVia) ? 'unknown' : row.actualVia };
    if (Number.isFinite(row.latencySeconds) && row.latencySeconds >= 0 && result.outcome === 'reply') result.latencySeconds = row.latencySeconds;
    if (result.actualVia === 'derp' && Number.isInteger(row.derpRegionId) && row.derpRegionId > 0 && row.derpRegionId <= 65535) result.derpRegionId = row.derpRegionId;
    if (result.actualVia === 'derp' && /^[A-Za-z0-9_-]{1,16}$/.test(row.derpRegionCode || '')) result.derpRegionCode = row.derpRegionCode;
    return result;
  });
  output.notes = ['主动探测可能更新 Bridge 路径；不是带宽测速。', 'TSMP 为固定 29 字节内层 IPv4，实际路径未知。',
    'disco 大小为 UDP 负载；超时不是已确认的公网丢包率，回复不证明 MTU 或下载带宽。'];
  return output;
}

export function probeReportText(report) {
  const safe = probeReportForExport(report);
  if (!safe) return '尚未探测。';
  const lines = [`${safe.completed ? '本组探测完成' : '本组探测尚未完成'} · 回复 ${safe.replies || 0}/${safe.completedProbes || 0} · 计划 ${safe.plannedProbes || 9} 次`,
    `开始：${safe.startedAtUtc || '—'}\n结束：${safe.finishedAtUtc || '—'}`];
  if (safe.stopReason) lines.push(`停止原因：${safe.stopReason}`);
  for (const [type, size] of [['TSMP', 0], ['disco', 128], ['disco', 1200]]) {
    const rows = safe.results.filter((row) => row.type === type && row.size === size), replies = rows.filter((row) => row.outcome === 'reply');
    const times = replies.map((row) => row.latencySeconds * 1000).filter(Number.isFinite);
    const latency = times.length ? ` · RTT ${Math.min(...times).toFixed(1)}～${Math.max(...times).toFixed(1)} ms` : '';
    const via = [...new Set(replies.map((row) => paths[row.actualVia]))].join(' / ') || '未知';
    lines.push(`${type}${size ? ` ${size}` : ''}：回复 ${replies.length}/${rows.length}，超时 ${rows.filter((row) => row.outcome === 'timeout').length}，其他 ${rows.length - replies.length - rows.filter((row) => row.outcome === 'timeout').length}${latency} · 路径 ${via}`);
  }
  return [...lines, '', ...safe.notes].join('\n');
}

export function createChannelProbeView({ api, $, available, toast }) {
  let open = false, epoch = 0, reading = null, action = false, snapshot = null, ownedJob = null;
  const busy = () => action || snapshot?.busy === true;
  function render() {
    const targets = Array.isArray(snapshot?.targets) ? snapshot.targets : [], select = $('channel-probe-target'), previous = select.value;
    select.replaceChildren();
    for (const target of targets) {
      const option = document.createElement('option'); option.value = target.id;
      option.textContent = `${target.role === 'host' ? 'B 服务端' : 'A 调用端'} · ${target.name || target.address || '当前配对设备'}`;
      select.append(option);
    }
    select.value = targets.some((target) => target.id === previous) ? previous : targets[0]?.id || '';
    select.disabled = busy() || !targets.length;
    $('channel-probe-start').disabled = !open || !available() || busy() || snapshot?.available !== true || !select.value || snapshot?.retryAfterMs > 0;
    $('channel-probe-cancel').disabled = !open || action || !snapshot?.busy || !snapshot?.job?.id;
    $('channel-probe-export').disabled = busy() || !snapshot?.job?.report?.results?.length;
    const wait = Math.ceil((snapshot?.retryAfterMs || 0) / 1000);
    $('channel-probe-status').textContent = busy() ? `正在探测 · ${snapshot?.job?.report?.completedProbes || 0}/9，最长 35 秒，可取消。` : wait ? `探测冷却中，约 ${wait} 秒后可再次运行。` :
      snapshot?.available === true ? '选择当前配对设备后手动开始，不会自动测速。' : snapshot?.message || reasons[snapshot?.reason] || '等待当前配对设备及网络组件就绪。';
    $('channel-probe-result').textContent = probeReportText(snapshot?.job?.report);
  }
  async function refresh() {
    if (!open || !available() || reading) return;
    const current = epoch, controller = reading = new AbortController();
    try {
      const value = await (await api(route, undefined, controller.signal)).json();
      if (open && epoch === current && reading === controller) { snapshot = value; if (!snapshot?.busy) ownedJob = null; render(); }
    } catch (error) {
      if (open && epoch === current && !controller.signal.aborted) $('channel-probe-status').textContent = `读取探测状态失败：${error.message}`;
    } finally { if (reading === controller) reading = null; }
  }
  $('channel-probe-start').onclick = async () => {
    if ($('channel-probe-start').disabled) return;
    const current = epoch, targetId = $('channel-probe-target').value;
    action = true; render();
    try {
      // Do not abort this short start response: a retired view must learn its
      // newly-created job id so it can cancel that exact job.
      const job = await (await api(route, { targetId })).json();
      if (!open || epoch !== current) { if (job.id) await api(`${route}/cancel`, { jobId: job.id }).catch(() => {}); return; }
      ownedJob = job.id; snapshot = { ...snapshot, busy: true, job };
    } catch (error) { if (open && epoch === current) toast(error.message, true); }
    finally { action = false; if (open && epoch === current) { render(); await refresh(); } }
  };
  $('channel-probe-cancel').onclick = async () => {
    const jobId = snapshot?.job?.id, current = epoch;
    if ($('channel-probe-cancel').disabled || !jobId) return;
    action = true; render();
    try { const value = await (await api(`${route}/cancel`, { jobId })).json(); if (open && epoch === current) snapshot = value; }
    catch (error) { if (open && epoch === current) toast(error.message, true); }
    finally { action = false; if (open && epoch === current) render(); }
  };
  $('channel-probe-export').onclick = () => {
    if ($('channel-probe-export').disabled) return;
    const report = probeReportForExport(snapshot?.job?.report); if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `Bridge-channel-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click(); URL.revokeObjectURL(url);
  };
  return {
    busy, refresh,
    async open() { open = true; ++epoch; render(); await refresh(); },
    close() {
      open = false; ++epoch; reading?.abort(); reading = null;
      const jobId = ownedJob; ownedJob = null; snapshot = null;
      if (jobId) void api(`${route}/cancel`, { jobId }, undefined, true).catch(() => {});
      render();
    }
  };
}
