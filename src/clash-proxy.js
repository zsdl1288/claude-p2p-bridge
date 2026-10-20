import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { digest, encodeInvitation, parseInvitation } from './crypto.js';
import { atomicWrite } from './storage.js';

const NODE = 'B 网络出口';
// Claude's own service/content domains and the CLI's two documented telemetry
// hosts. Shared registries, CDNs and source hosts remain outside this list.
const claudeDomains = ['claude.ai', 'claude.com', 'claude.app', 'anthropic.com', 'claudeusercontent.com', 'claudemcpcontent.com'];
const claudeTelemetry = ['http-intake.logs.us5.datadoghq.com', 'browser-intake-us5-datadoghq.com'];

// JSON is a YAML 1.2 subset accepted by Mihomo. No executable scripts or
// third-party subscription converters are involved in generating a profile.
export function clashProfile({ port, username, password, helperName = 'bridge-net.exe', system = false, scope = 'all' }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !username || !password) throw new Error('本地代理尚未就绪');
  if (/[\r\n,]/.test(helperName)) throw new Error('网络组件名称无效');
  if (!['all', 'claude'].includes(scope)) throw new Error('未知网络代理配置范围');
  const node = { name: NODE, type: 'socks5', server: '127.0.0.1', port, username, password, udp: true };
  const profile = {
    'mixed-port': 7890, 'allow-lan': false, 'bind-address': '127.0.0.1', mode: 'rule',
    'log-level': 'info', ipv6: true, 'find-process-mode': 'always',
    profile: { 'store-selected': false, 'store-fake-ip': true },
    tun: { enable: true, device: 'ClaudeBridgeTun', stack: 'gvisor', 'auto-route': true, 'auto-detect-interface': true,
      'route-address': ['0.0.0.0/1', '128.0.0.0/1', '::/1', '8000::/1'],
      'strict-route': true, 'dns-hijack': ['any:53', 'tcp://any:53'] },
    dns: { enable: true, listen: '127.0.0.1:1053', ipv6: true, 'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16', 'use-system-hosts': false,
      nameserver: [`https://1.1.1.1/dns-query#${NODE}`, `https://1.0.0.1/dns-query#${NODE}`],
      'proxy-server-nameserver': [`https://1.1.1.1/dns-query#${NODE}`] },
    proxies: [node],
    // Loopback subscription/proxy access remains local. The ONLY Internet
    // exception is the embedded transport, which must not tunnel into itself.
    rules: [`PROCESS-NAME,${system ? 'tailscaled.exe' : helperName},DIRECT`,
      ...(system ? ['IP-CIDR,100.64.0.0/10,DIRECT,no-resolve'] : []),
      'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve', 'IP-CIDR6,::1/128,DIRECT,no-resolve',
      `MATCH,${NODE}`]
  };
  if (scope === 'claude') {
    const directDns = ['223.5.5.5#DIRECT', '119.29.29.29#DIRECT'];
    const claudeDns = [`https://1.1.1.1/dns-query#${NODE}`, `https://1.0.0.1/dns-query#${NODE}`];
    profile.dns.nameserver = directDns;
    profile.dns['proxy-server-nameserver'] = directDns;
    profile.dns['fake-ip-filter-mode'] = 'whitelist';
    profile.dns['fake-ip-filter'] = [...claudeDomains.map((domain) => `+.${domain}`), ...claudeTelemetry];
    profile.dns['nameserver-policy'] = Object.fromEntries([
      ...claudeDomains.map((domain) => [`+.${domain}`, claudeDns]),
      ...claudeTelemetry.map((domain) => [domain, claudeDns])
    ]);
    // Sniff HTTP Host / TLS or QUIC SNI when a client still has a cached IP.
    // Traffic without a recoverable domain cannot be identified by this list.
    profile.sniffer = { enable: true, 'force-dns-mapping': true, 'parse-pure-ip': true, 'override-destination': true,
      sniff: { HTTP: { ports: [80, '8080-8880'] }, TLS: { ports: [443, 8443] }, QUIC: { ports: [443, 8443] } } };
    profile.rules = [
      ...claudeDomains.map((domain) => `DOMAIN-SUFFIX,${domain},${NODE}`),
      ...claudeTelemetry.map((domain) => `DOMAIN,${domain},${NODE}`),
      ...profile.rules.slice(0, -1), 'MATCH,DIRECT'];
  }
  return profile;
}

