import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeNewJson, updateJson } from '../src/io.js';

const cli = resolve('dist/src/cli.js');
test('CLI help and invalid input return useful statuses', () => {
  const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help, /batch prepare/);
  const invalid = spawnSync(process.execPath, [cli, 'batch', 'prepare'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /缺少/);
});

test('output files never overwrite existing evidence; journal update preserves valid JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codesys-ai-test-'));
  const path = join(dir, '记录.json');
  await writeNewJson(path, { value: '原始' });
  await assert.rejects(writeNewJson(path, { value: 'overwrite' }), /EEXIST/);
  await updateJson(path, input => ({ ...(input as object), next: true }));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).value, '原始');
  await writeFile(path + '.lock', 'existing lock');
  await assert.rejects(updateJson(path, () => ({})), /锁文件/);
});
