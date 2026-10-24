import test from 'node:test';
import assert from 'node:assert/strict';
import { appendEvent, prepareBatch, batchStatus, type Batch, type BatchEvent } from '../src/batch.js';
import type { Snapshot } from '../src/model.js';
import { fingerprint, snapshotHash } from '../src/snapshot.js';

const path = '/Device/Application/PLC_PRG';
const application = '/Device/Application';
const projectPath = 'C:\\Tests\\Bridge.project';
const declaration = 'PROGRAM PLC_PRG\nVAR\nx:INT;\nEND_VAR\n';
const beforeImpl = 'x := 1;\n', afterImpl = 'x := 2;\n';
const combined = (impl: string) => declaration + '\n' + impl;
const time = (n: number) => new Date(Date.UTC(2026, 9, 23, 12, 0, n)).toISOString();
const childrenHash = 'c'.repeat(64);
function source(implementation = beforeImpl, n = 0, target = path, decl = declaration) {
  return {path: target, id: 'object-guid', declaration: decl, implementation,
    text: decl + (implementation ? '\n' + implementation : ''),
    sha256: fingerprint(decl + '\0' + implementation), complete: true, capturedAt: time(n)};
}
function envelope<T>(result: T, ok = true) {
  return {ok, projectIdentity: {path: projectPath, handle: 1, instanceId: 'bound-instance'},
    result, completedAt: time(5)};
}
function mcp(result: unknown) {return {isError: false, content: [{type: 'text', text: JSON.stringify(result)}]};}
function snapshot(implementation = beforeImpl, n = 0): Snapshot {
  const read = source(implementation, n);
  return {schemaVersion: 1, origin: 'ide', capturedAt: time(n), treeComplete: true,
    identity: {projectPath, applicationPath: application, ideVersion: '3.5.20.60', pluginVersion: 'experimental-sp20-scriptengine/0.1.0'},
    inventory: [{path, type: 'PROGRAM', language: 'ST'}],
    objects: [{path, type: 'PROGRAM', language: 'ST', status: 'read', text: read.text, complete: true, evidenceIds: ['read']}],
    evidence: [{id: 'read', tool: 'codesys_read_object', arguments: {path}, result: mcp(envelope(read)), capturedAt: time(n)},
      {id: 'tree', tool: 'codesys_list_objects', arguments: {}, result: mcp(envelope({treeComplete: true,
        rootChildrenSha256: 'd'.repeat(64), objects: [{path: application, childrenSha256: childrenHash}, {path}]})), capturedAt: time(n)}]};
}
function event(b: Batch, type: BatchEvent['type'], n: number, data: Record<string, unknown>) {
  return appendEvent(b, {type, at: time(n), data});
}
function started() {
  let b = prepareBatch(snapshot(), {schemaVersion: 1, changes: [{path, type: 'PROGRAM', language: 'ST', text: combined(afterImpl)}]}, time(0));
  b = event(b, 'approve', 1, {actor: 'user', confirmation: 'confirmed exact bridge test plan', planHash: b.plan.planHash});
  return event(b, 'start', 2, {operationId: 'op-1', snapshot: snapshot(beforeImpl, 2)});
}
function writeEvidence() {
  return {tool: 'codesys_replace_st', arguments: {path, expectedSha256: source().sha256, declaration, implementation: afterImpl},
    result: mcp(envelope({created: false, verified: true, saved: false, beforeSha256: source().sha256, readback: source(afterImpl, 3)}))};
}
function result(b = started(), evidence: Record<string, unknown> = writeEvidence()) {
  return event(b, 'result', 3, {operationId: 'op-1', outcome: 'applied', evidence});
}
function verified() {return event(result(), 'readback', 4, {operationId: 'op-1', snapshot: snapshot(afterImpl, 4)});}
function compileData() {
  const s = snapshot(afterImpl, 5);
  return {mode: 'full', snapshot: s, sourceSnapshotHash: snapshotHash(s), toolError: false, errorCount: 0, warningCount: 0,
    diagnostics: [] as Array<Record<string, unknown>>, evidence: {tool: 'codesys_compile', capturedAt: time(5),
      arguments: {applicationPath: application, fullBuild: true},
      result: envelope({applicationPath: application, fullBuild: true, rebuildReturned: true, success: true,
        diagnostics: [] as Array<Record<string, unknown>>, errorCount: 0, warningCount: 0, completedAt: time(5), exception: null})}};
}
function unwrapped(evidence: ReturnType<typeof writeEvidence>): any {
  return JSON.parse(evidence.result.content[0].text);
}

