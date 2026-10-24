import { randomUUID } from 'node:crypto';
import type { Identity, Snapshot } from './model.js';
import { canonicalJson, fingerprint, identityKey, objectMap, snapshotHash, validateSnapshot } from './snapshot.js';
import { pointer, toolObjectPath, verifyCompileEvidence } from './evidence.js';

export interface Change { path: string; type: string; language: string; text: string }
export interface ChangeRequest { schemaVersion: 1; changes: Change[] }
export interface Operation extends Change {
  id: string; kind: 'create' | 'replace'; before: string | null;
  beforeHash: string | null; afterHash: string;
}
export interface Plan {
  schemaVersion: 1; id: string; createdAt: string; origin: 'ide' | 'fixture';
  identity: Identity; baselineHash: string; operations: Operation[]; planHash: string;
}
export interface BatchEvent { type: 'approve' | 'start' | 'result' | 'readback' | 'compile' | 'reopened'; at: string; data: Record<string, unknown> }
export interface Batch { schemaVersion: 1; baseline: Snapshot; plan: Plan; events: BatchEvent[] }
export type OperationState = 'planned' | 'executing' | 'applied' | 'verified' | 'failed' | 'unknown';
export interface BatchState {
  approved: boolean; halted: boolean; operations: Record<string, OperationState>;
  readbackVerified: boolean; compilation: 'not-run' | 'passed' | 'failed';
  persistence: 'not-verified' | 'verified';
}

function fail(message: string): never { throw new Error(message); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须为对象`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} 必须为非空字符串`);
  return value;
}
function date(value: unknown, label: string): number {
  const parsed = Date.parse(string(value, label));
  if (!Number.isFinite(parsed)) fail(`${label} 必须为有效时间`);
  return parsed;
}
function fullText(snapshot: Snapshot, path: string): string {
  const obj = objectMap(snapshot).get(path);
  if (!obj || obj.status !== 'read' || !obj.complete || typeof obj.text !== 'string') fail(`对象未完整读取: ${path}`);
  return obj.text;
}

