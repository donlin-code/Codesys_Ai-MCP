import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateSnapshot } from './snapshot.js';
import type { Snapshot, Evidence, InventoryEntry, SnapshotObject } from './model.js';

export function sourceClassification(source: Record<string, any>): {type: string; language: string; supported: boolean} {
  const keyword = /(?:^|\n)\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD|PROPERTY|INTERFACE|TYPE|VAR_GLOBAL)\b/i.exec(source.declaration)?.[1]?.toUpperCase();
  const type = source.sourceKind === 'ACTION' ? 'ACTION' : keyword === 'TYPE' ? 'DUT' : keyword === 'VAR_GLOBAL' ? 'GVL' : keyword ?? 'text';
  const declarationOnly = ['DUT', 'GVL'].includes(source.sourceKind) && source.sourceComplete === true;
  const language = declarationOnly ? 'ST' : typeof source.language === 'string' ? source.language : 'unknown';
  return {type, language, supported: declarationOnly || (language === 'ST' && source.sourceComplete === true)};
}

/** Capture through the actual MCP protocol and retain every raw tool response. */
export async function captureSnapshot(config: string, applicationPath?: string): Promise<Snapshot> {
  const client = new Client({name: 'codesys-snapshot', version: '0.1.0'});
  const transport = new StdioClientTransport({command: process.execPath, args: [fileURLToPath(new URL('./mcp-server.js', import.meta.url)), '--config', config], stderr: 'inherit'});
  const evidence: Evidence[] = [];
  async function call(tool: string, args: Record<string, unknown> = {}) {
    const raw = await client.callTool({name: tool, arguments: args});
    const blocks = raw.content as Array<{type: string; text?: string}>;
    const value = JSON.parse(blocks.find(item => item.type === 'text')?.text ?? '{}');
    const proof: Evidence = {id: randomUUID(), tool, arguments: args, result: raw, capturedAt: new Date().toISOString()};
    evidence.push(proof);
    return {value, proof, ok: !raw.isError && value.ok === true};
  }
  try {
    await client.connect(transport);
    const info = await call('codesys_project_info'), tree = await call('codesys_list_objects');
    if (!info.ok || !tree.ok || tree.value.result.treeComplete !== true) throw new Error('Cannot capture a complete project tree');
    const entries = tree.value.result.objects as Array<Record<string, any>>;
    const apps = entries.filter(item => item.isApplication === true);
    if (!applicationPath && apps.length !== 1) throw new Error('Select --application from the actual application tree');
    const selected = applicationPath ?? apps[0].path;
    if (!apps.some(item => item.path === selected)) throw new Error('Application path is not in the current project');
    const inventory: InventoryEntry[] = [], objects: SnapshotObject[] = [];
    for (const item of entries.filter(item => item.path.startsWith(selected + '/'))) {
      const entry: InventoryEntry = {path: item.path, parentPath: item.parentPath, type: item.typeGuid, language: 'unknown'};
      inventory.push(entry);
      if (!item.hasDeclaration && !item.hasImplementation) {
        objects.push({path: entry.path, type: entry.type, language: entry.language, status: 'unsupported', reason: 'Non-text object: structure listed, source not exposed by ST adapter'});
        continue;
      }
      const read = await call('codesys_read_object', {path: item.path});
      if (!read.ok || read.value.result.complete !== true) {
        objects.push({path: entry.path, type: entry.type, language: entry.language, status: 'unread', reason: 'Read failed or incomplete; see raw evidence', evidenceIds: [read.proof.id]});
        continue;
      }
      const source = read.value.result;
      const classification = sourceClassification(source);
      entry.type = classification.type;
      entry.language = classification.language;
      if (!classification.supported) {
        objects.push({path: entry.path, type: entry.type, language: entry.language, status: 'unsupported', reason: 'Text portions returned, but complete ST source is not proven; see raw evidence', evidenceIds: [read.proof.id]});
        continue;
      }
      objects.push({path: entry.path, type: entry.type, language: entry.language, status: 'read', text: source.text, complete: true, evidenceIds: [read.proof.id]});
    }
    const finalTree = await call('codesys_list_objects');
    const stable = finalTree.ok && finalTree.value.result.inventorySha256 === tree.value.result.inventorySha256;
    return validateSnapshot({schemaVersion: 1, origin: 'ide', capturedAt: new Date().toISOString(),
      identity: {projectPath: info.value.result.projectPath, applicationPath: selected, ideVersion: info.value.result.ideVersion ?? 'unknown', pluginVersion: 'experimental-sp20-scriptengine/0.1.0'},
      treeComplete: stable, inventory, objects, evidence});
  } finally { await client.close(); }
}