test('actual SP20 read/write envelopes verify a planned replacement', () => {
  const b = verified();
  assert.equal(batchStatus(b).readbackVerified, true);
  assert.equal(batchStatus(b).compilation, 'not-run');
});

test('bridge readback text, target and hash cannot diverge from plan', () => {
  for (const mutate of [
    (value: any) => {value.result.readback.path = '/Other';},
    (value: any) => {value.result.readback.sha256 = '0'.repeat(64);},
    (value: any) => {value.result.readback = source('x := 9;\n', 3);},
    (value: any) => {value.result.verified = false;},
  ]) {
    const proof = writeEvidence(), raw = unwrapped(proof);
    mutate(raw); proof.result = mcp(raw);
    assert.throws(() => result(started(), proof), /桥接/);
  }
});

test('bridge source baseline hash is bound to the fresh split source evidence', () => {
  const proof = writeEvidence(), raw = unwrapped(proof);
  proof.arguments.expectedSha256 = raw.result.beforeSha256 = 'f'.repeat(64);
  proof.result = mcp(raw);
  assert.throws(() => result(started(), proof), /写入前读取的声明/);
});

test('bridge failed nested status cannot be recorded as applied', () => {
  const proof = writeEvidence(), raw = unwrapped(proof);
  raw.ok = false; raw.error = {code: 'WRITE_FAILED', partial: true};
  proof.result = mcp(raw);
  assert.throws(() => result(started(), proof), /失败不能记录 applied/);
});

test('explicit bridge path pointer cannot disguise a wrong actual target', () => {
  const proof: any = writeEvidence();
  proof.arguments.decoy = path; proof.arguments.path = '/Wrong'; proof.pathArgumentPointer = '/decoy';
  assert.throws(() => result(started(), proof), /pathArgumentPointer/);
});

test('official write aliases and explicit pointers retain their existing behavior', () => {
  for (const evidence of [
    {tool: 'replace_text_in_structured_text', arguments: {objectPath: path}, result: {isError: false}},
    {tool: 'replace_text_in_structured_text', arguments: {target: {object_path: path}}, pathArgumentPointer: '/target/object_path', result: {isError: false}},
  ]) assert.equal(batchStatus(result(started(), evidence)).operations['op-1'], 'applied');
});

test('bridge create derives escaped path and binds fresh parent fingerprint', () => {
  const name = 'Name/with~escape', target = application + '/Name~1with~0escape';
  const decl = 'VAR_GLOBAL x:BOOL; END_VAR';
  let b = prepareBatch(snapshot(), {schemaVersion: 1, changes: [{path: target, type: 'GVL', language: 'ST', text: decl}]}, time(0));
  b = event(b, 'approve', 1, {actor: 'user', confirmation: 'confirm creation', planHash: b.plan.planHash});
  b = event(b, 'start', 2, {operationId: 'op-1', snapshot: snapshot(beforeImpl, 2)});
  const proof: any = {tool: 'codesys_create_st', arguments: {parentPath: application, name, kind: 'GVL',
    expectedChildrenSha256: childrenHash, declaration: decl, implementation: ''},
    result: mcp(envelope({created: true, verified: true, saved: false, beforeSha256: null, readback: source('', 3, target, decl)}))};
  assert.equal(batchStatus(result(b, proof)).operations['op-1'], 'applied');
  proof.arguments.expectedChildrenSha256 = 'a'.repeat(64);
  assert.throws(() => result(b, proof), /父节点基线与创建前清单不一致/);
  proof.arguments.parentPath = '/OtherApplication';
  assert.throws(() => result(b, proof), /路径与本批对象不一致/);
});

