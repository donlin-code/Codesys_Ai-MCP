import test from 'node:test';
import assert from 'node:assert/strict';
import { appendEvent, batchStatus, prepareBatch, validateBatch, type Batch, type BatchEvent } from '../src/batch.js';
import type { Snapshot } from '../src/model.js';
import { snapshotHash } from '../src/snapshot.js';

const path = 'Device.Application.PRG_Test';
const before = 'PROGRAM PRG_Test\nVAR\nx:BOOL;\nEND_VAR\nx := FALSE;\n';
const after = before.replace('FALSE', 'TRUE');
const time = (n: number) => new Date(Date.UTC(2026, 9, 23, 10, 0, n)).toISOString();
function snapshot(text = before, n = 0): Snapshot {
  return { schemaVersion: 1, origin: 'fixture', capturedAt: time(n),
    identity: { projectPath: 'C:\\Tests\\Smoke.project', applicationPath: 'Device.Application', ideVersion: '3.5.22.30', pluginVersion: 'fixture' },
    treeComplete: true, inventory: [{ path, type: 'POU', language: 'ST' }],
    objects: [{ path, type: 'POU', language: 'ST', status: 'read', complete: true, text }], evidence: [] };
}
function prepared(): Batch { return prepareBatch(snapshot(), { schemaVersion: 1, changes: [{ path, type: 'POU', language: 'ST', text: after }] }, time(0)); }
function event(batch: Batch, type: BatchEvent['type'], n: number, data: Record<string, unknown>): Batch {
  return appendEvent(batch, { type, at: time(n), data });
}
function approved(): Batch {
  const b = prepared();
  return event(b, 'approve', 1, { actor: 'user', confirmation: 'fixture: approve this exact batch', planHash: b.plan.planHash });
}
function started(): Batch { return event(approved(), 'start', 2, { operationId: 'op-1', snapshot: snapshot(before, 2) }); }
function verified(): Batch {
  let b = event(started(), 'result', 3, { operationId: 'op-1', outcome: 'applied', evidence: { tool: 'replace_text_in_structured_text', arguments: { path }, result: { isError: false } } });
  return event(b, 'readback', 4, { operationId: 'op-1', snapshot: snapshot(after, 4) });
}
function compileData(n = 5): Record<string, unknown> {
  return { mode: 'full', snapshot: snapshot(after, n), sourceSnapshotHash: snapshotHash(snapshot(after, n)), toolError: false, errorCount: 0, warningCount: 0, diagnostics: [],
    bindings: { fullBuildArgument: '/fixtureFullBuild', errorCountResult: '/errorCount', warningCountResult: '/warningCount', diagnosticsResult: '/diagnostics' },
    evidence: { tool: 'check_for_errors', capturedAt: time(n), arguments: { fixtureFullBuild: true }, result: { isError: false, fixture: true, errorCount: 0, warningCount: 0, diagnostics: [] } } };
}

test('full workflow separates confirmation, readback, compile and persistence', () => {
  assert.equal(batchStatus(prepared()).approved, false);
  let b = verified();
  assert.equal(batchStatus(b).readbackVerified, true);
  assert.equal(batchStatus(b).compilation, 'not-run');
  b = event(b, 'compile', 5, compileData());
  assert.equal(batchStatus(b).compilation, 'passed');
  assert.equal(batchStatus(b).persistence, 'not-verified');
  b = event(b, 'reopened', 6, { snapshot: snapshot(after, 6), savedAndReopened: true, confirmation: 'fixture saved and reopened' });
  assert.equal(batchStatus(b).persistence, 'verified');
  assert.equal(b.plan.origin, 'fixture');
});

test('approval is bound to the plan; edits and stale approval cannot pass', () => {
  let b = prepared();
  assert.throws(() => event(b, 'start', 1, { operationId: 'op-1', snapshot: snapshot(before, 1) }), /未确认/);
  assert.throws(() => event(b, 'approve', 1, { actor: 'user', confirmation: 'yes', planHash: 'wrong' }), /哈希/);
  b = approved();
  b.plan.operations[0]!.text += 'changed';
  assert.throws(() => validateBatch(b), /计划已改变/);
});

