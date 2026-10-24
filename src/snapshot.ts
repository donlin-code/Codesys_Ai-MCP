import { createHash } from 'node:crypto';
import type {
  CoverageReport, Evidence, Identity, InventoryEntry, LineRange,
  ObjectStatus, Reference, Snapshot, SnapshotObject, SourceChunk,
} from './model.js';

export class SnapshotValidationError extends Error {
  constructor(public readonly location: string, message: string) {
    super(`${location}: ${message}`);
    this.name = 'SnapshotValidationError';
  }
}

function fail(location: string, message: string): never {
  throw new SnapshotValidationError(location, message);
}

type RecordValue = Record<string, unknown>;

function record(value: unknown, location: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) {
    fail(location, 'expected a plain object');
  }
  return value as RecordValue;
}

function keys(value: RecordValue, allowed: string[], location: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${location}.${key}`, 'unknown field');
  }
}

function string(value: unknown, location: string, identifier = false): string {
  if (typeof value !== 'string') fail(location, 'expected a string');
  if (identifier && (value.trim() !== value || value.length === 0 || /[\x00-\x1f\x7f]/u.test(value))) {
    fail(location, 'expected a nonempty identifier without surrounding whitespace or control characters');
  }
  return value;
}

function boolean(value: unknown, location: string): boolean {
  if (typeof value !== 'boolean') fail(location, 'expected a boolean');
  return value;
}

function array(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) fail(location, 'expected an array');
  return value;
}

function integer(value: unknown, location: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    fail(location, `expected an integer >= ${min}`);
  }
  return value;
}

function timestamp(value: unknown, location: string): string {
  const result = string(value, location, true);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u.exec(result);
  if (!match) fail(location, 'expected an ISO 8601 timestamp with timezone');
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1]!
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (zone !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4, 6)) > 59))
    || !Number.isFinite(Date.parse(result))) {
    fail(location, 'invalid calendar date or time');
  }
  return result;
}

function sha256(value: unknown, location: string): string {
  const result = string(value, location);
  if (!/^[a-f\d]{64}$/iu.test(result)) fail(location, 'expected a SHA-256 hex digest');
  return result.toLowerCase();
}

/** Hash exact UTF-8 source bytes. No newline or Unicode normalization. */
export function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable JSON key ordering; rejects values that JSON would silently discard. */
export function canonicalJson(input: unknown): string {
  const ancestors = new Set<object>();
  function serialize(value: unknown, depth: number): string {
    if (depth > 100) throw new TypeError('JSON nesting exceeds 100 levels');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== 'object' || value === null) throw new TypeError('Expected JSON-compatible data');
    if (ancestors.has(value)) throw new TypeError('Circular JSON value');
    ancestors.add(value);
    let result: string;
    if (Array.isArray(value)) {
      result = `[${Array.from(value, item => serialize(item, depth + 1)).join(',')}]`;
    } else {
      const obj = record(value, 'json');
      result = `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${serialize(obj[key], depth + 1)}`).join(',')}}`;
    }
    ancestors.delete(value);
    return result;
  }
  return serialize(input, 0);
}

function jsonValue(value: unknown, location: string): unknown {
  try { return JSON.parse(canonicalJson(value)) as unknown; }
  catch (error) { return fail(location, `expected JSON-compatible evidence: ${(error as Error).message}`); }
}

function validateIdentity(input: unknown): Identity {
  const value = record(input, 'identity');
  keys(value, ['projectPath', 'applicationPath', 'ideVersion', 'pluginVersion'], 'identity');
  const projectPath = string(value.projectPath, 'identity.projectPath', true);
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\]+[\\]|\/)/iu.test(projectPath)) {
    fail('identity.projectPath', 'expected an absolute project path');
  }
  return {
    projectPath,
    applicationPath: string(value.applicationPath, 'identity.applicationPath', true),
    ideVersion: string(value.ideVersion, 'identity.ideVersion', true),
    pluginVersion: string(value.pluginVersion, 'identity.pluginVersion', true),
  };
}

export function identityKey(identity: Identity): string {
  return fingerprint(canonicalJson(validateIdentity(identity)));
}

/** Empty text has zero logical lines; trailing CR/LF terminates the last line. */
export function lineCount(text: string): number {
  if (!text) return 0;
  return text.split(/\r\n|\n|\r/u).length - (/[\r\n]$/u.test(text) ? 1 : 0);
}

function unique<T>(items: T[], id: (value: T) => string, location: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = id(item);
    if (seen.has(key)) fail(location, `duplicate entry: ${key}`);
    seen.add(key);
  }
}

