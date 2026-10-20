const paths = [
  ['direct_ipv4', 'IPv4 直连'], ['direct_ipv6', 'IPv6 直连'], ['derp', 'DERP 中转'],
  ['peer_relay_ipv4', 'IPv4 节点中继'], ['peer_relay_ipv6', 'IPv6 节点中继'],
];
const counters = [
  ['counter_tcp_retransmits', 'TCP 重传段数'], ['counter_tcp_fast_retransmit', '快速重传'],
  ['counter_tcp_timeouts', '重传超时'], ['counter_tcp_established_timeout', '已建立连接超时'],
  ['counter_tcp_segments_sent', '已发送 TCP 段'], ['counter_tcp_valid_segments_received', '有效接收 TCP 段'],
  ['gauge_tcp_current_established', '当前已建立连接'], ['counter_tcp_failed_connection_attempts', '连接失败次数'],
];

function integer(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(value)) {
    const number = BigInt(value);
    return number <= 18446744073709551615n ? number : null;
  }
  return null;
}
const count = (value) => value === null ? '—' : value.toLocaleString('zh-CN');
function bytes(value) {
  if (value === null) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  let divisor = 1n, unit = 0;
  while (value >= divisor * 1024n && unit < units.length - 1) { divisor *= 1024n; ++unit; }
  if (!unit) return `${count(value)} B`;
  return `${count(value / divisor)}.${value % divisor * 10n / divisor} ${units[unit]}`;
}
function capturedTime(value) {
  if (typeof value !== 'string' || !value) return '—';
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? '—' : time.toLocaleString('zh-CN', { hour12: false });
}

// Missing or imprecise counters stay unknown. In particular, summing a partial
// path list must not make absent paths look like zero traffic.
export function networkDiagnosticsView(snapshot) {
  const available = snapshot?.available === true;
  const rows = available && Array.isArray(snapshot.transport) ? snapshot.transport : [];
  const values = new Map();
  for (const row of rows) {
    if (!row || !['inbound', 'outbound'].includes(row.direction) || !paths.some(([path]) => path === row.path)) continue;
    const key = `${row.direction}:${row.path}`;
    values.set(key, values.has(key) ? null : { bytes: integer(row.bytes), packets: integer(row.packets) });
  }
  const traffic = (direction, path) => values.get(`${direction}:${path}`) || { bytes: null, packets: null };
  const total = (direction, field) => {
    const collected = paths.map(([path]) => traffic(direction, path)[field]);
    return collected.some((value) => value === null) ? null : collected.reduce((sum, value) => sum + value, 0n);
  };
  return {
    available,
    message: available ? '本机节点统计快照；打开期间每 2 秒更新，也可手动刷新。'
      : typeof snapshot?.message === 'string' && snapshot.message ? snapshot.message : '当前无法读取内置组网诊断。',
    capturedAt: capturedTime(snapshot?.capturedAt),
    tcp: counters.map(([name, label]) => ({ label, value: count(available ? integer(snapshot.netstack?.[name]) : null) })),
    totals: [['inbound', '接收总量'], ['outbound', '发送总量']].map(([direction, label]) => ({
      label, bytes: bytes(total(direction, 'bytes')), packets: count(total(direction, 'packets')),
    })),
    paths: paths.map(([path, label]) => {
      const inbound = traffic('inbound', path), outbound = traffic('outbound', path);
      return { label, inboundBytes: bytes(inbound.bytes), inboundPackets: count(inbound.packets),
        outboundBytes: bytes(outbound.bytes), outboundPackets: count(outbound.packets) };
    }),
  };
}
