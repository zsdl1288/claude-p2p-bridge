import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge.js';

async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for model catalog condition');
}

async function fixture(t, modelCatalogProvider) {
  const host = new Bridge({ demo: true, modelCatalogProvider });
  const client = new Bridge({ demo: true });
  t.after(async () => { await client.disconnect(); await host.disconnect(); });
  const state = await host.host({ workspace: process.cwd(), bridgePort: 0, claudeCommand: 'fixture-old' });
  await client.join({ invitation: state.invitation });
  await until(() => host.status().online && client.modelStatus().online);
  return { host, client };
}

test('a late old-config catalog probe cannot replace the reconfigured B catalog or either A view', { timeout: 15000 }, async (t) => {
  const oldModels = [{ id: 'claude-old-account-model', name: 'Old account model' }];
  const newModels = [{ id: 'provider/claude-new-account:preview[1m]', name: 'New account model' }];
  let blockOld = false;
  let releaseOld;
  const { host, client } = await fixture(t, async (config) => {
    if (config.claudeCommand !== 'fixture-old') return structuredClone(newModels);
    if (!blockOld) return structuredClone(oldModels);
    return new Promise((resolve) => { releaseOld = () => resolve(structuredClone(oldModels)); });
  });
  assert.deepEqual((await host.getModels()).map((entry) => entry.id), oldModels.map((entry) => entry.id));
  blockOld = true;
  const oldRefresh = client.refreshModels();
  // Observe rejections immediately because a generation change may abort an
  // in-flight probe before it is awaited below.
  void oldRefresh.catch(() => {});
  await until(() => Boolean(releaseOld));
  t.after(() => releaseOld?.());
  await host.configureModel({ enabled: true, claudeCommand: 'fixture-new' });
  assert.deepEqual((await host.getModels()).map((entry) => entry.id), newModels.map((entry) => entry.id));
  await until(() => client.modelStatus().models?.[0]?.id === newModels[0].id);
  releaseOld();
  await oldRefresh.catch(() => {});
  assert.deepEqual((await host.getModels()).map((entry) => entry.id), newModels.map((entry) => entry.id));
  assert.deepEqual(client.modelStatus().models.map((entry) => entry.id), newModels.map((entry) => entry.id));
  assert.deepEqual((await client.getModels()).map((entry) => entry.id), newModels.map((entry) => entry.id));
  assert.equal(host.modelStatus().modelsState, 'ready');
});

test('disabling B while a catalog probe is pending cannot restore the old selectable models', { timeout: 15000 }, async (t) => {
  let slow = false;
  let release;
  const { host, client } = await fixture(t, async () => {
    if (!slow) return [{ id: 'claude-fixture-account-model', name: 'Fixture account model' }];
    return new Promise((resolve) => { release = () => resolve([{ id: 'claude-retired-account-model', name: 'Retired model' }]); });
  });
  await host.getModels();
  slow = true;
  const pending = host.refreshModels();
  void pending.catch(() => {});
  await until(() => Boolean(release));
  t.after(() => release?.());
  await host.configureModel({ enabled: false });
  release();
  await pending.catch(() => {});
  await until(() => client.modelStatus().enabled === false);
  assert.equal(host.modelStatus().enabled, false);
  assert.deepEqual(host.modelStatus().models, []);
  assert.deepEqual(client.modelStatus().models, []);
  await assert.rejects(client.getModels());
});

test('B rejects an unadvertised model even when an authenticated A bypasses its local HTTP validation', { timeout: 15000 }, async (t) => {
  const { host, client } = await fixture(t, async () => [{ id: 'claude-account-only-model', name: 'Account model' }]);
  await client.getModels();
  const id = randomUUID();
  const events = [];
  const onMessage = (message) => { if (message.id === id && message.type === 'event') events.push(message.event); };
  client.modelPeer.on('message', onMessage);
  t.after(() => client.modelPeer?.off('message', onMessage));
  client.modelPeer.send({ type: 'run', id, request: { kind: 'model', model: 'claude-not-in-this-account', messages: [{ role: 'user', content: 'Must be rejected by B.' }] } });
  await until(() => events.some((event) => event.type === 'done'));
  assert.equal(events.some((event) => event.type === 'started' || event.type === 'claude'), false);
  assert.ok(events.some((event) => event.type === 'error' && /模型|model/i.test(event.message)));
  assert.equal(host.active.size, 0);
  assert.equal(host.queue.length, 0);
});
