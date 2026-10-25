const route = '/api/proxy/speed-test';
const stops = new Set(['user-cancelled', 'remote-cancelled', 'closed', 'deadline', 'target-changed', 'helper-changed', 'network-stopped',
  'model-busy', 'recovery-busy', 'busy', 'cooldown', 'unsupported', 'peer-unsupported', 'connection-failed', 'transport-error',
  'speed-failed', 'transport-failed', 'invalid-result', 'control-unavailable', 'handshake-timeout', 'protocol-error', 'peer-disconnected', 'receiver-timeout']);
const phases = { connecting: '连接测速通道', download: '测试 TCP 单连接 · A 下载 · B → A', upload: '测试 TCP 单连接 · A 上传 · A → B',
  'multi-download': '测试 TCP 四连接 · A 下载 · B → A', 'multi-upload': '测试 TCP 四连接 · A 上传 · A → B',
  'udp-download': '测试 UDP · A 下载 · B → A', 'udp-upload': '测试 UDP · A 上传 · A → B', completed: '整理测速结果' };
const maximumSeconds = 60, maxBytesPerDirection = 256 * 1024 * 1024;
const stopMessages = { 'receiver-timeout': '接收端确认超时', deadline: '已达到测速总时限', 'handshake-timeout': '测速通道连接超时', 'peer-disconnected': '对端已断开',
  'target-changed': '配对连接已变化', 'helper-changed': '组网通道已变化', 'network-stopped': '私有网络已停止',
  'model-busy': '模型任务开始运行', 'recovery-busy': '通道正在恢复', 'connection-failed': '测速通道连接失败',
  'protocol-error': '未收到有效的测速确认', 'invalid-result': '未收到有效的测速结果' };
const number = (value) => Number.isFinite(value) && value >= 0;
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const time = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ? value : null;

function udpTransfer(value, adaptive = false) {
  const maximum = (adaptive ? 512 : 64) * 1024 * 1024;
  const pending = adaptive && value?.durationMs === 0 && value.receivedBytes === 0 && value.completion === 'partial';
  if (!value || !integer(value.receivedBytes, maximum) || !number(value.durationMs) || (!pending && value.durationMs === 0) || value.durationMs > 60000 ||
      !['complete', 'partial', 'failed'].includes(value.completion) || !integer(value.packetBytes, 1200) || value.packetBytes < 1 ||
      !integer(value.receivedPackets, maximum) || !integer(value.duplicatePackets, maximum) || !integer(value.outOfOrderPackets, maximum) ||
      !number(value.offeredBytesPerSecond) || value.offeredBytesPerSecond > (adaptive ? 125000000 : 6250000)) return null;
  const confirmed = integer(value.sentPackets, maximum) && integer(value.sentBytes, maximum) && value.sentPackets >= value.receivedPackets && value.sentBytes >= value.receivedBytes;
  if (!confirmed && value.completion === 'complete') return null;
  const counted = confirmed && number(value.lossPercent) && value.lossPercent <= 100 && integer(value.lostPackets, maximum);
  return { receivedBytes: value.receivedBytes, durationMs: value.durationMs, bytesPerSecond: pending ? null : value.receivedBytes * 1000 / value.durationMs,
    completion: value.completion, limitReached: value.limitReached === true,
    sentBytes: confirmed ? value.sentBytes : null, sentPackets: confirmed ? value.sentPackets : null, receivedPackets: value.receivedPackets,
    lostPackets: counted ? value.sentPackets - value.receivedPackets : null,
    lossPercent: counted && value.sentPackets > 0 ? (value.sentPackets - value.receivedPackets) * 100 / value.sentPackets : null,
    duplicatePackets: value.duplicatePackets, outOfOrderPackets: value.outOfOrderPackets,
    offeredBytesPerSecond: value.offeredBytesPerSecond, packetBytes: value.packetBytes };
}

const udpStops = { 'loss-limited': '出现超过 1% 的丢包', 'sender-limited': '发送端未达到目标速率',
  'rate-ceiling': '达到 1 Gbps 测试上限', 'byte-budget': '达到测试流量上限', 'time-budget': '达到测试时限', cancelled: '已取消', failed: '测量未完成' };
