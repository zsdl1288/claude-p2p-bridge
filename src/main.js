import path from 'node:path';
import { ApplicationBridge } from './application-bridge.js';
import { PairingStore } from './pairing-store.js';
import { createLocalServer, getApiToken } from './server.js';
import { EmbeddedNetwork } from './embedded-network.js';
import { parseOptions } from './options.js';
import { version } from './version.js';

let options;
try { options = parseOptions(process.argv.slice(2)); }
catch (error) { console.error(`启动参数无效：${error.message}`); process.exit(1); }
if (options.version) { console.log(`Claude Bridge ${version}`); process.exit(0); }
if (options.help) { console.log('node src/main.js [--port 3210] [--data-dir PATH] [--demo] [--system-tailscale] [--version]'); process.exit(0); }
const { port, directory, demo } = options;
const token = process.env.BRIDGE_API_TOKEN || await getApiToken(directory);
const core = new EmbeddedNetwork({ directory });
const network = !demo && !options.systemTailscale ? core : null;
const store = new PairingStore({ directory, protector: core, demo });
const bridge = new ApplicationBridge({ store, directory, demo, proxyOptions: { diagnosticsEnabled: process.env.BRIDGE_FLOW_DIAGNOSTICS === '1' },
  ...(network ? { networkProvider: () => network.status(), networkAdapter: network } : {}) });
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log('正在退出客户端，保存的配对将保留');
  let failed = false;
  try { await app.close(); console.log('桥接服务已停止'); }
  catch (error) { failed = true; console.error(`停止桥接失败：${error.message}`); }
  try { await core.close(); console.log('组网核心已关闭'); }
  catch (error) { failed = true; console.error(`停止组网失败：${error.message}`); }
  process.exit(failed ? 1 : 0);
};
const app = createLocalServer({ port, token, bridge, directory, onShutdown: shutdown });
try {
  const address = await app.listen();
  bridge.start().catch((error) => console.error(`恢复配对失败：${error.message}`));
  const tokenLocation = process.env.BRIDGE_API_TOKEN ? '使用 BRIDGE_API_TOKEN 环境变量' : path.join(directory, 'api-token');
  console.log(`\nClaude Bridge · 内置组网版 v${version}\n控制台: http://127.0.0.1:${address.port}\n模型 API: http://127.0.0.1:${port}/v1（默认关闭，在 A 的模型 API 页开启后监听）\nAPI Token: ${tokenLocation}\n模式: ${bridge.demo ? '演示（模拟 Claude，不产生模型费用）' : '真实 Claude Code'}\n\n${network ? '在控制台点击「连接私有网络」，完成账号登录。无需另装 Tailscale。' : demo ? '本机演示，不连接真实私有网络。' : '兼容模式：在系统 Tailscale 客户端中登录。'}\n在 B 端创建配对，多个 A 输入同一配对码后即可各自使用本地 API。关闭浏览器可继续运行；点击「退出客户端」停止。\n`);
} catch (error) { if (!stopping) { console.error(`启动失败：${error.message}`); process.exit(1); } }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
