// Deterministic fake CLI for transport tests. Never calls a model or spends credits.
import { randomUUID } from 'node:crypto';
if (process.argv.includes('--version')) { console.log('bridge-demo 1.0'); process.exit(0); }
let prompt = '';
for await (const part of process.stdin) prompt += part;
const resume = process.argv.indexOf('--resume');
const sessionId = resume > -1 ? process.argv[resume + 1] : randomUUID();
const write = (event) => console.log(JSON.stringify({ ...event, session_id: sessionId }));
write({ type: 'system', subtype: 'init', model: 'bridge-demo' });
if (process.argv.includes('--json-schema')) {
  const { request } = JSON.parse(prompt);
  const last = request.messages.at(-1);
  const content = Array.isArray(last.content) ? last.content.map((part) => part.text).join('') : last.content || '';
  const forced = typeof request.tool_choice === 'object' ? request.tool_choice.function.name : null;
  const tool = request.tools.find((item) => !forced || item.function.name === forced);
  const call = tool && request.tool_choice !== 'none' && last.role !== 'tool' && (forced || request.tool_choice === 'required' || content.includes('[tool]'));
  const args = {};
  for (const [name, schema] of Object.entries(tool?.function.parameters.properties || {})) args[name] = schema.type === 'number' || schema.type === 'integer' ? 0 : schema.type === 'boolean' ? false : schema.type === 'array' ? [] : schema.type === 'object' ? {} : 'demo';
  const decision = call ? { content: '', tool_calls: [{ name: tool.function.name, arguments: JSON.stringify(args) }] }
    : { content: `【模型演示】${last.role === 'tool' ? 'A 端工具结果：' : 'B 端收到：'}${content}`, tool_calls: [] };
  if (content.includes('[slow]')) await new Promise((resolve) => setTimeout(resolve, 30000));
  write({ type: 'result', subtype: 'success', is_error: false, structured_output: decision, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 });
  process.exit(0);
}
const text = `【演示模式】B 端已收到请求：${prompt}\n配对、加密传输和流式 API 已连通。这是模拟回复，尚未调用 Claude。`;
for (const piece of text.match(/.{1,12}|\n/gu) || []) {
  await new Promise((resolve) => setTimeout(resolve, prompt.includes('[slow]') ? 1000 : 15));
  write({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
}
write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
write({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0 });
