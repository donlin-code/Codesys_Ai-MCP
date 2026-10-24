import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson } from './snapshot.js';

export interface BridgeConfig {
  protocolVersion: 1; ipcDirectory: string; sessionId: string; nonce: string;
  projectPath: string; mode: 'open' | 'create'; isolatedTestProject: true;
}
export interface Ready {
  protocolVersion: 1; status: 'ready'; sessionId: string; nonce: string; pid: number;
  projectIdentity: { path: string; handle: number; instanceId: string };
  actions: string[];
}
export interface BridgeResponse {
  id: string; ok: boolean; result?: Record<string, any>;
  error?: {code: string; message: string; partial?: boolean; details?: unknown};
  completedAt: string;
}
export class BridgeClientError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
const mutations = new Set(['replace_st', 'create_st']);
const actions = new Set(['ping', 'project_info', 'list', 'read', 'compile', ...mutations]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
function record(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sourceHash(declaration: string, implementation: string): string {
  return createHash('sha256').update(declaration + '\0' + implementation, 'utf8').digest('hex');
}
function normalizeInput(value: unknown): string {
  if (typeof value !== 'string') throw new BridgeClientError('INVALID_RESPONSE', 'Submitted source is not a string');
  return value.replace(/\r\n?/g, '\n');
}
function objectPath(action: string, args: Record<string, any>): string {
  return action === 'create_st'
    ? (args.parentPath === '/' ? '' : args.parentPath) + '/' + String(args.name).replace(/~/g, '~0').replace(/\//g, '~1')
    : args.path;
}
function checkSource(value: unknown, path: string): asserts value is Record<string, any> {
  if (!record(value) || value.path !== path || typeof value.id !== 'string' || !value.id
    || typeof value.declaration !== 'string' || typeof value.implementation !== 'string'
    || value.complete !== true || typeof value.sha256 !== 'string' || !digest.test(value.sha256)
    || typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt))
    || value.text !== value.declaration + (value.implementation ? '\n' + value.implementation : '')
    || value.sha256 !== sourceHash(value.declaration, value.implementation))
    throw new BridgeClientError('INVALID_RESPONSE', 'Source readback path, exact text, or fingerprint is invalid');
}
export async function jsonFile(path: string): Promise<any> { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
async function optionalJson(path: string): Promise<any | undefined> {
  try { return await jsonFile(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
  await rename(temp, path);
}
export class BridgeClient {
  private constructor(public readonly config: BridgeConfig, public readonly ready: Ready, readonly timeoutMs: number) {}
  static async load(configPath: string, timeoutMs = 20000): Promise<BridgeClient> {
    const config = await jsonFile(configPath) as BridgeConfig;
    if (!record(config) || config.protocolVersion !== 1 || typeof config.sessionId !== 'string' || !uuid.test(config.sessionId)
      || typeof config.nonce !== 'string' || config.nonce.length < 32 || !['open', 'create'].includes(config.mode)
      || typeof config.ipcDirectory !== 'string' || !isAbsolute(config.ipcDirectory)
      || typeof config.projectPath !== 'string' || !isAbsolute(config.projectPath) || config.isolatedTestProject !== true)
      throw new BridgeClientError('INVALID_CONFIG', 'Invalid isolated bridge bootstrap');
    const ready = await jsonFile(join(config.ipcDirectory, 'ready.json')) as Ready;
    if (!record(ready) || ready.status !== 'ready' || ready.protocolVersion !== 1 || ready.sessionId !== config.sessionId || ready.nonce !== config.nonce
      || !Number.isSafeInteger(ready.pid) || ready.pid <= 0 || !record(ready.projectIdentity)
      || typeof ready.projectIdentity.path !== 'string' || !isAbsolute(ready.projectIdentity.path)
      || !Number.isSafeInteger(ready.projectIdentity.handle) || typeof ready.projectIdentity.instanceId !== 'string'
      || !uuid.test(ready.projectIdentity.instanceId) || !Array.isArray(ready.actions)
      || !['ping', 'project_info', 'list', 'read', 'create_st', 'replace_st'].every(action => ready.actions.includes(action))
      || resolve(ready.projectIdentity.path).toLowerCase() !== resolve(config.projectPath).toLowerCase())
      throw new BridgeClientError('IDENTITY_MISMATCH', 'Ready session does not match bootstrap');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 110000) throw new Error('Invalid timeout');
    return new BridgeClient(config, ready, timeoutMs);
  }
  private file(name: string): string { return join(this.config.ipcDirectory, name); }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    let handle;
    try { handle = await open(this.file('client.lock'), 'wx'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new BridgeClientError('CLIENT_BUSY', 'Another call is active. A crash lock requires inspecting its PID and pending write before manual recovery.');
      throw e;
    }
    try { await handle.writeFile(JSON.stringify({pid: process.pid, createdAt: new Date().toISOString()})); return await fn(); }
    finally { await handle.close(); await unlink(this.file('client.lock')); }
  }
  private checkResponse(value: any, id: string): BridgeResponse {
    if (!record(value)) throw new BridgeClientError('INVALID_RESPONSE', 'Response must be an object', {id});
    for (const key of ['protocolVersion', 'sessionId', 'nonce', 'pid', 'projectIdentity'] as const) {
      if (!Object.hasOwn(value, key) || canonicalJson(value[key]) !== canonicalJson(this.ready[key])) throw new BridgeClientError('IDENTITY_MISMATCH', 'Response identity mismatch: ' + key, {id});
    }
    if (value.id !== id || typeof value.ok !== 'boolean' || typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt))
      || (value.ok ? !record(value.result) || value.error !== undefined
        : !record(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string'
          || typeof value.error.partial !== 'boolean' || value.result !== undefined))
      throw new BridgeClientError('INVALID_RESPONSE', 'Invalid bridge response', {id});
    return value as BridgeResponse;
  }
  private checkResult(response: BridgeResponse, action: string, args: Record<string, unknown>): void {
    if (!response.ok) return;
    if (action === 'read') checkSource(response.result, objectPath(action, args));
    if (mutations.has(action)) {
      const result = response.result!;
      checkSource(result.readback, objectPath(action, args));
      if (result.verified !== true || result.saved !== false || result.created !== (action === 'create_st')
        || result.beforeSha256 !== (action === 'replace_st' ? args.expectedSha256 : null)
        || result.readback.declaration !== normalizeInput(args.declaration)
        || result.readback.implementation !== normalizeInput(args.implementation ?? ''))
        throw new BridgeClientError('INVALID_RESPONSE', 'Write success lacks exact verified source readback', {id: response.id});
    }
  }
  private async exchange(action: string, args: Record<string, unknown>): Promise<BridgeResponse> {
    const id = randomUUID(), createdAt = new Date().toISOString();
    const request = { protocolVersion: 1, id, sessionId: this.ready.sessionId, nonce: this.ready.nonce,
      pid: this.ready.pid, projectIdentity: this.ready.projectIdentity, action, args, createdAt,
      deadlineUtc: new Date(Date.now() + this.timeoutMs).toISOString() };
    if (mutations.has(action)) await atomicJson(this.file('pending-write.json'), {id, action, args, createdAt});
    await atomicJson(this.file(id + '.req.json'), request);
    const end = Date.now() + this.timeoutMs;
    while (Date.now() < end) {
      const raw = await optionalJson(this.file(id + '.res.json'));
      if (raw !== undefined) {
        const response = this.checkResponse(raw, id);
        this.checkResult(response, action, args);
        if (mutations.has(action) && (response.ok || response.error?.partial === false)) await unlink(this.file('pending-write.json'));
        return response;
      }
      const fatal = await optionalJson(this.file('worker-error.json'));
      if (fatal) throw new BridgeClientError('WORKER_FAILED', 'IDE worker failed; inspect evidence before any retry', {id, fatal});
      await delay(50);
    }
    throw new BridgeClientError(mutations.has(action) ? 'WRITE_OUTCOME_UNKNOWN' : 'TIMEOUT', 'No response before timeout; do not repeat a write. Inspect the request and reconcile.', {id, action, ipcDirectory: this.config.ipcDirectory});
  }
  async call(action: string, args: Record<string, unknown> = {}): Promise<BridgeResponse> {
    if (!actions.has(action) || !this.ready.actions.includes(action)) throw new BridgeClientError('INVALID_ACTION', 'Unsupported bridge action in this session');
    return this.locked(async () => {
      if (mutations.has(action)) {
        const pending = await optionalJson(this.file('pending-write.json'));
        if (pending) throw new BridgeClientError('UNRESOLVED_WRITE', 'Previous write outcome must be reconciled before another write', pending);
      }
      return this.exchange(action, args);
    });
  }
  /** Reconciliation is read-only in the IDE. Never retries a mutation. */
  async reconcile(id: string, expectedSha256: string): Promise<Record<string, unknown>> {
    if (!uuid.test(id) || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('Invalid reconciliation identity/hash');
    return this.locked(async () => {
      const pending = await optionalJson(this.file('pending-write.json'));
      if (!pending || pending.id !== id) throw new BridgeClientError('NOT_PENDING', 'Request is not the pending write');
      const raw = await optionalJson(this.file(id + '.res.json'));
      if (!raw) throw new BridgeClientError('STILL_UNKNOWN', 'No terminal response; wait or inspect IDE. Write remains blocked.');
      const response = this.checkResponse(raw, id);
      if (response.error?.code === 'EXECUTION_UNKNOWN') throw new BridgeClientError('STILL_UNKNOWN', 'Primary-thread callback may still be running. Inspect IDE and start a new session after resolving it.');
      if (!mutations.has(pending.action) || !record(pending.args)) throw new BridgeClientError('INVALID_PENDING', 'Pending record is not a mutation');
      const path = objectPath(pending.action, pending.args);
      const readback = await this.exchange('read', {path});
      if (!readback.ok || readback.result?.sha256 !== expectedSha256) throw new BridgeClientError('RECONCILE_MISMATCH', 'Current source does not match the supplied observed fingerprint', readback);
      const reconciliation = {id, response, readback, reconciledAt: new Date().toISOString()};
      await atomicJson(this.file(id + '.reconciled.json'), reconciliation);
      await unlink(this.file('pending-write.json'));
      return reconciliation;
    });
  }
}
