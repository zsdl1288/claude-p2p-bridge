import { hostname, networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

export function isTailscaleIp(value) {
  if (typeof value !== 'string' || !isIPv4(value)) return false;
  const parts = value.split('.').map(Number);
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

export function validatePeerAddress(value, { allowLoopback = false } = {}) {
  if (isTailscaleIp(value) || (allowLoopback && value === '127.0.0.1')) return value;
  throw new Error('连接地址必须是 Tailscale IPv4（100.64.0.0–100.127.255.255）；不接受公网、局域网、域名或通配监听地址');
}

export function interfaceAddresses(interfaces = networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name, addresses]) => (addresses || [])
    .filter((entry) => entry.family === 'IPv4' && isTailscaleIp(entry.address))
    .map((entry) => ({ name, address: entry.address })));
}

// Keep the transport's peer list intact. The UI's device list also contains
// this computer and only assigns remote roles known from its own pairing.
export function networkDevices(network, { role = null, serverAddress = null } = {}) {
  const addresses = [...new Set((network.addresses || []).filter((address) => isTailscaleIp(address) || (network.demo && address === '127.0.0.1')))];
  const name = network.hostname || hostname();
  const devices = (addresses.length ? addresses : ['']).map((address) => ({
    name, address, self: true, role, online: network.demo ? true : network.running === true, path: 'local'
  }));
  const seen = new Set(addresses);
  for (const peer of network.peers || []) {
    if (!isTailscaleIp(peer.address) || seen.has(peer.address)) continue;
    seen.add(peer.address);
    devices.push({ name: peer.name, address: peer.address, online: peer.online === true, path: peer.path || 'unknown', self: false,
      role: role === 'client' && peer.address === serverAddress ? 'host' : null });
  }
  return devices;
}

async function findCli() {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
    : ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale'];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch {} }
  return process.platform === 'win32' ? 'tailscale.exe' : 'tailscale';
}

export function summarizeTailscale(status, interfaces = networkInterfaces()) {
  const assigned = new Set(interfaceAddresses(interfaces).map((entry) => entry.address));
  const addresses = [...new Set((status.TailscaleIPs || status.Self?.TailscaleIPs || [])
    .filter((address) => isTailscaleIp(address) && assigned.has(address)))];
  const running = status.BackendState === 'Running' && addresses.length > 0;
  const peers = Object.values(status.Peer || {}).flatMap((peer) => {
    const address = (peer.TailscaleIPs || []).find(isTailscaleIp);
    return address ? [{ name: peer.HostName, address, online: peer.Online === true,
      path: peer.CurAddr ? 'direct' : peer.PeerRelay ? 'peer-relay' : peer.Active && peer.Relay ? 'relay' : 'unknown' }] : [];
  }).sort((a, b) => Number(b.online) - Number(a.online) || (a.name || '').localeCompare(b.name || '')).slice(0, 200);
  return { installed: true, running, addresses, backendState: status.BackendState || 'Unknown', source: 'cli', hostname: status.Self?.HostName || '',
    peers,
    message: running ? `Tailscale 已连接 · ${addresses.join(', ')}` : 'Tailscale 尚未就绪，请打开客户端登录，并确认已加入 A、B 共用的私有网络' };
}

export async function getTailscaleStatus() {
  const interfaces = networkInterfaces();
  const command = await findCli();
  return new Promise((resolve) => {
    execFile(command, ['status', '--json'], { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (!error) {
        try { return resolve(summarizeTailscale(JSON.parse(stdout), interfaces)); } catch {}
      }
      const addresses = interfaceAddresses(interfaces).filter((entry) => /tailscale/i.test(entry.name)).map((entry) => entry.address);
      const installed = error?.code !== 'ENOENT';
      resolve({ installed, running: addresses.length > 0, addresses, source: addresses.length ? 'interface' : 'none', backendState: addresses.length ? 'InterfaceDetected' : installed ? 'Unavailable' : 'NotInstalled',
        message: addresses.length ? `检测到 Tailscale 接口 · ${addresses.join(', ')}（CLI 状态不可用，请确认已登录）` : installed ? '无法读取 Tailscale 状态，请启动并登录 Tailscale 后重新检测' : '未安装 Tailscale。请在 A、B 安装并登录同一个私有网络后重新检测' });
    });
  });
}