const bridgeWriteTools = new Set(['codesys_replace_st', 'codesys_create_st']);
function bridgeEnvelope(raw: unknown): Record<string, unknown> {
  const root = record(raw, '原始桥接返回');
  if (root.content !== undefined) {
    if (!Array.isArray(root.content) || root.content.length !== 1) fail('桥接 MCP 返回必须包含唯一 JSON text 内容');
    const block = record(root.content[0], 'MCP text');
    if (block.type !== 'text' || typeof block.text !== 'string') fail('桥接 MCP 返回缺少 JSON text');
    try { return record(JSON.parse(block.text), '桥接返回'); }
    catch { fail('桥接 MCP text 不是有效对象 JSON'); }
  }
  return root;
}
function sourceParts(value: Record<string, unknown>, label: string): { declaration: string; implementation: string; text: string; sha256: string } {
  if (typeof value.declaration !== 'string' || typeof value.implementation !== 'string') fail(`${label} 缺少声明或实现原文`);
  const declaration = value.declaration, implementation = value.implementation;
  return {declaration, implementation, text: declaration + (implementation ? '\n' + implementation : ''),
    sha256: fingerprint(declaration + '\0' + implementation)};
}
function bridgeWritePath(tool: Record<string, unknown>): string {
  const args = record(tool.arguments, '写入 arguments');
  if (tool.tool === 'codesys_create_st') {
    const parent = string(args.parentPath, 'parentPath'), name = string(args.name, 'name');
    if (!parent.startsWith('/') || (parent !== '/' && parent.endsWith('/'))) fail('create parentPath 必须为转义后的绝对对象路径');
    return (parent === '/' ? '' : parent) + '/' + name.replaceAll('~', '~0').replaceAll('/', '~1');
  }
  const path = string(args.path, 'path');
  if (tool.pathArgumentPointer !== undefined && toolObjectPath(args, tool.pathArgumentPointer) !== path) fail('桥接 pathArgumentPointer 与实际 path 参数不一致');
  return path;
}
function verifyBridgeWrite(tool: Record<string, unknown>, operation: Operation, snapshot: Snapshot): void {
  const envelope = bridgeEnvelope(tool.result);
  if ((tool.result as {isError?: boolean})?.isError === true || envelope.ok !== true) fail('桥接工具失败不能记录 applied');
  const raw = record(envelope.result, '桥接写入结果'), args = record(tool.arguments, '桥接写入参数');
  if ((tool.tool === 'codesys_create_st') !== (operation.kind === 'create')) fail('桥接写入类型与计划不符');
  if (raw.verified !== true || raw.saved !== false || raw.created !== (operation.kind === 'create')) fail('桥接写入缺少 verified/created/saved 原始证据');
  const readback = record(raw.readback, '桥接 readback'), source = sourceParts(readback, '桥接 readback');
  if (readback.path !== operation.path || readback.complete !== true || readback.text !== source.text || readback.sha256 !== source.sha256)
    fail('桥接 readback 路径、完整性或源码指纹不符');
  const submitted = sourceParts(args, '桥接提交');
  const declaration = submitted.declaration.replace(/\r\n?/g, '\n'), implementation = submitted.implementation.replace(/\r\n?/g, '\n');
  const expectedText = declaration + (implementation ? '\n' + implementation : '');
  if (expectedText !== operation.text || source.declaration !== declaration || source.implementation !== implementation) fail('桥接写入参数或 readback 与已确认计划源码不符');
  if (record(envelope.projectIdentity, '桥接 projectIdentity').path !== snapshot.identity.projectPath) fail('桥接结果来自不同工程');
  if (operation.kind === 'replace') {
    if (typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedSha256) || raw.beforeSha256 !== args.expectedSha256) fail('桥接写入基线指纹不符');
    const prior = objectMap(snapshot).get(operation.path);
    const proofs = snapshot.evidence.filter(e => prior?.evidenceIds?.includes(e.id) && e.tool === 'codesys_read_object');
    if (!proofs.length) fail('桥接替换需要本次写入前原始声明/实现读取证据');
    for (const proof of proofs) {
      const previousEnvelope = bridgeEnvelope(proof.result);
      if (previousEnvelope.ok !== true) fail('写入前桥接读取失败');
      if (record(previousEnvelope.projectIdentity, '写入前 projectIdentity').path !== snapshot.identity.projectPath) fail('写入前桥接读取来自不同工程');
      const previous = record(previousEnvelope.result, '写入前源码'), parts = sourceParts(previous, '写入前源码');
      if (previous.path !== operation.path || previous.sha256 !== parts.sha256 || parts.text !== operation.before || parts.sha256 !== args.expectedSha256)
        fail('桥接 expectedSha256 与写入前读取的声明/实现不一致');
    }
  } else {
    if (raw.beforeSha256 !== null || typeof args.expectedChildrenSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedChildrenSha256)) fail('桥接创建缺少父节点基线指纹');
    const trees = snapshot.evidence.filter(e => e.tool === 'codesys_list_objects');
    if (!trees.length) fail('桥接创建需要本次写入前父节点清单原始证据');
    for (const proof of trees) {
      const treeEnvelope = bridgeEnvelope(proof.result), tree = record(treeEnvelope.result, '创建前工程树');
      if (treeEnvelope.ok !== true || tree.treeComplete !== true || !Array.isArray(tree.objects)) fail('创建前工程树证据不完整');
      const parent = args.parentPath === '/' ? {childrenSha256: tree.rootChildrenSha256}
        : tree.objects.find(value => record(value, 'tree object').path === args.parentPath);
      if (!parent || record(parent, 'parent').childrenSha256 !== args.expectedChildrenSha256) fail('桥接父节点基线与创建前清单不一致');
    }
  }
}

