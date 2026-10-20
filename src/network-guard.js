import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const validProfile = /^[a-z0-9][a-z0-9-]{0,63}$/;
const guardStates = new Set(['enabled', 'disabled', 'partial', 'unsupported', 'unknown']);

function validateGuardStatus(result, profileId) {
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      result.profileId !== profileId || typeof result.supported !== 'boolean' ||
      typeof result.enabled !== 'boolean' || !guardStates.has(result.state)) {
    throw new Error('网络保护组件状态校验失败');
  }
  if (result.enabled !== (result.state === 'enabled') || result.supported !== (result.state !== 'unsupported')) {
    throw new Error('网络保护组件返回的启用状态不一致');
  }
  // Unknown is an explicit permission/read failure, so it can lack rule counts.
  // Every verified state must include nonnegative counts, including disabled:
  // a helper returning "disabled" with remaining rules has not restored access.
  if (!['unknown', 'unsupported'].includes(result.state) &&
      (!Number.isSafeInteger(result.filterCount) || result.filterCount < 0 ||
       !Number.isSafeInteger(result.expectedFilters) || result.expectedFilters < 1 ||
       (result.state === 'enabled' && result.filterCount !== result.expectedFilters) ||
       (result.state === 'disabled' && result.filterCount !== 0) ||
       (result.state === 'partial' && result.filterCount === 0))) {
    throw new Error('网络保护过滤规则状态不一致');
  }
  if (result.issues !== undefined && (!Array.isArray(result.issues) || result.issues.some((issue) => typeof issue !== 'string'))) {
    throw new Error('网络保护组件返回了无效诊断信息');
  }
  return result;
}

export function networkGuardProfile(directory) {
  if (typeof directory !== 'string' || !directory) throw new Error('保护配置目录不能为空');
  const normalized = path.resolve(directory).toLowerCase();
  return `profile-${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
}

export function networkGuardArguments(action, profileId) {
  if (!['status', 'verify', 'enable', 'disable'].includes(action) || typeof profileId !== 'string' || !validProfile.test(profileId)) {
    throw new Error('网络保护操作或配置标识无效');
  }
  return ['--network-guard', action === 'status' ? action : `elevate-${action === 'verify' ? 'status' : action}`, '--guard-id', profileId];
}

// This component has no auto-disable/close hook: protection survives application
// shutdown and can be removed only by a separate explicit, UAC-authorized call.
export class NetworkGuard {
  constructor({ directory, profileId = networkGuardProfile(directory || '.bridge'), command = process.env.BRIDGE_NET_HELPER || path.join(root, 'bin', 'bridge-net.exe'), execute = executeFile, platform = process.platform } = {}) {
    if (typeof profileId !== 'string' || !validProfile.test(profileId)) throw new Error('网络保护配置标识无效');
    this.profileId = profileId;
    this.command = command;
    this.execute = execute;
    this.platform = platform;
    this.mutating = false;
    this.statusCalls = new Set();
  }

  async call(action) {
    if (this.platform !== 'win32') {
      if (action !== 'status') throw new Error('持续断网保护仅支持 Windows 10/11 x64');
      return { supported: false, profileId: this.profileId, state: 'unsupported', enabled: false, scope: 'windows-bfe-runtime' };
    }
    let output;
    let result;
    const statusCall = action === 'status' ? new AbortController() : null;
    if (statusCall) this.statusCalls.add(statusCall);
    try {
      output = await this.execute(this.command, networkGuardArguments(action, this.profileId), {
        windowsHide: true, shell: false, timeout: action === 'status' ? 15000 : 330000, maxBuffer: 256 * 1024,
        ...(statusCall ? { signal: statusCall.signal } : {}),
      });
    } catch (error) {
      let native;
      try { native = JSON.parse(error.stdout || '{}'); } catch {}
      if (action === 'status' && native?.status?.state === 'unknown') {
        result = validateGuardStatus(native.status, this.profileId);
        result = { ...result, issues: [...(result.issues || []), typeof native.error === 'string' && native.error || '当前权限无法核实系统过滤状态'] };
      } else {
        throw new Error(native?.error || `网络保护操作失败：${error.message}`);
      }
    } finally { if (statusCall) this.statusCalls.delete(statusCall); }
    if (!result) {
      try { result = JSON.parse(output.stdout); } catch { throw new Error('网络保护组件返回了无效状态'); }
    }
    if (result?.error) throw new Error(result.error);
    return validateGuardStatus(result, this.profileId);
  }

  status() { return this.call('status'); }
  // Stopping a read-only helper never removes policy. Elevated operations must
  // finish: cancelling their parent could lose a reply after policy committed.
  cancelStatus() {
    for (const call of this.statusCalls) call.abort();
  }
  // Explicit user action only: a status refresh never calls this automatically.
  verify() { return this.change('verify'); }

  async change(action) {
    if (this.mutating) throw new Error('已有网络保护授权操作正在进行');
    this.mutating = true;
    try {
      const result = await this.call(action);
      if (action === 'enable' && result.state !== 'enabled') throw new Error('网络保护未完整生效，请检查过滤规则状态');
      if (action === 'disable' && result.state !== 'disabled') throw new Error('网络保护尚未完全移除，请检查过滤规则状态');
      return result;
    } finally { this.mutating = false; }
  }

  enable() { return this.change('enable'); }
  disable() { return this.change('disable'); }
}
