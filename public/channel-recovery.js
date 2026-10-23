const states = new Set(['disabled', 'monitoring', 'refreshing', 'cooldown', 'budget-exhausted', 'waiting']);
const results = new Set(['refreshed', 'cooldown', 'unavailable', 'busy']);
const finite = (value, maximum) => Number.isFinite(value) && value >= 0 && value <= maximum;

function currentNotice(value, mode) {
  if (!value || !Number.isSafeInteger(value.id) || value.id <= 0 || !finite(value.ageMs, 300000) ||
      !['suggested', 'refreshing', 'refreshed', 'failed'].includes(value.phase) ||
      !(value.result === null || results.has(value.result))) return null;
  if (mode === 'notify') return value.phase === 'suggested' && value.result === null ? value : null;
  if (value.phase === 'suggested' || value.phase === 'refreshing' && value.result !== null ||
      value.phase === 'refreshed' && value.result !== 'refreshed' || value.phase === 'failed' && value.result === 'refreshed') return null;
  return value;
}

// Only current, bounded notices from the backend may describe an automatic
// result. Historical lastResult/lastAttempt fields never identify this session.
export function channelRecoveryText(proxy, role, { available = true } = {}) {
  if (!['host', 'client'].includes(role)) return '后台监测：—';
  if (!available) return '后台监测：本地服务不可用，等待状态更新。';
  const status = proxy?.channelRecovery;
  if (!status || typeof status.enabled !== 'boolean' || !states.has(status.state) || !['notify', 'automatic'].includes(status.mode)) return '后台监测：状态暂不可用。';
  if (!status.enabled || status.state === 'disabled') return role === 'host' ? '后台监测未启用；由对应 A 决定刷新。' : '后台监测：未启用。';
  const manual = proxy?.channelRefresh?.busy === true || status.state === 'refreshing' && status.lastReason === 'manual-refresh';
  if (manual) return role === 'host' ? '已请求所选 A 刷新通道；后台监测暂缓，由对应 A 决定刷新。' : '正在按请求刷新 Bridge 通道；后台监测暂缓。';
  if (role === 'host') return status.state === 'waiting' ? '后台监测共享通道，等待共享启用、流量或任务空闲；由对应 A 决定刷新。' : '后台监测共享通道；由对应 A 决定刷新。';
  const wait = finite(status.cooldownMs, 120000) && status.cooldownMs > 0 ? ` 共享冷却还需约 ${Math.ceil(status.cooldownMs / 1000)} 秒。` : '';
  const notice = currentNotice(status.notice, status.mode);
  if (notice?.phase === 'suggested') return '后台监测：通道持续受阻，建议点击“刷新线路”；当前仅提示，不会自动刷新。' + wait;
  if (notice?.phase === 'refreshing') return '后台监测：检测到通道持续受阻，正在重新探测当前 Bridge 通道。';
  if (notice?.phase === 'refreshed') return '后台监测：已重新探测，继续观察实际流量。' + wait;
  if (notice?.phase === 'failed') return '后台监测：本次重新探测未完成，继续观察实际流量。' + wait;
  if (status.state === 'budget-exhausted') return '后台监测：继续观察；通道恢复额度暂时用完，请稍后再刷新。';
  if (status.state === 'cooldown') return '后台监测：继续观察；通道刷新处于共享冷却。' + wait;
  if (status.state === 'waiting') return status.mode === 'notify' ? '后台监测：等待连接、代理流量或任务空闲；持续受阻时仅提示，由你刷新。' : '后台监测：等待连接、代理流量或任务空闲。';
  if (status.state === 'refreshing') return '后台监测：当前通道正在处理刷新，等待结果。';
  return status.mode === 'notify' ? '后台监测：持续受阻时仅提示，由你点击“刷新线路”。' : '后台监测：正在观察现有代理流量，持续受阻时重新探测通道。';
}
