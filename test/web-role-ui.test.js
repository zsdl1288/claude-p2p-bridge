import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uiState, allowedPage, deviceIdentity, deviceConnection } from '../public/ui-state.js';

test('role controls stay locked while connecting, connected and temporarily offline', () => {
  for (const networkState of ['connecting', 'online', 'offline']) {
    const state = uiState({ identity: { loaded: true, role: 'client', locked: true, desiredOnline: true, state: networkState, canSwitchRole: false }, network: { running: networkState === 'online' } });
    assert.equal(state.canSelectRole, false);
    assert.equal(state.canConnect, false);
    assert.equal(state.canDisconnect, true);
  }
  const disconnected = uiState({ identity: { loaded: true, role: 'client', locked: false, desiredOnline: false, canSwitchRole: true } });
  assert.equal(disconnected.canSelectRole, true);
  assert.equal(disconnected.canConnect, true);
  assert.equal(disconnected.canDisconnect, false);
  assert.equal(uiState({ identity: { loaded: true, role: 'client', locked: false, desiredOnline: true, canSwitchRole: true } }).canSelectRole, false);
  assert.equal(uiState({ identity: { loaded: true, role: 'client', locked: false } }).canSelectRole, false);
});

test('business pages depend on saved authorization rather than current connectivity', () => {
  const unpaired = uiState({ identity: { loaded: true, role: 'host' }, capabilities: { model: false, proxy: false } });
  assert.equal(allowedPage('api', unpaired), 'connection');
  assert.equal(allowedPage('proxy', unpaired), 'connection');
  assert.equal(allowedPage('settings', unpaired), 'settings');
  const pairedOffline = uiState({ identity: { loaded: true, role: 'client', locked: true }, online: false, capabilities: { model: true, proxy: true } });
  assert.equal(allowedPage('api', pairedOffline), 'api');
  assert.equal(allowedPage('proxy', pairedOffline), 'proxy');
  assert.equal(allowedPage('toString', pairedOffline), 'connection');
});

test('network login requires identity and role mutation is blocked during pending operations', () => {
  assert.equal(uiState({}).canConnect, false);
  const busy = uiState({ identity: { loaded: true, role: 'host', canSwitchRole: true }, network: { running: true } }, true);
  assert.equal(busy.canSelectRole, false);
  assert.equal(busy.canConnect, false);
  assert.equal(busy.canPair, false);
  const loading = uiState({ identity: { loaded: false, role: 'host', canSwitchRole: false }, capabilities: { model: true, proxy: true } });
  assert.equal(loading.canSelectRole, false);
  assert.equal(loading.canConnect, false);
  assert.equal(loading.model, false);
  assert.equal(loading.proxy, false);
  const invalidRole = uiState({ identity: { loaded: true, role: 'both' }, capabilities: { model: true, proxy: true } });
  assert.equal(invalidRole.model, false);
  assert.equal(invalidRole.proxy, false);
});

test('network login stays disabled while identity changes or an incomplete down keeps the role locked', () => {
  for (const phase of ['switching', 'disconnected', 'error']) {
    const pending = uiState({ identity: { loaded: true, role: 'client', desiredOnline: false, locked: true, canSwitchRole: false, state: phase } });
    assert.equal(pending.canConnect, false, `${phase} must not offer login before the locked transition completes`);
    assert.equal(pending.canSelectRole, false);
  }
});

test('device labels only describe explicit role and self markers', () => {
  assert.equal(deviceIdentity({ self: true, role: 'host' }), '本机 · B 服务端');
  assert.equal(deviceIdentity({ self: true, role: 'client' }), '本机 · A 调用端');
  assert.equal(deviceIdentity({ name: 'server-host' }), '');
  assert.equal(deviceConnection({ online: true, path: 'direct' }), 'P2P 直连');
  assert.equal(deviceConnection({ online: true, path: 'relay' }), '加密中转');
  assert.equal(deviceConnection({ online: false, path: 'direct' }), '离线');
});

test('device page excludes Claude inputs and business navigation starts gated', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const devicePage = html.slice(html.indexOf('<section id="connection"'), html.indexOf('<section id="api"'));
  assert.doesNotMatch(devicePage, /id="(?:workspace|claude-command|profile|probe)"/);
  assert.match(html, /data-page="api"[^>]+disabled/);
  assert.match(html, /data-page="proxy"[^>]+disabled/);
});

test('web controllers reference present, unique controls in the page template', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'control IDs must be unique');
  for (const match of script.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), `missing #${match[1]}`);
});