function comparePath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function validateInventory(input: unknown, identity: Identity): InventoryEntry[] {
  const entries = array(input, 'inventory').map((item, index): InventoryEntry => {
    const at = `inventory[${index}]`;
    const value = record(item, at);
    keys(value, ['path', 'type', 'language', 'parentPath'], at);
    const result: InventoryEntry = {
      path: string(value.path, `${at}.path`, true),
      type: string(value.type, `${at}.type`, true),
      language: string(value.language, `${at}.language`, true),
    };
    if (value.parentPath !== undefined) result.parentPath = string(value.parentPath, `${at}.parentPath`, true);
    if (result.parentPath === result.path) fail(at, 'an object cannot be its own parent');
    return result;
  });
  unique(entries, item => item.path, 'inventory');
  const map = new Map(entries.map(item => [item.path, item]));
  for (const item of entries) {
    if (item.parentPath && !map.has(item.parentPath) && item.parentPath !== identity.applicationPath) {
      fail(`inventory[${item.path}].parentPath`, 'parent must be in inventory or be the application root');
    }
    const ancestors = new Set<string>([item.path]);
    let cursor = item.parentPath;
    while (cursor && map.has(cursor)) {
      if (ancestors.has(cursor)) fail('inventory', `parent cycle at ${cursor}`);
      ancestors.add(cursor);
      cursor = map.get(cursor)!.parentPath;
    }
  }
  return entries.sort(comparePath);
}

function validateEvidence(input: unknown, capturedAt: string): Evidence[] {
  const entries = array(input, 'evidence').map((item, index): Evidence => {
    const at = `evidence[${index}]`;
    const value = record(item, at);
    keys(value, ['id', 'tool', 'arguments', 'result', 'capturedAt', 'sourceBinding'], at);
    const result: Evidence = {
      id: string(value.id, `${at}.id`, true),
      tool: string(value.tool, `${at}.tool`, true),
      arguments: jsonValue(value.arguments, `${at}.arguments`),
      result: jsonValue(value.result, `${at}.result`),
      capturedAt: timestamp(value.capturedAt, `${at}.capturedAt`),
    };
    if (value.sourceBinding !== undefined) {
      const binding = record(value.sourceBinding, `${at}.sourceBinding`);
      keys(binding, ['pathPointer'], `${at}.sourceBinding`);
      const pointer = string(binding.pathPointer, `${at}.sourceBinding.pathPointer`, true);
      if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) {
        fail(`${at}.sourceBinding.pathPointer`, 'expected a non-root RFC 6901 JSON pointer inside arguments');
      }
      result.sourceBinding = { pathPointer: pointer };
    }
    if (Date.parse(result.capturedAt) > Date.parse(capturedAt)) fail(at, 'evidence timestamp is later than the snapshot');
    return result;
  });
  unique(entries, item => item.id, 'evidence');
  return entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function resolveSourcePathPointer(argumentsValue: unknown, pointer: string, location: string): unknown {
  let value = argumentsValue;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(value)) fail(location, 'source path pointers cannot select an object from a multi-object array');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      fail(location, `source path pointer does not resolve: ${pointer}`);
    }
    value = (value as RecordValue)[key];
  }
  return value;
}

function validateSourceEvidence(proof: Evidence, path: string, location: string): void {
  if (!['get_structured_text_content', 'codesys_read_object'].includes(proof.tool)) {
    fail(location, 'IDE source evidence must be an actual get_structured_text_content or codesys_read_object call');
  }
  const args = record(proof.arguments, `${location}.arguments`);
  const candidates = ['path', 'objectPath', 'object_path'].filter(key => Object.hasOwn(args, key));
  for (const key of candidates) {
    if (args[key] !== path) fail(location, 'source evidence target path differs from the snapshot object');
  }
  if (proof.sourceBinding) {
    if (resolveSourcePathPointer(args, proof.sourceBinding.pathPointer, location) !== path) {
      fail(location, 'source evidence target path differs from the snapshot object');
    }
  } else if (candidates.length === 0) {
    fail(location, 'source evidence requires path/objectPath/object_path or an explicit sourceBinding.pathPointer');
  }
}