function bridgeSeverity(value: unknown): string {
  const aliases: Record<string, string> = {error: 'error', fatal: 'error', fatalerror: 'error', warning: 'warning', info: 'info', information: 'info', text: 'info'};
  const severity = typeof value === 'string' ? aliases[value.toLowerCase()] : undefined;
  if (!severity) fail('未知的原始编译诊断级别');
  return severity;
}
function verifyBridgeCompile(data: Record<string, unknown>, tool: Record<string, unknown>, snapshot: Snapshot, eventAt: string): boolean {
  const args = record(tool.arguments, 'compile arguments');
  if (args.applicationPath !== snapshot.identity.applicationPath || args.fullBuild !== true) fail('实际桥接参数没有请求目标 Application 的完整编译');
  if ((tool.result as {isError?: boolean})?.isError === true || data.toolError === true) return false;
  const envelope = bridgeEnvelope(tool.result);
  if (envelope.ok === false) return false;
  if (envelope.ok !== true) fail('缺少原始桥接编译成功状态');
  if (record(envelope.projectIdentity, 'compile projectIdentity').path !== snapshot.identity.projectPath) fail('编译结果来自不同工程');
  const result = record(envelope.result, 'compile result');
  if (result.applicationPath !== args.applicationPath || result.fullBuild !== true || typeof result.rebuildReturned !== 'boolean' || typeof result.success !== 'boolean') fail('桥接编译返回缺少完整编译结果字段');
  const completed = date(result.completedAt, 'compile.result.completedAt');
  if (completed < date(snapshot.capturedAt, 'snapshot.capturedAt') || completed > date(tool.capturedAt, 'compile.evidence.capturedAt') + 2000 || completed > date(eventAt, 'event.at') + 2000) fail('原始编译完成时间与当前源码不一致');
  if (result.errorCount !== data.errorCount || result.warningCount !== data.warningCount || !Array.isArray(result.diagnostics)) fail('归一化错误/警告总数与原始编译结果不符');
  const diagnostics = data.diagnostics as Array<Record<string, unknown>>;
  if (result.diagnostics.length !== diagnostics.length) fail('编译诊断与原始结果条数不符');
  const bindings = data.bindings === undefined ? undefined : record(data.bindings, 'bindings');
  const messageKey = bindings?.messageKey === 'text' ? 'text' : 'message';
  let errors = 0, warnings = 0;
  for (let i = 0; i < result.diagnostics.length; i++) {
    const raw = record(result.diagnostics[i], '原始 diagnostic'), severity = bridgeSeverity(raw.severity);
    if (severity === 'error') errors++;
    if (severity === 'warning') warnings++;
    if (severity !== diagnostics[i]?.severity || raw[messageKey] !== diagnostics[i]?.message) fail('编译诊断内容与原始结果不符');
  }
  if (errors !== result.errorCount || warnings !== result.warningCount) fail('原始诊断条数与错误/警告总数不符');
  if (bindings) {
    const expected = {fullBuildArgument: args.fullBuild, errorCountResult: result.errorCount, warningCountResult: result.warningCount, diagnosticsResult: result.diagnostics};
    for (const [key, value] of Object.entries(expected)) {
      if (typeof bindings[key] !== 'string') fail(`缺少编译证据绑定 ${key}`);
      const actual = pointer(key === 'fullBuildArgument' ? tool.arguments : tool.result, bindings[key] as string);
      if (canonicalJson(actual) !== canonicalJson(value)) fail('显式编译指针与实际桥接字段不一致');
    }
  }
  if (result.success && (!result.rebuildReturned || result.errorCount !== 0 || (result.exception !== null && result.exception !== undefined))) fail('原始编译 success 与返回状态/错误数矛盾');
  return result.success === true && result.rebuildReturned === true;
}

