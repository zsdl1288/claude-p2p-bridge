import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';

async function until(check, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for multi-client condition');
}
async function setup(t, count = 2) {
  const host = new Bridge({ demo: true });
  const clients = Array.from({ length: count }, () => new Bridge({ demo: true }));
  t.after(async () => { await Promise.all(clients.map((client) => client.disconnect())); await host.disconnect(); });
  const { invitation } = await host.host({ workspace: process.cwd(), tailscaleIp: '127.0.0.1', bridgePort: 0, profile: 'read' });
  await Promise.all(clients.map((client) => client.join({ invitation })));
  await until(() => host.status().connectedClients === count);
  return { host, clients, invitation };
}
function begin(client, prompt, options = {}) {
  const events = [];
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const id = client.run({ prompt, ...options }, (event) => {
    events.push(event);
    if (event.type === 'done') finish(events);
  });
  return { id, events, done };
}
const result = (events) => events.find((event) => event.type === 'claude' && event.event.type === 'result')?.event;
const successful = (events) => events.some((event) => event.type === 'done' && event.exitCode === 0 && !event.cancelled) && !events.some((event) => event.type === 'error');

test('three independent A clients queue FIFO and B runs only one Claude process', { timeout: 15000 }, async (t) => {
  const { host, clients: [a1, a2, a3] } = await setup(t, 3);
  assert.equal(host.status().maxClients, 16);
  assert.equal(new Set([a1, a2, a3].map((client) => client.status().connectionId)).size, 3);
  let maxActive = 0;
  host.on('state', () => { maxActive = Math.max(maxActive, host.active.size); });
  const first = begin(a1, '[slow] A-one');
  await until(() => first.events.some((event) => event.type === 'started'));
  const second = begin(a2, 'A-two');
  await until(() => host.status().queuedRequests === 1);
  const third = begin(a3, 'A-three');
  await until(() => host.status().queuedRequests === 2 && third.events.some((event) => event.type === 'queued'));
  assert.equal(host.status().activeRequests, 3);
  assert.equal(second.events.find((event) => event.type === 'queued').position, 1);
  assert.equal(third.events.find((event) => event.type === 'queued').position, 2);
  a1.cancel(first.id);
  await Promise.all([first.done, second.done, third.done]);
  assert.equal(successful(second.events), true);
  assert.equal(successful(third.events), true);
  assert.match(result(second.events).result, /A-two/);
  assert.doesNotMatch(result(second.events).result, /A-one|A-three/);
  assert.match(result(third.events).result, /A-three/);
  assert.equal(maxActive, 1);
  const starts = host.logs.filter((entry) => entry.message.startsWith('开始任务 ')).reverse().map((entry) => entry.message);
  assert.deepEqual(starts, [first, second, third].map((task) => `开始任务 ${task.id.slice(0, 8)}`));
  await until(() => host.status().activeRequests === 0);
});

test('cancel messages are scoped to their A and queued cancellation does not stop another A', { timeout: 15000 }, async (t) => {
  const { host, clients: [a1, a2] } = await setup(t);
  const first = begin(a1, '[slow] protected active task');
  await until(() => first.events.some((event) => event.type === 'started'));
  const second = begin(a2, 'cancel while queued');
  await until(() => second.events.some((event) => event.type === 'queued'));
  a2.modelPeer.send({ type: 'cancel', id: first.id });
  a1.modelPeer.send({ type: 'cancel', id: second.id });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal([...host.active.values()][0].controller.signal.aborted, false);
  assert.equal(host.status().queuedRequests, 1);
  assert.equal(second.events.some((event) => event.type === 'started'), false);
  a2.cancel(second.id);
  await second.done;
  assert.equal(second.events.at(-1).cancelled, true);
  assert.equal(host.status().queuedRequests, 0);
  assert.equal(host.active.size, 1);
  assert.equal([...host.active.values()][0].controller.signal.aborted, false);
  a1.cancel(first.id);
  await first.done;
  await until(() => host.active.size === 0);
});

