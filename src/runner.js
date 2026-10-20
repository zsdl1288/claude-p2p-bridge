import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { consumeLines } from './line-stream.js';
import { normalizeChatRequest, decisionSchema, modelSystemPrompt, buildModelPrompt } from './model-protocol.js';
import { resolveClaude } from './claude-discovery.js';
export { resolveClaude } from './claude-discovery.js';

const profiles = { read: ['Read', 'Glob', 'Grep'], edit: ['Read', 'Glob', 'Grep', 'Edit', 'Write'], develop: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] };
const outputLimit = 16 * 1024 * 1024;

function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    killer.on('error', () => child.kill());
    killer.on('exit', (code) => { if (code !== 0) child.kill(); });
  } else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
}
export function validateRequest(input) {
  if (input?.kind === 'model') return normalizeChatRequest(input);
  if (input?.kind && input.kind !== 'task') throw new Error('不支持的请求类型');
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 128 * 1024) throw new Error('prompt 必须为非空字符串，且不超过 128 KiB');
  if (input.sessionId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.sessionId)) throw new Error('sessionId 必须为 Claude 会话 UUID');
  if (input.model !== undefined && (typeof input.model !== 'string' || !/^[a-zA-Z0-9][\w.:-]{0,99}$/.test(input.model))) throw new Error('model 格式无效');
  return { prompt: input.prompt, ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.model ? { model: input.model } : {}) };
}

export async function probeClaude(command) {
  try {
    const executable = await resolveClaude(command);
    const resolvedPath = executable.prefix[0] || executable.command;
    return await new Promise((resolve) => {
      const child = spawn(executable.command, [...executable.prefix, '--version'], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let output = '';
      const timer = setTimeout(() => { terminateProcessTree(child); resolve({ available: false, message: '版本检测超时' }); }, 8000);
      const collect = (text) => { output = (output + text).slice(0, 1000); };
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder('utf8');
        stream.on('data', (data) => collect(decoder.write(data)));
        stream.on('end', () => collect(decoder.end()));
      }
      child.on('error', (e) => { clearTimeout(timer); resolve({ available: false, message: e.message }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ available: code === 0, resolvedPath, message: `${output.trim() || `退出码 ${code}`}\n程序路径：${resolvedPath}` }); });
    });
  } catch (error) { return { available: false, message: error.message }; }
}

export async function runClaude(config, request, emit, signal) {
  request = validateRequest(request);
  if (!profiles[config.profile]) throw new Error('工具权限配置无效');
  const executable = config.demo ? { command: process.execPath, prefix: [fileURLToPath(new URL('./demo-claude.js', import.meta.url))] } : await resolveClaude(config.claudeCommand);
  if (signal.aborted) return emit({ type: 'done', exitCode: null, cancelled: true });
  const modelMode = request.kind === 'model';
  if (modelMode && config.maxTurns < 3) throw new Error('主模型的结构化输出需要至少 3 个 CLI 内部轮次，请在 B 端重新开启服务并提高 maxTurns');
  const tools = modelMode ? '' : profiles[config.profile].join(',');
  const args = [...executable.prefix, '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'dontAsk', '--tools', tools, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--max-turns', String(config.maxTurns || 30)];
  if (modelMode) {
    // --bare skips subscription OAuth. Safe mode disables customizations while
    // retaining the official CLI's normal authentication flow.
    args.push('--safe-mode', '--disable-slash-commands', '--disallowedTools', 'mcp__*', '--no-session-persistence', '--system-prompt', modelSystemPrompt, '--json-schema', JSON.stringify(decisionSchema));
    if (request.model !== 'claude-code') args.push('--model', request.model);
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(request.reasoning_effort)) args.push('--effort', request.reasoning_effort);
  } else {
    args.push('--allowedTools', tools);
    if (request.sessionId) args.push('--resume', request.sessionId);
    if (request.model) args.push('--model', request.model);
  }
  const env = { ...process.env };
  delete env.CLAUDECODE;
  if (modelMode) delete env.CLAUDE_CODE_SIMPLE;
  return new Promise((resolve) => {
    const child = spawn(executable.command, args, { cwd: config.workspace, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let resultSeen = false;
    let totalBytes = 0;
    let stopReason;
    const safeEmit = (event) => { try { emit(event); } catch { stop('传输中断'); } };
    const stop = (reason) => {
      if (settled || stopReason) return;
      stopReason = reason;
      terminateProcessTree(child);
    };
    const onAbort = () => stop('任务已取消');
    signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => stop('任务超过 B 端配置的时间限制'), config.timeoutMs || 600000);
    const forceKill = setInterval(() => {
      if (stopReason && !settled) {
        try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    }, 3000);
    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(forceKill);
      signal.removeEventListener('abort', onAbort);
      if (error) safeEmit({ type: 'error', code: 'CLAUDE_PROCESS_ERROR', message: error });
      else if (stopReason && !signal.aborted) safeEmit({ type: 'error', code: 'RUN_LIMIT', message: stopReason });
      else if (!resultSeen && !signal.aborted) safeEmit({ type: 'error', code: 'CLAUDE_NO_RESULT', message: `Claude 未返回最终结果（退出码 ${exitCode}），请检查 B 端的登录状态和 CLI 版本` });
      safeEmit({ type: 'done', exitCode, cancelled: signal.aborted });
      resolve();
    };
    safeEmit({ type: 'started', demo: Boolean(config.demo), mode: modelMode ? 'model' : 'task', profile: config.profile, workspace: config.workspace });
    const countOutput = (data) => {
      totalBytes += data.length;
      if (totalBytes > outputLimit) stop('输出超过 16 MiB 限制');
      return !stopReason;
    };
    child.stdout.on('data', countOutput);
    consumeLines(child.stdout, { maxBytes: 1024 * 1024, onError: (error) => stop(`Claude ${error.message}`), onLine: (line) => {
      if (stopReason) return;
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === 'result') resultSeen = true;
        safeEmit({ type: 'claude', event });
      } catch { safeEmit({ type: 'stderr', text: line.slice(0, 4000) }); }
    } });
    const stderrDecoder = new StringDecoder('utf8');
    const emitStderr = (text) => { if (text && !stopReason) safeEmit({ type: 'stderr', text: text.slice(0, 8000) }); };
    child.stderr.on('data', (data) => { if (countOutput(data)) emitStderr(stderrDecoder.write(data)); });
    child.stderr.on('end', () => emitStderr(stderrDecoder.end()));
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code));
    child.stdin.end(modelMode ? buildModelPrompt(request) : request.prompt, 'utf8');
    if (signal.aborted) onAbort();
  });
}
