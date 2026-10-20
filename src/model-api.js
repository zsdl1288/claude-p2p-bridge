import { randomUUID } from 'node:crypto';
import { ModelError, normalizeChatRequest, readDecision, modelUsage } from './model-protocol.js';
import { sendJson } from './http.js';

export function modelError(error) {
  const message = typeof error?.message === 'string' && error.message ? error.message : '模型桥接失败';
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : (/未连接|尚未连接/.test(message) ? 503 : /任务执行中/.test(message) ? 409 : 502);
  const code = typeof error?.code === 'string' && error.code ? error.code : (status === 503 ? 'peer_unavailable' : 'model_bridge_error');
  return { status, body: { error: { message, type: status < 500 ? 'invalid_request_error' : 'bridge_error', code } } };
}

// CLI structured output is validated before publishing a decision. SSE framing
// is OpenAI-compatible; the answer is buffered per step, not streamed tokenwise.
export async function serveModel(req, res, body, bridge, streams) {
  const request = normalizeChatRequest(body);
  const streaming = body.stream === true;
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  let completed = false;
  let timer;
  let result;
  let resolveRun;
  let rejectRun;
  const running = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
  // Admission can emit an error and then throw before execution reaches await.
  // Observe that rejection immediately; awaiting still preserves its failure.
  void running.catch(() => {});
  const fail = (error) => { rejectRun(error); };
  const onClose = () => { if (!completed) { controller.abort(); fail(new ModelError('调用端已断开', 499, 'request_cancelled')); } };
  res.once('close', onClose);
  if (res.destroyed) { res.off('close', onClose); return; }
  const frame = (data) => {
    if (res.destroyed) throw new ModelError('调用端已断开', 499, 'request_cancelled');
    const ok = res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    if (!ok && res.writableLength > 2 * 1024 * 1024) throw new ModelError('模型响应接收过慢', 499, 'slow_consumer');
  };
  try {
    await bridge.getModels();
    const requestId = bridge.run(request, (event) => {
      if (completed) return;
      if (event.type === 'error') fail(new ModelError(event.message || 'B 模型请求失败', event.code === 'PEER_DISCONNECTED' ? 503 : event.code === 'CANCEL_TIMEOUT' ? 499 : 502, event.code || 'model_process_error'));
      else if (event.type === 'claude' && event.event?.type === 'result') result = event.event;
      else if (event.type === 'done') {
        if (event.cancelled) fail(new ModelError('模型请求已取消', 499, 'request_cancelled'));
        else if (event.exitCode !== 0) fail(new ModelError('B 的 Claude Code 运行失败，请检查登录状态、CLI 版本及错误日志', 502, 'model_process_error'));
        else resolveRun();
      }
    }, controller.signal);
    streams.add(res);
    if (streaming) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Request-ID': requestId, 'X-Bridge-Output': 'buffered-structured-decision' });
      res.flushHeaders();
      timer = setInterval(() => { if (!res.destroyed) res.write(': bridge-waiting\n\n'); }, 15000);
    }
    await running;
    const message = readDecision(result, request);
    const finish_reason = message.tool_calls?.length ? 'tool_calls' : 'stop';
    const usage = modelUsage(result);
    if (streaming) {
      const chunk = (delta, reason = null) => ({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta, finish_reason: reason }] });
      frame(chunk({ role: 'assistant' }));
      if (message.content) frame(chunk({ content: message.content }));
      if (message.tool_calls) frame(chunk({ tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }));
      frame(chunk({}, finish_reason));
      if (body.stream_options?.include_usage) frame({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [], usage });
      frame('[DONE]');
      completed = true;
      res.end();
    } else {
      const response = { id, object: 'chat.completion', created, model: request.model, choices: [{ index: 0, message, finish_reason }], usage };
      completed = true;
      sendJson(res, 200, response, { 'X-Request-ID': requestId, 'X-Bridge-Output': 'buffered-structured-decision' });
    }
  } catch (error) {
    controller.abort();
    completed = true;
    if (!res.destroyed) {
      const failure = modelError(error);
      if (res.headersSent) { try { frame(failure.body); } catch {} res.end(); }
      else sendJson(res, failure.status, failure.body);
    }
  } finally {
    clearInterval(timer);
    streams.delete(res);
    res.off('close', onClose);
  }
}
