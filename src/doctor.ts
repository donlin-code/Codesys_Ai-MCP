import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_IDE_ROOT = String.raw`D:\Program Files\CODESYS 3.5.22.30`;

export interface DoctorOptions { ideRoot?: string; bridge?: string }
export interface DoctorCheck {
  id: string;
  status: 'pass' | 'fail' | 'unknown';
  message: string;
  path?: string;
}
export interface DoctorResult {
  /** Only filesystem prerequisites, never a claim that the licensed IDE is connected. */
  ready: boolean;
  scope: 'filesystem-prerequisites';
  connectionVerified: false;
  ideRoot: string;
  ideExecutable: string;
  ideVersion: string | null;
  bridgeVersion: string | null;
  profileCandidates: string[];
  bridgeCandidates: string[];
  selectedBridge: string | null;
  checks: DoctorCheck[];
  nextSteps: string[];
}

async function isFile(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

/** Extract the PE RT_VERSION resource without loading or executing the Windows binary. */
export async function readExecutableVersion(file: string): Promise<string | null> {
  try {
    const handle = await open(file, 'r');
    let data: Buffer;
    try {
      const size = (await handle.stat()).size;
      if (size < 256 || size > 64 * 1024 * 1024) return null;
      data = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const result = await handle.read(data, read, size - read, read);
        if (result.bytesRead === 0) return null;
        read += result.bytesRead;
      }
    } finally { await handle.close(); }
    const u16 = (offset: number) => data.readUInt16LE(offset);
    const u32 = (offset: number) => data.readUInt32LE(offset);
    if (u16(0) !== 0x5a4d) return null;
    const pe = u32(0x3c);
    if (u32(pe) !== 0x4550) return null;
    const sections = u16(pe + 6);
    const optional = pe + 24;
    const magic = u16(optional);
    if (magic !== 0x10b && magic !== 0x20b) return null;
    const directories = optional + (magic === 0x10b ? 96 : 112);
    if (u32(directories - 4) < 3) return null;
    const resourceRva = u32(directories + 16);
    const resourceSize = u32(directories + 20);
    if (!resourceRva || !resourceSize) return null;
    const sectionsOffset = optional + u16(pe + 20);
    function rvaOffset(rva: number): number {
      for (let i = 0; i < sections; i++) {
        const section = sectionsOffset + i * 40;
        const start = u32(section + 12);
        const rawSize = u32(section + 16);
        if (rva >= start && rva - start < rawSize) return u32(section + 20) + rva - start;
      }
      throw new Error('RVA is outside file-backed PE sections');
    }
    const resource = rvaOffset(resourceRva);
    function entries(relative: number): Array<{ id: number; target: number }> {
      if (relative < 0 || relative + 16 > resourceSize) throw new Error('Invalid resource directory');
      const count = u16(resource + relative + 12) + u16(resource + relative + 14);
      if (relative + 16 + count * 8 > resourceSize) throw new Error('Truncated resource directory');
      return Array.from({ length: count }, (_, i) => ({
        id: u32(resource + relative + 16 + i * 8),
        target: u32(resource + relative + 20 + i * 8),
      }));
    }
    const versionType = entries(0).find(entry => entry.id === 16);
    if (!versionType || !(versionType.target & 0x80000000)) return null;
    function versionAt(target: number, depth: number): string | null {
      if (depth > 3) return null;
      if (target & 0x80000000) {
        for (const child of entries(target & 0x7fffffff)) {
          const version = versionAt(child.target, depth + 1);
          if (version) return version;
        }
        return null;
      }
      if (target + 16 > resourceSize) return null;
      const versionStart = rvaOffset(u32(resource + target));
      const versionSize = u32(resource + target + 4);
      if (versionStart + versionSize > data.length || versionSize < 6) return null;
      const blockEnd = versionStart + Math.min(u16(versionStart), versionSize);
      const key = Buffer.from('VS_VERSION_INFO\0', 'utf16le');
      if (!data.subarray(versionStart + 6, versionStart + 6 + key.length).equals(key)) return null;
      const fixed = Math.ceil((versionStart + 6 + key.length) / 4) * 4;
      if (fixed + 52 > blockEnd || u16(versionStart + 2) < 52 || u32(fixed) !== 0xfeef04bd) return null;
      const high = u32(fixed + 8);
      const low = u32(fixed + 12);
      return [high >>> 16, high & 0xffff, low >>> 16, low & 0xffff].join('.');
    }
    return versionAt(versionType.target, 0);
  } catch { return null; }
}

async function directoryEntries(directory: string) {
  try { return await readdir(directory, { withFileTypes: true }); } catch { return []; }
}

async function findBridges(directory: string, depth = 0): Promise<string[]> {
  // Search only the official add-on directory. Do not follow junctions or scan projects.
  if (depth > 4) return [];
  const found: string[] = [];
  for (const entry of await directoryEntries(directory)) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === 'codesysmcpbridge.exe') found.push(entryPath);
    else if (entry.isDirectory()) found.push(...await findBridges(entryPath, depth + 1));
  }
  return found.sort();
}

