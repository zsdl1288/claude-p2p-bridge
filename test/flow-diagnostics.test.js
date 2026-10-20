import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';
import { NetworkProxy } from '../src/network-proxy.js';

// Controlled write completion exercises the observation boundary; the real
// TCP/WS slow-reader tests remain in network-proxy.test.js.
function fixture(t, enabled = true) {
  const bridge = new EventEmitter(), connection = { session: 'private-session' };
  const peer = bridge.peer = { role: 'host', connections: new Set([connection]), isConnected: () => true };
  const proxy = new NetworkProxy({ bridge, diagnosticsEnabled: enabled });
  proxy.sharing = true;
  t.after(() => proxy.close());
  const addFlow = () => {
    const socket = new net.Socket({ allowHalfOpen: true }), callbacks = [];
    const ws = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, bufferedAmount: 0, isPaused: false, _socket: new net.Socket() });
    ws.send = (_frame, callback) => { callbacks.push(callback); };
    ws.pause = () => { ws.isPaused = true; ws._socket?.pause(); };
    ws.resume = () => { ws.isPaused = false; ws._socket?.resume(); };
    ws.ping = ws.pong = (_data, callback) => callback?.();
    ws.terminate = () => { ws.readyState = WebSocket.CLOSED; ws._socket?.destroy(); };
    ws.close = ws.terminate;
    const flow = proxy.makeFlow(peer, connection, 'host', ws);
    flow.resources.add(socket); proxy.pipeTcp(flow, socket);
    return { flow, socket, ws, callbacks };
  };
  return { proxy, addFlow };
}

test('flow diagnostics is disabled by default and only accepts an explicit true option', (t) => {
  const defaults = new NetworkProxy({ bridge: new EventEmitter() });
  t.after(() => defaults.close());
  assert.equal(defaults.diagnosticsEnabled, false); assert.equal(defaults.diagnostics(), undefined);
  for (const enabled of [false, '1', 'false', 1]) {
    const { proxy, addFlow } = fixture(t, enabled), { flow } = addFlow();
    assert.equal(proxy.diagnostics(), undefined); assert.equal(flow.diagnostics, undefined);
    assert.equal(flow.diagnosticControl, undefined);
  }
});

test('flow diagnostics observes pending and completed local DATA callbacks without payload retention or state events', (t) => {
  const { proxy, addFlow } = fixture(t), { flow, socket, callbacks } = addFlow();
  const payload = Buffer.from('https://secret-target.invalid/private?token=secret-token');
  socket.emit('data', payload);
  let snapshot = proxy.diagnostics().active[0];
  assert.equal(snapshot.flowId, 1); assert.equal(snapshot.side, 'host'); assert.equal(snapshot.sourceToWsDirection, 'download');
  assert.equal(snapshot.sourceReadBytes, payload.length); assert.equal(snapshot.wsWriteCompletedBytes, 0);
  assert.equal(snapshot.pendingDataFrames, 1); assert.equal(snapshot.pendingDataBytes, payload.length);
  assert.equal(snapshot.tcpPaused, true); assert.ok(snapshot.pendingDataAgeMs >= 0); assert.equal(snapshot.lastDoneAgoMs, null);
  const control = []; const originalPong = flow.ws.pong;
  flow.ws.pong = (_data, callback) => control.push(callback);
  flow.pauseReceive();
  snapshot = proxy.diagnostics().active[0];
  assert.equal(snapshot.wsReceivePaused, true); assert.ok(snapshot.receivePausedForMs >= 0); assert.ok(snapshot.controlWritePendingForMs >= 0);
  control.shift()(); flow.ws.pong = originalPong;
  assert.equal(proxy.diagnostics().active[0].controlWritePendingForMs, null);
  flow.resumeReceive(); callbacks.shift()();
  snapshot = proxy.diagnostics().active[0];
  assert.equal(snapshot.wsWriteCompletedBytes, payload.length); assert.equal(snapshot.pendingDataFrames, 0);
  assert.equal(snapshot.pendingDataBytes, 0); assert.equal(snapshot.pendingDataAgeMs, null);
  assert.equal(snapshot.sourcePausedForMs, null); assert.equal(snapshot.wsReceivePaused, false);
  assert.equal(snapshot.receivePausedForMs, null); assert.equal(snapshot.tcpPaused, false);
  let events = 0; proxy.on('state', () => events++);
  const before = { paused: socket.isPaused(), wsPaused: flow.ws.isPaused, timers: flow.timers.size };
  const serialized = JSON.stringify(proxy.diagnostics());
  assert.equal(events, 0); assert.deepEqual({ paused: socket.isPaused(), wsPaused: flow.ws.isPaused, timers: flow.timers.size }, before);
  for (const secret of ['secret-target', 'secret-token', 'private-session', proxy.username, proxy.password]) assert.equal(serialized.includes(secret), false);
  assert.ok(Object.values(flow.diagnostics).every((value) => value === socket || value === null || typeof value === 'number'));
});

