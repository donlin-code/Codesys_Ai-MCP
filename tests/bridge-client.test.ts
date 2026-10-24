import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rename, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeClient, BridgeClientError } from '../src/bridge-client.js';

type Request = Record<string, any>;
type Reply = Record<string, any>;
type Peer = (request: Request) => Reply | undefined | Promise<Reply | undefined>;

function source(declaration = 'PROGRAM PLC_PRG\nVAR\nEND_VAR\n', implementation = 'x := 1;\n', path = '/PLC_PRG') {
  return {path, id: 'frozen-object-guid', declaration, implementation,
    hasDeclaration: true, hasImplementation: true, complete: true,
    text: declaration + (implementation ? '\n' + implementation : ''),
    sha256: createHash('sha256').update(declaration + '\0' + implementation, 'utf8').digest('hex'),
    capturedAt: new Date().toISOString()};
}
function mutationReply(request: Request): Reply {
  const {args} = request;
  const declaration = args.declaration.replace(/\r\n?/g, '\n');
  const implementation = (args.implementation ?? '').replace(/\r\n?/g, '\n');
  const path = request.action === 'create_st' ? (args.parentPath === '/' ? '' : args.parentPath) + '/' + args.name : args.path;
  return {ok: true, result: {created: request.action === 'create_st', verified: true, saved: false,
    beforeSha256: request.action === 'create_st' ? null : args.expectedSha256,
    readback: source(declaration, implementation, path)}};
}
function errorCode(code: string) {
  return (error: unknown) => error instanceof BridgeClientError && error.code === code;
}
async function harness(t: TestContext, timeoutMs = 500) {
  const directory = await mkdtemp(join(tmpdir(), 'codesys-bridge-contract-'));
  const configPath = join(directory, 'bootstrap.json');
  const config = {protocolVersion: 1, ipcDirectory: directory, sessionId: randomUUID(), nonce: randomUUID(),
    projectPath: join(directory, 'sandbox.project'), mode: 'open', isolatedTestProject: true};
  const ready = {protocolVersion: 1, status: 'ready', sessionId: config.sessionId, nonce: config.nonce, pid: 12345,
    projectIdentity: {path: config.projectPath, handle: 42, instanceId: randomUUID()},
    actions: ['ping', 'project_info', 'list', 'read', 'replace_st', 'create_st']};
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(join(directory, 'ready.json'), JSON.stringify(ready));
  const client = await BridgeClient.load(configPath, timeoutMs);
  const requests: Request[] = [];
  let stopped = false;
  let peer: Peer = request => request.action === 'read' ? {ok: true, result: source(undefined, undefined, request.args.path)} : mutationReply(request);
  async function reply(request: Request, value: Reply) {
    const identity = Object.fromEntries(['protocolVersion', 'sessionId', 'nonce', 'pid', 'projectIdentity'].map(key => [key, ready[key as keyof typeof ready]]));
    const response = {...identity, id: request.id, completedAt: new Date().toISOString(), ...value};
    const destination = join(directory, request.id + '.res.json');
    const temporary = destination + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(response));
    await rename(temporary, destination);
  }
  const seen = new Set<string>();
  const running = (async () => {
    while (!stopped) {
      for (const name of await readdir(directory)) {
        if (!name.endsWith('.req.json') || seen.has(name)) continue;
        seen.add(name);
        const request = JSON.parse(await readFile(join(directory, name), 'utf8')) as Request;
        requests.push(request);
        const response = await peer(request);
        if (response) await reply(request, response);
      }
      await delay(5);
    }
  })();
  t.after(async () => { stopped = true; await running; await rm(directory, {recursive: true, force: true}); });
  return {client, configPath, directory, requests, ready, reply,
    setPeer(value: Peer) {peer = value;},
    async pending() {return JSON.parse(await readFile(join(directory, 'pending-write.json'), 'utf8'));},
    async noPending() {await assert.rejects(access(join(directory, 'pending-write.json')), {code: 'ENOENT'});}};
}
function editArgs() {
  return {path: '/PLC_PRG', expectedSha256: source().sha256, declaration: source().declaration, implementation: 'x := 2;\n'};
}

