import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() && !['node_modules', '__pycache__'].includes(entry.name) ? javascriptFiles(file) : entry.isFile() && /\.m?js$/.test(entry.name) ? [file] : [];
  });
}
const files = ['src', 'public', 'scripts', 'test'].flatMap(javascriptFiles).sort();
for (const file of files) { const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true, timeout: 30000 }); if (result.error) console.error(`${file}: ${result.error.message}`); if (result.status !== 0) process.exit(1); }
console.log(`Syntax checked ${files.length} JavaScript files.`);
