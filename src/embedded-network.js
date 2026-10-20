import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { consumeLines } from './line-stream.js';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const root = fileURLToPath(new URL('../', import.meta.url));

export class EmbeddedNetwork extends EventEmitter {
  constructor({ directory, command = process.env.BRIDGE_NET_HELPER || path.join(root, 'bin', process.platform === 'win32' ? 'bridge-net.exe' : 'bridge-net'), args = process.env.BRIDGE_NET_HELPER_ARGS ? JSON.parse(process.env.BRIDGE_NET_HELPER_ARGS) : [], requestTimeoutMs = 25000, shutdownTimeoutMs = 3000 } = {}) {
    super();
    this.directory = path.resolve(directory || '.bridge', 'tailscale');
    this.hostname = `bridge-${hostname()}`;
    this.command = command; this.args = args; this.pending = new Map(); this.sequence = 0; this.embedded = true;
    this.resources = new WeakMap();
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
    await access(this.command);
    // close() can run while the filesystem check is in flight.
    if (this.closed) throw new Error('内置组网已关闭');
    const env = { ...process.env };
    for (const key of ['TS_AUTHKEY', 'TS_AUTH_KEY', 'TS_CLIENT_SECRET']) delete env[key];
    // The underlay must bootstrap without the proxy it is carrying.
    for (const key of Object.keys(env)) if (/^(all|https?|no)_proxy$/i.test(key)) delete env[key];
    delete env.TS_BIND_TO_INTERFACE_BY_ROUTE;
    const child = this.child = spawn(this.command, this.args, { windowsHide: true, shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] });
    consumeLines(child.stdout, { maxBytes: 2 * 1024 * 1024, onError: (error) => this.invalidate(child, error), onLine: (line) => {
      try {
        const message = JSON.parse(line); const pending = this.pending.get(message.id);
        if (!pending || pending.child !== child) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`内置组网：${message.error}`)); else pending.resolve(message.result);
      } catch (error) { this.invalidate(child, error); }
    } });
    child.stderr.on('data', () => {});
    child.stdin.on('error', (error) => this.invalidate(child, error));
    child.on('error', (error) => this.invalidate(child, error));
    child.on('exit', () => this.invalidate(child, new Error('内置组网进程已退出，将在下次连接时重试')));
    try {
      await this.request('init', { stateDir: this.directory, hostname: this.hostname }, child);
      this.initialized.add(child);
      if (this.wantRunning) await this.request('connect', {}, child);
      return child;
    } catch (error) {
      this.invalidate(child, error);
      throw error;
    }
  }
  fail(error, child) {
    for (const [id, pending] of this.pending) {
      if (child && pending.child !== child) continue;
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error);
    }
  }
  invalidate(child, error) {
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
      const timer = setTimeout(() => {
        // A timed-out listen/dial may still allocate a proxy. Reset its owner
        // so those resources cannot survive without a corresponding JS handle.
        this.invalidate(child, new Error('内置组网响应超时，将在下次连接时重试'));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, child });
      child.stdin.write(line, (error) => { if (error) this.invalidate(child, error); });
    });
  }
  async call(method, params) { const child = await this.start(); return this.request(method, params, child); }
  async networkState(method) { return { hostname: this.hostname, ...await this.call(method) }; }
  async status() {
    try { return await this.networkState('status'); }
    catch (error) { return { installed: false, embedded: true, running: false, addresses: [], peers: [], hostname: this.hostname, source: 'embedded', backendState: 'Unavailable', message: `内置组网组件不可用：${error.message}。请使用完整发行版，或先运行原生组件构建脚本。` }; }
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
    this.fail(new Error('组网正在关闭'));
    this.closing = new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, this.shutdownTimeoutMs);
      child.once('close', () => { clearTimeout(timer); resolve(); }); child.stdin.end();
    });
    await this.closing;
    if (this.child === child) this.child = null;
  }
}
