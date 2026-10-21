const valid = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function proxyRate(value) {
  if (!valid(value)) return '—';
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)} MB/s`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} KB/s`;
  return `${Math.round(value)} B/s`;
}
export function proxyRealtimeText(device) {
  const known = device?.online === true;
  return `↑ ${proxyRate(known ? device.uploadBytesPerSecond : null)} · ↓ ${proxyRate(known ? device.downloadBytesPerSecond : null)} · ${known && !device.self && valid(device.latencyMs) ? `${device.latencyMs.toFixed(0)} ms` : '— ms'}`;
}
