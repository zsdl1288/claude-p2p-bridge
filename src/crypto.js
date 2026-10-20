import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { validatePeerAddress } from './tailscale.js';

export const randomId = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const digest = (value) => createHash('sha256').update(value).digest('base64url');
export const equalSecret = (actual, expected) => typeof actual === 'string' && Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));

export function makePairing(host, port = 3211, options = {}) {
  validatePeerAddress(host, options);
  if (!Number.isInteger(port) || port < (options.allowLoopback ? 0 : 1) || port > 65535) throw new Error('桥接端口必须为 1–65535 的整数');
  return { v: 2, mode: 'tailscale', host, port, room: randomId(18), secret: randomId(32) };
}

export function encodeInvitation(pairing) {
  const { v, mode, host, port, room, secret } = pairing;
  return `p2pcc://pair/${Buffer.from(JSON.stringify({ v, mode, host, port, room, secret })).toString('base64url')}`;
}

export function parseInvitation(input, options = {}) {
  if (typeof input !== 'string' || input.length > 4096 || !input.startsWith('p2pcc://pair/')) throw new Error('配对码格式不正确');
  let value;
  try { value = JSON.parse(Buffer.from(input.slice(13), 'base64url').toString()); }
  catch { throw new Error('配对码无法解析'); }
  if (value?.v === 1) throw new Error('这是旧版公网中转配对码，请在新版 B 端重新创建 Tailscale 配对码');
  if (!value || value.v !== 2 || value.mode !== 'tailscale' || typeof value.room !== 'string' || !/^[\w-]{24}$/.test(value.room) || typeof value.secret !== 'string' || !/^[\w-]{43}$/.test(value.secret) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('配对码内容无效');
  return { v: 2, mode: 'tailscale', host: validatePeerAddress(value.host, options), port: value.port, room: value.room, secret: value.secret };
}

export class SecureChannel {
  constructor(secret, room, role) {
    const key = Buffer.from(secret, 'base64url');
    const derive = (direction) => Buffer.from(hkdfSync('sha256', key, room, `p2pcc-v2:${direction}`, 32));
    this.sendKey = derive(role === 'host' ? 'host-client' : 'client-host');
    this.receiveKey = derive(role === 'host' ? 'client-host' : 'host-client');
    this.prefix = randomBytes(8);
    this.counter = 0n;
    this.windows = new Map();
    this.aad = Buffer.from(`p2pcc-v2:${room}`);
  }
  seal(message) {
    const iv = Buffer.alloc(12);
    this.prefix.copy(iv);
    if (++this.counter > 0xffffffffn) throw new Error('连接消息过多，请重新连接');
    iv.writeUInt32BE(Number(this.counter), 8);
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, iv);
    cipher.setAAD(this.aad);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()]);
    return { v: 2, iv: iv.toString('base64url'), data: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  }
  open(envelope) {
    if (!envelope || envelope.v !== 2 || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string' || typeof envelope.tag !== 'string') throw new Error('无效加密帧');
    const iv = Buffer.from(envelope.iv, 'base64url');
    const tag = Buffer.from(envelope.tag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || envelope.data.length > 3 * 1024 * 1024) throw new Error('无效或过大的加密帧');
    const prefix = iv.subarray(0, 8).toString('hex');
    const sequence = BigInt(iv.readUInt32BE(8));
    let window = this.windows.get(prefix);
    if (window && (window.seen.has(sequence) || sequence <= window.high - 4096n)) throw new Error('重复或过期的加密帧');
    const decipher = createDecipheriv('aes-256-gcm', this.receiveKey, iv);
    decipher.setAAD(this.aad);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]);
    const result = JSON.parse(plaintext.toString('utf8'));
    if (!window) {
      if (this.windows.size >= 16) throw new Error('密钥已超出连接次数限制，请重新配对');
      window = { high: sequence, seen: new Set() };
      this.windows.set(prefix, window);
    }
    window.high = sequence > window.high ? sequence : window.high;
    window.seen.add(sequence);
    // Arrival order can differ from sequence order. Scan the entire window so
    // an earlier high sequence cannot retain expired entries behind it.
    for (const old of window.seen) if (old <= window.high - 4096n) window.seen.delete(old);
    return result;
  }
}
