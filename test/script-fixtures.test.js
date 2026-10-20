import assert from 'node:assert/strict';
import { access, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { temporaryTestDirectory } from '../scripts/test-support.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = path.join(root, '.bridge');

test('script fixtures remove only their own directory and allow repeated cleanup', async (t) => {
  const own = await temporaryTestDirectory(fixtures, 'script-cleanup-');
  const neighbour = await temporaryTestDirectory(fixtures, 'script-neighbour-');
  t.after(() => neighbour.cleanup());
  t.after(() => own.cleanup());
  const sentinel = path.join(neighbour.directory, 'keep.txt');
  await writeFile(sentinel, 'preserve');
  await writeFile(path.join(own.directory, 'temporary.txt'), 'temporary');
  await own.cleanup();
  await assert.rejects(access(own.directory), { code: 'ENOENT' });
  await access(sentinel);
  await own.cleanup();
});

test('script fixtures reject external roots and unsafe directory prefixes', async () => {
  await assert.rejects(temporaryTestDirectory(root, 'unsafe-'), /workspace/);
  await assert.rejects(temporaryTestDirectory(fixtures, '../unsafe-'));
});

test('script cleanup refuses a linked directory and preserves its target', async (t) => {
  const own = await temporaryTestDirectory(fixtures, 'script-link-');
  const target = await temporaryTestDirectory(fixtures, 'script-target-');
  t.after(() => target.cleanup());
  const link = path.join(own.directory, 'linked');
  t.after(async () => {
    try { await unlink(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await own.cleanup();
  });
  const sentinel = path.join(target.directory, 'keep.txt');
  await writeFile(sentinel, 'preserve');
  try { await symlink(target.directory, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip('Windows link creation is unavailable'); return;
  }
  await assert.rejects(own.cleanup(), /Linked/);
  await access(sentinel);
});
