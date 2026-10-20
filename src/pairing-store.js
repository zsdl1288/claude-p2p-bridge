import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseInvitation, encodeInvitation } from './crypto.js';
import { atomicWrite } from './storage.js';

export function validateSavedPairing(value, demo) {
  if (!value || ![1, 2].includes(value.v) || value.mode !== (demo ? 'demo' : 'tailscale') || !['host', 'client'].includes(value.role)) throw new Error('保存的配对信息格式无效，请忘记后重新配对');
  const pair = parseInvitation(value.invitation, { allowLoopback: demo });
  if (demo && pair.host !== '127.0.0.1') throw new Error('演示配对地址无效');
  const record = { v: value.v, mode: value.mode, role: value.role, invitation: encodeInvitation(pair) };
  if (value.role === 'host' && (value.v === 1 || value.config !== undefined)) {
    const config = value.config;
    if (!config || typeof config.workspace !== 'string' || !path.isAbsolute(config.workspace) || !['read', 'edit', 'develop'].includes(config.profile)
        || typeof config.claudeCommand !== 'string' || !config.claudeCommand || config.claudeCommand.length > 4096
        || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 3600000
        || !Number.isInteger(config.maxTurns) || config.maxTurns < 1 || config.maxTurns > 200) throw new Error('保存的 B 端配置无效，请重新开启服务');
    record.config = { workspace: config.workspace, profile: config.profile, claudeCommand: config.claudeCommand,
      timeoutMs: config.timeoutMs, maxTurns: config.maxTurns, tailscaleIp: pair.host, bridgePort: pair.port };
  }
  return record;
}

export class PairingStore {
  constructor({ directory, protector, demo = false }) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, demo ? 'pairing-demo.dat' : 'pairing.dat');
    this.protector = protector; this.demo = demo;
  }
  async load() {
    let data;
    try { data = await readFile(this.file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      if (data.length > 256 * 1024) throw new Error('oversized state');
      const record = JSON.parse((await this.protector.unprotect(data)).toString('utf8'));
      return validateSavedPairing(record, this.demo);
    } catch { throw new Error('配对信息无法读取或解密，请在原 Windows 账户打开，或点击“忘记配对”后重新配对'); }
  }
  async save(value) {
    const record = validateSavedPairing(value, this.demo);
    const ciphertext = await this.protector.protect(Buffer.from(JSON.stringify(record)));
    await atomicWrite(this.file, ciphertext);
    return record;
  }
  async clear() { await rm(this.file, { force: true }); }
}
