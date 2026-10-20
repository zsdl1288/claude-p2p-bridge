import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ApplicationStore } from '../src/application-store.js';

test('application preferences reject oversized UTF-8 writes while preserving the readable prior record', async (t) => {
  const parent = path.resolve('.bridge');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'application-store-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(parent));
    assert.match(path.basename(directory), /^application-store-/);
    await rm(directory, { recursive: true, force: true });
  });
  const store = new ApplicationStore({ directory, demo: true });
  const original = { v: 1, role: null, desiredOnline: false, locked: false, model: { enabled: false, config: null } };
  await store.save(original);
  const before = await readFile(store.file);
  const oversized = { ...original, role: 'host', model: { enabled: false, config: { workspace: '目录'.repeat(6000) } } };
  await assert.rejects(store.save(oversized), /身份配置过大/);
  assert.deepEqual(await readFile(store.file), before);
  assert.deepEqual(await store.load(), original);
  assert.deepEqual(await new ApplicationStore({ directory, demo: true }).load(), original);
  assert.equal(await new ApplicationStore({ directory }).load(), null, 'Demo and real preferences remain isolated');
});