test('human change or switched project after approval blocks execution', () => {
  const b = approved();
  assert.throws(() => event(b, 'start', 2, { operationId: 'op-1', snapshot: snapshot('human edit', 2) }), /冲突/);
  const switched = snapshot(before, 2); switched.identity.projectPath = 'C:\\Other.project';
  assert.throws(() => event(b, 'start', 2, { operationId: 'op-1', snapshot: switched }), /批次失效/);
  assert.throws(() => event(b, 'start', 2, { operationId: 'op-1', snapshot: snapshot(before, 0) }), /重新读取/);
  assert.throws(() => event(b, 'start', 400, { operationId: 'op-1', snapshot: snapshot(before, 2) }), /5分钟/);
});

test('timeout requires reconciliation, and may not blindly retry', () => {
  let b = event(started(), 'result', 3, { operationId: 'op-1', outcome: 'unknown', evidence: { tool: 'replace_text_in_structured_text', arguments: { path }, result: { error: 'timeout' } } });
  assert.equal(batchStatus(b).operations['op-1'], 'unknown');
  assert.throws(() => event(b, 'start', 4, { operationId: 'op-1', snapshot: snapshot(before, 4) }), /尚未执行/);
  b = event(b, 'readback', 4, { operationId: 'op-1', snapshot: snapshot(after, 4) });
  assert.equal(batchStatus(b).operations['op-1'], 'verified');
});

test('partial write halts, preserving unknown vs not-applied status', () => {
  const b = event(started(), 'result', 3, { operationId: 'op-1', outcome: 'applied', evidence: { tool: 'replace_text_in_structured_text', arguments: { path }, result: {} } });
  const partial = event(b, 'readback', 4, { operationId: 'op-1', snapshot: snapshot('partial change', 4) });
  assert.equal(batchStatus(partial).halted, true);
  assert.equal(batchStatus(partial).operations['op-1'], 'unknown');
  const unchanged = event(b, 'readback', 4, { operationId: 'op-1', snapshot: snapshot(before, 4) });
  assert.equal(batchStatus(unchanged).operations['op-1'], 'failed');
});

test('failed result halts even if later text looks correct', () => {
  let b = event(started(), 'result', 3, { operationId: 'op-1', outcome: 'failed', evidence: { tool: 'replace_text_in_structured_text', arguments: { path }, result: { isError: true } } });
  b = event(b, 'readback', 4, { operationId: 'op-1', snapshot: snapshot(after, 4) });
  assert.equal(batchStatus(b).halted, true);
  assert.throws(() => event(b, 'compile', 5, compileData()), /回读一致/);
});

test('full compiler diagnostics override transport success', () => {
  const b = verified();
  const d = compileData(); d.errorCount = 1; d.diagnostics = [{ severity: 'error', message: 'C0006: expected expression', objectPath: path, line: 5 }];
  const raw = (d.evidence as Record<string, unknown>).result as Record<string, unknown>;
  raw.errorCount = 1; raw.diagnostics = d.diagnostics;
  assert.equal(batchStatus(event(b, 'compile', 5, d)).compilation, 'failed');
  assert.throws(() => event(b, 'compile', 5, { ...d, errorCount: 0 }), /诊断条数/);
  assert.throws(() => event(b, 'compile', 5, { ...d, mode: 'precompile' }), /完整编译/);
  assert.throws(() => event(b, 'reopened', 6, { snapshot: snapshot(after, 6), savedAndReopened: true, confirmation: 'saved' }), /完整编译通过/);
});

test('reopened comparison catches unsaved or changed code', () => {
  const b = event(verified(), 'compile', 5, compileData());
  assert.throws(() => event(b, 'reopened', 6, { snapshot: snapshot(before, 6), savedAndReopened: true, confirmation: 'saved' }), /冲突/);
});

test('creation requires complete tree, and conflicts are rejected', () => {
  const s = snapshot(); s.treeComplete = false;
  const change = { schemaVersion: 1, changes: [{ path: 'Device.Application.New', type: 'GVL', language: 'ST', text: 'VAR_GLOBAL\nx:BOOL;\nEND_VAR' }] };
  assert.throws(() => prepareBatch(s, change, time(0)), /工程树未读全/);
  const p = prepareBatch(snapshot(), change, time(0));
  assert.equal(p.plan.operations[0]!.kind, 'create');
});

