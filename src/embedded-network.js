import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { consumeLines } from './line-stream.js';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createLifecycleLog } from './lifecycle-log.js';

const root = fileURLToPath(new URL('../', import.meta.url));

export class EmbeddedNetwork extends EventEmitter {
  constructor({ directory, command = process.env.BRIDGE_NET_HELPER || path.join(root, 'bin', process.platform === 'win32' ? 'bridge-net.exe' : 'bridge-net'), args = process.env.BRIDGE_NET_HELPER_ARGS ? JSON.parse(process.env.BRIDGE_NET_HELPER_ARGS) : [], requestTimeoutMs = 25000, shutdownTimeoutMs = 3000, lifecycleLog } = {}) {
    super();
    this.directory = path.resolve(directory || '.bridge', 'tailscale');
    this.hostname = `bridge-${hostname()}`;
    this.command = command; this.args = args; this.pending = new Map(); this.sequence = 0; this.embedded = true;
    this.resources = new WeakMap();
    this.lifecycleLog = lifecycleLog || createLifecycleLog({ directory });
    this.childLifecycle = new WeakMap();
    this.initialized = new WeakSet();
    this.requestTimeoutMs = requestTimeoutMs; this.shutdownTimeoutMs = shutdownTimeoutMs;
  }
  async start() {
    if (this.closed) throw new Error('内置组网已关闭');
    if (!this.starting) {
      const starting = this.launch().catch((error) => { if (this.starting === starting) this.starting = null; throw error; });
      this.starting = starting;
    }
    return this.starting;
  }
  async launch() {
    try { await access(this.command); }
    catch (error) { this.lifecycleLog.write('helper-launch-failed', { reason: 'helper-missing', error }); throw error; }
    // close() can run while the filesystem check is in flight.
    if (this.closed) throw new Error('内置组网已关闭');
    const env = { ...process.env, BRIDGE_LIFECYCLE_SESSION: this.lifecycleLog.sessionId };
    for (const key of ['TS_AUTHKEY', 'TS_AUTH_KEY', 'TS_CLIENT_SECRET']) delete env[key];
    // The underlay must bootstrap without the proxy it is carrying.
    for (const key of Object.keys(env)) if (/^(all|https?|no)_proxy$/i.test(key)) delete env[key];
    delete env.TS_BIND_TO_INTERFACE_BY_ROUTE;
    if (this.hasLaunched) this.lifecycleLog.write('helper-restart', { reason: 'retry-after-retirement' });
    let child;
    try { child = this.child = spawn(this.command, this.args, { windowsHide: true, shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { this.lifecycleLog.write('helper-launch-failed', { reason: 'process-error', error }); throw error; }
    this.hasLaunched = true;
    this.childLifecycle.set(child, { ownerRequested: false, retired: false });
    this.lifecycleLog.write('helper-launch', { childPid: child.pid, ownerRequested: false });
    consumeLines(child.stdout, { maxBytes: 2 * 1024 * 1024, onError: (error) => this.invalidate(child, error, 'stdout-error'), onLine: (line) => {
      try {
        const message = JSON.parse(line); const pending = this.pending.get(message.id);
        if (!pending || pending.child !== child) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`内置组网：${message.error}`)); else pending.resolve(message.result);
      } catch (error) { this.invalidate(child, error, 'protocol-error'); }
    } });
    child.stderr.on('data', () => {});
    child.stdin.on('error', (error) => this.invalidate(child, error, 'stdin-error'));
    child.on('error', (error) => {
      this.lifecycleLog.write('helper-error', { childPid: child.pid, reason: 'process-error', ownerRequested: this.childLifecycle.get(child)?.ownerRequested === true, error });
      this.invalidate(child, error, 'process-error');
    });
    child.on('exit', (code, signal) => {
      const state = this.childLifecycle.get(child);
      this.lifecycleLog.write('helper-exit', { childPid: child.pid, code, signal, reason: state?.reason || 'child-exit', ownerRequested: state?.ownerRequested === true });
      this.invalidate(child, new Error('内置组网进程已退出，将在下次连接时重试'), 'child-exit');
    });
    try {
      await this.request('init', { stateDir: this.directory, hostname: this.hostname }, child);
      this.initialized.add(child);
      this.lifecycleLog.write('helper-ready', { childPid: child.pid });
      if (this.wantRunning) await this.request('connect', {}, child);
      return child;
    } catch (error) {
      this.invalidate(child, error, 'init-failed');
      throw error;
    }
  }
  fail(error, child) {
    for (const [id, pending] of this.pending) {
      if (child && pending.child !== child) continue;
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error);
    }
  }
  invalidate(child, error, reason = 'unknown') {
    const state = this.childLifecycle.get(child);
    if (!state?.retired) {
      const ownerRequested = reason !== 'child-exit';
      if (state) { state.retired = true; state.ownerRequested ||= ownerRequested; state.reason ||= reason; }
      this.lifecycleLog.write('helper-retired', { childPid: child.pid, reason: state?.reason || reason, ownerRequested: state?.ownerRequested ?? ownerRequested, error });
    }
    this.fail(error, child); child.kill();
    if (this.child === child) {
      this.child = null; this.starting = null;
      if (!this.closed && this.initialized.has(child)) this.emit('reset', error);
    }
  }
  request(method, params = {}, child = this.child) {
    return new Promise((resolve, reject) => {
      if (this.closed || child !== this.child || !child?.stdin.writable) { reject(new Error('组网进程未启动或已关闭')); return; }
      const id = ++this.sequence;
      const line = `${JSON.stringify({ id, method, params })}\n`;
      const nonfatal = method === 'diagnostics' || method === 'refresh-transport' || method === 'channel-probe';
      const fail = (error, reason = 'request-write') => {
        if (!nonfatal) {
          if (reason === 'request-timeout') this.lifecycleLog.write('helper-timeout-kill', { childPid: child.pid, reason, ownerRequested: true });
          return this.invalidate(child, error, reason);
        }
        // A failed maintenance request must not revoke this helper's live transports.
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); reject(error);
      };
      const timer = setTimeout(() => {
        // A timed-out listen/dial may still allocate a proxy. Reset its owner
        // so those resources cannot survive without a corresponding JS handle.
        fail(new Error(method === 'diagnostics' ? '内置组网诊断响应超时' : method === 'refresh-transport' ? '内置组网通道刷新响应超时' : method === 'channel-probe' ? '内置组网探针响应超时' : '内置组网响应超时，将在下次连接时重试'), 'request-timeout');
      }, method === 'channel-probe' ? Math.min(this.requestTimeoutMs, 4000) : method === 'refresh-transport' ? Math.min(this.requestTimeoutMs, 5000) : this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, child });
      try { child.stdin.write(line, (error) => { if (error) fail(error); }); }
      catch (error) { fail(error); }
    });
  }
  async call(method, params) { const child = await this.start(); return this.request(method, params, child); }
  async networkState(method) { return { hostname: this.hostname, ...await this.call(method) }; }
  async status() {
    try { return await this.networkState('status'); }
    catch (error) { return { installed: false, embedded: true, running: false, addresses: [], peers: [], hostname: this.hostname, source: 'embedded', backendState: 'Unavailable', message: `内置组网组件不可用：${error.message}。请使用完整发行版，或先运行原生组件构建脚本。` }; }
  }
  async diagnostics() {
    const unavailable = (message) => ({ available: false, source: 'embedded', scope: 'node', capturedAt: new Date().toISOString(), netstack: {}, transport: [], message });
    const child = this.child;
    if (this.closed || !child || !this.initialized.has(child) || !child.stdin?.writable) return unavailable('内置组网进程尚未就绪，未启动诊断');
    try { return await this.request('diagnostics', {}, child); }
    catch { return unavailable('内置组网诊断暂不可用'); }
  }
  async refreshTransport() {
    const unavailable = () => ({ refreshed: false, reason: 'unavailable' });
    const child = this.child;
    if (this.closed || this.wantRunning !== true || !child || !this.initialized.has(child) || !child.stdin?.writable) return unavailable();
    if (this.transportRefreshChild === child) return { refreshed: false, reason: 'busy' };
    this.transportRefreshChild = child;
    try {
      const result = await this.request('refresh-transport', {}, child);
      if (!result || !['refreshed', 'cooldown', 'unavailable', 'busy'].includes(result.reason) ||
          result.refreshed !== (result.reason === 'refreshed')) return unavailable();
      const safe = { refreshed: result.refreshed, reason: result.reason };
      if (result.reason === 'cooldown' && Number.isSafeInteger(result.retryAfterMs) && result.retryAfterMs > 0 && result.retryAfterMs <= 120000) safe.retryAfterMs = result.retryAfterMs;
      return safe;
    } catch { return unavailable(); }
    finally { if (this.transportRefreshChild === child) this.transportRefreshChild = null; }
  }
  async channelProbe(params, child = this.child) {
    const unavailable = () => ({ type, size, outcome: 'unavailable', actualVia: 'unknown' });
    const host = params?.host, type = params?.type, size = params?.size;
    const octets = typeof host === 'string' && host.split('.');
    if (!octets || octets.length !== 4 || !octets.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) ||
        Number(octets[0]) !== 100 || Number(octets[1]) < 64 || Number(octets[1]) > 127 ||
        !((type === 'TSMP' && size === 0) || (type === 'disco' && [128, 1200].includes(size)))) return { outcome: 'invalid-request', actualVia: 'unknown' };
    if (this.closed || this.wantRunning !== true || !child || child !== this.child || !this.initialized.has(child) || !child.stdin?.writable) return unavailable();
    if (this.channelProbeChild === child) return { type, size, outcome: 'busy', actualVia: 'unknown' };
    this.channelProbeChild = child;
    try {
      const value = await this.request('channel-probe', { host, type, size }, child);
      if (this.closed || this.wantRunning !== true || child !== this.child) return unavailable();
      const safe = { type, size, outcome: 'invalid-result', actualVia: 'unknown' };
      if (type === 'TSMP') safe.innerIPv4Bytes = 29; else safe.discoPayloadBytes = size;
      if (!value || value.type !== type || value.size !== size ||
          !['reply', 'timeout', 'cancelled', 'busy', 'unavailable', 'probe-error', 'invalid-request'].includes(value.outcome)) return safe;
      safe.outcome = value.outcome;
      if (value.outcome !== 'reply') return safe;
      if (typeof value.latencySeconds !== 'number' || !Number.isFinite(value.latencySeconds) || value.latencySeconds < 0) { safe.outcome = 'invalid-result'; return safe; }
      safe.latencySeconds = value.latencySeconds;
      if (type === 'TSMP') return safe;
      if (value.actualVia === 'derp' && Number.isInteger(value.derpRegionId) && value.derpRegionId > 0 && value.derpRegionId <= 65535) {
        safe.actualVia = 'derp'; safe.derpRegionId = value.derpRegionId;
        if (typeof value.derpRegionCode === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(value.derpRegionCode)) safe.derpRegionCode = value.derpRegionCode;
      } else if (['direct', 'peer-relay'].includes(value.actualVia)) safe.actualVia = value.actualVia;
      return safe;
    } catch { return unavailable(); }
    finally { if (this.channelProbeChild === child) this.channelProbeChild = null; }
  }
  login() { this.wantRunning = true; return this.networkState('login'); }
  connect() { this.wantRunning = true; return this.networkState('connect'); }
  async disconnect() {
    // A deliberate stop survives helper replacement. Status/DPAPI calls may
    // initialize the helper but must never bring the saved node online again.
    this.wantRunning = false;
    return this.networkState('disconnect');
  }
  async protect(data) { return Buffer.from((await this.call('protect', { data: Buffer.from(data).toString('base64') })).data, 'base64'); }
  async unprotect(data) { return Buffer.from((await this.call('unprotect', { data: Buffer.from(data).toString('base64') })).data, 'base64'); }
  async allocate(method, params) {
    const child = await this.start();
    const resource = await this.request(method, params, child);
    this.resources.set(resource, child);
    return resource;
  }
  listen({ port, targetPort, maxConnections }) { return this.allocate('listen', { port, targetPort, maxConnections }); }
  dial({ host, port, maxConnections }) { return this.allocate('dial', { host, port, maxConnections }); }
  async release(resource) {
    if (!resource?.id) return;
    const owner = this.resources.get(resource); this.resources.delete(resource);
    if (owner && owner === this.child && !this.closed) await this.request('release', { id: resource.id }, owner);
  }
  async close() {
    this.closed = true;
    if (this.closing) return this.closing;
    const child = this.child; if (!child) return;
    const state = this.childLifecycle.get(child);
    if (state) { state.ownerRequested = true; state.reason ||= 'owner-close'; }
    this.lifecycleLog.write('helper-stop-requested', { childPid: child.pid, reason: 'owner-close', ownerRequested: true });
    this.fail(new Error('组网正在关闭'));
    this.closing = new Promise((resolve) => {
      const timer = setTimeout(() => { this.lifecycleLog.write('helper-timeout-kill', { childPid: child.pid, reason: 'shutdown-timeout', ownerRequested: true }); child.kill(); resolve(); }, this.shutdownTimeoutMs);
      child.once('close', () => { clearTimeout(timer); resolve(); }); child.stdin.end();
    });
    await this.closing;
    if (this.child === child) this.child = null;
  }
}
