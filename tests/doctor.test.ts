import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { doctor, readExecutableVersion } from '../src/doctor.js';

/** A data-only PE fixture with an RT_VERSION resource; never an executable program. */
function versionedPe(version: [number, number, number, number], pe64 = false): Buffer {
  const data = Buffer.alloc(1024);
  data.writeUInt16LE(0x5a4d, 0);
  data.writeUInt32LE(0x80, 0x3c);
  data.writeUInt32LE(0x4550, 0x80);
  data.writeUInt16LE(1, 0x86);
  data.writeUInt16LE(pe64 ? 240 : 224, 0x94);
  const optional = 0x98;
  data.writeUInt16LE(pe64 ? 0x20b : 0x10b, optional);
  const directories = optional + (pe64 ? 112 : 96);
  data.writeUInt32LE(16, directories - 4);
  data.writeUInt32LE(0x1000, directories + 16);
  data.writeUInt32LE(0x200, directories + 20);
  const section = optional + (pe64 ? 240 : 224);
  data.writeUInt32LE(0x1000, section + 12);
  data.writeUInt32LE(0x200, section + 16);
  data.writeUInt32LE(0x200, section + 20);
  for (const relative of [0, 0x18, 0x30]) data.writeUInt16LE(1, 0x200 + relative + 14);
  data.writeUInt32LE(16, 0x210);
  data.writeUInt32LE(0x80000018, 0x214);
  data.writeUInt32LE(1, 0x228);
  data.writeUInt32LE(0x80000030, 0x22c);
  data.writeUInt32LE(1033, 0x240);
  data.writeUInt32LE(0x48, 0x244);
  data.writeUInt32LE(0x1100, 0x248);
  data.writeUInt32LE(92, 0x24c);
  data.writeUInt16LE(92, 0x300);
  data.writeUInt16LE(52, 0x302);
  Buffer.from('VS_VERSION_INFO\0', 'utf16le').copy(data, 0x306);
  data.writeUInt32LE(0xfeef04bd, 0x328);
  data.writeUInt32LE(version[0] * 65536 + version[1], 0x330);
  data.writeUInt32LE(version[2] * 65536 + version[3], 0x334);
  return data;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codesys doctor '));
  const ide = path.join(root, 'CODESYS');
  await mkdir(path.join(ide, 'Common'), { recursive: true });
  await mkdir(path.join(ide, 'Profiles'));
  await writeFile(path.join(ide, 'Common', 'CODESYS.exe'), versionedPe([3, 5, 22, 30]));
  await writeFile(path.join(ide, 'Profiles', 'CODESYS V3.5 SP22 Patch 3.profile.xml'), '<Profile/>');
  return { root, ide };
}

async function addBridge(ide: string, version: string) {
  const bridge = path.join(ide, 'CODESYS MCP Server', version, 'CodesysMCPBridge', 'CodesysMCPBridge.exe');
  await mkdir(path.dirname(bridge), { recursive: true });
  await writeFile(bridge, versionedPe([1, 1, 0, 0], true));
  return bridge;
}