test('bridge ACTION creation preserves empty declaration and exact implementation in the confirmed plan', () => {
  const target = path + '/ACT_Init', implementation = 'x := 0;\n';
  const current = (n = 0) => {
    const s = snapshot(beforeImpl, n);
    const tree = JSON.parse((s.evidence[1].result as any).content[0].text);
    tree.result.objects[1].childrenSha256 = childrenHash;
    s.evidence[1].result = mcp(tree);
    return s;
  };
  let b = prepareBatch(current(), {schemaVersion: 1, changes: [{path: target, type: 'ACTION', language: 'ST', text: '\n' + implementation}]}, time(0));
  b = event(b, 'approve', 1, {actor: 'user', confirmation: 'fixture confirmation for ACTION', planHash: b.plan.planHash});
  b = event(b, 'start', 2, {operationId: 'op-1', snapshot: current(2)});
  const proof: any = {tool: 'codesys_create_st', arguments: {parentPath: path, name: 'ACT_Init', kind: 'ACTION',
    expectedChildrenSha256: childrenHash, declaration: '', implementation},
    result: mcp(envelope({created: true, verified: true, saved: false, beforeSha256: null, readback: source(implementation, 3, target, '')}))};
  assert.equal(batchStatus(result(b, proof)).operations['op-1'], 'applied');
  proof.arguments.declaration = 'ACTION ACT_Init';
  assert.throws(() => result(b, proof), /已确认计划源码不符/);
});

test('bridge compile passes only when full build actually reports success', () => {
  const d = compileData();
  assert.equal(batchStatus(event(verified(), 'compile', 5, d)).compilation, 'passed');
  d.evidence.result.result.success = false;
  assert.equal(batchStatus(event(verified(), 'compile', 5, d)).compilation, 'failed');
  d.evidence.result.result.rebuildReturned = false;
  assert.equal(batchStatus(event(verified(), 'compile', 5, d)).compilation, 'failed');
});

test('bridge compile cannot accept another application, stale timestamp or inconsistent success', () => {
  let d = compileData();
  d.evidence.arguments.applicationPath = '/Other';
  assert.throws(() => event(verified(), 'compile', 5, d), /目标 Application/);
  d = compileData(); d.evidence.result.result.completedAt = time(1);
  assert.throws(() => event(verified(), 'compile', 5, d), /完成时间/);
  d = compileData(); d.evidence.result.result.rebuildReturned = false;
  assert.throws(() => event(verified(), 'compile', 5, d), /success 与返回状态/);
});

test('bridge compile diagnostic aliases preserve errors and require exact message', () => {
  const d = compileData();
  d.errorCount = d.evidence.result.result.errorCount = 1;
  d.diagnostics = [{severity: 'error', message: 'Fatal build error'}];
  d.evidence.result.result.diagnostics = [{severity: 'FatalError', message: 'Fatal build error'}];
  d.evidence.result.result.success = false;
  assert.equal(batchStatus(event(verified(), 'compile', 5, d)).compilation, 'failed');
  d.diagnostics[0].message = 'different';
  assert.throws(() => event(verified(), 'compile', 5, d), /诊断内容/);
});

test('bridge compile supports MCP JSON pointers and rejects decoy bindings', () => {
  const d: any = compileData();
  d.evidence.result = mcp(d.evidence.result);
  d.bindings = {fullBuildArgument: '/fullBuild', errorCountResult: '/content/0/text/result/errorCount',
    warningCountResult: '/content/0/text/result/warningCount', diagnosticsResult: '/content/0/text/result/diagnostics'};
  assert.equal(batchStatus(event(verified(), 'compile', 5, d)).compilation, 'passed');
  d.evidence.result.decoy = 1;
  d.bindings.errorCountResult = '/decoy';
  assert.throws(() => event(verified(), 'compile', 5, d), /显式编译指针/);
});

test('legacy text diagnostic field requires explicit message binding', () => {
  const d: any = compileData();
  d.warningCount = d.evidence.result.result.warningCount = 1;
  d.diagnostics = [{severity: 'warning', message: 'Build warning'}];
  d.evidence.result.result.diagnostics = [{severity: 'Warning', text: 'Build warning'}];
  assert.throws(() => event(verified(), 'compile', 5, d), /诊断内容/);
  d.bindings = {fullBuildArgument: '/fullBuild', errorCountResult: '/result/errorCount',
    warningCountResult: '/result/warningCount', diagnosticsResult: '/result/diagnostics', messageKey: 'text'};
  assert.equal(batchStatus(event(verified(), 'compile', 5, d)).compilation, 'passed');
});

test('bridge transport failures record failed without invented zero diagnostics', () => {
  const d: any = compileData();
  d.evidence.result = {ok: false, error: {code: 'IDE_ERROR', message: 'Lost connection', partial: false}};
  d.errorCount = null; d.warningCount = null; d.diagnostics = null;
  assert.equal(batchStatus(event(verified(), 'compile', 5, d)).compilation, 'failed');
});