const assessments = { passed: '低丢包', 'loss-limited': '丢包偏高', 'sender-limited': '发送受限', incomplete: '未确认' };
const rateText = (value) => number(value) ? `${(value * 8 / 1e6).toFixed(2)} Mbps` : '—';

function adaptiveUDP(value) {
  const maximum = 512 * 1024 * 1024;
  if (!value || value.mode !== 'adaptive' || !['complete', 'partial', 'failed'].includes(value.completion) ||
      !Array.isArray(value.stages) || value.stages.length > 16 || (value.stopReason !== null && !Object.hasOwn(udpStops, value.stopReason))) return null;
  const stages = []; let totalSentBytes = 0, totalReceivedBytes = 0, lowLossStageIndex = null, peakStageIndex = null;
  for (const [index, input] of value.stages.entries()) {
    const stage = udpTransfer(input, true), target = input?.targetBytesPerSecond;
    if (!stage || input.index !== index || !number(target) || target < 31250 || target > 125000000 ||
        stage.packetBytes !== 1100 || stage.offeredBytesPerSecond !== target || stage.receivedBytes !== stage.receivedPackets * 1100 ||
        stage.outOfOrderPackets > stage.receivedPackets) return null;
    const senderKnown = stage.sentBytes !== null;
    if (senderKnown && (stage.sentBytes !== stage.sentPackets * 1100 || !number(input.senderDurationMs) || input.senderDurationMs <= 0 || input.senderDurationMs > 120000)) return null;
    if (stage.completion === 'complete' && (!senderKnown || stage.lossPercent === null)) return null;
    const senderDurationMs = senderKnown ? input.senderDurationMs : null;
    const senderBytesPerSecond = senderKnown ? stage.sentBytes * 1000 / senderDurationMs : null;
    const targetReached = senderKnown && senderBytesPerSecond >= target * 0.85;
    const assessment = stage.completion !== 'complete' ? 'incomplete' : !targetReached ? 'sender-limited' : stage.lossPercent > 1 ? 'loss-limited' : 'passed';
    stages.push({ ...stage, index, targetBytesPerSecond: target, senderDurationMs, senderBytesPerSecond, targetReached, assessment });
    totalSentBytes += stage.sentBytes ?? 0; totalReceivedBytes += stage.receivedBytes;
    if (totalSentBytes > maximum || totalReceivedBytes > maximum) return null;
    if (stage.completion === 'complete') {
      if (peakStageIndex === null || stage.bytesPerSecond > stages[peakStageIndex].bytesPerSecond) peakStageIndex = index;
      if (stage.lossPercent <= 1 && (lowLossStageIndex === null || stage.bytesPerSecond > stages[lowLossStageIndex].bytesPerSecond)) lowLossStageIndex = index;
    }
  }
  if (value.completion === 'complete' && (peakStageIndex === null || !value.stopReason || ['cancelled', 'failed'].includes(value.stopReason))) return null;
  return { mode: 'adaptive', completion: value.completion, stages, lowLossStageIndex, peakStageIndex, stopReason: value.stopReason,
    lowerBound: ['sender-limited', 'rate-ceiling', 'byte-budget', 'time-budget'].includes(value.stopReason),
    totalSentBytes, totalReceivedBytes, rateCeilingBytesPerSecond: 125000000, lossThresholdPercent: 1, minimumSenderRatio: 0.85 };
}

const connectionCounts = [1, 2, 4, 8, 16];
function multiTransfer(value, connections = 4, maximum = 512 * 1024 * 1024, maximumMs = 150000) {
  if (!value || !Array.isArray(value.streams) || value.streams.length !== connections ||
      !integer(value.receivedBytes, maximum) || !number(value.durationMs) || value.durationMs > maximumMs ||
      !['complete', 'partial', 'failed'].includes(value.completion) || typeof value.limitReached !== 'boolean') return null;
  const streams = []; let received = 0;
  for (const [index, stream] of value.streams.entries()) {
    if (!stream || stream.index !== index || !integer(stream.receivedBytes, maximum) || !number(stream.durationMs) ||
        stream.durationMs > value.durationMs || (stream.durationMs === 0 && (stream.receivedBytes !== 0 || stream.completion === 'complete')) ||
        !['complete', 'partial', 'failed'].includes(stream.completion) || typeof stream.limitReached !== 'boolean' ||
        (value.completion === 'complete' && stream.completion !== 'complete')) return null;
    received += stream.receivedBytes;
    streams.push({ index, receivedBytes: stream.receivedBytes, durationMs: stream.durationMs,
      completion: stream.completion, limitReached: stream.limitReached });
  }
  if (received !== value.receivedBytes || received > maximum || (value.durationMs === 0 && (received !== 0 || value.completion === 'complete'))) return null;
  return { receivedBytes: received, durationMs: value.durationMs,
    bytesPerSecond: value.durationMs > 0 ? received * 1000 / value.durationMs : null,
    completion: value.completion, limitReached: value.limitReached, streams };
}

