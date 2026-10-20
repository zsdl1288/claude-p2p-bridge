import { validateRequest } from './runner.js';
import { sendJson } from './http.js';

// This endpoint runs a task in B's workspace. Model decisions use the separate
// chat endpoint, so their structured results cannot become empty task success.
export async function serveTask(res, body, bridge, streams) {
  if (body.kind !== undefined && body.kind !== 'task') throw new Error('/v1/run 仅接受 B 端任务；模型请求请使用 /v1/chat/completions');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new Error('stream 必须是布尔值');
  const request = validateRequest(body);
  const controller = new AbortController();
  let done = false;
  let ready = false;
  let timer;
  let id;
  let result;
  let sessionId;
  const errors = [];
  const earlyEvents = [];
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const onClose = () => { if (!done) controller.abort(); finish(); };
  res.once('close', onClose);
  if (res.destroyed) { res.off('close', onClose); return; }
  const streaming = body.stream !== false;
  const consume = (event) => {
    if (res.destroyed || done) return;
    if (!ready) { earlyEvents.push(event); return; }
    if (streaming) {
      const ok = res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (!ok && res.writableLength > 2 * 1024 * 1024) { controller.abort(); res.destroy(); return; }
    } else {
      if (event.type === 'claude' && event.event) {
        sessionId = event.event.session_id || sessionId;
        if (event.event.type === 'result') result = event.event;
      }
      if (event.type === 'error') errors.push(event);
    }
    if (event.type === 'done') {
      done = true;
      clearInterval(timer);
      if (streaming) res.end();
      else {
        if (!result && !errors.length && !event.cancelled) errors.push({ type: 'error', code: 'CLAUDE_NO_RESULT', message: 'B 未返回任务结果' });
        sendJson(res, 200, { requestId: id, success: Boolean(result) && event.exitCode === 0 && !result.is_error && !errors.length && !event.cancelled, sessionId, result, errors, exitCode: event.exitCode, cancelled: event.cancelled });
      }
      finish();
    }
  };
  try {
    id = bridge.run(request, consume, controller.signal);
    streams.add(res);
    if (streaming) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Request-ID': id });
      res.flushHeaders();
      timer = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
    }
    ready = true;
    for (const event of earlyEvents) consume(event);
    await finished;
  } finally {
    if (!done) controller.abort();
    clearInterval(timer);
    streams.delete(res);
    res.off('close', onClose);
  }
}