export function validateChanges(input: unknown): ChangeRequest {
  const r = record(input, 'changes');
  if (r.schemaVersion !== 1 || !Array.isArray(r.changes) || !r.changes.length) fail('changes 需要 schemaVersion:1 和非空 changes 数组');
  const seen = new Set<string>();
  const changes = r.changes.map((item: unknown) => {
    const c = record(item, 'change');
    const path = string(c.path, 'path');
    if (seen.has(path)) fail(`重复修改对象: ${path}`);
    seen.add(path);
    if (typeof c.text !== 'string') fail(`修改必须包含完整 text: ${path}`);
    const language = string(c.language, 'language');
    if (!['ST', 'Structured Text'].includes(language)) fail(`v0.1 只修改 ST: ${path}`);
    return { path, type: string(c.type, 'type'), language, text: c.text };
  });
  return { schemaVersion: 1, changes };
}

function buildPlan(snapshot: Snapshot, changes: ChangeRequest, id: string, createdAt: string): Plan {
  const objects = objectMap(snapshot);
  const operations: Operation[] = [];
  for (const change of changes.changes) {
    const previous = objects.get(change.path);
    const inventory = snapshot.inventory.find(o => o.path === change.path);
    if (inventory && !previous) fail(`基线缺少对象内容: ${change.path}`);
    if (previous && (previous.type !== change.type || previous.language !== change.language)) fail(`禁止隐式改变对象类型/语言: ${change.path}`);
    if (!previous && !snapshot.treeComplete) fail('工程树未读全，不能证明新增对象不存在');
    const before = previous ? fullText(snapshot, change.path) : null;
    if (before === change.text) continue;
    operations.push({ ...change, id: `op-${operations.length + 1}`, kind: previous ? 'replace' : 'create', before,
      beforeHash: before === null ? null : fingerprint(before), afterHash: fingerprint(change.text) });
  }
  if (!operations.length) fail('没有实际修改');
  const body = { schemaVersion: 1 as const, id, createdAt, origin: snapshot.origin, identity: snapshot.identity,
    baselineHash: snapshotHash(snapshot), operations };
  return { ...body, planHash: fingerprint(canonicalJson(body)) };
}

export function prepareBatch(input: unknown, request: unknown, now = new Date().toISOString()): Batch {
  const baseline = validateSnapshot(input);
  date(now, 'createdAt');
  return { schemaVersion: 1, baseline, plan: buildPlan(baseline, validateChanges(request), randomUUID(), now), events: [] };
}

function currentSnapshot(batch: Batch, input: unknown, at: string, after: string): Snapshot {
  const snapshot = validateSnapshot(input);
  if (identityKey(snapshot.identity) !== identityKey(batch.plan.identity) || snapshot.origin !== batch.plan.origin) fail('工程、Application、版本或证据来源改变，批次失效');
  const time = date(snapshot.capturedAt, 'snapshot.capturedAt');
  const eventTime = date(at, 'event.at');
  if (time < date(after, 'after') || time > eventTime + 2000 || eventTime - time > 300000) fail('必须在确认/上次操作之后重新读取当前工程（快照不得超过5分钟）');
  if (snapshot.origin === 'ide') {
    const evidence = new Map(snapshot.evidence.map(item => [item.id, item]));
    for (const op of batch.plan.operations) {
      const obj = objectMap(snapshot).get(op.path);
      for (const id of obj?.evidenceIds ?? []) {
        if (date(evidence.get(id)?.capturedAt, 'evidence.capturedAt') < date(after, 'after')) fail(`必须重新采集对象原始工具证据，不能只更新快照时间: ${op.path}`);
      }
    }
    if (batch.plan.operations.some(op => op.kind === 'create')) {
      const tree = snapshot.evidence.filter(item => ['browse_project_tree', 'codesys_list_objects'].includes(item.tool));
      if (!tree.length || tree.some(item => date(item.capturedAt, 'tree.capturedAt') < date(after, 'after'))) fail('新增对象必须重新采集完整工程树的原始证据，不能只更新时间');
    }
  }
  return snapshot;
}