function adaptiveTCP(value, earlyStop = false) {
  if (!value || !['complete', 'partial', 'failed'].includes(value.completion) || !Array.isArray(value.stages) || value.stages.length > 5 ||
      ![null, 'completed', 'cancelled', 'failed', ...(earlyStop ? ['plateau'] : [])].includes(value.stopReason)) return null;
  const stages = []; let bestStageIndex = null, totalReceivedBytes = 0, stagnant = 0, plateau = false;
  for (const [index, input] of value.stages.entries()) {
    if (plateau || input?.index !== index || input.connections !== connectionCounts[index] ||
        (index > 0 && stages[index - 1].completion !== 'complete')) return null;
    const stage = multiTransfer(input, input.connections, 192 * 1024 * 1024, 210000);
    if (!stage) return null;
    stages.push({ ...stage, index, connections: input.connections }); totalReceivedBytes += stage.receivedBytes;
    if (stage.completion === 'complete') {
      const priorBest = bestStageIndex === null ? 0 : stages[bestStageIndex].bytesPerSecond;
      if (earlyStop) {
        stagnant = priorBest > 0 && stage.bytesPerSecond * 100 < priorBest * 105 ? stagnant + 1 : 0;
        plateau = stagnant >= 2 && index < 4;
      }
      if (bestStageIndex === null || stage.bytesPerSecond > priorBest) bestStageIndex = index;
    }
  }
  const complete = stages.length > 0 && stages.every((stage) => stage.completion === 'complete') &&
    (plateau ? value.stopReason === 'plateau' : stages.length === 5 && value.stopReason === 'completed');
  if ((value.completion === 'complete' && !complete) ||
      (['completed', 'plateau'].includes(value.stopReason) && value.completion !== 'complete')) return null;
  return { completion: value.completion, stages, bestStageIndex, totalReceivedBytes, stopReason: value.stopReason };
}
const bestTCP = (value) => integer(value?.bestStageIndex, 4) ? value.stages[value.bestStageIndex] : null;

