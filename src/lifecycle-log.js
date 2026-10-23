import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { version } from './version.js';

const sourceDirectory = fileURLToPath(new URL('./', import.meta.url));
const maxBytes = 512 * 1024;
let sourceFiles = new Set();
try { sourceFiles = new Set(readdirSync(sourceDirectory).filter((name) => /^[A-Za-z0-9_-]+\.js$/.test(name))); } catch {}
const events = new Set(['startup', 'ready', 'startup-failed', 'shutdown-requested', 'shutdown-complete', 'shutdown-failed', 'fatal', 'exit',
  'helper-launch', 'helper-ready', 'helper-launch-failed', 'helper-exit', 'helper-error', 'helper-retired', 'helper-stop-requested', 'helper-timeout-kill', 'helper-restart']);
const reasons = new Set(['unknown', 'invalid-options', 'token-load', 'construction', 'listen', 'api-shutdown', 'signal-SIGINT', 'signal-SIGTERM',
  'uncaught-exception', 'unhandled-rejection', 'helper-missing', 'process-error', 'stdin-error', 'stdout-error',
  'protocol-error', 'init-failed', 'request-timeout', 'request-write', 'owner-close', 'child-exit', 'retry-after-retirement', 'shutdown-timeout', 'bridge-close', 'network-close']);
const shutdownSources = new Set(['api-shutdown', 'signal-SIGINT', 'signal-SIGTERM']);
const signals = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGBREAK', 'SIGHUP', 'SIGILL', 'SIGBUS', 'SIGFPE']);
const errorNames = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'AbortError', 'SystemError']);
const errorCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOTDIR', 'EISDIR', 'EIO', 'ENOSPC', 'EMFILE', 'ENFILE', 'EINVAL', 'ENOEXEC',
  'EADDRINUSE', 'EADDRNOTAVAIL', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH',
  'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_UNHANDLED_REJECTION']);
const normalized = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (left, right) => normalized(path.resolve(left)) === normalized(path.resolve(right));
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const regular = (stat) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;

// Never serialize arbitrary exception text. Stack parsing keeps only locations
// that resolve to this checkout's direct src/*.js files, without function names.
export function safeError(error) {
  const value = {};
  try {
    if (errorNames.has(error?.name)) value.errorName = error.name;
    if (errorCodes.has(error?.code)) value.errorCode = error.code;
    if (typeof error?.stack !== 'string') return value;
    const locations = [];
    for (const line of error.stack.split('\n').slice(1)) {
      const match = line.match(/(?:\(|\s)((?:file:\/\/\/|[A-Za-z]:[\\/]|\/)[^\r\n]*?):(\d+):(\d+)\)?$/);
      if (!match) continue;
      let file;
      try { file = match[1].startsWith('file:') ? fileURLToPath(match[1]) : match[1]; } catch { continue; }
      if (!samePath(path.dirname(file), sourceDirectory) || !sourceFiles.has(path.basename(file))) continue;
      const lineNumber = Number(match[2]), column = Number(match[3]);
      if (!Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(column) || lineNumber < 1 || column < 1) continue;
      locations.push({ file: path.basename(file), line: lineNumber, column });
      if (locations.length === 12) break;
    }
    if (locations.length) value.locations = locations;
  } catch { /* Logging must never become another failure path. */ }
  return value;
}

// Validate every ancestor, including pre-existing parents outside the data dir.
// realpath also rejects Windows junction/reparse redirections exposed by Node.
function checkedDirectory(directory) {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const part of ['', ...absolute.slice(root.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      mkdirSync(current, { mode: 0o700 }); stat = lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync.native(current), current)) throw new Error('unsafe lifecycle directory');
  }
}
function checkedFile(file) {
  try {
    const stat = lstatSync(file);
    if (!regular(stat) || !samePath(realpathSync.native(file), file)) throw new Error('unsafe lifecycle file');
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function createLifecycleLog({ directory, sessionId = process.env.BRIDGE_LIFECYCLE_SESSION } = {}) {
  const id = typeof sessionId === 'string' && /^[a-zA-Z0-9-]{1,96}$/.test(sessionId) ? sessionId : randomUUID();
  const folder = path.resolve(directory || '.bridge', 'diagnostics', 'lifecycle');
  const file = path.join(folder, 'runtime.jsonl');
  return { sessionId: id, write(event, fields = {}) {
    let fd;
    try {
      if (!events.has(event)) return false;
      const record = { v: 1, version, utc: new Date().toISOString(), component: 'runtime', pid: process.pid, sessionId: id, event };
      if (reasons.has(fields.reason)) record.reason = fields.reason;
      if (shutdownSources.has(fields.shutdownSource)) record.shutdownSource = fields.shutdownSource;
      for (const key of ['code', 'childPid', 'parentPid']) if (Number.isSafeInteger(fields[key]) && (key === 'code' || fields[key] > 0)) record[key] = fields[key];
      if (fields.code === null) record.code = null;
      if (signals.has(fields.signal) || fields.signal === null) record.signal = fields.signal;
      if (typeof fields.ownerRequested === 'boolean') record.ownerRequested = fields.ownerRequested;
      if (fields.error) Object.assign(record, safeError(fields.error));
      const line = Buffer.from(`${JSON.stringify(record)}\n`);
      checkedDirectory(folder);
      const backups = [file, `${file}.1`, `${file}.2`];
      const stats = backups.map(checkedFile);
      if (stats[0] && stats[0].size + line.length > maxBytes) {
        if (stats[2]) unlinkSync(backups[2]);
        if (stats[1]) renameSync(backups[1], backups[2]);
        renameSync(file, backups[1]);
      }
      // Exclusive creation prevents replacing an existing link. For an existing
      // file, verify the opened identity and validate the path again before I/O.
      const before = checkedFile(file);
      fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | (before ? 0 : constants.O_CREAT | constants.O_EXCL) | (constants.O_NOFOLLOW || 0), 0o600);
      const opened = fstatSync(fd);
      if (!regular(opened) || (before && !sameFile(before, opened))) return false;
      checkedDirectory(folder);
      const after = checkedFile(file);
      if (!after || !sameFile(after, opened)) return false;
      for (let offset = 0; offset < line.length;) offset += writeSync(fd, line, offset, line.length - offset);
      fsyncSync(fd);
      return true;
    } catch { return false; }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
  } };
}

export function installRuntimeLifecycle(options) {
  const log = createLifecycleLog(options);
  let shutdownSource, fatalReason;
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    fatalReason = origin === 'unhandledRejection' ? 'unhandled-rejection' : 'uncaught-exception';
    log.write('fatal', { reason: fatalReason, error });
  });
  process.on('exit', (code) => log.write('exit', { code, reason: fatalReason || shutdownSource || 'unknown', shutdownSource }));
  log.write('startup', { parentPid: process.ppid });
  return { ...log, requestShutdown(source) {
    shutdownSource = shutdownSources.has(source) ? source : undefined;
    log.write('shutdown-requested', { reason: shutdownSource || 'unknown', shutdownSource });
  } };
}
