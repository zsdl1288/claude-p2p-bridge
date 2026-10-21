import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyRate, proxyRealtimeText } from '../public/proxy-metrics.js';

test('real-time proxy rates and RTT preserve missing values and always describe A directions', () => {
  assert.equal(proxyRate(2000000), '2.00 MB/s'); assert.equal(proxyRate(12500), '12.5 KB/s');
  assert.equal(proxyRate(0), '0 B/s'); assert.equal(proxyRate(null), '—'); assert.equal(proxyRate(-1), '—');
  const device = { online: true, uploadBytesPerSecond: 1000000, downloadBytesPerSecond: 2000000, latencyMs: 135.8 };
  assert.equal(proxyRealtimeText(device), '↑ 1.00 MB/s · ↓ 2.00 MB/s · 136 ms');
  assert.match(proxyRealtimeText({ ...device, self: true }), /— ms$/);
  assert.equal(proxyRealtimeText({ ...device, online: false }), '↑ — · ↓ — · — ms');
  assert.match(proxyRealtimeText({ ...device, latencyMs: null }), /— ms$/);
});