test('missing add-on is reported without pretending to connect', async () => {
  const { root } = await fixture();
  try {
    const result = await doctor({ ideRoot: root });
    assert.equal(result.ready, false);
    assert.deepEqual(result.bridgeCandidates, []);
    assert.equal(result.connectionVerified, false);
    assert.equal(result.checks.find(check => check.id === 'license')?.status, 'unknown');
    assert.equal(result.checks.find(check => check.id === 'connection')?.status, 'unknown');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('accepts installation root or CODESYS directory and discovers the versioned Bridge', async () => {
  const { root, ide } = await fixture();
  try {
    const bridge = await addBridge(ide, '1.1.0.0');
    for (const ideRoot of [root, ide]) {
      const result = await doctor({ ideRoot });
      assert.equal(result.selectedBridge, bridge);
      assert.equal(result.ideVersion, '3.5.22.30');
      assert.equal(result.bridgeVersion, '1.1.0.0');
      assert.equal(result.checks.find(check => check.id === 'bridge-installation')?.status, 'pass');
      assert.equal(result.ready, process.platform === 'win32' && Number(process.versions.node.split('.')[0]) >= 22);
      assert.equal(result.scope, 'filesystem-prerequisites');
      assert.equal(result.connectionVerified, false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reads PE32/PE32+ versions and rejects spoofed or malformed executable data', async () => {
  const { root, ide } = await fixture();
  try {
    const executable = path.join(ide, 'Common', 'CODESYS.exe');
    await writeFile(executable, versionedPe([3, 5, 20, 60], true));
    const mismatch = await doctor({ ideRoot: root });
    assert.equal(mismatch.ideVersion, '3.5.20.60');
    assert.equal(mismatch.checks.find(check => check.id === 'ide-version')?.status, 'fail');
    assert.equal(mismatch.ready, false);
    await writeFile(executable, 'fake CODESYS.exe version 3.5.22.30');
    assert.equal(await readExecutableVersion(executable), null);
    const corrupt = versionedPe([3, 5, 22, 30]);
    corrupt.writeUInt32LE(0xfffffff0, 0x3c);
    await writeFile(executable, corrupt);
    assert.equal(await readExecutableVersion(executable), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('multiple installed versions require an explicit path from the IDE', async () => {
  const { root, ide } = await fixture();
  try {
    await addBridge(ide, '1.0.0.0');
    const bridge = await addBridge(ide, '1.1.0.0');
    const ambiguous = await doctor({ ideRoot: root });
    assert.equal(ambiguous.bridgeCandidates.length, 2);
    assert.equal(ambiguous.selectedBridge, null);
    assert.equal(ambiguous.ready, false);
    assert.equal((await doctor({ ideRoot: root, bridge })).selectedBridge, bridge);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects a real Bridge from another installation and an invalid explicit path', async () => {
  const { root, ide } = await fixture();
  try {
    const foreign = await addBridge(path.join(root, 'OtherInstallation'), '1.1.0.0');
    const result = await doctor({ ideRoot: ide, bridge: foreign });
    assert.equal(result.ready, false);
    assert.equal(result.checks.find(check => check.id === 'bridge-installation')?.status, 'fail');
    const absent = await doctor({ ideRoot: root, bridge: path.join(ide, 'absent.exe') });
    assert.equal(absent.checks.find(check => check.id === 'bridge')?.status, 'fail');
  } finally { await rm(root, { recursive: true, force: true }); }
});

function configure(args: string[]) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.resolve('scripts/Configure-CodesysMcp.ps1'), ...args,
  ], { encoding: 'utf8' });
}

test('configuration refuses an existing server name without calling add', { skip: process.platform !== 'win32' }, async () => {
  const { root, ide } = await fixture();
  try {
    const bridge = await addBridge(ide, '1.1.0.0');
    const codex = path.join(root, 'mock codex.ps1');
    await writeFile(codex, `if ($args[0] -eq 'mcp' -and $args[1] -eq 'list') { '[{"name":"codesys-sp22"}]'; exit 0 }; throw 'Unexpected mutation attempted'`);
    const result = configure(['-Bridge', bridge, '-IdeRoot', root, '-RegisterCodex', '-CodexPath', codex]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already exists/);
    assert.doesNotMatch(result.stderr, /Unexpected mutation attempted/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('registration passes the Bridge as one argument and only adds the requested server', { skip: process.platform !== 'win32' }, async () => {
  const { root, ide } = await fixture();
  try {
    const bridge = await addBridge(ide, '1.1.0.0');
    const codex = path.join(root, 'mock codex.ps1');
    const log = path.join(root, 'codex-invocation.json');
    await writeFile(codex, `if ($args[0] -eq 'mcp' -and $args[1] -eq 'list') { '[]'; exit 0 }; $args | ConvertTo-Json | Set-Content -LiteralPath '${log.replaceAll("'", "''")}' -Encoding UTF8; exit 0`);
    const result = configure(['-Bridge', bridge, '-IdeRoot', root, '-RegisterCodex', '-CodexPath', codex]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse((await readFile(log, 'utf8')).replace(/^\uFEFF/, '')), ['mcp', 'add', 'codesys-sp22', '--', bridge]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configuration rejects a missing Bridge before invoking a client', { skip: process.platform !== 'win32' }, async () => {
  const { root } = await fixture();
  try {
    const result = configure(['-Bridge', path.join(root, 'missing.exe'), '-IdeRoot', root, '-RegisterCodex', '-CodexPath', path.join(root, 'must-not-run.exe')]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Bridge file does not exist/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
