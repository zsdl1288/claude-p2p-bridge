import test from 'node:test';
import assert from 'node:assert/strict';
import { SecureChannel, makePairing, encodeInvitation, parseInvitation } from '../src/crypto.js';
import { isTailscaleIp, validatePeerAddress, summarizeTailscale } from '../src/tailscale.js';

test('only literal Tailscale addresses are accepted in production invitations', () => {
  const pair = makePairing('100.101.102.103');
  assert.deepEqual(parseInvitation(encodeInvitation(pair)), pair);
  for (const host of ['0.0.0.0', '127.0.0.1', '192.168.1.2', '8.8.8.8', '100.63.255.255', '100.128.0.1', 'localhost', 'fake.ts.net', '::1', '100.101.102.103/24']) {
    assert.throws(() => makePairing(host), host);
    assert.throws(() => parseInvitation(encodeInvitation({ ...pair, host })), host);
  }
  assert.ok(isTailscaleIp('100.64.0.1'));
  assert.ok(isTailscaleIp('100.127.255.254'));
  assert.throws(() => validatePeerAddress(undefined));
  assert.throws(() => makePairing('100.100.1.2', 0));
  assert.throws(() => parseInvitation(encodeInvitation({ ...pair, port: 70000 })));
  assert.throws(() => parseInvitation(encodeInvitation({ ...pair, v: 1 })), /旧版/);
  assert.throws(() => parseInvitation('invalid'));
  const local = makePairing('127.0.0.1', 3211, { allowLoopback: true });
  assert.throws(() => parseInvitation(encodeInvitation(local)));
  assert.deepEqual(parseInvitation(encodeInvitation(local), { allowLoopback: true }), local);
});

test('Tailscale CLI detection only accepts IPs actually assigned on this machine', () => {
  const interfaces = { Tailscale: [{ family: 'IPv4', address: '100.100.1.2' }], WiFi: [{ family: 'IPv4', address: '192.168.1.2' }] };
  const ready = summarizeTailscale({ BackendState: 'Running', TailscaleIPs: ['100.100.1.2', '100.100.1.3', '8.8.8.8'], Self: { HostName: 'B' } }, interfaces);
  assert.equal(ready.running, true);
  assert.deepEqual(ready.addresses, ['100.100.1.2']);
  assert.equal(ready.hostname, 'B');
  assert.equal(summarizeTailscale({ BackendState: 'NeedsLogin', TailscaleIPs: ['100.100.1.2'] }, interfaces).running, false);
  assert.equal(summarizeTailscale({ BackendState: 'Running', TailscaleIPs: ['100.100.1.3'] }, interfaces).running, false);
});

test('AES-GCM is directional and rejects tampering, replay and an incorrect secret', () => {
  const pair = makePairing('100.101.102.103');
  const host = new SecureChannel(pair.secret, pair.room, 'host');
  const client = new SecureChannel(pair.secret, pair.room, 'client');
  const packet = host.seal({ prompt: 'secret project data 中文' });
  assert.ok(!JSON.stringify(packet).includes('secret project data'));
  assert.throws(() => host.open(packet));
  assert.deepEqual(client.open(packet), { prompt: 'secret project data 中文' });
  assert.throws(() => client.open(packet));
  const tampered = host.seal({ prompt: 'hello' });
  tampered.data = Buffer.from('changed').toString('base64url');
  assert.throws(() => client.open(tampered));
  const wrong = new SecureChannel(makePairing('100.100.1.1').secret, pair.room, 'client');
  assert.throws(() => wrong.open(host.seal({ private: true })));
  assert.equal(Buffer.from(packet.iv, 'base64url').length, 12);
});

test('out-of-order encrypted frames keep a bounded replay window and expire old arrivals', () => {
  const pair = makePairing('100.101.102.103');
  const host = new SecureChannel(pair.secret, pair.room, 'host');
  const client = new SecureChannel(pair.secret, pair.room, 'client');
  const frames = Array.from({ length: 4097 }, (_, index) => host.seal({ index }));
  client.open(frames[4095]);
  for (const frame of frames.slice(0, 4095)) client.open(frame);
  client.open(frames[4096]);
  const window = [...client.windows.values()][0];
  assert.equal(window.seen.size, 4096);
  assert.equal(window.seen.has(1n), false);
  assert.throws(() => client.open(frames[0]), /重复或过期/);
});
