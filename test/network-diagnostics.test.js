import test from 'node:test';
import assert from 'node:assert/strict';
import { networkDiagnosticsView } from '../public/network-diagnostics.js';

const paths = ['direct_ipv4', 'direct_ipv6', 'derp', 'peer_relay_ipv4', 'peer_relay_ipv6'];
const snapshot = () => ({ available: true, source: 'embedded', scope: 'node', capturedAt: '2026-10-21T12:34:56Z',
  netstack: { counter_tcp_retransmits: 12345, counter_tcp_fast_retransmit: 0, gauge_tcp_current_established: 2 },
  transport: ['inbound', 'outbound'].flatMap((direction, index) => paths.map((path, offset) => ({
    direction, path, bytes: 1024 * (index + 1) * (offset + 1), packets: (index + 1) * (offset + 1),
  }))),
});

test('network diagnostics formats cumulative counters, current gauge and complete path totals', () => {
  const view = networkDiagnosticsView(snapshot());
  assert.equal(view.available, true);
  assert.equal(view.tcp.find((item) => item.label === 'TCP 重传段数').value, '12,345');
  assert.equal(view.tcp.find((item) => item.label === '快速重传').value, '0');
  assert.equal(view.tcp.find((item) => item.label === '当前已建立连接').value, '2');
  assert.equal(view.tcp.find((item) => item.label === '重传超时').value, '—');
  assert.notEqual(view.capturedAt, '—');
  assert.deepEqual(view.totals, [{ label: '接收总量', bytes: '15.0 KiB', packets: '15' }, { label: '发送总量', bytes: '30.0 KiB', packets: '30' }]);
  assert.deepEqual(view.paths[2], { label: 'DERP 中转', inboundBytes: '3.0 KiB', inboundPackets: '3', outboundBytes: '6.0 KiB', outboundPackets: '6' });
});

test('unavailable and partial diagnostics preserve unknown values instead of displaying zero or a partial total', () => {
  for (const source of [undefined, { ...snapshot(), available: false, capturedAt: 'invalid', message: '<img onerror="fixture"> unavailable' }]) {
    const view = networkDiagnosticsView(source);
    assert.equal(view.available, false);
    assert.ok(view.tcp.every((counter) => counter.value === '—'));
    assert.ok(view.totals.every((total) => total.bytes === '—' && total.packets === '—'));
    assert.equal(view.capturedAt, '—');
  }
  const partial = snapshot();
  partial.transport = partial.transport.filter((row) => row.direction !== 'inbound' || row.path !== 'derp');
  partial.transport.find((row) => row.direction === 'outbound' && row.path === 'direct_ipv4').packets = null;
  const view = networkDiagnosticsView(partial);
  assert.equal(view.totals[0].bytes, '—');
  assert.equal(view.totals[0].packets, '—');
  assert.equal(view.totals[1].bytes, '30.0 KiB');
  assert.equal(view.totals[1].packets, '—');
  assert.equal(view.paths[0].inboundBytes, '1.0 KiB');
  assert.equal(view.paths[2].inboundBytes, '—');
});

test('invalid or imprecise counters remain unknown while exact uint64 text and real zero are preserved', () => {
  const source = snapshot();
  source.netstack = { counter_tcp_retransmits: '18446744073709551615', counter_tcp_fast_retransmit: 0,
    counter_tcp_timeouts: Number.MAX_SAFE_INTEGER + 1, counter_tcp_established_timeout: -1,
    counter_tcp_segments_sent: '18446744073709551616', counter_tcp_valid_segments_received: 1.5,
    gauge_tcp_current_established: false, counter_tcp_failed_connection_attempts: '' };
  source.transport[0].bytes = '18446744073709551615';
  const view = networkDiagnosticsView(source);
  assert.equal(view.tcp[0].value, '18,446,744,073,709,551,615');
  assert.equal(view.tcp[1].value, '0');
  assert.ok(view.tcp.slice(2).every((item) => item.value === '—'));
  assert.equal(view.paths[0].inboundBytes, '15.9 EiB');
  source.transport.push({ ...source.transport[0] });
  const duplicate = networkDiagnosticsView(source);
  assert.equal(duplicate.paths[0].inboundBytes, '—');
  assert.equal(duplicate.totals[0].bytes, '—');
});