test('read verifies exact Unicode/newline source and bound path', async t => {
  const h = await harness(t);
  const exact = source('PROGRAM PLC_PRG\r\n(* 气缸 *)\n', 'x := 1;\r\n');
  h.setPeer(() => ({ok: true, result: exact}));
  assert.deepEqual((await h.client.call('read', {path: '/PLC_PRG'})).result, exact);
  assert.ok(Date.parse(h.requests[0].deadlineUtc) > Date.parse(h.requests[0].createdAt));
});

test('ready rejects missing identity and mismatched session', async t => {
  const h = await harness(t);
  await writeFile(join(h.directory, 'ready.json'), JSON.stringify({...h.ready, projectIdentity: null}));
  await assert.rejects(BridgeClient.load(h.configPath), errorCode('IDENTITY_MISMATCH'));
  await writeFile(join(h.directory, 'ready.json'), JSON.stringify({...h.ready, sessionId: randomUUID()}));
  await assert.rejects(BridgeClient.load(h.configPath), errorCode('IDENTITY_MISMATCH'));
});

test('response identity mismatch leaves a write unresolved', async t => {
  const h = await harness(t);
  h.setPeer(request => ({...mutationReply(request), pid: 999}));
  await assert.rejects(h.client.call('replace_st', editArgs()), errorCode('IDENTITY_MISMATCH'));
  assert.equal((await h.pending()).action, 'replace_st');
});

test('read rejects corrupt source hash and wrong object with identical text', async t => {
  const h = await harness(t);
  h.setPeer(() => ({ok: true, result: {...source(), sha256: '0'.repeat(64)}}));
  await assert.rejects(h.client.call('read', {path: '/PLC_PRG'}), errorCode('INVALID_RESPONSE'));
  h.setPeer(() => ({ok: true, result: source(undefined, undefined, '/OtherObject')}));
  await assert.rejects(h.client.call('read', {path: '/PLC_PRG'}), errorCode('INVALID_RESPONSE'));
});

test('verified replacement accepts documented LF conversion and clears pending', async t => {
  const h = await harness(t);
  const response = await h.client.call('replace_st', {...editArgs(), implementation: 'x := 2;\r\n'});
  assert.equal(response.result?.readback.implementation, 'x := 2;\n');
  await h.noPending();
});

test('verified creation checks exact target and clears pending', async t => {
  const h = await harness(t);
  const response = await h.client.call('create_st', {parentPath: '/', name: 'NewGVL', kind: 'GVL',
    expectedChildrenSha256: 'a'.repeat(64), declaration: 'VAR_GLOBAL\nx:BOOL;\nEND_VAR\n', implementation: ''});
  assert.equal(response.result?.readback.path, '/NewGVL');
  await h.noPending();
});

test('unverified success cannot clear pending, including after client reload', async t => {
  const h = await harness(t);
  h.setPeer(() => ({ok: true, result: {verified: true}}));
  await assert.rejects(h.client.call('replace_st', editArgs()), errorCode('INVALID_RESPONSE'));
  const restarted = await BridgeClient.load(h.configPath);
  await assert.rejects(restarted.call('replace_st', editArgs()), errorCode('UNRESOLVED_WRITE'));
  assert.equal(h.requests.length, 1);
});

test('valid hash of wrong written text cannot claim success', async t => {
  const h = await harness(t);
  h.setPeer(request => {
    const response = mutationReply(request);
    response.result.readback = source();
    return response;
  });
  await assert.rejects(h.client.call('replace_st', editArgs()), errorCode('INVALID_RESPONSE'));
  assert.ok(await h.pending());
});

test('explicit nonpartial conflict clears pending without claiming success', async t => {
  const h = await harness(t);
  h.setPeer(() => ({ok: false, error: {code: 'CONFLICT', message: 'Baseline changed', partial: false}}));
  assert.equal((await h.client.call('replace_st', editArgs())).ok, false);
  await h.noPending();
});

