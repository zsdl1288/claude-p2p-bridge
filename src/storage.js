import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Commit complete, flushed state without replacing the previous file on a
// failed write. Pairing secrets and proxy preferences use the same protocol.
export async function atomicWrite(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, file);
  } finally {
    try { await handle?.close(); }
    finally { await rm(temporary, { force: true }); }
  }
}