test('a multi-object batch cannot advance until the previous write is verified', () => {
  const s = snapshot();
  s.inventory.push({ path: 'Device.Application.P2', type: 'POU', language: 'ST' });
  s.objects.push({ ...s.objects[0]!, path: 'Device.Application.P2' });
  let b = prepareBatch(s, { schemaVersion: 1, changes: s.inventory.map(o => ({ ...o, text: after })) }, time(0));
  b = event(b, 'approve', 1, { actor: 'user', confirmation: 'fixture', planHash: b.plan.planHash });
  const s2 = structuredClone(s); s2.capturedAt = time(2);
  b = event(b, 'start', 2, { operationId: 'op-1', snapshot: s2 });
  assert.throws(() => event(b, 'start', 3, { operationId: 'op-2', snapshot: s2 }), /先回读/);
});

test('compiler summaries cannot contradict raw arguments, results, timestamp or source fingerprint', () => {
  const b = verified();
  let d = compileData();
  ((d.evidence as any).arguments).fixtureFullBuild = false;
  assert.throws(() => event(b, 'compile', 5, d), /没有请求完整编译/);
  d = compileData(); (d.evidence as any).result.errorCount = 1;
  assert.throws(() => event(b, 'compile', 5, d), /原始编译结果不符/);
  d = compileData(); (d.evidence as any).capturedAt = time(0);
  assert.throws(() => event(b, 'compile', 5, d), /证据时间/);
  d = compileData(); d.sourceSnapshotHash = 'stale';
  assert.throws(() => event(b, 'compile', 5, d), /源码快照哈希/);
});

test('reopen invalidates prior compilation when an unedited dependency changes', () => {
  const dependency = { path: 'Device.Application.GVL_Dep', type: 'GVL', language: 'ST' };
  function withDependency(s: Snapshot, text: string) {
    s.inventory.push(dependency);
    s.objects.push({ ...dependency, status: 'read', complete: true, text });
    return s;
  }
  const d = compileData(); d.snapshot = withDependency(snapshot(after, 5), 'VAR_GLOBAL x:BOOL; END_VAR');
  d.sourceSnapshotHash = snapshotHash(d.snapshot as Snapshot);
  const b = event(verified(), 'compile', 5, d);
  assert.throws(() => event(b, 'reopened', 6, { snapshot: withDependency(snapshot(after, 6), 'INVALID ST'), savedAndReopened: true, confirmation: 'saved' }), /依赖源码改变/);
});

test('write evidence must identify the planned object', () => {
  assert.throws(() => event(started(), 'result', 3, { operationId: 'op-1', outcome: 'applied', evidence: {
    tool: 'replace_text_in_structured_text', arguments: { path: 'OtherApplication.Wrong' }, result: {} } }), /路径与本批对象不一致/);
});

test('compiler transport failures are recorded without inventing diagnostic counts', () => {
  const d = compileData();
  d.toolError = true; d.errorCount = null; d.warningCount = null;
  (d.evidence as any).result = { isError: true, content: [{ type: 'text', text: 'IDE connection closed' }] };
  delete d.bindings;
  assert.equal(batchStatus(event(verified(), 'compile', 5, d)).compilation, 'failed');
});

test('creation requires new tree evidence, not just a refreshed snapshot timestamp', () => {
  const s = snapshot(); s.origin = 'ide';
  s.objects[0]!.evidenceIds = ['source'];
  s.evidence = [
    { id: 'source', tool: 'get_structured_text_content', arguments: { path }, result: { source: before }, capturedAt: time(0) },
    { id: 'tree', tool: 'browse_project_tree', arguments: {}, result: { paths: [path] }, capturedAt: time(0) }
  ];
  let b = prepareBatch(s, { schemaVersion: 1, changes: [{ path: 'Device.Application.New', type: 'GVL', language: 'ST', text: 'VAR_GLOBAL x:BOOL; END_VAR' }] }, time(0));
  b = event(b, 'approve', 1, { actor: 'user', confirmation: 'test confirmation', planHash: b.plan.planHash });
  s.capturedAt = time(2);
  assert.throws(() => event(b, 'start', 2, { operationId: 'op-1', snapshot: s }), /完整工程树的原始证据/);
});
