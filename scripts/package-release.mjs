import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const build = spawnSync(process.execPath, ['scripts/dev.mjs', 'build'], { cwd: root, stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const parent = join(root, 'artifacts', 'publication', new Date().toISOString().replace(/[:.]/g, '-'));
const source = join(parent, `donlinxg_MCP-${pkg.version}-source`);
const runtime = join(parent, `donlinxg_MCP-${pkg.version}-runtime`);
await mkdir(source, { recursive: true });
const allowlist = [
  'src', 'tests', 'distribution', 'workflows/ANALYZE.md', 'workflows/EDIT.md',
  'docs/data-format.md', 'docs/sp20-bridge-protocol.md', 'examples/smoke',
  'tsconfig.json', 'package-lock.json',
  'scripts/dev.mjs', 'scripts/package-release.mjs', 'scripts/sp20_bridge.py',
  'scripts/Start-SP20Bridge.ps1', 'scripts/Configure-SP20Mcp.ps1',
  'scripts/Configure-CodesysMcp.ps1', 'scripts/Start-CodesysAI.ps1',
];
for (const relative of allowlist) {
  await cp(join(root, relative), join(source, relative), { recursive: true, errorOnExist: true, force: false,
    filter: path => !path.includes('__pycache__') && !path.endsWith('.pyc') && !path.endsWith('.tsbuildinfo') });
}
for (const [from, to] of Object.entries({
  'README.md': 'README.md', 'README.en.md': 'README.en.md', 'acceptance.md': 'docs/acceptance.md',
  'setup-sp20.md': 'docs/setup-sp20.md', 'CONNECT.md': 'workflows/CONNECT.md',
  'mcp.example.json': 'config/mcp.example.json',
})) {
  await mkdir(dirname(join(source, to)), { recursive: true });
  await cp(join(root, 'distribution', from), join(source, to));
}
const releasePkg = { ...pkg,
  scripts: { build: 'node scripts/dev.mjs build', test: 'node scripts/dev.mjs test --core',
    doctor: 'node dist/src/cli.js doctor', 'package:release': 'node scripts/package-release.mjs' },
  repository: { type: 'git', url: 'https://github.com/donlin-code/donlinxg_MCP.git' },
};
await writeFile(join(source, 'package.json'), JSON.stringify(releasePkg, null, 2) + '\n');
await writeFile(join(source, '.gitignore'), 'node_modules/\ndist/\nartifacts/\ntmp/\n__pycache__/\n*.pyc\n*.tsbuildinfo\n*.project\n*.projectarchive\n*.opt\n*.auxiliary\n.env\n.env.*\n');
await writeFile(join(source, 'AGENTS.md'), '# Contributor and operator rules\n\nRead docs/acceptance.md and workflows/ANALYZE.md and EDIT.md. Use fresh isolated test copies. Present actual engineering batch diffs and obtain confirmation for the exact plan hash before writes; reread immediately before each write. Stop on unknown/failed writes and reconcile first. Compilation, saving, reopening and behavior are separate. Never package live IPC, bootstrap, nonce, session files or user projects. No PLC download/start/force tools. Test with npm ci and npm test; Python contracts: python tests/sp20-bridge-contract.py.\n');
await mkdir(join(source, '.github', 'workflows'), { recursive: true });
await writeFile(join(source, '.github', 'workflows', 'ci.yml'), 'name: Check\non: [push, pull_request, workflow_dispatch]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: windows-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: npm\n      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.12"\n      - run: npm ci\n      - run: npm test\n      - run: python tests/sp20-bridge-contract.py\n');
await cp(source, runtime, { recursive: true, force: false, errorOnExist: true });
await cp(join(root, 'dist', 'src'), join(runtime, 'dist', 'src'), { recursive: true });
const dependencies = [];
for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (!path.startsWith('node_modules/') || metadata.dev === true) continue;
  if (metadata.link || path.split('/').includes('..')) throw new Error(`Unsupported dependency: ${path}`);
  if (path.includes('/@types/') || path.endsWith('/typescript')) continue;
  const installed = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'));
  if (installed.version !== metadata.version) throw new Error(`Dependency differs from lock: ${path}`);
  await mkdir(dirname(join(runtime, path)), { recursive: true });
  const origin = join(root, path);
  await cp(origin, join(runtime, path), { recursive: true, filter: candidate => candidate === origin || basename(candidate) !== 'node_modules' });
  dependencies.push({ path, version: installed.version, license: installed.license ?? metadata.license ?? null });
}
await writeFile(join(runtime, 'RUNTIME-PACKAGE.json'), JSON.stringify({
  name: 'donlinxg_MCP', version: pkg.version, node: '22+ (not bundled)', dependencies,
  status: 'Experimental SP20 Scripting adapter; official SP22 integration not verified.',
  excludes: ['user projects', 'business source', 'historical engineering evidence', 'IPC/bootstrap/session credentials', 'Node.js', 'development dependencies'],
}, null, 2) + '\n');
for (const folder of [source, runtime]) {
  const manifest = [];
  async function walk(dir, relative = '') {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name), full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, path);
      else manifest.push({ path: path.replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(full)).digest('hex') });
    }
  }
  await walk(folder);
  await writeFile(join(folder, 'SHA256SUMS.json'), JSON.stringify(manifest, null, 2) + '\n');
}
console.log(JSON.stringify({ source, runtime, productionDependencies: dependencies.length }, null, 2));