test('disconnecting a queued A leaves the running A alone; disconnecting that A releases the next task', { timeout: 15000 }, async (t) => {
  const { host, clients: [a1, a2, a3] } = await setup(t, 3);
  const first = begin(a1, '[slow] running A');
  await until(() => first.events.some((event) => event.type === 'started'));
  const second = begin(a2, 'queued A survives other departures');
  await until(() => second.events.some((event) => event.type === 'queued'));
  const third = begin(a3, 'departing queued A');
  await until(() => third.events.some((event) => event.type === 'queued'));
  await a3.disconnect();
  await third.done;
  await until(() => host.status().connectedClients === 2 && host.status().queuedRequests === 1);
  assert.equal([...host.active.values()][0].controller.signal.aborted, false);
  await a1.disconnect();
  await first.done;
  await second.done;
  assert.equal(successful(second.events), true);
  assert.equal(host.status().connectedClients, 1);
  assert.equal(a2.status().online, true);
  assert.equal(host.logs.some((entry) => entry.message === `开始任务 ${third.id.slice(0, 8)}`), false);
});

test('Claude session IDs belong to one authenticated A connection and cannot cross clients or reconnects', { timeout: 15000 }, async (t) => {
  const { host, clients: [a1, a2], invitation } = await setup(t);
  const first = begin(a1, 'create private conversation');
  await first.done;
  const sessionId = result(first.events).session_id;
  const foreign = begin(a2, 'attempt to resume another A', { sessionId });
  await foreign.done;
  assert.equal(successful(foreign.events), false);
  assert.match(foreign.events.find((event) => event.type === 'error').message, /不属于当前配对连接/);
  const own = begin(a1, 'resume my own conversation', { sessionId });
  await own.done;
  assert.equal(successful(own.events), true);
  assert.equal(result(own.events).session_id, sessionId);
  const oldConnection = a1.status().connectionId;
  await a1.disconnect();
  await until(() => host.status().connectedClients === 1);
  await a1.join({ invitation });
  assert.notEqual(a1.status().connectionId, oldConnection);
  const stale = begin(a1, 'resume from an earlier socket', { sessionId });
  await stale.done;
  assert.equal(successful(stale.events), false);
  const fresh = begin(a2, 'A-two creates its own conversation');
  await fresh.done;
  assert.equal(successful(fresh.events), true);
  assert.notEqual(result(fresh.events).session_id, sessionId);
});

test('identical request IDs on different A connections have separate cancellation and reply routing', { timeout: 15000 }, async (t) => {
  const { host, clients: [a1, a2] } = await setup(t);
  const first = begin(a1, '[slow] original owner');
  await until(() => first.events.some((event) => event.type === 'started'));
  const secondEvents = [];
  a2.modelPeer.on('message', (message) => { if (message.type === 'event' && message.id === first.id) secondEvents.push(message.event); });
  a2.modelPeer.send({ type: 'run', id: first.id, request: { prompt: 'same id, different A' } });
  await until(() => secondEvents.some((event) => event.type === 'queued'));
  a2.modelPeer.send({ type: 'cancel', id: first.id });
  await until(() => secondEvents.some((event) => event.type === 'done'));
  assert.equal(secondEvents.at(-1).cancelled, true);
  assert.equal([...host.active.values()][0].controller.signal.aborted, false);
  secondEvents.length = 0;
  a2.modelPeer.send({ type: 'run', id: first.id, request: { prompt: 'same id, different A' } });
  await until(() => secondEvents.some((event) => event.type === 'queued'));
  a1.cancel(first.id);
  await first.done;
  await until(() => secondEvents.some((event) => event.type === 'done'));
  assert.equal(successful(secondEvents), true);
  assert.match(result(secondEvents).result, /same id, different A/);
  assert.doesNotMatch(result(secondEvents).result, /original owner/);
});

test('recreating B pairing cancels its old queue and cannot revive tasks while an old process exits', { timeout: 15000 }, async (t) => {
  const { host, clients: [a1, a2] } = await setup(t);
  let maxActive = 0;
  host.on('state', () => { maxActive = Math.max(maxActive, host.active.size); });
  const first = begin(a1, '[slow] old process');
  await until(() => first.events.some((event) => event.type === 'started'));
  const stale = begin(a2, 'must never execute from the old queue');
  await until(() => stale.events.some((event) => event.type === 'queued'));
  const replacement = await host.host({ workspace: process.cwd(), tailscaleIp: '127.0.0.1', bridgePort: 0, profile: 'read' });
  await Promise.all([first.done, stale.done]);
  await a2.join({ invitation: replacement.invitation });
  const fresh = begin(a2, 'new B pairing works after old task shutdown');
  await fresh.done;
  assert.equal(successful(fresh.events), true);
  assert.equal(maxActive, 1);
  assert.equal(host.logs.some((entry) => entry.message === `开始任务 ${stale.id.slice(0, 8)}`), false);
  await until(() => host.active.size === 0 && host.queue.length === 0);
});