test('partial failure blocks writes but permits read and exact reconciliation', async t => {
  const h = await harness(t);
  const observed = source(source().declaration + '(* partial change *)', source().implementation);
  h.setPeer(request => request.action === 'read' ? {ok: true, result: observed}
    : {ok: false, error: {code: 'WRITE_FAILED', message: 'Second editor failed', partial: true, details: observed}});
  assert.equal((await h.client.call('replace_st', editArgs())).ok, false);
  const pending = await h.pending();
  await assert.rejects(h.client.call('replace_st', editArgs()), errorCode('UNRESOLVED_WRITE'));
  assert.equal((await h.client.call('read', {path: '/PLC_PRG'})).result?.sha256, observed.sha256);
  await assert.rejects(h.client.reconcile(pending.id, source().sha256), errorCode('RECONCILE_MISMATCH'));
  assert.ok(await h.pending());
  const reconciled = await h.client.reconcile(pending.id, observed.sha256);
  assert.equal((reconciled.response as Reply).ok, false);
  await h.noPending();
  assert.equal(h.requests.filter(request => request.action === 'replace_st').length, 1);
});

test('timeout persists pending and cannot be reconciled without terminal response', async t => {
  const h = await harness(t, 100);
  h.setPeer(() => undefined);
  await assert.rejects(h.client.call('replace_st', editArgs()), errorCode('WRITE_OUTCOME_UNKNOWN'));
  const pending = await h.pending();
  const restarted = await BridgeClient.load(h.configPath, 100);
  await assert.rejects(restarted.call('replace_st', editArgs()), errorCode('UNRESOLVED_WRITE'));
  await assert.rejects(restarted.reconcile(pending.id, source().sha256), errorCode('STILL_UNKNOWN'));
  assert.equal(h.requests.length, 1);
});

test('late terminal result reconciles with fresh actual read without repeating write', async t => {
  const h = await harness(t, 100);
  h.setPeer(() => undefined);
  await assert.rejects(h.client.call('replace_st', editArgs()), errorCode('WRITE_OUTCOME_UNKNOWN'));
  const request = h.requests[0];
  await h.reply(request, mutationReply(request));
  const changedLater = source(source().declaration, 'x := 3;\n');
  h.setPeer(() => ({ok: true, result: changedLater}));
  await assert.rejects(h.client.reconcile(request.id, source(source().declaration, 'x := 2;\n').sha256), errorCode('RECONCILE_MISMATCH'));
  await h.client.reconcile(request.id, changedLater.sha256);
  await h.noPending();
  assert.equal(h.requests.filter(item => item.action === 'replace_st').length, 1);
});

test('server execution unknown remains blocked even with a matching observed hash', async t => {
  const h = await harness(t);
  h.setPeer(() => ({ok: false, error: {code: 'EXECUTION_UNKNOWN', message: 'Callback still queued', partial: true}}));
  assert.equal((await h.client.call('replace_st', editArgs())).ok, false);
  const pending = await h.pending();
  await assert.rejects(h.client.reconcile(pending.id, source().sha256), errorCode('STILL_UNKNOWN'));
  assert.ok(await h.pending());
});

test('process lock prevents overlapping calls and is released after timeout', async t => {
  const h = await harness(t, 100);
  h.setPeer(() => undefined);
  const active = h.client.call('read', {path: '/PLC_PRG'});
  while (h.requests.length === 0) await delay(5);
  await assert.rejects(h.client.call('read', {path: '/PLC_PRG'}), errorCode('CLIENT_BUSY'));
  await assert.rejects(active, errorCode('TIMEOUT'));
  h.setPeer(() => ({ok: true, result: source()}));
  assert.equal((await h.client.call('read', {path: '/PLC_PRG'})).ok, true);
});

test('malformed error cannot clear uncertain write state', async t => {
  const h = await harness(t);
  h.setPeer(() => ({ok: false, error: {partial: false}}));
  await assert.rejects(h.client.call('replace_st', editArgs()), errorCode('INVALID_RESPONSE'));
  assert.ok(await h.pending());
});
