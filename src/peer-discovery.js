import http from 'node:http';
import { isTailscaleIp } from './tailscale.js';

const failure = () => new Error('Role discovery unavailable');

// Discovery is an unauthenticated display hint. Its result must never authorize
// pairing, model access or network forwarding.
export class PeerDiscovery {
  constructor({ adapter = null, timeoutMs = 1200, ttlMs = 12000, maxPeers = 12, concurrency = 3, now = Date.now } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 1200 ||
      !Number.isInteger(ttlMs) || ttlMs < 10000 || ttlMs > 15000 ||
      !Number.isInteger(maxPeers) || maxPeers < 1 || maxPeers > 12 ||
      !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('Invalid role discovery limits');
    Object.assign(this, { adapter, timeoutMs, ttlMs, maxPeers, concurrency, now });
    this.roles = new Map(); this.attempted = new Map(); this.cancelPending = new Set(); this.online = new Set();
    this.generation = 0; this.allocated = 0; this.closed = false;
  }
  refresh(peers) {
    if (this.closed || !this.adapter?.dial || !this.adapter?.release) return Promise.resolve(this.roles);
    const generation = this.generation, now = this.now();
    const addresses = [...new Set((Array.isArray(peers) ? peers.slice(0, 200) : [])
      .filter((peer) => peer?.online === true && isTailscaleIp(peer.address)).map((peer) => peer.address))];
    const online = this.online = new Set(addresses);
    for (const [address, value] of this.roles) if (!online.has(address) || now - value.at >= this.ttlMs) this.roles.delete(address);
    for (const [address, at] of this.attempted) if (!online.has(address) || now - at >= this.ttlMs) this.attempted.delete(address);
    if (this.refreshing) return this.refreshing;
    const candidates = addresses.filter((address) => !this.attempted.has(address)).slice(0, this.maxPeers);
    let cursor = 0;
    const worker = async () => {
      while (!this.closed && generation === this.generation && cursor < candidates.length) {
        // Timed-out allocations keep their reservation until the adapter settles.
        // A slow helper cannot make each refresh accumulate another set of dials.
        if (this.allocated >= this.concurrency) return;
        const address = candidates[cursor++];
        if (!this.online.has(address)) continue;
        this.attempted.set(address, this.now());
        const info = await this.probe(address, generation);
        if (info && !this.closed && generation === this.generation && this.online.has(address)) this.roles.set(address, { ...info, at: this.now() });
      }
    };
    const refreshing = Promise.all(Array.from({ length: Math.min(this.concurrency, candidates.length) }, worker))
      .then(() => this.roles).finally(() => { if (this.refreshing === refreshing) this.refreshing = null; });
    this.refreshing = refreshing;
    return refreshing;
  }
  release(resource) {
    try { Promise.resolve(this.adapter.release(resource)).catch(() => {}); } catch {}
  }
  async probe(address, generation) {
    ++this.allocated;
    let resource, settled = false, finished = false, dropped = false, request;
    const drop = () => { if (!dropped) { dropped = true; --this.allocated; } };
    let rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
    const cancel = () => { request?.destroy(failure()); rejectDeadline(failure()); };
    const timer = setTimeout(cancel, this.timeoutMs);
    this.cancelPending.add(cancel);
    const allocation = Promise.resolve().then(() => this.adapter.dial({ host: address, port: 3211, maxConnections: 1 })).then((value) => {
      settled = true;
      if (finished || this.closed || generation !== this.generation) { this.release(value); drop(); return null; }
      resource = value;
      return value;
    }, (error) => { settled = true; if (finished) drop(); throw error; });
    try {
      const allocated = await Promise.race([allocation, deadline]);
      if (!allocated || !Number.isInteger(allocated.port) || allocated.port < 1 || allocated.port > 65535) return null;
      const response = new Promise((resolve, reject) => {
        request = http.get({ hostname: '127.0.0.1', port: allocated.port, path: '/bridge-info', agent: false,
          maxHeaderSize: 8192, headers: { Accept: 'application/json', Connection: 'close' } }, (res) => {
          if (res.statusCode !== 200) { res.destroy(); reject(failure()); return; }
          const chunks = []; let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 2048) { res.destroy(failure()); reject(failure()); } else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('aborted', () => reject(failure()));
          res.on('end', () => {
            try {
              const info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
              if (!info || Array.isArray(info) || info.role !== 'host' || info.protocol !== 1 || typeof info.name !== 'string' ||
                !info.name.trim() || info.name.length > 80 || /[\x00-\x1f\x7f]/.test(info.name)) throw failure();
              resolve({ role: 'host', name: info.name.trim() });
            } catch (error) { reject(error); }
          });
        });
        request.on('error', reject);
      });
      return await Promise.race([response, deadline]);
    } catch { return null; }
    finally {
      finished = true; clearTimeout(timer); this.cancelPending.delete(cancel); request?.destroy();
      if (resource) this.release(resource);
      if (settled) drop();
    }
  }
  reset() {
    ++this.generation; this.roles.clear(); this.attempted.clear(); this.online.clear();
    for (const cancel of this.cancelPending) cancel();
    this.refreshing = null;
  }
  close() { this.closed = true; this.reset(); }
}
