import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoots = new Set(['.bridge', '.cache'].map((name) => path.join(root, name)));

// Only directories created by this call can be removed. Refuse linked content
// so a test cannot accidentally traverse a live profile or another workspace.
export async function temporaryTestDirectory(parent, prefix) {
  parent = path.resolve(parent);
  assert.ok(fixtureRoots.has(parent), 'Test fixtures must be inside this workspace .bridge or .cache');
  assert.match(prefix, /^[A-Za-z0-9][A-Za-z0-9-]*-$/);
  await mkdir(parent, { recursive: true });
  assert.equal(await realpath(parent), parent, 'Test fixture root must not contain links');
  const directory = await mkdtemp(path.join(parent, prefix));
  async function check(file) {
    const entry = await lstat(file);
    assert.equal(entry.isSymbolicLink(), false, `Linked test fixture is not allowed: ${file}`);
    assert.equal(await realpath(file), file, `Linked test fixture is not allowed: ${file}`);
    if (entry.isDirectory()) {
      for (const child of await readdir(file)) await check(path.join(file, child));
    }
  }
  return {
    directory,
    async cleanup() {
      assert.equal(path.dirname(directory), parent);
      try { await lstat(directory); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      await check(directory);
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
}
