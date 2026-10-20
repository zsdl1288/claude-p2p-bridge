import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite } from './storage.js';

const MAX_APPLICATION_BYTES = 32768;

export function validateApplication(value) {
  if (!value || value.v !== 1 || ![null, 'host', 'client'].includes(value.role) ||
      typeof value.desiredOnline !== 'boolean' || typeof value.locked !== 'boolean' ||
      (value.desiredOnline && (!value.role || !value.locked)) || (!value.role && value.locked) ||
      !value.model || typeof value.model.enabled !== 'boolean' ||
      (value.model.config !== null && (typeof value.model.config !== 'object' || Array.isArray(value.model.config))) ||
      (value.model.enabled && !value.model.config)) throw new Error('身份或业务配置格式无效，请先断开私有网络后重新选择身份');
  return { v: 1, role: value.role, desiredOnline: value.desiredOnline, locked: value.locked,
    model: { enabled: value.model.enabled, config: value.model.config ? { ...value.model.config } : null } };
}

// Pairing credentials stay in the existing DPAPI store. This file holds only
// identity intent and independent Claude preferences, with demo isolation.
export class ApplicationStore {
  constructor({ directory, demo = false } = {}) {
    this.file = directory ? path.join(directory, demo ? 'application-demo.json' : 'application.json') : null;
    this.memory = null;
  }
  async load() {
    if (!this.file) return this.memory ? validateApplication(this.memory) : null;
    try {
      const data = await readFile(this.file);
      if (data.length > MAX_APPLICATION_BYTES) throw new Error('身份配置过大');
      return validateApplication(JSON.parse(data.toString('utf8')));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async save(value) {
    const record = validateApplication(value);
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized) > MAX_APPLICATION_BYTES) throw new Error('身份配置过大');
    if (this.file) await atomicWrite(this.file, serialized);
    this.memory = record;
    return record;
  }
}