async function isInside(file: string, directory: string): Promise<boolean> {
  try {
    const relative = path.relative(await realpath(directory), await realpath(file));
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch { return false; }
}

/** Read-only: no executables, MCP connections, license stores, registry, or project contents. */
export async function doctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const requestedRoot = path.resolve(options.ideRoot ?? DEFAULT_IDE_ROOT);
  const ideRoot = await isFile(path.join(requestedRoot, 'Common', 'CODESYS.exe'))
    ? requestedRoot : path.join(requestedRoot, 'CODESYS');
  const ideExecutable = path.join(ideRoot, 'Common', 'CODESYS.exe');
  const profileDirectory = path.join(ideRoot, 'Profiles');
  const profileCandidates = (await directoryEntries(profileDirectory))
    .filter(entry => entry.isFile() && /^CODESYS V3\.5 SP22(?: Patch \d+)?\.profile\.xml$/i.test(entry.name))
    .map(entry => path.join(profileDirectory, entry.name)).sort();
  const bridgeCandidates = await findBridges(path.join(ideRoot, 'CODESYS MCP Server'));
  const selectedBridge = options.bridge ? path.resolve(options.bridge)
    : bridgeCandidates.length === 1 ? bridgeCandidates[0]! : null;
  const ideVersion = await readExecutableVersion(ideExecutable);
  const bridgeVersion = selectedBridge ? await readExecutableVersion(selectedBridge) : null;
  const checks: DoctorCheck[] = [
    { id: 'node', status: Number(process.versions.node.split('.')[0]) >= 22 ? 'pass' : 'fail', message: `Node.js ${process.versions.node}; version 22 or later is required.` },
    { id: 'platform', status: process.platform === 'win32' ? 'pass' : 'fail', message: `CODESYS SP22 local integration requires Windows; current platform: ${process.platform}.` },
    { id: 'ide', status: await isFile(ideExecutable) ? 'pass' : 'fail', message: 'CODESYS executable exists; integrity/signature is not verified.', path: ideExecutable },
    { id: 'ide-version', status: ideVersion === '3.5.22.30' ? 'pass' : 'fail', message: `PE file version: ${ideVersion ?? 'unavailable'}. This v0.1 environment targets 3.5.22.30.`, path: ideExecutable },
    { id: 'profile', status: profileCandidates.length > 0 ? 'pass' : 'fail', message: `${profileCandidates.length} SP22 profile file(s) found. A profile name does not establish the executable version.`, path: profileDirectory },
  ];
  const bridgeExists = selectedBridge !== null && await isFile(selectedBridge);
  checks.push({
    id: 'bridge', status: bridgeExists ? 'pass' : 'fail',
    message: selectedBridge
      ? 'Selected Bridge file presence only; use the exact path shown by Tools > Configure MCP Client.'
      : bridgeCandidates.length > 1
        ? 'Several add-on versions were found. Specify the exact Bridge shown by Tools > Configure MCP Client.'
        : 'Official Bridge not found. Install CODESYS Development System MCP Server for this IDE.',
    ...(selectedBridge ? { path: selectedBridge } : {}),
  });
  checks.push({ id: 'bridge-version', status: bridgeVersion ? 'pass' : 'unknown', message: `Bridge PE file version: ${bridgeVersion ?? 'unavailable'}. This does not verify add-on version matching.` });
  checks.push({
    id: 'bridge-installation',
    status: bridgeExists && selectedBridge !== null && path.basename(selectedBridge).toLowerCase() === 'codesysmcpbridge.exe'
      && await isInside(selectedBridge, ideRoot) ? 'pass' : 'fail',
    message: 'The official CodesysMCPBridge.exe must belong to this IDE installation. Add-on version matching still requires the IDE-generated path.',
  });
  checks.push(
    { id: 'license', status: 'unknown', message: 'PDE/MCP license entitlement is not inspected. CodeMeter or package presence does not prove entitlement.' },
    { id: 'ide-server', status: 'unknown', message: 'Enable MCP Server in one SP22 IDE instance. Running processes and IDE state are not inspected.' },
    { id: 'connection', status: 'unknown', message: 'No Bridge was executed and no initialize/tools/list request was sent.' },
  );
  const ready = checks.every(check => check.status !== 'fail');
  return {
    ready, scope: 'filesystem-prerequisites', connectionVerified: false,
    ideRoot, ideExecutable, ideVersion, bridgeVersion, profileCandidates, bridgeCandidates, selectedBridge, checks,
    nextSteps: [
      ...(!bridgeExists ? ['In CODESYS Installer, select the SP22 installation and install CODESYS Development System MCP Server.'] : []),
      'Verify PDE/MCP entitlement, open an isolated test project, and use Tools > Enable MCP Server in one IDE instance.',
      'Copy the exact path from Tools > Configure MCP Client; run scripts/Configure-CodesysMcp.ps1 with that path.',
      'Start a new Codex session, inspect /mcp, and verify tools/list and a read-only project query before editing.',
    ],
  };
}