function matchTargets(batch: Batch, snapshot: Snapshot, state: BatchState, allAfter: boolean): void {
  const map = objectMap(snapshot);
  for (const op of batch.plan.operations) {
    const after = allAfter || state.operations[op.id] === 'verified';
    const expected = after ? op.afterHash : op.beforeHash;
    if (expected === null) {
      if (!snapshot.treeComplete || map.has(op.path) || snapshot.inventory.some(o => o.path === op.path)) fail(`新增对象冲突或工程树不完整: ${op.path}`);
    } else {
      const current = map.get(op.path);
      if (current?.type !== op.type || current.language !== op.language || fingerprint(fullText(snapshot, op.path)) !== expected) fail(`源码基线冲突: ${op.path}`);
    }
  }
}

function eventState(batch: Batch): BatchState {
  const state: BatchState = { approved: false, halted: false, operations: Object.fromEntries(batch.plan.operations.map(o => [o.id, 'planned'])),
    readbackVerified: false, compilation: 'not-run', persistence: 'not-verified' };
  let previousAt = batch.plan.createdAt;
  let lastMutation = batch.plan.createdAt;
  let compiledSources: string | undefined;
  const startSnapshots = new Map<string, Snapshot>();
  const sourceState = (s: Snapshot) => fingerprint(canonicalJson({ identity: s.identity, origin: s.origin, treeComplete: s.treeComplete,
    inventory: s.inventory, objects: s.objects.map(o => ({ path: o.path, type: o.type, language: o.language, status: o.status, text: o.text ?? null, reason: o.reason ?? null })) }));
  for (const event of batch.events) {
    if (date(event.at, 'event.at') < date(previousAt, 'previousAt')) fail('事件时间必须递增');
    const d = record(event.data, 'event.data');
    if (event.type === 'approve') {
      if (state.approved || d.planHash !== batch.plan.planHash) fail('确认必须绑定未确认的当前计划哈希');
      if (d.actor !== 'user') fail('确认必须由 user 提供，CLI 不代替用户批准');
      string(d.confirmation, 'confirmation');
      state.approved = true;
      lastMutation = event.at;
    } else if (event.type === 'start') {
      if (!state.approved || state.halted) fail('批次未确认或已停止');
      const opId = string(d.operationId, 'operationId');
      if (state.operations[opId] !== 'planned') fail('只能开始尚未执行的操作');
      if (Object.values(state.operations).some(s => s !== 'planned' && s !== 'verified')) fail('先回读并核实上一项操作，不得继续写入');
      const next = batch.plan.operations.find(o => state.operations[o.id] === 'planned');
      if (next?.id !== opId) fail('必须按已确认计划的顺序执行');
      const startSnapshot = currentSnapshot(batch, d.snapshot, event.at, previousAt);
      matchTargets(batch, startSnapshot, state, false);
      startSnapshots.set(opId, startSnapshot);
      state.operations[opId] = 'executing';
      state.readbackVerified = false;
      state.compilation = 'not-run';
      state.persistence = 'not-verified';
      lastMutation = event.at;
    } else if (event.type === 'result') {
      const id = string(d.operationId, 'operationId');
      if (state.operations[id] !== 'executing') fail('result 必须对应已开始的操作');
      const tool = record(d.evidence, 'evidence');
      if (!['replace_text_in_structured_text', 'create_or_replace_structured_text_object', ...bridgeWriteTools].includes(String(tool.tool))) fail('result 必须对应 ST 写入工具');
      if (!('arguments' in tool) || !('result' in tool)) fail('必须保留工具参数和原始结果');
      const operation = batch.plan.operations.find(o => o.id === id)!;
      const nativeBridge = bridgeWriteTools.has(String(tool.tool));
      if ((nativeBridge ? bridgeWritePath(tool) : toolObjectPath(tool.arguments, tool.pathArgumentPointer)) !== operation.path) fail('写入工具参数路径与本批对象不一致');
      if (!['applied', 'failed', 'unknown'].includes(String(d.outcome))) fail('无效的操作结果');
      const result = tool.result as { isError?: boolean } | null;
      if (d.outcome === 'applied' && result?.isError === true) fail('工具报错不能记录 applied');
      if (d.outcome === 'applied' && nativeBridge) verifyBridgeWrite(tool, operation, startSnapshots.get(id)!);
      state.operations[id] = d.outcome as OperationState;
      if (d.outcome === 'failed') state.halted = true;
      lastMutation = event.at;
    } else if (event.type === 'readback') {
      const id = string(d.operationId, 'operationId');
      if (!['executing', 'applied', 'failed', 'unknown'].includes(state.operations[id])) fail('readback 必须对应已尝试写入的操作');
      const op = batch.plan.operations.find(o => o.id === id)!;
      const snapshot = currentSnapshot(batch, d.snapshot, event.at, lastMutation);
      const obj = objectMap(snapshot).get(op.path);
      const actual = obj ? fingerprint(fullText(snapshot, op.path)) : null;
      if (!obj && !snapshot.treeComplete) fail('工程树不完整，无法判断对象是否存在');
      if (obj && (obj.type !== op.type || obj.language !== op.language)) fail('回读对象类型改变');
      if (actual === op.afterHash) state.operations[id] = 'verified';
      else {
        state.operations[id] = actual === op.beforeHash ? 'failed' : 'unknown';
        state.halted = true;
      }
      state.readbackVerified = Object.values(state.operations).every(s => s === 'verified');
    } else if (event.type === 'compile') {
      if (!state.readbackVerified || state.halted) fail('所有目标回读一致后才能记录编译验证');
      if (d.mode !== 'full') fail('必须显式执行完整编译，预编译检查不能作为验收');
      const snapshot = currentSnapshot(batch, d.snapshot, event.at, lastMutation);
      matchTargets(batch, snapshot, state, true);
      const tool = record(d.evidence, 'evidence');
      if (!['check_for_errors', 'codesys_compile'].includes(String(tool.tool)) || !('arguments' in tool) || !('result' in tool)) fail('需要 check_for_errors 或 codesys_compile 原始调用和返回');
      if (typeof d.toolError !== 'boolean') fail('必须明确记录编译工具是否报错');
      const compileTime = date(tool.capturedAt, 'compile.evidence.capturedAt');
      if (compileTime < date(snapshot.capturedAt, 'snapshot.capturedAt') || compileTime < date(lastMutation, 'lastMutation') || compileTime > date(event.at, 'event.at') + 2000) fail('编译证据时间必须在当前源码采集和修改之后');
      if (d.sourceSnapshotHash !== snapshotHash(snapshot)) fail('编译结果必须绑定当前源码快照哈希');
      const rawError = (tool.result as { isError?: boolean } | null)?.isError === true;
      const bridgeError = tool.tool === 'codesys_compile' && !rawError && bridgeEnvelope(tool.result).ok === false;
      if (d.toolError || rawError || bridgeError) {
        if (tool.tool === 'codesys_compile') verifyBridgeCompile(d, tool, snapshot, event.at);
        // A failed tool call may have no compiler counts at all. Preserve the
        // failure instead of asking the operator to invent a zero-error report.
        state.compilation = 'failed';
        state.persistence = 'not-verified';
        compiledSources = undefined;
        previousAt = event.at;
        continue;
      }
      for (const key of ['errorCount', 'warningCount']) if (!Number.isInteger(d[key]) || Number(d[key]) < 0) fail(`${key} 必须为非负整数`);
      if (!Array.isArray(d.diagnostics)) fail('需要完整 diagnostics 数组');
      const diagnostics = d.diagnostics.map(v => record(v, 'diagnostic'));
      for (const item of diagnostics) {
        string(item.message, 'diagnostic.message');
        if (!['error', 'warning', 'info'].includes(String(item.severity))) fail('无效诊断级别');
      }
      if (diagnostics.filter(v => v.severity === 'error').length !== d.errorCount || diagnostics.filter(v => v.severity === 'warning').length !== d.warningCount) fail('诊断条数与错误/警告总数不符，不能接受截断结果');
      const bridgePassed = tool.tool === 'codesys_compile' ? verifyBridgeCompile(d, tool, snapshot, event.at) : true;
      if (tool.tool === 'check_for_errors') verifyCompileEvidence(d, tool);
      state.compilation = Number(d.errorCount) > 0 || !bridgePassed ? 'failed' : 'passed';
      compiledSources = sourceState(snapshot);
      state.persistence = 'not-verified';
    } else if (event.type === 'reopened') {
      if (state.compilation !== 'passed' || state.halted) fail('完整编译通过后再验证保存重开');
      if (d.savedAndReopened !== true) fail('需要用户实际保存、关闭并重开后的确认');
      string(d.confirmation, 'confirmation');
      const snapshot = currentSnapshot(batch, d.snapshot, event.at, previousAt);
      matchTargets(batch, snapshot, state, true);
      if (sourceState(snapshot) !== compiledSources) fail('保存重开后的工程清单或已读取依赖源码改变，须重新完整编译');
      state.persistence = 'verified';
    } else fail(`不支持的事件类型: ${String(event.type)}`);
    previousAt = event.at;
  }
  return state;
}