export class ClashProxy {
  constructor({ bridge, token, directory = null }) {
    this.bridge = bridge; this.proxy = bridge.networkProxy; this.directory = directory;
    this.file = directory ? path.join(directory, bridge.demo ? 'proxy-demo.json' : 'proxy.json') : null;
    this.subscriptionToken = digest(`clash-subscription-v1:${token}`);
    this.proxy.username = digest(`clash-user-v1:${token}`).slice(0, 24);
    this.proxy.password = digest(`clash-password-v1:${token}`);
    this.settings = { v: 1, enabled: false, sharing: false, port: 0, pairing: null };
    this.operations = Promise.resolve(); this.error = '';
    this.onState = () => this.synchronize();
    bridge.proxyController = this;
    bridge.on('state', this.onState);
  }
  pairing() {
    const invitation = this.bridge.peer ? encodeInvitation(this.bridge.peer.pairing) : this.bridge.saved?.invitation;
    return invitation ? digest(invitation) : null;
  }
  role() { return this.bridge.networkIdentity().role; }
  start(address) {
    if (this.closed) return Promise.reject(new Error('网络代理正在退出'));
    if (!this.starting) this.starting = this.restore(address);
    return this.starting;
  }
  async restore(address) {
    this.address = address;
    if (this.file) {
      try {
        const text = await readFile(this.file, 'utf8');
        if (text.length > 8192) throw new Error('配置过大');
        const value = JSON.parse(text);
        if (value.v !== 1 || typeof value.enabled !== 'boolean' || typeof value.sharing !== 'boolean' ||
            !Number.isInteger(value.port) || value.port < 0 || value.port > 65535 ||
            (value.pairing !== null && !/^[\w-]{43}$/.test(value.pairing)) ||
            (value.enabled && (!value.port || value.sharing)) ||
            ((value.enabled || value.sharing) && !value.pairing)) throw new Error('配置格式无效');
        this.settings = { v: 1, enabled: value.enabled, sharing: value.sharing, port: value.port, pairing: value.pairing };
      } catch (error) { if (error.code !== 'ENOENT') this.error = `网络代理配置无法恢复：${error.message}`; }
    }
    if (this.closed) return;
    this.proxy.listenPort = this.settings.port;
    if (this.settings.enabled) {
      try { await this.proxy.start(); }
      catch (error) { this.error = `本地代理监听失败：${error.message}，不会改用其他端口`; }
    }
    this.synchronize();
  }
  synchronize() {
    if (this.closed) return;
    const match = this.pairing() === this.settings.pairing && Boolean(this.settings.pairing);
    const enabled = match && this.settings.enabled && this.role() === 'client';
    const sharing = match && this.settings.sharing && this.role() === 'host';
    if (enabled !== this.proxy.enabled || sharing !== this.proxy.sharing) this.proxy.configure({ enabled, sharing });
    this.bridge.broadcastProxyStatus?.();
  }
  status() {
    const state = this.proxy.status();
    const role = this.role();
    const sharing = role === 'client' ? this.bridge.remoteSharing === true : state.sharing;
    const online = role === 'client' ? state.online && sharing && Boolean(this.proxy.server?.listening) && !this.error : Boolean(this.bridge.peer?.state.listening);
    const enabled = state.enabled;
    let phase = 'disabled', message = '请先配对，然后开启 B 网络共享或 A 本地 Clash 节点。';
    if (role === 'host') { phase = sharing ? online ? 'ready' : 'waiting' : 'disabled'; message = sharing ? 'B 已允许配对的 A 使用本机网络；关闭共享会立即断开代理连接。' : 'B 网络共享已关闭；模型调用权限不受影响。'; }
    else if (enabled) { phase = online ? 'ready' : 'blocked'; message = online ? 'B 出口已连接；请在 Clash 导入完整配置并开启 TUN。' : this.bridge.remoteSharing === false ? 'B 未开启网络共享，代理流量已阻断。' : 'B 已断开或正在恢复，代理流量已阻断，等待自动重连。'; }
    else if (role === 'client') message = '启用本地节点后，可将完整配置订阅导入 Mihomo / Clash Meta 客户端。';
    if (this.error) { phase = enabled ? 'blocked' : 'disabled'; message = this.error; }
    if (online && phase === 'ready' && state.lastError?.code === 'PROXY_CAPACITY') message = '代理连接数已达上限，请等待空闲连接释放后重试';
    const subscription = enabled && this.proxy.server?.listening && this.address ? `http://127.0.0.1:${this.address.port}/clash/${this.subscriptionToken}` : '';
    return { enabled, sharing, online, state: phase, message, port: state.listenPort,
      connections: state.connections, uploadBytes: state.uploadBytes, downloadBytes: state.downloadBytes,
      connectionLimit: state.connectionLimit, sessionConnectionLimit: state.sessionConnectionLimit, lastError: state.lastError || null,
      subscriptionUrl: subscription ? `${subscription}/config.yaml` : '',
      claudeSubscriptionUrl: subscription ? `${subscription}/claude.yaml` : '',
      clients: state.clients || [], devices: this.devices(state.clients || []) };
  }
  devices(clients) {
    const network = this.bridge.networkStatus?.();
    const devices = network?.devices || [];
    const own = devices.filter((device) => device.self);
    if (this.role() === 'host') return [...own, ...clients.map((client) => ({ ...client, self: false, role: 'client', path: 'paired' }))];
    let address = this.bridge.networkIdentity().serverAddress;
    if (!address && this.bridge.saved?.role === 'client') {
      try { address = parseInvitation(this.bridge.saved.invitation, { allowLoopback: this.bridge.demo }).host; } catch {}
    }
    const remote = devices.filter((device) => !device.self && device.address === address);
    if (!remote.length && address) {
        remote.push({ name: '已配对的服务端', address, self: false, role: 'host', online: this.bridge.peer?.state.online === true, path: 'paired' });
    }
    return [...own, ...remote.map((device) => ({ ...device, online: this.bridge.peer?.state.online === true }))];
  }
  resetAuthorization() {
    return this.enqueue(async () => {
      const settings = { ...this.settings, enabled: false, sharing: false, pairing: null };
      await this.save(settings); this.settings = settings; this.synchronize();
    });
  }
  enqueue(operation) {
    const result = this.operations.then(async () => { await this.starting; if (this.closed) throw new Error('网络代理正在退出'); return operation(); });
    this.operations = result.catch(() => {}); return result;
  }
  async save(settings) {
    if (this.file) await atomicWrite(this.file, JSON.stringify(settings));
  }
  configure(input) {
    return this.enqueue(async () => {
      this.bridge.requireBusiness?.('proxy');
      const keys = Object.keys(input);
      if (!keys.length || keys.some((key) => !['enabled', 'sharing'].includes(key)) || keys.some((key) => typeof input[key] !== 'boolean')) throw new Error('只支持 enabled / sharing 布尔开关');
      const role = this.role(), pairing = this.pairing();
      if (!pairing) throw new Error('请先完成 A / B 配对');
      if ('sharing' in input && role !== 'host') throw new Error('只能在 B 服务端设置网络共享');
      if ('enabled' in input && role !== 'client') throw new Error('只能在 A 客户端设置 Clash 节点');
      const base = pairing === this.settings.pairing ? this.settings : { ...this.settings, enabled: false, sharing: false };
      const settings = { ...base, ...input, pairing };
      if (settings.enabled) { await this.proxy.start(); settings.port = this.proxy.port; }
      await this.save(settings);
      this.settings = settings; this.error = ''; this.synchronize();
      return this.status();
    });
  }
  profile(nodesOnly = false, scope = 'all') {
    if (!this.proxy.enabled || !this.proxy.server?.listening) throw Object.assign(new Error('请先启用 A 本地 Clash 节点'), { status: 503 });
    const config = clashProfile({ port: this.proxy.port, username: this.proxy.username, password: this.proxy.password,
      helperName: path.basename(this.bridge.networkAdapter?.command || 'bridge-net.exe'), system: !this.bridge.demo && !this.bridge.networkAdapter, scope });
    return JSON.stringify(nodesOnly ? { proxies: config.proxies } : config, null, 2) + '\n';
  }
  close() {
    if (!this.closing) this.closing = this.stop();
    return this.closing;
  }
  async stop() {
    this.closed = true; this.bridge.off('state', this.onState);
    try { await this.starting; await this.operations; }
    finally { await this.proxy.close(); }
  }
}
