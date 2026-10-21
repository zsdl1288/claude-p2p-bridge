const route = '/api/proxy/speed-test';
const stops = new Set(['user-cancelled', 'remote-cancelled', 'closed', 'deadline', 'target-changed', 'helper-changed', 'network-stopped',
  'model-busy', 'recovery-busy', 'busy', 'cooldown', 'unsupported', 'peer-unsupported', 'connection-failed', 'transport-error',
  'speed-failed', 'transport-failed', 'invalid-result', 'control-unavailable', 'handshake-timeout', 'protocol-error', 'peer-disconnected', 'receiver-timeout']);
const phases = { connecting: '连接测速通道', download: '测试 A 下载 · B → A', upload: '测试 A 上传 · A → B', completed: '整理测速结果' };
const maximumSeconds = 60, maxBytesPerDirection = 256 * 1024 * 1024;
const stopMessages = { 'receiver-timeout': '接收端确认超时', deadline: '已达到测速总时限', 'handshake-timeout': '测速通道连接超时', 'peer-disconnected': '对端已断开',
  'target-changed': '配对连接已变化', 'helper-changed': '组网通道已变化', 'network-stopped': '私有网络已停止',
  'model-busy': '模型任务开始运行', 'recovery-busy': '通道正在恢复', 'connection-failed': '测速通道连接失败',
  'protocol-error': '未收到有效的测速确认', 'invalid-result': '未收到有效的测速结果' };
const number = (value) => Number.isFinite(value) && value >= 0;
const time = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ? value : null;

// Project only measurement fields; the containing job/status holds local IDs.
export function speedReportForExport(report) {
  if (!report || report.v !== 1) return null;
  const result = { v: 1, completed: report.completed === true, startedAtUtc: time(report.startedAtUtc), finishedAtUtc: time(report.finishedAtUtc),
    targetRole: ['host', 'client'].includes(report.targetRole) ? report.targetRole : null,
    maximumSeconds, maxBytesPerDirection,
    stopReason: report.stopReason == null ? null : stops.has(report.stopReason) ? report.stopReason : 'speed-failed' };
  const latency = report.latency;
  if (latency && Array.isArray(latency.samples)) {
    const samples = latency.samples.filter((value) => number(value) && value <= maximumSeconds * 1000).slice(0, 64);
    const sorted = [...samples].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    result.latency = { samples, minMs: sorted[0] ?? null, maxMs: sorted.at(-1) ?? null,
      medianMs: samples.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null,
      failedSamples: Number.isSafeInteger(latency.failedSamples) && latency.failedSamples >= 0 ? Math.min(64 - samples.length, latency.failedSamples) : 0 };
  } else result.latency = null;
  for (const direction of ['download', 'upload']) {
    const value = report[direction];
    result[direction] = value && number(value.receivedBytes) && value.receivedBytes <= maxBytesPerDirection && number(value.durationMs) && number(value.bytesPerSecond)
      ? { receivedBytes: value.receivedBytes, durationMs: value.durationMs, bytesPerSecond: value.bytesPerSecond,
        completion: ['complete', 'partial', 'failed'].includes(value.completion) ? value.completion : 'failed', limitReached: value.limitReached === true } : null;
  }
  result.notes = ['A 下载为 B→A，A 上传为 A→B；吞吐按接收端实际收到的载荷计算。',
    '每方向最多 20 秒或 256 MiB；RTT 在上传、下载期间采样，反映传输负载下的往返时间。',
    '结果反映配对通道，不代表 B 的互联网出口带宽。'];
  return result;
}

export function speedMetric(value) {
  if (!value || !number(value.bytesPerSecond) || !['complete', 'partial'].includes(value.completion)) return { primary: '—', secondary: 'Mbps / MB/s' };
  return { primary: (value.bytesPerSecond * 8 / 1e6).toFixed(2), secondary: `Mbps · ${(value.bytesPerSecond / 1e6).toFixed(2)} MB/s${value.completion === 'partial' ? ' · 部分结果' : ''}` };
}

