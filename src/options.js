import path from 'node:path';
import { parseArgs } from 'node:util';

export function parseOptions(args, env = process.env, cwd = process.cwd()) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    port: { type: 'string', default: env.BRIDGE_PORT || '3210' },
    'data-dir': { type: 'string', default: '.bridge' },
    demo: { type: 'boolean', default: false },
    'system-tailscale': { type: 'boolean', default: false },
    version: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  } });
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API 端口必须为 1–65535');
  if (!values['data-dir'].trim()) throw new Error('数据目录不能为空');
  return { port, directory: path.resolve(cwd, values['data-dir']), demo: values.demo, systemTailscale: values['system-tailscale'], version: values.version, help: values.help };
}