export function validateBatch(input: unknown): Batch {
  const b = record(input, 'batch');
  if (b.schemaVersion !== 1 || !Array.isArray(b.events)) fail('无效 batch');
  const baseline = validateSnapshot(b.baseline);
  const p = record(b.plan, 'plan');
  if (!Array.isArray(p.operations) || !p.operations.length) fail('缺少 operations');
  const changes = validateChanges({ schemaVersion: 1, changes: p.operations });
  date(p.createdAt, 'plan.createdAt');
  const expected = buildPlan(baseline, changes, string(p.id, 'id'), string(p.createdAt, 'createdAt'));
  // Compare the complete immutable plan, not only a caller-supplied hash.
  if (canonicalJson(p) !== canonicalJson(expected)) fail('计划已改变或哈希不符，必须重新 prepare 并确认');
  const batch = { schemaVersion: 1 as const, baseline, plan: expected, events: b.events as BatchEvent[] };
  eventState(batch);
  return batch;
}

export function appendEvent(input: unknown, event: BatchEvent): Batch {
  const batch = validateBatch(input);
  const next = { ...batch, events: [...batch.events, event] };
  eventState(next);
  return next;
}

export function batchStatus(input: unknown): BatchState { return eventState(validateBatch(input)); }

export function renderBatchReport(input: unknown): string {
  const batch = validateBatch(input);
  const state = batchStatus(batch);
  const lines = ['# CODESYS 修改批次', '', `批次：${batch.plan.id}`, `计划哈希：${batch.plan.planHash}`,
    `证据来源：${batch.plan.origin === 'fixture' ? '离线演示（不是 IDE 验收）' : 'IDE 工具采集'}`,
    `工程：${batch.plan.identity.projectPath}`, `Application：${batch.plan.identity.applicationPath}`, '',
    `用户已确认：${state.approved}；已停止：${state.halted}`,
    `回读一致：${state.readbackVerified}；完整编译：${state.compilation}；保存重开：${state.persistence}`, '',
    '| 对象 | 操作 | 状态 |', '|---|---|---|'];
  for (const op of batch.plan.operations) lines.push(`| ${op.path.replaceAll('|', '\\|')} | ${op.kind} | ${state.operations[op.id]} |`);
  lines.push('', '本记录不代表 IDE 原子事务。局部恢复需新建确认批次；完整恢复使用原生工程副本。', '');
  return lines.join('\n');
}
