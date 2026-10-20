import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const windows = process.platform === 'win32';
const extensions = windows ? ['.exe', '.cmd', '.bat', ''] : [''];

async function isFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function directories(directory) {
  try { return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch { return []; }
}

function environmentValue(env, name) {
  const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return key ? env[key] || '' : '';
}

function absoluteDirectory(value, env) {
  const expanded = value.trim().replace(/^"(.*)"$/, '$1').replace(/%([^%]+)%/g, (match, name) => environmentValue(env, name) || match);
  // Never resolve relative entries against the workspace opened by a remote user.
  return path.isAbsolute(expanded) ? expanded : null;
}

async function currentWindowsPath(env) {
  const systemRoot = environmentValue(env, 'SystemRoot');
  if (!path.isAbsolute(systemRoot)) return [];
  try {
    // Read the persisted PATH without importing a shell profile. A running tray
    // process otherwise keeps the PATH it inherited before Claude was installed.
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ConvertTo-Json -Compress -InputObject @([Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Machine'))";
    const { stdout } = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 3000, maxBuffer: 256 * 1024, encoding: 'utf8' });
    const values = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    return Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [];
  } catch { return []; }
}

function* pathCandidates(values, env) {
  for (const value of values) {
    for (const component of value.split(path.delimiter)) {
      const directory = absoluteDirectory(component, env);
      if (directory) for (const extension of extensions) yield path.join(directory, `claude${extension}`);
    }
  }
}

async function executable(file, explicit = false) {
  if (!(await isFile(file))) {
    if (explicit) throw new Error(`Claude 程序路径不是可访问的文件：${file}`);
    return null;
  }
  if (/\.(cmd|bat)$/i.test(file)) {
    const cli = path.join(path.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (await isFile(cli)) return { command: process.execPath, prefix: [cli] };
    if (explicit) throw new Error('该 .cmd/.bat 不是受支持的 npm Claude 启动器，请指定 claude.exe 或官方 cli.js 的绝对路径');
    return null;
  }
  return /\.[cm]?js$/i.test(file) ? { command: process.execPath, prefix: [file] } : { command: file, prefix: [] };
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return right[i] - left[i];
  return 0;
}

async function* desktopCandidates(roots) {
  const versions = [];
  for (const root of roots) {
    for (const version of await directories(root)) {
      if (/^\d+\.\d+\.\d+$/.test(version)) versions.push({ root, version });
    }
  }
  versions.sort((a, b) => compareVersions(a.version, b.version));
  // Claude Desktop stores a Windows CLI under <version>/<build>/claude.exe.
  // Limit discovery to these known directories; the adjacent claude-code-vm
  // contains a Linux executable and must never be selected on Windows.
  for (const { root, version } of versions) {
    const directory = path.join(root, version);
    yield path.join(directory, 'claude.exe');
    for (const build of (await directories(directory)).sort()) yield path.join(directory, build, 'claude.exe');
  }
}

async function* installedCandidates(env, home) {
  if (path.isAbsolute(home)) {
    for (const extension of extensions) yield path.join(home, '.local', 'bin', `claude${extension}`);
  }
  // App-container environments may redirect LOCALAPPDATA. Also check the real
  // user profile so an already installed Desktop CLI remains discoverable.
  const appDataRoots = new Set([absoluteDirectory(environmentValue(env, 'APPDATA'), env)]);
  const localAppDataRoots = new Set([absoluteDirectory(environmentValue(env, 'LOCALAPPDATA'), env)]);
  if (windows && path.isAbsolute(home)) {
    appDataRoots.add(path.join(home, 'AppData', 'Roaming'));
    localAppDataRoots.add(path.join(home, 'AppData', 'Local'));
  }
  appDataRoots.delete(null);
  localAppDataRoots.delete(null);
  const npmPrefix = absoluteDirectory(environmentValue(env, 'NPM_CONFIG_PREFIX'), env);
  const npmRoots = [npmPrefix, ...(windows ? [...appDataRoots].map((root) => path.join(root, 'npm')) : [])].filter(Boolean);
  for (const root of npmRoots) {
    yield* pathCandidates([windows ? root : path.join(root, 'bin')], env);
    yield path.join(root, ...(windows ? [] : ['lib']), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  }
  if (path.isAbsolute(home)) yield path.join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  if (!windows) return;
  for (const localAppData of localAppDataRoots) yield path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'claude.exe');
  const roots = [...appDataRoots].map((root) => path.join(root, 'Claude', 'claude-code'));
  for (const localAppData of localAppDataRoots) {
    const packages = path.join(localAppData, 'Packages');
    for (const name of await directories(packages)) {
      if (/^AnthropicPBC\.Claude_[\w]+$/i.test(name)) roots.push(path.join(packages, name, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
    }
  }
  yield* desktopCandidates(roots);
}

export async function resolveClaude(command = 'claude', { env = process.env, home = homedir(), windowsPath } = {}) {
  command = command.trim().replace(/^"(.*)"$/, '$1');
  if (path.isAbsolute(command)) return executable(command, true);
  if (command !== 'claude') throw new Error('请填写 claude 或 Claude 可执行文件的绝对路径');
  const seen = new Set();
  const find = async (candidates) => {
    for await (const candidate of candidates) {
      const key = windows ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      const result = await executable(candidate);
      if (result) return result;
    }
    return null;
  };
  let result = await find(pathCandidates([environmentValue(env, 'PATH')], env));
  if (!result && windows) result = await find(pathCandidates(windowsPath ?? await currentWindowsPath(env), env));
  if (!result) result = await find(installedCandidates(env, home));
  if (result) return result;
  throw new Error('未自动定位到 Claude Code。已检查 PATH 和常见安装目录（含 Claude 桌面版）；已安装的用户可在“Claude 程序路径或命令”填写 claude.exe 或官方 cli.js 的绝对路径。');
}
