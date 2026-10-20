import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveClaude } from './claude-discovery.js';
import { consumeLines } from './line-stream.js';

const discoveryTimeoutMs = 30000;
const outputLimit = 2 * 1024 * 1024;
const modelId = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*(?:\[[a-zA-Z0-9._:-]+\])?$/;
const effortLevels = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid() { throw new Error('Claude 返回的模型目录无效'); }
export function isModelId(value) {
  return typeof value === 'string' && value.length <= 512 && modelId.test(value);
}
function identifier(value) {
  if (!isModelId(value)) invalid();
  return value;
}
function label(value, maxLength, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > maxLength || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid();
  return value;
}

// Shared by the local CLI discovery and the authenticated peer catalog. Never
// forward initialize's account data, arbitrary properties or disabled rows.
export function normalizeModels(raw) {
  if (!Array.isArray(raw) || raw.length > 256) invalid();
  const seen = new Set();
  const models = [];
  for (const entry of raw) {
    if (!object(entry)) invalid();
    if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') invalid();
    if (entry.disabled === true) continue;
    const id = identifier(entry.id ?? entry.value);
    if (seen.has(id)) invalid();
    seen.add(id);
    const model = { id, name: label(entry.name ?? entry.displayName, 256, id) || id, description: label(entry.description, 4096) };
    if (entry.resolvedModel !== undefined) model.resolvedModel = identifier(entry.resolvedModel);
    if (entry.supportsEffort !== undefined) {
      if (typeof entry.supportsEffort !== 'boolean') invalid();
      model.supportsEffort = entry.supportsEffort;
    }
    if (entry.supportedEffortLevels !== undefined) {
      const levels = entry.supportedEffortLevels;
      if (!Array.isArray(levels) || levels.length > effortLevels.size || levels.some((level) => !effortLevels.has(level)) || new Set(levels).size !== levels.length) invalid();
      model.supportedEffortLevels = [...levels];
    }
    models.push(model);
  }
  return models;
}

function aborted() {
  const error = new Error('Claude 模型发现已取消');
  error.name = 'AbortError';
  return error;
}

function terminate(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(command, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    killer.once('error', () => child.kill());
    killer.once('exit', (code) => { if (code !== 0) child.kill(); });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
  }
}

export async function discoverClaudeModels(config, { signal } = {}) {
  if (signal?.aborted) throw aborted();
  if (config.demo) return normalizeModels([
    { id: 'default', name: '默认模型（演示）', description: '模拟模型目录，不调用真实 Claude' },
    { id: 'sonnet', name: 'Sonnet（演示）', description: '模拟模型目录，不代表账号模型权限' },
    { id: 'opus', name: 'Opus（演示）', description: '模拟模型目录，不代表账号模型权限' }
  ]);
  const executable = await resolveClaude(config.claudeCommand);
  if (signal?.aborted) throw aborted();
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SIMPLE;
  const args = [...executable.prefix, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--safe-mode', '--disable-slash-commands', '--disallowedTools', 'mcp__*', '--no-session-persistence'];

  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const child = spawn(executable.command, args, { cwd: config.workspace, env, windowsHide: true, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stopped = false, models, failure, bytes = 0, killTimer, closeLines;
    const stop = (error, result) => {
      if (stopped) return;
      stopped = true; failure = error; models = result;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      closeLines?.();
      child.stdin.end();
      terminate(child);
      killTimer = setTimeout(() => {
        try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, 1000);
      killTimer.unref();
    };
    const onAbort = () => stop(aborted());
    const timeout = setTimeout(() => stop(new Error('Claude 模型发现超时（30 秒），请检查 B 端登录状态与网络连接')), discoveryTimeoutMs);
    const countOutput = (chunk) => {
      bytes += chunk.length;
      if (!stopped && bytes > outputLimit) stop(new Error('Claude 模型发现输出超过 2 MiB 限制'));
    };
    child.stdout.on('data', countOutput);
    child.stderr.on('data', countOutput);
    closeLines = consumeLines(child.stdout, { maxBytes: 1024 * 1024, onError: (error) => stop(error), onLine: (line) => {
      if (stopped || !line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { stop(new Error('Claude 模型发现返回的初始化协议无效')); return; }
      if (!object(message) || message.type !== 'control_response') return;
      const response = message.response;
      if (!object(response) || typeof response.request_id !== 'string') { stop(new Error('Claude 模型发现返回的初始化响应无效')); return; }
      if (response.request_id !== requestId) return;
      if (response.subtype !== 'success' || !object(response.response)) {
        stop(new Error('Claude 初始化失败，请检查 B 端 Claude 登录状态、模型权限与 CLI 版本'));
        return;
      }
      try {
        const discovered = normalizeModels(response.response.models);
        if (!discovered.length) throw new Error('B 端 Claude 未返回可用模型，请检查登录状态与模型权限');
        stop(null, discovered);
      } catch (error) { stop(error); }
    } });
    child.stdin.on('error', () => { if (!stopped) stop(new Error('Claude 模型发现的初始化连接已中断')); });
    child.once('error', () => stop(new Error('无法启动 Claude 模型发现进程，请检查程序路径与工作目录')));
    child.once('close', (code) => {
      clearTimeout(timeout); clearTimeout(killTimer); closeLines();
      signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else if (models) resolve(models);
      else reject(new Error(`Claude 未返回模型目录（退出码 ${code}），请检查 B 端登录状态与 CLI 版本`));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    // This control request is the SDK's no-prompt initialization handshake.
    // Never send a user message: discovery must not start a model inference.
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize', hooks: {} } })}\n`);
  });
}