export function createSpeedTestView({ api, $, available, toast }) {
  let open = false, epoch = 0, reading = null, actionEpoch = null, snapshot = null, ownedJob = null, timer = null;
  const busy = () => actionEpoch !== null || snapshot?.busy === true;
  const dialog = $('speed-test-dialog');
  function render() {
    const targets = Array.isArray(snapshot?.targets) ? snapshot.targets : [], select = $('speed-test-target'), previous = select.value;
    select.replaceChildren();
    for (const target of targets) {
      const option = document.createElement('option'); option.value = target.id;
      option.textContent = `${target.role === 'host' ? 'B 服务端' : 'A 调用端'} · ${target.name || '当前配对设备'}${target.supported === false ? '（需升级）' : ''}`;
      select.append(option);
    }
    select.value = targets.some((target) => target.id === previous) ? previous : targets[0]?.id || '';
    select.disabled = busy() || targets.length < 2;
    const selected = targets.find((target) => target.id === select.value);
    $('speed-test-start').disabled = !open || !available() || busy() || snapshot?.available !== true || !selected || selected.supported === false || snapshot?.retryAfterMs > 0;
    $('speed-test-cancel').disabled = !open || actionEpoch !== null || !snapshot?.busy || !snapshot?.job?.id;
    $('speed-test-export').disabled = busy() || !snapshot?.job?.report?.finishedAtUtc;
    const report = speedReportForExport(snapshot?.job?.report), progress = snapshot?.job?.progress;
    const measuredLatency = number(report?.latency?.medianMs), recentLatency = number(progress?.latencyMs);
    $('speed-test-latency').textContent = measuredLatency ? report.latency.medianMs.toFixed(1) : recentLatency ? progress.latencyMs.toFixed(1) : '—';
    $('speed-test-latency-unit').textContent = measuredLatency ? `ms · 传输中采样 · 中位数 · ${report.latency.samples.length} 个样本` :
      recentLatency ? 'ms · 传输中最近样本' : 'ms · 上传、下载时同步测量';
    for (const direction of ['download', 'upload']) {
      let metric = report?.[direction];
      if (snapshot?.busy && progress?.phase === direction && number(progress.bytesPerSecond)) metric = { bytesPerSecond: progress.bytesPerSecond, completion: 'partial' };
      const view = speedMetric(metric);
      $(`speed-test-${direction}`).textContent = view.primary;
      $(`speed-test-${direction}-unit`).textContent = snapshot?.busy && progress?.phase === direction ? view.secondary.replace('部分结果', '测速中') : view.secondary;
    }
    const bar = $('speed-test-progress');
    bar.value = snapshot?.job?.state === 'completed' ? 1 : 0;
    let waitingForReceiver = false;
    if (snapshot?.busy && progress) {
      const elapsed = number(progress.elapsedMs) && progress.durationMs > 0 ? progress.elapsedMs / progress.durationMs : 0;
      const payload = number(progress.bytes) && progress.maxBytes > 0 ? progress.bytes / progress.maxBytes : 0;
      const ratio = Math.min(1, Math.max(elapsed, payload));
      waitingForReceiver = progress.waitingForReceiver === true || ratio === 1;
      if (progress.phase === 'download' || progress.phase === 'upload') {
        bar.value = (progress.phase === 'upload' ? 0.5 : 0) + Math.min(0.98, ratio) / 2;
      } else if (progress.phase === 'completed') bar.value = 0.99;
    }
    const wait = Math.ceil((snapshot?.retryAfterMs || 0) / 1000);
    const finished = snapshot?.job && snapshot.job.state !== 'running';
    const phaseName = progress?.phase === 'download' ? '下载' : progress?.phase === 'upload' ? '上传' : '';
    const failure = report?.stopReason ? stopMessages[report.stopReason] || '测速通道未完成传输或接收确认' : '可重新开始';
    const finishedText = report?.completed ? '测速完成' : snapshot?.job?.state === 'cancelled' ? '测速已取消' : `${phaseName}测速未完成：${failure}`;
    $('speed-test-status').textContent = snapshot?.busy ? waitingForReceiver && phaseName ? `${phaseName}阶段等待接收端确认（最多 ${number(progress.confirmationRemainingMs) ? Math.min(5, Math.ceil(progress.confirmationRemainingMs / 1000)) : 5} 秒）… 可随时取消。` :
      `${phases[progress?.phase] || '准备测速'}… 上传、下载各最多 20 秒，延迟同步测量。` :
      finished ? `${finishedText}${wait ? `；约 ${wait} 秒后可重测。` : '。'}` :
      selected?.supported === false ? '对端需要升级到 1.2.0 或更新版才能使用本版测速。' :
      wait ? `约 ${wait} 秒后可再次测速。` : snapshot?.available ? '选择设备后点击开始测速。' : snapshot?.message || '等待当前配对设备连接。';
  }
  async function refresh() {
    if (!open || !available() || reading || actionEpoch !== null) return;
    const current = epoch, controller = reading = new AbortController();
    try {
      const value = await (await api(route, undefined, controller.signal)).json();
      if (open && epoch === current && reading === controller && actionEpoch === null) {
        snapshot = value;
        if (ownedJob && (!snapshot?.busy || snapshot?.job?.id !== ownedJob)) ownedJob = null;
        render();
      }
    } catch (error) {
      if (open && epoch === current && !controller.signal.aborted) $('speed-test-status').textContent = `读取测速状态失败：${error.message}`;
    } finally { if (reading === controller) reading = null; }
  }
  $('speed-test-target').onchange = render;
  $('speed-test-start').onclick = async () => {
    if ($('speed-test-start').disabled) return;
    const current = epoch, targetId = $('speed-test-target').value;
    actionEpoch = current; reading?.abort(); reading = null; render();
    try {
      const job = await (await api(route, { targetId })).json();
      if (!open || epoch !== current) { if (job.id) await api(`${route}/cancel`, { jobId: job.id }).catch(() => {}); return; }
      ownedJob = job.id; snapshot = { ...snapshot, busy: job.state === 'running', job };
    } catch (error) { if (open && epoch === current) toast(error.message, true); }
    finally { if (actionEpoch === current) actionEpoch = null; if (open && epoch === current) { render(); await refresh(); } }
  };
  $('speed-test-cancel').onclick = async () => {
    const jobId = snapshot?.job?.id, current = epoch;
    if ($('speed-test-cancel').disabled || !jobId) return;
    actionEpoch = current; reading?.abort(); reading = null; render();
    try { const value = await (await api(`${route}/cancel`, { jobId })).json(); if (open && epoch === current) snapshot = value; }
    catch (error) { if (open && epoch === current) toast(error.message, true); }
    finally { if (actionEpoch === current) actionEpoch = null; if (open && epoch === current) render(); }
  };
  $('speed-test-export').onclick = () => {
    if ($('speed-test-export').disabled) return;
    const report = speedReportForExport(snapshot?.job?.report); if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `Bridge-speed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click(); URL.revokeObjectURL(url);
  };
  function close() {
    if (!open) return;
    open = false; ++epoch; reading?.abort(); reading = null; clearInterval(timer); timer = null;
    const jobId = ownedJob; ownedJob = null; snapshot = null;
    if (jobId) void api(`${route}/cancel`, { jobId }, undefined, true).catch(() => {});
    if (dialog.open) dialog.close();
  }
  $('speed-test-close').onclick = close;
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('close', close);
  $('speed-test-open').onclick = async () => {
    if ($('speed-test-open').disabled || open) return;
    open = true; ++epoch; snapshot = null; render(); dialog.showModal();
    timer = setInterval(refresh, 750);
    await refresh();
  };
  return { busy, refresh, close };
}
