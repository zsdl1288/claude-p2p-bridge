export const RATE_WINDOW_MS = 2000;
const BUCKET_MS = 250, BUCKET_COUNT = RATE_WINDOW_MS / BUCKET_MS;
const add = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);

// Fixed two-second, 250-ms buckets, zero-padded at session startup. Reading
// does not create traffic or advance a sampling baseline. Only accepted proxy
// account() calls contribute bytes; detached control sessions are never summed.
export class TrafficRates {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now; this.connections = new WeakMap(); this.lastTime = null;
  }
  time() {
    const at = this.now();
    if (!Number.isFinite(at) || at < 0) { this.connections = new WeakMap(); this.lastTime = null; return null; }
    if (this.lastTime !== null && at < this.lastTime) this.connections = new WeakMap();
    this.lastTime = at; return at;
  }
  record(connection, bytes, outgoing) {
    if (!connection || typeof connection !== 'object' || !Number.isSafeInteger(bytes) || bytes <= 0 || typeof outgoing !== 'boolean') return;
    const at = this.time(); if (at === null) return;
    let state = this.connections.get(connection);
    if (!state || state.session !== connection.session) {
      state = { session: connection.session, buckets: Array(BUCKET_COUNT).fill(null) }; this.connections.set(connection, state);
    }
    const index = Math.floor(at / BUCKET_MS), slot = index % BUCKET_COUNT;
    let bucket = state.buckets[slot];
    if (!bucket || bucket.index !== index) bucket = state.buckets[slot] = { index, upload: 0, download: 0 };
    const key = outgoing ? 'upload' : 'download'; bucket[key] = add(bucket[key], bytes);
  }
  value(connection, at) {
    const state = connection && this.connections.get(connection);
    let upload = 0, download = 0;
    if (at !== null && state && state.session === connection.session) {
      const index = Math.floor(at / BUCKET_MS);
      for (const bucket of state.buckets) if (bucket && bucket.index <= index && index - bucket.index < BUCKET_COUNT) {
        upload = add(upload, bucket.upload); download = add(download, bucket.download);
      }
    }
    return { uploadBytesPerSecond: upload * 1000 / RATE_WINDOW_MS, downloadBytesPerSecond: download * 1000 / RATE_WINDOW_MS };
  }
  read(connection) { return this.value(connection, this.time()); }
  sample(connections) {
    const at = this.time();
    return { at, values: new Map(connections.map((connection) => [connection, this.value(connection, at)])) };
  }
}
