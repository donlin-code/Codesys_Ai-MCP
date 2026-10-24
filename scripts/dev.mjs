import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] ?? 'test';
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!['build', 'test'].includes(command)) throw new Error('Use build or test');
run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
if (command === 'test') {
  run(['--test', 'dist/tests/*.test.js']);
  if (!process.argv.includes('--core')) {
    run(['scripts/prepare-examples.mjs', '--check']);
    run(['examples/tests/entry-scan.mjs']);
  }
}