/** Exact source leaves, including JSON embedded in MCP text content. Not substrings. */
function containsSource(value: unknown, source: string, depth = 0): boolean {
  if (depth > 100) return false;
  if (typeof value === 'string') {
    if (value === source) return true;
    if (/^\s*[{[]/u.test(value)) {
      try { return containsSource(JSON.parse(value) as unknown, source, depth + 1); }
      catch { return false; }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(item => containsSource(item, source, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(item => containsSource(item, source, depth + 1));
  }
  return false;
}

function hasIncompleteMarker(value: unknown, allowPagination = false, depth = 0): boolean {
  if (depth > 100) return true;
  if (typeof value === 'string' && /^\s*[{[]/u.test(value)) {
    try { return hasIncompleteMarker(JSON.parse(value) as unknown, allowPagination, depth + 1); }
    catch { return false; }
  }
  if (Array.isArray(value)) return value.some(item => hasIncompleteMarker(item, allowPagination, depth + 1));
  if (value !== null && typeof value === 'object') {
    const obj = value as RecordValue;
    if (obj.truncated === true || obj.isTruncated === true || obj.is_truncated === true
      || obj.isError === true || obj.is_error === true || obj.ok === false) return true;
    if (!allowPagination && (obj.hasMore === true || obj.has_more === true || obj.complete === false)) return true;
    return Object.values(obj).some(item => hasIncompleteMarker(item, allowPagination, depth + 1));
  }
  return false;
}

function containsLineRange(value: unknown, range: LineRange, depth = 0): boolean {
  if (depth > 100) return false;
  if (typeof value === 'string' && /^\s*[{[]/u.test(value)) {
    try { return containsLineRange(JSON.parse(value) as unknown, range, depth + 1); }
    catch { return false; }
  }
  if (Array.isArray(value)) return value.some(item => containsLineRange(item, range, depth + 1));
  if (value !== null && typeof value === 'object') {
    const obj = value as RecordValue;
    if ((obj.startLine === range.startLine && obj.endLine === range.endLine)
      || (obj.start_line === range.startLine && obj.end_line === range.endLine)) return true;
    return Object.values(obj).some(item => containsLineRange(item, range, depth + 1));
  }
  return false;
}

function validateChunks(input: unknown, object: SnapshotObject, evidence: Map<string, Evidence>, location: string): SourceChunk[] {
  const values = array(input, location);
  if (values.length === 0) fail(location, 'chunks must not be empty; use a single complete response for empty source');
  const sourceLines = object.text!.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) ?? [];
  if (sourceLines.at(-1) === '') sourceLines.pop();
  const result: SourceChunk[] = [];
  let nextLine = 1;
  for (let index = 0; index < values.length; index++) {
    const at = `${location}[${index}]`, value = record(values[index], at);
    keys(value, ['startLine', 'endLine', 'evidenceId'], at);
    const chunk: SourceChunk = {
      startLine: integer(value.startLine, `${at}.startLine`, 1),
      endLine: integer(value.endLine, `${at}.endLine`, 1),
      evidenceId: string(value.evidenceId, `${at}.evidenceId`, true),
    };
    if (chunk.startLine !== nextLine || chunk.endLine < chunk.startLine || chunk.endLine > object.totalLines!) {
      fail(at, 'chunks must be ordered, continuous, non-overlapping and within totalLines');
    }
    if (!object.evidenceIds?.includes(chunk.evidenceId)) fail(`${at}.evidenceId`, 'chunk evidence must also appear in evidenceIds');
    const proof = evidence.get(chunk.evidenceId);
    if (!proof) fail(`${at}.evidenceId`, `unknown evidence: ${chunk.evidenceId}`);
    if (!containsLineRange(proof.arguments, chunk) && !containsLineRange(proof.result, chunk)) {
      fail(at, 'chunk requires its explicit one-based startLine/endLine in raw tool arguments or result');
    }
    const isFinal = index === values.length - 1;
    if (hasIncompleteMarker(proof.result, !isFinal)) {
      fail(at, isFinal ? 'final page is failed, truncated, incomplete or hasMore' : 'page is failed or explicitly truncated');
    }
    const expectedText = sourceLines.slice(chunk.startLine - 1, chunk.endLine).join('');
    if (!containsSource(proof.result, expectedText)) {
      fail(at, 'page text must exactly match the source slice, including its original line terminators');
    }
    result.push(chunk);
    nextLine = chunk.endLine + 1;
  }
  if (nextLine !== object.totalLines! + 1) fail(location, 'chunks do not cover the complete source; a page is missing');
  return result;
}

function validateRanges(input: unknown, totalLines: number, location: string): LineRange[] {
  if (input === undefined) return totalLines === 0 ? [] : [{ startLine: 1, endLine: totalLines }];
  const ranges = array(input, location).map((item, index): LineRange => {
    const at = `${location}[${index}]`, value = record(item, at);
    keys(value, ['startLine', 'endLine'], at);
    const range = {
      startLine: integer(value.startLine, `${at}.startLine`, 1),
      endLine: integer(value.endLine, `${at}.endLine`, 1),
    };
    if (range.endLine < range.startLine) fail(at, 'endLine precedes startLine');
    return range;
  }).sort((a, b) => a.startLine - b.startLine);
  let next = 1;
  for (const range of ranges) {
    if (range.startLine !== next) fail(location, 'line ranges contain a gap or overlap');
    next = range.endLine + 1;
  }
  if (next !== totalLines + 1) fail(location, 'line ranges do not cover the complete declared source');
  return ranges;
}

function validateObjects(input: unknown, inventory: InventoryEntry[], evidence: Evidence[], origin: Snapshot['origin']): SnapshotObject[] {
  const inventoryMap = new Map(inventory.map(item => [item.path, item]));
  const evidenceMap = new Map(evidence.map(item => [item.id, item]));
  const entries = array(input, 'objects').map((item, index): SnapshotObject => {
    const at = `objects[${index}]`, value = record(item, at);
    keys(value, ['path', 'type', 'language', 'status', 'text', 'sha256', 'complete', 'totalLines', 'ranges', 'chunks', 'evidenceIds', 'reason'], at);
    const path = string(value.path, `${at}.path`, true);
    const listed = inventoryMap.get(path);
    if (!listed) fail(at, `object is absent from inventory: ${path}`);
    const type = string(value.type, `${at}.type`, true), language = string(value.language, `${at}.language`, true);
    if (type !== listed.type || language !== listed.language) fail(at, 'type/language differ from inventory');
    if (!['read', 'unread', 'unsupported', 'protected'].includes(value.status as string)) fail(`${at}.status`, 'invalid object status');
    const status = value.status as ObjectStatus;
    const result: SnapshotObject = { path, type, language, status };
    if (value.reason !== undefined) result.reason = string(value.reason, `${at}.reason`, true);
    if (value.evidenceIds !== undefined) {
      result.evidenceIds = array(value.evidenceIds, `${at}.evidenceIds`).map((id, i) => string(id, `${at}.evidenceIds[${i}]`, true));
      unique(result.evidenceIds, id => id, `${at}.evidenceIds`);
      for (const id of result.evidenceIds) if (!evidenceMap.has(id)) fail(`${at}.evidenceIds`, `unknown evidence: ${id}`);
      result.evidenceIds.sort();
    }
    if (status !== 'read') {
      if (!result.reason) fail(`${at}.reason`, 'non-read objects require an explicit reason');
      for (const key of ['text', 'sha256', 'totalLines', 'ranges', 'chunks']) {
        if (value[key] !== undefined) fail(`${at}.${key}`, 'non-read objects cannot carry source claims');
      }
      if (value.complete !== undefined && value.complete !== false) fail(`${at}.complete`, 'non-read objects cannot be complete');
      result.complete = false;
      return result;
    }
    if (value.complete !== true) fail(`${at}.complete`, 'read requires complete:true; record incomplete reads as unread with a reason');
    result.text = string(value.text, `${at}.text`);
    if (/\u0000/u.test(result.text)) fail(`${at}.text`, 'NUL bytes are not supported in source');
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result.text)) {
      fail(`${at}.text`, 'unpaired UTF-16 surrogates cannot be preserved as UTF-8 source');
    }
    result.sha256 = fingerprint(result.text);
    if (value.sha256 !== undefined && sha256(value.sha256, `${at}.sha256`) !== result.sha256) fail(`${at}.sha256`, 'source hash mismatch');
    const actualLines = lineCount(result.text);
    result.totalLines = value.totalLines === undefined ? actualLines : integer(value.totalLines, `${at}.totalLines`);
    if (result.totalLines !== actualLines) fail(`${at}.totalLines`, 'declared total differs from the exact source line count');
    result.ranges = validateRanges(value.ranges, result.totalLines, `${at}.ranges`);
    result.complete = true;
    if (origin === 'ide') {
      if (!result.evidenceIds?.length) fail(`${at}.evidenceIds`, 'IDE source requires raw tool evidence');
      for (const id of result.evidenceIds) validateSourceEvidence(evidenceMap.get(id)!, path, `${at}.evidenceIds[${id}]`);
    }
    if (value.chunks !== undefined) {
      result.chunks = validateChunks(value.chunks, result, evidenceMap, `${at}.chunks`);
      const chunkRanges = result.chunks.map(({ startLine, endLine }) => ({ startLine, endLine }));
      if (value.ranges !== undefined && canonicalJson(result.ranges) !== canonicalJson(chunkRanges)) {
        fail(`${at}.ranges`, 'ranges must match the explicit chunks');
      }
      result.ranges = chunkRanges;
    } else if (origin === 'ide') {
      const proofs = (result.evidenceIds ?? []).map(id => evidenceMap.get(id)!);
      if (proofs.length === 0) fail(`${at}.evidenceIds`, 'IDE source requires raw tool evidence');
      if (!proofs.some(proof => !hasIncompleteMarker(proof.result) && containsSource(proof.result, result.text!))) {
        fail(`${at}.text`, 'complete source must exactly match a string in a referenced successful, non-truncated raw tool result');
      }
    }
    return result;
  });
  unique(entries, item => item.path, 'objects');
  return entries.sort(comparePath);
}

export function validateSnapshot(input: unknown): Snapshot {
  const value = record(input, 'snapshot');
  keys(value, ['schemaVersion', 'origin', 'capturedAt', 'identity', 'treeComplete', 'inventory', 'objects', 'evidence', 'references'], 'snapshot');
  if (value.schemaVersion !== 1) fail('schemaVersion', 'only schemaVersion 1 is supported');
  if (value.origin !== 'ide' && value.origin !== 'fixture') fail('origin', 'expected ide or fixture');
  const capturedAt = timestamp(value.capturedAt, 'capturedAt');
  const identity = validateIdentity(value.identity);
  const inventory = validateInventory(value.inventory, identity);
  const evidence = validateEvidence(value.evidence, capturedAt);
  const result: Snapshot = {
    schemaVersion: 1,
    origin: value.origin,
    capturedAt,
    identity,
    treeComplete: boolean(value.treeComplete, 'treeComplete'),
    inventory,
    objects: validateObjects(value.objects, inventory, evidence, value.origin),
    evidence,
  };
  if (value.references !== undefined) {
    result.references = array(value.references, 'references').map((item, index): Reference => {
      const at = `references[${index}]`, ref = record(item, at);
      keys(ref, ['path', 'sha256', 'role'], at);
      return { path: string(ref.path, `${at}.path`, true), sha256: sha256(ref.sha256, `${at}.sha256`), role: string(ref.role, `${at}.role`, true) };
    });
    unique(result.references, ref => ref.path, 'references');
    result.references.sort(comparePath);
  }
  return result;
}

export function objectMap(snapshot: Snapshot): Map<string, SnapshotObject> {
  return new Map(snapshot.objects.map(item => [item.path, item]));
}

export function coverage(snapshot: Snapshot): CoverageReport {
  const validated = validateSnapshot(snapshot), objects = objectMap(validated);
  const result: CoverageReport = {
    origin: validated.origin,
    inventoryCount: validated.inventory.length,
    readCompleteCount: 0, unreadCount: 0, unsupportedCount: 0, protectedCount: 0, missingCount: 0,
    treeComplete: validated.treeComplete, percent: null, knownInventoryPercent: 0,
    completeForInventory: false, fullyCovered: false, editablePaths: [], issues: [],
  };
  const editableTypes = new Set(['POU', 'PROGRAM', 'FUNCTION', 'FUNCTION_BLOCK', 'FB', 'GVL', 'DUT', 'TYPE', 'METHOD', 'PROPERTY', 'ACTION', 'INTERFACE']);
  for (const entry of validated.inventory) {
    const object = objects.get(entry.path);
    if (!object) { result.missingCount++; result.issues.push(`Missing object result: ${entry.path}`); continue; }
    if (object.status === 'read') {
      result.readCompleteCount++;
      if (object.language.toUpperCase() === 'ST' && editableTypes.has(object.type.toUpperCase())) result.editablePaths.push(object.path);
    } else {
      if (object.status === 'unread') result.unreadCount++;
      if (object.status === 'unsupported') result.unsupportedCount++;
      if (object.status === 'protected') result.protectedCount++;
      result.issues.push(`${object.status}: ${object.path}: ${object.reason}`);
    }
  }
  if (!validated.treeComplete) result.issues.unshift('Project tree is incomplete; overall coverage is unknown.');
  if (validated.inventory.length === 0) result.issues.push('Inventory is empty; there are no verified source objects.');
  if (validated.origin === 'fixture') result.issues.push('Fixture data: this is not evidence of a live IDE read.');
  result.knownInventoryPercent = result.inventoryCount === 0 ? 0 : Math.floor(result.readCompleteCount / result.inventoryCount * 10000) / 100;
  result.percent = validated.treeComplete ? result.knownInventoryPercent : null;
  result.completeForInventory = result.inventoryCount > 0 && result.readCompleteCount === result.inventoryCount;
  result.fullyCovered = validated.treeComplete && result.completeForInventory;
  return result;
}

/** Binds the entire validated artifact, including identity, origin and evidence. */
export function snapshotHash(snapshot: Snapshot): string {
  return fingerprint(canonicalJson(validateSnapshot(snapshot)));
}