// Project only measurement fields; the containing job/status holds local IDs.
export function speedReportForExport(report) {
  if (!report || ![1, 2, 3, 4, 5, 6].includes(report.v) || (report.v >= 2 && report.transport !== 'native-tailscale')) return null;
  const native = report.v >= 2, adaptive = report.v >= 3, multi = report.v >= 4, ramp = report.v >= 5, earlyStop = report.v === 6;
  const result = { v: report.v, transport: native ? 'native-tailscale' : 'legacy-websocket', completed: report.completed === true, startedAtUtc: time(report.startedAtUtc), finishedAtUtc: time(report.finishedAtUtc),
    targetRole: ['host', 'client'].includes(report.targetRole) ? report.targetRole : null,
    maximumSeconds: ramp ? 210 : multi ? 150 : adaptive ? 120 : maximumSeconds, maxBytesPerDirection: ramp ? 1472 * 1024 * 1024 : multi ? 1216 * 1024 * 1024 : adaptive ? 704 * 1024 * 1024 : maxBytesPerDirection,
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
    result[direction] = value && number(value.receivedBytes) && value.receivedBytes <= (native ? 192 * 1024 * 1024 : maxBytesPerDirection) && number(value.durationMs) && value.durationMs > 0 && value.durationMs <= 60000 && number(value.bytesPerSecond)
      ? { receivedBytes: value.receivedBytes, durationMs: value.durationMs, bytesPerSecond: native ? value.receivedBytes * 1000 / value.durationMs : value.bytesPerSecond,
        completion: ['complete', 'partial', 'failed'].includes(value.completion) ? value.completion : 'failed', limitReached: value.limitReached === true } : null;
  }
  if (native) {
    Object.assign(result, { tcpMaxBytesPerDirection: 192 * 1024 * 1024, udpMaxBytesPerDirection: (adaptive ? 512 : 64) * 1024 * 1024,
      tcpSecondsPerDirection: 10, udpSecondsPerDirection: adaptive ? 30 : 8 });
    if (adaptive) result.udpBudgetIsSoft = true;
    const parseUDP = adaptive ? adaptiveUDP : udpTransfer;
    result.udp = { download: parseUDP(report.udp?.download), upload: parseUDP(report.udp?.upload) };
  }
  if (multi) {
    result.tcpMultiMaxBytesPerDirection = (ramp ? 960 : 512) * 1024 * 1024; result.tcpMultiSecondsPerDirection = ramp ? 50 : 10;
    result.tcpMulti = ramp ? { mode: 'adaptive', connectionCounts: [...connectionCounts], download: null, upload: null } : { connections: 4, download: null, upload: null };
    if (ramp) {
      if (earlyStop) result.tcpMulti.earlyStop = { minimumGainPercent: 5, consecutiveStages: 2 };
      result.tcpStageMaxBytes = 192 * 1024 * 1024; result.tcpStageSeconds = 10;
      const validPlan = report.tcpMulti?.mode === 'adaptive' && JSON.stringify(report.tcpMulti.connectionCounts) === JSON.stringify(connectionCounts) &&
        (!earlyStop || report.tcpMulti.earlyStop?.minimumGainPercent === 5 && report.tcpMulti.earlyStop?.consecutiveStages === 2);
      for (const direction of ['download', 'upload']) {
        const value = result.tcpMulti[direction] = validPlan ? adaptiveTCP(report.tcpMulti[direction], earlyStop) : null, first = value?.stages[0];
        result[direction] = first && first.durationMs > 0 ? Object.fromEntries(['receivedBytes', 'durationMs', 'bytesPerSecond', 'completion', 'limitReached'].map((key) => [key, first[key]])) : null;
      }
    } else if (report.tcpMulti?.connections === 4) for (const direction of ['download', 'upload']) result.tcpMulti[direction] = multiTransfer(report.tcpMulti[direction]);
  }
  result.notes = adaptive ? ['UDP 从 1 Mbps 起逐档加压；每档记录目标、实际发送、实际接收速率和丢包，低丢包值取丢包不超过 1% 的已确认档。',
    '达到测试上限、时间/流量预算或发送端受限时，结果仅为本次已测下界；不能据此声称找到了线路极限。',
    'TCP 每方向 10 秒 / 192 MiB；UDP 每方向 512 MiB、30 秒升档预算，收尾确认可延长；整组硬限 120 秒 / 1408 MiB。',
    '各档最多发送 1.5 秒，结果是本次短时测量。UDP 丢包可能来自链路、代理处理或本机套接字；不含 B 的互联网出口及 Clash TUN 开销。'] : native ? ['A 下载为 B→A，A 上传为 A→B；TCP/UDP 使用原生代理相同的数据处理路径及固定合成源汇，不访问外部测速网站。',
    'TCP 每方向最多 10 秒 / 192 MiB；UDP 每方向最多 8 秒 / 64 MiB；整组最长 60 秒、最多 512 MiB。',
    'UDP 以 50 Mbps 目标发送负载测试有效接收吞吐和丢包，不代表 UDP 最大带宽；丢包按已确认的实际发包数计算。',
    '结果不包含 B 的互联网出口、网站或 Clash TUN 开销；未完成或缺失的测量不能视为零。'] : ['A 下载为 B→A，A 上传为 A→B；吞吐按接收端实际收到的载荷计算。',
    '每方向最多 20 秒或 256 MiB；RTT 在上传、下载期间采样，反映传输负载下的往返时间。',
    '这是旧 WebSocket 配对通道测速，不代表原生 TCP/UDP 代理或 B 的互联网出口带宽。'];
  if (ramp) result.notes.splice(2, 1,
    'TCP 每方向依次测试 1、2、4、8、16 条独立连接，每档共同发送最多 10 秒 / 192 MiB；速率按同一窗口的总实收字节计算，单连接卡片复用第 1 档。',
    '最高值只取完整确认档，相同速率优先更少连接；未完成的档位不会参与最高值。每方向 TCP 五档合计 960 MiB，UDP 512 MiB；整组硬限 210 秒 / 2944 MiB（约 2.88 GiB）。这是已测档位中的最高速度，不代表物理带宽或全局最优连接数。');
  else if (multi) result.notes.splice(2, 1,
    'TCP 单连接和四连接依次测量，上下行各最多 10 秒；单连接每方向 192 MiB，四连接共享每方向 512 MiB。四连接速率是总实收字节除以共同测量时间。',
    'UDP 每方向 512 MiB、30 秒升档预算；整组硬限 150 秒 / 2432 MiB（约 2.38 GiB）。单连接与四连接的差异用于比较本次通道吞吐，不保证跑满物理线路。');
  if (earlyStop) result.notes.push('TCP 连续两次加档后，相比此前已确认最高速度的提升均不足 5%，就提前结束该方向；达到 5% 重新计数。最早测完 1、2、4 三档后结束，仍保留小幅提升后的真实最高速度和对应连接数。');
  if (multi) result.completed = result.completed && ['download', 'upload'].every((direction) =>
    result[direction]?.completion === 'complete' && result.tcpMulti[direction]?.completion === 'complete' && result.udp[direction]?.completion === 'complete');
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
    const native = report?.transport === 'native-tailscale' || (!report && snapshot?.transport === 'native-tailscale');
    const adaptive = report?.v >= 3 || (!report && native), multi = report?.v >= 4 || (!report && native), ramp = report?.v >= 5 || (!report && native);
    const earlyStop = report?.v === 6 || (!report && native);
    $('speed-test-scope').textContent = ramp ? 'TCP 按 1、2、4、8、16 条连接逐档测试，分别显示最高速度及对应连接数，再测 UDP 自动升速。整组最多 210 秒 / 2944 MiB（约 2.88 GiB）测试载荷；不含 B 互联网出口和 Clash TUN 开销。' : multi ? '分别测试 TCP 单连接与四连接并发，再测 UDP 自动升速。整组最多 150 秒 / 2432 MiB（约 2.38 GiB）测试载荷；不含 B 的互联网出口和 Clash TUN 开销。' : adaptive ? 'UDP 从 1 Mbps 起逐级加压，最高测试 1 Gbps，显示实发、实收及丢包。整组最多 120 秒 / 1408 MiB（约 1.38 GiB）；结果是本次短窗测量。' : native ? '原生代理路径：TCP 每方向 10 秒，UDP 每方向 8 秒、50 Mbps 目标发送负载。整组最多 60 秒 / 512 MiB；不含 B 的互联网出口和 Clash TUN 开销。' :
      '旧 WebSocket 配对通道测速：每方向最多 20 秒 / 256 MiB，不代表原生 TCP/UDP 代理性能。';
    if (earlyStop) $('speed-test-scope').textContent += ' TCP 连续两次加档后，相比此前已测最高速度的提升均不足 5% 时提前结束；仍保留最高值及连接数。';
    $('speed-test-download-label').textContent = `${native ? 'TCP 单连接 · ' : ''}A 下载 · B → A`;
    $('speed-test-upload-label').textContent = `${native ? 'TCP 单连接 · ' : ''}A 上传 · A → B`;
    $('speed-test-tcp-multi').hidden = !multi;
    $('speed-test-tcp-stages').hidden = !ramp;
    $('speed-test-udp').hidden = !native;
    $('speed-test-udp-stages').hidden = !adaptive;
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
      const tcp = report?.tcpMulti?.[direction];
      let multiMetric = ramp ? bestTCP(tcp) : tcp;
      const multiRunning = snapshot?.busy && progress?.phase === `multi-${direction}`;
      if (!ramp && multiRunning && number(progress.bytesPerSecond)) multiMetric = { bytesPerSecond: progress.bytesPerSecond, completion: 'partial' };
      const multiView = speedMetric(multiMetric), single = report?.[direction];
      $(`speed-test-multi-${direction}`).textContent = multiView.primary;
      const comparable = single?.completion === 'complete' && multiMetric?.completion === 'complete' && single.bytesPerSecond > 0;
      $(`speed-test-multi-${direction}-label`).textContent = `TCP ${ramp ? '已测最高' : '四连接'} · A ${direction === 'download' ? '下载 · B → A' : '上传 · A → B'}`;
      $(`speed-test-multi-${direction}-unit`).textContent = `${!ramp && multiRunning ? multiView.secondary.replace('部分结果', '测速中') : multiView.secondary}${ramp && multiMetric ? ` · ${multiMetric.connections} 条连接` : ''}${comparable ? ` · 单连接的 ${(multiMetric.bytesPerSecond / single.bytesPerSecond).toFixed(2)} 倍` : ''}${multiMetric?.limitReached ? ' · 已达该档流量上限' : ''}${ramp && tcp?.completion !== 'complete' ? ' · 逐档测试未完成' : ''}${tcp?.stopReason === 'plateau' ? ` · 提升不足，提前结束，已测 ${tcp.stages.length}/5 档` : ''}`;
      const tcpRows = $(`speed-test-tcp-${direction}-rows`); tcpRows.replaceChildren();
      if (ramp) for (const stage of tcp?.stages || []) {
        const row = document.createElement('tr');
        for (const text of [String(stage.connections), rateText(stage.bytesPerSecond), `${(stage.durationMs / 1000).toFixed(2)} s`, `${(stage.receivedBytes / 1e6).toFixed(2)} MB`,
          stage.completion !== 'complete' ? '未完成' : stage.index === tcp.bestStageIndex ? '已测最高' : '已确认']) {
          const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
        }
        tcpRows.append(row);
      }
      const udp = report?.udp?.[direction];
      const chosen = adaptive ? udp?.stages?.[udp.lowLossStageIndex ?? udp.peakStageIndex] : udp;
      const udpView = speedMetric(chosen);
      $(`speed-test-udp-${direction}`).textContent = udpView.primary;
      if (adaptive) {
        const peak = udp?.stages?.[udp.peakStageIndex];
        const bestText = chosen ? `${udp.lowLossStageIndex === null ? '暂无低丢包档，显示峰值' : '低丢包最佳（≤1%）'} · 丢包 ${chosen.lossPercent.toFixed(2)}%` : '等待完整档位确认';
        const peakText = peak ? `；峰值 ${rateText(peak.bytesPerSecond)} / 丢包 ${peak.lossPercent.toFixed(2)}%` : '';
        $(`speed-test-udp-${direction}-unit`).textContent = `${bestText}${peakText}${udp?.stopReason ? `；${udpStops[udp.stopReason]}${udp.lowerBound ? '，仅为已测下界' : ''}` : ''}${udp?.completion === 'partial' ? '；部分结果' : ''}`;
      } else $(`speed-test-udp-${direction}-unit`).textContent = udp ? `${udpView.secondary} · 丢包 ${number(udp.lossPercent) ? `${udp.lossPercent.toFixed(2)}%` : '待确认'} · 目标发送 ${(udp.offeredBytesPerSecond * 8 / 1e6).toFixed(0)} Mbps` : '有效接收 Mbps · 丢包待确认 · 目标发送 50 Mbps';
      const rows = $(`speed-test-udp-${direction}-rows`); rows.replaceChildren();
      if (adaptive) for (const stage of udp?.stages || []) {
        const row = document.createElement('tr');
        for (const text of [String(stage.index + 1), rateText(stage.targetBytesPerSecond), rateText(stage.senderBytesPerSecond), rateText(stage.bytesPerSecond),
          number(stage.lossPercent) ? `${stage.lossPercent.toFixed(2)}%` : '待确认', assessments[stage.assessment]]) {
          const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
        }
        rows.append(row);
      }
    }
    const bar = $('speed-test-progress');
    bar.value = snapshot?.job?.state === 'completed' ? 1 : 0;
    let waitingForReceiver = false;
    if (snapshot?.busy && progress) {
      const elapsed = number(progress.elapsedMs) && progress.durationMs > 0 ? progress.elapsedMs / progress.durationMs : 0;
      const payload = number(progress.bytes) && progress.maxBytes > 0 ? progress.bytes / progress.maxBytes : 0;
      const ratio = Math.min(1, Math.max(elapsed, payload));
      waitingForReceiver = progress.waitingForReceiver === true || ratio === 1;
      const phaseIndex = (ramp ? ['multi-download', 'multi-upload', 'udp-download', 'udp-upload'] : multi ? ['download', 'upload', 'multi-download', 'multi-upload', 'udp-download', 'udp-upload'] : native ? ['download', 'upload', 'udp-download', 'udp-upload'] : ['download', 'upload']).indexOf(progress.phase);
      if (phaseIndex >= 0) {
        const fraction = ramp && progress.phase.startsWith('multi-') && integer(progress.stageIndex, 4) ? (progress.stageIndex + Math.min(0.98, ratio)) / 5 : Math.min(0.98, ratio);
        bar.value = (phaseIndex + fraction) / (ramp ? 4 : multi ? 6 : native ? 4 : 2);
      } else if (progress.phase === 'completed') bar.value = 0.99;
    }
    const wait = Math.ceil((snapshot?.retryAfterMs || 0) / 1000);
    const finished = snapshot?.job && snapshot.job.state !== 'running';
    const phaseName = progress?.phase === 'udp-download' ? 'UDP 下载' : progress?.phase === 'udp-upload' ? 'UDP 上传' : progress?.phase === 'multi-download' ? `TCP ${ramp ? '逐档' : '四连接'}下载` : progress?.phase === 'multi-upload' ? `TCP ${ramp ? '逐档' : '四连接'}上传` : progress?.phase === 'download' ? '下载' : progress?.phase === 'upload' ? '上传' : '';
    const failure = report?.stopReason ? stopMessages[report.stopReason] || '测速通道未完成传输或接收确认' : '可重新开始';
    const plateauText = ['download', 'upload'].filter((direction) => report?.tcpMulti?.[direction]?.stopReason === 'plateau')
      .map((direction) => `TCP ${direction === 'download' ? '下载' : '上传'}提升不足，提前结束，已测 ${report.tcpMulti[direction].stages.length}/5 档`).join('；');
    const finishedText = (report?.completed ? '测速完成' : snapshot?.job?.state === 'cancelled' ? '测速已取消' : `${phaseName}测速未完成：${failure}`) + (plateauText ? `；${plateauText}` : '');
    const stageText = ramp && progress?.phase?.startsWith('multi-') && integer(progress.stageIndex, 4) ? ` 第 ${progress.stageIndex + 1}/5 档 · ${connectionCounts[progress.stageIndex]} 条连接 · 实收 ${rateText(progress.bytesPerSecond)}` : adaptive && progress?.phase?.startsWith('udp-') && integer(progress.stageIndex, 15) ? ` 第 ${progress.stageIndex + 1} 档 · 目标 ${rateText(progress.targetBytesPerSecond)} · 实发 ${rateText(progress.senderBytesPerSecond)}` : '';
    const confirmationText = native ? `${phaseName}阶段正在完成传输并确认接收结果（整组最多 ${ramp ? 210 : multi ? 150 : adaptive ? 120 : 60} 秒）… 可随时取消。` :
      `${phaseName}阶段等待接收端确认（最多 ${number(progress?.confirmationRemainingMs) ? Math.min(5, Math.ceil(progress.confirmationRemainingMs / 1000)) : 5} 秒）… 可随时取消。`;
    $('speed-test-status').textContent = snapshot?.busy ? waitingForReceiver && phaseName ? confirmationText :
      `${ramp && progress?.phase?.startsWith('multi-') ? phaseName : phases[progress?.phase] || '准备测速'}${stageText}… ${native ? 'TCP/UDP 分别测量，UDP 按接收端统计有效速率及丢包。' : '上传、下载各最多 20 秒，延迟同步测量。'}` :
      finished ? `${finishedText}${wait ? `；约 ${wait} 秒后可重测。` : '。'}` :
      selected?.supported === false ? '双方需要升级到 1.2.11 或更新版，才能使用支持提前结束的 TCP 自动升档测速。' :
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
