import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from './bridge.js';
import { randomId, equalSecret } from './crypto.js';
import { version } from './version.js';
import { modelInputLimit } from './model-protocol.js';
import { serveModel, modelError } from './model-api.js';
import { serveTask } from './task-api.js';
import { sendJson as json, readJsonObject as readBody } from './http.js';
import { ClashProxy } from './clash-proxy.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/ui-state.js': ['ui-state.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/licenses': ['licenses.txt', 'text/plain; charset=utf-8'] };
const modelPaths = new Set(['/v1/chat/completions', '/v1/models', '/v1/responses', '/v1/messages']);
const tokenLoads = new Map();
export function getApiToken(directory) {
  const resolved = path.resolve(directory);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  if (!tokenLoads.has(key)) {
    const loading = loadApiToken(resolved).finally(() => { if (tokenLoads.get(key) === loading) tokenLoads.delete(key); });
    tokenLoads.set(key, loading);
  }
  return tokenLoads.get(key);
}
async function loadApiToken(directory) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'api-token');
  try {
    for (let attempt = 0; ; attempt++) {
      const token = (await readFile(file, 'utf8')).trim();
      if (/^[\w-]{43}$/.test(token)) return token;
      // Another process can see an exclusively created file before its small
      // write completes. Retry only plausible partial credentials, bounded to
      // 500 ms; never replace existing data, even when it remains invalid.
      if (attempt >= 20 || token.length >= 43 || !/^[\w-]*$/.test(token)) throw new Error(`API Token 文件无效，请关闭客户端，删除 ${file} 后重新启动`);
      await delay(25);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomId(32);
    try { await writeFile(file, token, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') return loadApiToken(directory); throw error; }
    return token;
  }
}

export function createLocalServer({ port = 3210, controlPort = port === 0 ? 0 : port === 65535 ? 65534 : port + 1, token, bridge = new Bridge(), workspace = process.cwd(), directory = null, onShutdown } = {}) {
  if (!token) throw new Error('API Token 必须设置');
  const streams = new Set();
  const modelStreams = new Set();
  let modelEnabled = false, modelErrorText = '', modelPort = port;
  let modelTransition = Promise.resolve();
  let controlBusy = false;
  let stopping = false;
  let ready = false;
  let closing;
  let finishInitializing;
  const initialized = new Promise((resolve) => { finishInitializing = resolve; });
  const proxy = bridge.networkProxy ? new ClashProxy({ bridge, token, directory }) : null;
  const modelApiStatus = () => ({ enabled: modelEnabled, listening: modelEnabled && modelServer.listening,
    port: modelPort, baseUrl: `http://127.0.0.1:${modelPort}/v1`, error: modelErrorText });
  const status = () => ({ ...bridge.status(), modelApi: modelApiStatus(), ...(proxy ? { proxy: proxy.status() } : {}) });
  const actionStatus = (result) => result?.identity ? status() : result;
  const canListen = () => {
    const state = bridge.status();
    return state.role === 'client' && (!state.capabilities || state.capabilities.model === true);
  };
  const modelChanged = () => bridge.emit?.('state');
  const configureModelApi = (enabled) => {
    const operation = modelTransition.then(async () => {
      if (enabled) {
        if (stopping) throw new Error('客户端正在退出');
        if (!canListen()) throw Object.assign(new Error('请先在 A 调用端完成设备配对，再开启本机模型 API'), { status: 409 });
        if (modelEnabled && modelServer.listening) return status();
        try { await listen(modelServer, port); }
        catch (error) {
          modelErrorText = error.code === 'EADDRINUSE' ? `模型 API 端口 ${port} 已被占用，请关闭占用程序后重试` : `模型 API 启动失败：${error.message}`;
          modelChanged();
          throw Object.assign(new Error(modelErrorText), { status: 409 });
        }
        modelPort = modelServer.address().port;
        modelEnabled = true; modelErrorText = ''; modelChanged();
      } else {
        modelEnabled = false; modelErrorText = '';
        // Include browser test responses on the management connection, without
        // closing that listener or cancelling unrelated proxy/task traffic.
        for (const res of modelStreams) res.destroy();
        modelServer.closeAllConnections();
        await closeListener(modelServer);
        modelChanged();
      }
      return status();
    });
    modelTransition = operation.catch(() => {});
    return operation;
  };
  const onBridgeState = () => {
    if (modelEnabled && !canListen()) void configureModelApi(false).catch(() => {});
  };
  const handle = (modelListener) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let modelRequest = modelPaths.has((req.url || '').split('?')[0]);
    const reject = (status, message, code) => {
      const error = modelRequest ? modelError({ status, message, code }).body : { error: message };
      if (modelRequest && status === 401) error.error.type = 'authentication_error';
      json(res, status, error);
    };
    const address = (modelListener ? modelServer : server).address();
    if (stopping || !address) return reject(503, '客户端正在退出', 'server_stopping');
    const hosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
    if (!hosts.includes(req.headers.host) || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') return reject(403, '仅接受本机同源请求', 'forbidden_origin');
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); } catch { return reject(400, 'URL 无效', 'invalid_request_error'); }
    modelRequest = modelPaths.has(url.pathname);
    try {
      const modelCancel = req.method === 'POST' && /^\/v1\/requests\/[a-f0-9-]{36}\/cancel$/i.test(url.pathname);
      if (modelListener && (!modelRequest && !modelCancel)) return reject(404, '接口不存在', 'not_found');
      if (modelListener && (!modelEnabled || !canListen())) return reject(503, '本机模型 API 未开启或设备授权已失效', 'model_api_disabled');
      if (!modelListener && modelRequest) return reject(404, '请使用模型 API 页的 Base URL，并先开启本机模型 API', 'not_found');
      if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        const [file, type] = assets[url.pathname];
        const content = await readFile(path.join(publicDir, file));
        res.writeHead(200, { 'Content-Type': type });
        res.end(content);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') return json(res, ready ? 200 : 503, { ok: ready, service: 'claude-p2p-bridge', version, parentPid: process.ppid });
      // Keep authenticated shutdown available while preferences
      // are loading. Other APIs must not race restoration and overwrite it.
      if (req.method === 'POST' && url.pathname === '/api/shutdown' && onShutdown) {
        if (!equalSecret(req.headers.authorization, `Bearer ${token}`)) return reject(401, '需要有效的 Authorization: Bearer <API_TOKEN>', 'invalid_api_key');
        await readBody(req); json(res, 200, { stopping: true }); setImmediate(onShutdown); return;
      }
      await initialized;
      if (stopping || !ready) return reject(503, '客户端尚未就绪或正在退出', 'server_stopping');
      if (req.method === 'GET' && url.pathname === '/api/bootstrap' && req.headers['x-bridge-ui'] === '1') return json(res, 200, { token, workspace, version, api: `http://127.0.0.1:${modelPort}` });
      const subscription = url.pathname.match(/^\/clash\/([\w-]{43})\/(config|nodes)\.yaml$/);
      if (url.pathname.startsWith('/clash/')) {
        if (req.method !== 'GET' || !subscription) return reject(404, '订阅不存在', 'not_found');
        if (!proxy || !equalSecret(subscription[1], proxy.subscriptionToken)) return reject(401, '订阅凭据无效');
        const content = proxy.profile(subscription[2] === 'nodes');
        res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Content-Disposition': 'inline; filename="ClaudeBridge-Clash.yaml"', 'Profile-Update-Interval': '12' });
        res.end(content); return;
      }
      if (!equalSecret(req.headers.authorization, `Bearer ${token}`)) return reject(401, '需要有效的 Authorization: Bearer <API_TOKEN>', 'invalid_api_key');
      if (req.method === 'POST' && url.pathname === '/api/model-api') {
        const body = await readBody(req);
        if (Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') throw new Error('模型 API 开关必须为 enabled: true 或 false');
        return json(res, 200, await configureModelApi(body.enabled));
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const models = await bridge.getModels();
        return json(res, 200, { object: 'list', data: models.map(({ id, name, description, resolvedModel }) => ({ id, object: 'model', created: 0, owned_by: 'claude-code-bridge', name, description, ...(resolvedModel ? { resolved_model: resolvedModel } : {}) })) });
      }
      if (req.method === 'POST' && url.pathname === '/api/models/refresh') {
        const body = await readBody(req);
        if (Object.keys(body).length) throw new Error('刷新模型列表无需额外参数');
        await bridge.refreshModels();
        return json(res, 200, status());
      }
      if (req.method === 'POST' && ['/v1/responses', '/v1/messages'].includes(url.pathname)) return json(res, 400, { error: { message: '请选择 OpenAI Chat Completions 协议；当前仅提供 /v1/chat/completions', type: 'invalid_request_error', code: 'unsupported_protocol' } });
      if (req.method === 'POST' && ['/v1/chat/completions', '/api/model-test'].includes(url.pathname)) {
        if (!modelEnabled || !modelServer.listening || !canListen()) return json(res, 503, modelError({ status: 503, message: '请先开启本机模型 API', code: 'model_api_disabled' }).body);
        // Track browser tests before reading their body, so stopping the API
        // also closes a slow upload and it cannot resume after a later start.
        modelStreams.add(res);
        try {
          const body = await readBody(req, modelInputLimit);
          if (res.destroyed) return;
          if (!modelEnabled || !modelServer.listening || !canListen()) return json(res, 503, modelError({ status: 503, message: '请先开启本机模型 API', code: 'model_api_disabled' }).body);
          await serveModel(req, res, body, bridge, modelStreams);
        } finally { modelStreams.delete(res); }
        return;
      }
      if (req.method === 'GET' && ['/api/status', '/v1/status'].includes(url.pathname)) return json(res, 200, status());
      if (proxy && req.method === 'GET' && url.pathname === '/api/proxy') return json(res, 200, proxy.status());
      if (proxy && req.method === 'POST' && url.pathname === '/api/proxy') return json(res, 200, await proxy.configure(await readBody(req)));
      if (req.method === 'GET' && url.pathname === '/api/tailscale') return json(res, 200, await bridge.networkInfo(true));
      if (req.method === 'POST' && url.pathname === '/api/network/login') { await readBody(req); return json(res, 200, actionStatus(await bridge.loginNetwork())); }
      if (req.method === 'POST' && url.pathname === '/api/network/disconnect') {
        await readBody(req);
        if (!bridge.disconnectNetwork) throw new Error('当前模式不支持断开私有网络');
        return json(res, 200, actionStatus(await bridge.disconnectNetwork()));
      }
      if (req.method === 'POST' && url.pathname === '/api/identity') {
        if (!bridge.selectIdentity) throw new Error('当前模式不支持身份管理');
        return json(res, 200, actionStatus(await bridge.selectIdentity(await readBody(req))));
      }
      if (req.method === 'GET' && url.pathname === '/api/model') return json(res, 200, bridge.status().model || {});
      if (req.method === 'POST' && url.pathname === '/api/model') {
        if (!bridge.configureModel) throw new Error('当前模式不支持模型服务配置');
        return json(res, 200, actionStatus(await bridge.configureModel(await readBody(req))));
      }
      if (req.method === 'POST' && url.pathname === '/api/probe') { const body = await readBody(req); return json(res, 200, await bridge.probe(body.claudeCommand)); }
      if (req.method === 'POST' && ['/api/host', '/api/join', '/api/disconnect', '/api/pause', '/api/reconnect'].includes(url.pathname)) {
        if (controlBusy) return json(res, 409, { error: '正在处理配对设置，请稍候' });
        controlBusy = true;
        try {
          const body = await readBody(req);
          if (url.pathname === '/api/host') return json(res, 200, actionStatus(await bridge.host(body)));
          if (url.pathname === '/api/join') return json(res, 200, actionStatus(await bridge.join(body)));
          if (url.pathname === '/api/pause') { if (!bridge.pause) throw new Error('当前模式不支持保存配对'); return json(res, 200, actionStatus(await bridge.pause())); }
          if (url.pathname === '/api/reconnect') { if (!bridge.resume) throw new Error('当前模式不支持保存配对'); return json(res, 200, actionStatus(await bridge.resume())); }
          await bridge.disconnect();
          return json(res, 200, status());
        } finally { controlBusy = false; }
      }
      if (req.method === 'POST' && url.pathname === '/v1/run') {
        await serveTask(res, await readBody(req), bridge, streams);
        return;
      }
      const cancelMatch = url.pathname.match(/^\/v1\/requests\/([a-f0-9-]{36})\/cancel$/i);
      if (req.method === 'POST' && cancelMatch) return json(res, bridge.cancel(cancelMatch[1]) ? 202 : 404, { requestId: cancelMatch[1] });
      return reject(404, '接口不存在', 'not_found');
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) res.end();
      else if (modelRequest) { const failure = modelError(error); json(res, failure.status, failure.body); }
      else reject(Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : (/未连接|尚未连接/.test(error.message) ? 503 : /任务执行中/.test(error.message) ? 409 : 400), error.message, error.code);
    }
  };
  const server = http.createServer(handle(false));
  const modelServer = http.createServer(handle(true));
  bridge.on?.('state', onBridgeState);
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  modelServer.requestTimeout = 30000;
  modelServer.headersTimeout = 15000;
  return {
    server, modelServer, bridge, proxy,
    async listen() {
      if (stopping) throw new Error('客户端正在退出');
      await listen(server, controlPort);
      try {
        await proxy?.start(server.address());
        if (stopping) throw new Error('客户端正在退出');
        ready = true;
      }
      catch (error) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); throw error; }
      finally { finishInitializing(); }
      return server.address();
    },
    close() {
      if (!closing) {
        stopping = true;
        ready = false; finishInitializing();
        bridge.off?.('state', onBridgeState);
        for (const res of streams) res.destroy();
        streams.clear();
        server.closeAllConnections();
        closing = (async () => {
          await configureModelApi(false);
          try { if (bridge.close) await bridge.close(); else await bridge.disconnect(); }
          finally {
            try { await proxy?.close(); }
            finally {
              server.closeAllConnections();
              await new Promise((resolve, reject) => server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
            }
          }
        })();
      }
      return closing;
    }
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { server.off('error', onError); server.off('listening', onListen); server.off('close', onClose); };
    const onError = (error) => { cleanup(); reject(error); };
    const onListen = () => { cleanup(); resolve(); };
    const onClose = () => onError(new Error('客户端在完成监听前已退出'));
    server.once('error', onError); server.once('listening', onListen); server.once('close', onClose);
    try { server.listen(port, '127.0.0.1'); } catch (error) { onError(error); }
  });
}

function closeListener(server) {
  return new Promise((resolve, reject) => server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
}
