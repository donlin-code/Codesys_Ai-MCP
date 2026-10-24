#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { BridgeClient, BridgeClientError } from './bridge-client.js';

const str = {type: 'string'};
const hash = {type: 'string', pattern: '^[a-f0-9]{64}$'};
function tool(name: string, description: string, properties: Record<string, object>, required: string[], readOnly = true): Tool {
  return { name, description, inputSchema: {type: 'object', properties, required, additionalProperties: false},
    annotations: {readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false} };
}
export const bridgeTools: Tool[] = [
  tool('codesys_project_info', 'Read identity of the bound isolated SP20 IDE project. This is the experimental ScriptEngine adapter, not official SP22 MCP.', {}, []),
  tool('codesys_list_objects', 'Read the complete project object tree, including method children and per-parent child fingerprints. Does not claim all entries contain readable ST.', {}, []),
  tool('codesys_read_object', 'Read exact declaration and implementation from one object by escaped full path. sha256 hashes declaration + NUL + implementation.', {path: str}, ['path']),
  tool('codesys_replace_st', 'After showing the concrete diff and obtaining batch confirmation, replace source with optimistic hash check and exact readback. No save or compile. Failure stops the batch; do not retry timeouts.', {path: str, expectedSha256: hash, declaration: str, implementation: str}, ['path', 'expectedSha256', 'declaration', 'implementation'], false),
  tool('codesys_create_st', 'After batch confirmation, create ST object with parent children hash conflict check and readback. ACTION requires a PROGRAM or FUNCTION_BLOCK parent and an empty declaration. No save or compile.', {parentPath: str, name: str, kind: {type: 'string', enum: ['PROGRAM', 'FUNCTION_BLOCK', 'GVL', 'DUT', 'METHOD', 'ACTION']}, declaration: str, implementation: str, expectedChildrenSha256: hash}, ['parentPath', 'name', 'kind', 'declaration', 'implementation', 'expectedChildrenSha256'], false),
  tool('codesys_compile', 'Rebuild the entire specified Application and return all compiler diagnostics. success=false means compilation failed even when the tool transport succeeds. Does not save or connect a PLC.', {applicationPath: str, fullBuild: {type: 'boolean', const: true}}, ['applicationPath', 'fullBuild']),
  tool('codesys_reconcile_write', 'Resolve an uncertain/partial write only after reading its current source. Requires terminal response and the observed current sha256. Never repeats a write. Does not prove the original edit succeeded.', {requestId: str, observedSha256: hash}, ['requestId', 'observedSha256']),
];
const actionMap: Record<string, string> = {codesys_project_info: 'project_info', codesys_list_objects: 'list', codesys_read_object: 'read', codesys_replace_st: 'replace_st', codesys_create_st: 'create_st', codesys_compile: 'compile'};
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('Usage: codesys-ai-mcp --config <bootstrap.json>');
  const client = await BridgeClient.load(process.argv[3], 90000);
  const ping = await client.call('ping');
  if (!ping.ok || ping.result?.pong !== true) throw new Error('IDE handshake failed: ' + JSON.stringify(ping));
  const server = new Server({name: 'codesys-sp20-ai', version: '0.1.0'}, {capabilities: {tools: {}},
    instructions: 'Experimental SP20 adapter bound to a separate project copy. For engineering edits show a batch diff, obtain confirmation, reread, write once, and stop on failure. Readback, compilation and saving are separate. Do not claim official MCP or PLC runtime control.'});
  const availableTools = bridgeTools.filter(tool => tool.name === 'codesys_reconcile_write' || client.ready.actions.includes(actionMap[tool.name]));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: availableTools}));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const definition = availableTools.find(item => item.name === request.params.name);
      if (!definition) throw new Error('Unknown tool');
      const args = request.params.arguments ?? {};
      for (const key of Object.keys(args)) if (!(key in definition.inputSchema.properties!)) throw new Error('Unknown argument: ' + key);
      for (const key of definition.inputSchema.required ?? []) {
        if (key === 'fullBuild') { if (args[key] !== true) throw new Error('fullBuild must be true'); }
        else if (typeof args[key] !== 'string') throw new Error('Required string: ' + key);
      }
      const response = request.params.name === 'codesys_reconcile_write'
        ? await client.reconcile(String(args.requestId), String(args.observedSha256))
        : await client.call(actionMap[request.params.name], args);
      return {isError: response.ok === false, content: [{type: 'text' as const, text: JSON.stringify(response)}]};
    } catch (error) {
      return {isError: true, content: [{type: 'text' as const, text: JSON.stringify({ok: false, error: {code: error instanceof BridgeClientError ? error.code : 'CLIENT_ERROR', message: (error as Error).message, details: error instanceof BridgeClientError ? error.details : undefined}})}]};
    }
  });
  await server.connect(new StdioServerTransport());
}
main().catch(error => { console.error(error); process.exitCode = 1; });
