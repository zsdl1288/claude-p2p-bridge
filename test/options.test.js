import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseOptions } from '../src/options.js';

test('source CLI rejects missing, mistyped and invalid arguments before writing data', () => {
  for (const args of [['--data-dir'], ['--data-dir', '--demo'], ['--port'], ['--prot', '3210'], ['--port', '0'], ['--port', '65536'], ['--port', '3210junk'], ['--data-dir', ''], ['unexpected']]) {
    assert.throws(() => parseOptions(args, {}), undefined, args.join(' '));
  }
  assert.throws(() => parseOptions([], { BRIDGE_PORT: 'invalid' }));
});

test('source CLI preserves explicit flags and resolves the private data directory', () => {
  const cwd = path.resolve('test');
  const options = parseOptions(['--port', '3213', '--data-dir', 'client data', '--demo'], { BRIDGE_PORT: '1234' }, cwd);
  assert.equal(options.port, 3213);
  assert.equal(options.directory, path.join(cwd, 'client data'));
  assert.equal(options.demo, true);
  assert.equal(options.systemTailscale, false);
});