test('flow diagnostics bounds active and closed projections, freezes closure values and expires history after 120 seconds', (t) => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const { proxy, addFlow } = fixture(t), flows = Array.from({ length: 130 }, () => addFlow());
  let snapshot = proxy.diagnostics();
  assert.equal(snapshot.activeCount, 130); assert.equal(snapshot.active.length, 128); assert.equal(snapshot.truncated, 2);
  assert.deepEqual(snapshot.active.map(({ flowId }) => flowId), Array.from({ length: 128 }, (_, index) => index + 1));
  flows[0].socket.emit('data', Buffer.alloc(64));
  flows[0].flow.close(false, 'https://must-not-escape.invalid/?token=private');
  flows[0].callbacks.shift()();
  const firstClosed = proxy.diagnostics().closed[0];
  assert.equal(firstClosed.closeReason, 'closed'); assert.equal(firstClosed.pendingDataFrames, 1);
  assert.equal(firstClosed.wsWriteCompletedBytes, 0, 'Completion after close must not rewrite the frozen summary');
  assert.equal(firstClosed.tcpDestroyed, false);
  for (const { flow } of flows.slice(1, 35)) flow.close();
  snapshot = proxy.diagnostics();
  assert.equal(snapshot.closed.length, 32); assert.equal(snapshot.closed[0].flowId, 4); assert.equal(snapshot.closed.at(-1).flowId, 35);
  snapshot.closed[0].sourceReadBytes = 12345;
  assert.equal(proxy.diagnostics().closed[0].sourceReadBytes, 0, 'Projection must not expose mutable history records');
  now += 119999; assert.equal(proxy.diagnostics().closed.length, 32);
  now++; assert.deepEqual(proxy.diagnostics().closed, []);
});

test('flow diagnostics omits handshakes and UDP and projects unsafe numbers or unsupported queues as null', (t) => {
  const { proxy, addFlow } = fixture(t), { flow, ws, socket } = addFlow();
  const pending = proxy.makeFlow(flow.peer, flow.connection, 'host', ws);
  assert.equal(proxy.diagnostics().activeCount, 1, 'A flow without a TCP source must not be observed');
  pending.close();
  flow.diagnostics.sourceReadBytes = NaN; flow.diagnostics.wsWriteCompletedBytes = Infinity;
  flow.diagnostics.pendingDataFrames = -1; flow.diagnostics.pendingDataBytes = Number.MAX_SAFE_INTEGER * 2;
  flow.diagnostics.lastDoneAt = performance.now() + 1000;
  Object.defineProperty(socket, 'writableLength', { value: -1 });
  ws.bufferedAmount = Infinity; ws._socket = undefined;
  const value = proxy.diagnostics().active[0];
  assert.equal(value.sourceReadBytes, null); assert.equal(value.wsWriteCompletedBytes, null); assert.equal(value.pendingDataFrames, null);
  assert.equal(value.pendingDataBytes, Number.MAX_SAFE_INTEGER); assert.equal(value.lastDoneAgoMs, 0);
  assert.equal(value.tcpWritableLength, null); assert.equal(value.wsBufferedAmount, null);
  assert.equal(value.wsSocketReadableLength, null); assert.equal(value.wsSocketWritableLength, null);
  assert.equal(value.wsSocketNeedDrain, null); assert.equal(value.wsSocketReadPaused, null);
  for (const field of Object.values(value)) if (typeof field === 'number') assert.ok(Number.isSafeInteger(field) && field >= 0);
  assert.equal(JSON.stringify(value).includes('Infinity'), false);
});
