import { ApplicationBridge } from '../src/application-bridge.js';
import { validateSavedPairing } from '../src/pairing-store.js';
import { createLocalServer, getApiToken } from '../src/server.js';
import path from 'node:path';
function demoBridge() {
  const store = {
    record: null,
    async load() { return this.record; },
    async save(value) { this.record = validateSavedPairing(value, true); return this.record; },
    async clear() { this.record = null; }
  };
  return new ApplicationBridge({ demo: true, store });
}
const host = demoBridge(), client = demoBridge();
const portA = Number(process.env.DEMO_A_PORT || 3210);
const portB = Number(process.env.DEMO_B_PORT || 3212);
let stopping = false;
const appA = createLocalServer({ port: portA, token: await getApiToken(path.resolve('.bridge/demo-a')), bridge: client, onShutdown: shutdown });
const appB = createLocalServer({ port: portB, token: await getApiToken(path.resolve('.bridge/demo-b')), bridge: host, onShutdown: shutdown });
const cleanup = async () => { await Promise.allSettled([appA.close(), appB.close()]); };
try {
  await appB.listen();
  await appA.listen();
  await host.selectIdentity({ role: 'host' }); await host.loginNetwork();
  await client.selectIdentity({ role: 'client' }); await client.loginNetwork();
  const status = await host.host({ tailscaleIp: '127.0.0.1', bridgePort: 0 });
  await host.configureModel({ enabled: true, workspace: process.cwd(), profile: 'read' });
  await client.join({ invitation: status.invitation });
  console.log(`\nTailscale 组网版演示已启动：通过本机模拟两端，不调用真实 Claude。\nA / 本地 API：http://127.0.0.1:${portA}\nB / 控制台：http://127.0.0.1:${portB}\n两端已自动配对，无需公网中转。此演示不代表已接通真实 Tailscale 网络。\nAPI Token：.bridge/demo-a/api-token\nCtrl+C 停止全部服务。\n`);
} catch (error) { console.error(error.message); await cleanup(); process.exit(1); }
async function shutdown() { if (stopping) return; stopping = true; await cleanup(); process.exit(0); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
