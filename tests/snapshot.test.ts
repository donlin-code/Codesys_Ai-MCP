import test from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from '../src/model.js';
import {
  canonicalJson, coverage, fingerprint, identityKey, lineCount,
  objectMap, snapshotHash, SnapshotValidationError, validateSnapshot,
} from '../src/snapshot.js';
import { diffSnapshots, unifiedTextDiff } from '../src/diff.js';

const source = 'PROGRAM PRG_McpSmoke\r\nVAR\r\n    xReady : BOOL; // 中文注释\r\nEND_VAR\r\nxReady := TRUE;\r\n';

function fixture(text = source): Snapshot {
  return {
    schemaVersion: 1,
    origin: 'fixture',
    capturedAt: '2026-10-23T10:00:00.000Z',
    identity: {
      projectPath: 'C:\\Projects\\McpSmoke.project',
      applicationPath: 'Device.Application',
      ideVersion: '3.5.22.30',
      pluginVersion: '1.1.0.0',
    },
    treeComplete: true,
    inventory: [{ path: 'Device.Application.PRG_McpSmoke', type: 'POU', language: 'ST' }],
    objects: [{ path: 'Device.Application.PRG_McpSmoke', type: 'POU', language: 'ST', status: 'read', complete: true, text }],
    evidence: [],
  };
}

function ide(text = source): Snapshot {
  const result = fixture(text);
  result.origin = 'ide';
  result.objects[0]!.evidenceIds = ['read-1'];
  result.evidence.push({
    id: 'read-1',
    tool: 'get_structured_text_content',
    arguments: { path: result.objects[0]!.path },
    result: { content: [{ type: 'text', text: JSON.stringify({ source: text }) }] },
    capturedAt: '2026-10-23T09:59:59Z',
  });
  return result;
}

function paged(): Snapshot {
  const result = fixture();
  const firstPage = 'PROGRAM PRG_McpSmoke\r\nVAR\r\n';
  result.origin = 'ide';
  result.objects[0]!.evidenceIds = ['page-1', 'page-2'];
  result.objects[0]!.chunks = [
    { startLine: 1, endLine: 2, evidenceId: 'page-1' },
    { startLine: 3, endLine: 5, evidenceId: 'page-2' },
  ];
  result.evidence = [
    {
      id: 'page-1', tool: 'get_structured_text_content',
      arguments: { path: result.objects[0]!.path, startLine: 1, endLine: 2 },
      result: { text: firstPage, hasMore: true, complete: false }, capturedAt: '2026-10-23T09:59:58Z',
    },
    {
      id: 'page-2', tool: 'get_structured_text_content',
      arguments: { path: result.objects[0]!.path, startLine: 3, endLine: 5 },
      result: { content: [{ type: 'text', text: JSON.stringify({ source: source.slice(firstPage.length), hasMore: false }) }] },
      capturedAt: '2026-10-23T09:59:59Z',
    },
  ];
  return result;
}

test('validation preserves exact UTF-8 source and normalizes only metadata', () => {
  const input = fixture();
  const snapshot = validateSnapshot(input);
  assert.equal(snapshot.objects[0]!.text, source);
  assert.equal(snapshot.objects[0]!.sha256, fingerprint(source));
  assert.equal(snapshot.objects[0]!.totalLines, 5);
  assert.deepEqual(snapshot.objects[0]!.ranges, [{ startLine: 1, endLine: 5 }]);
  assert.equal(input.objects[0]!.sha256, undefined, 'input must not be mutated');
  assert.notEqual(fingerprint(source), fingerprint(source.replaceAll('\r\n', '\n')));
  assert.equal(lineCount(''), 0);
  assert.equal(lineCount('\n'), 1);
  assert.equal(lineCount('one\r\ntwo\n'), 2);
  assert.equal(validateSnapshot(fixture('// emoji: 😀\n')).objects[0]!.text, '// emoji: 😀\n');
  assert.throws(() => validateSnapshot(fixture('invalid: \uD800')), /unpaired UTF-16/);
});

test('IDE source requires raw evidence and accepts MCP JSON text envelopes', () => {
  assert.equal(validateSnapshot(ide()).objects[0]!.text, source);
  const missing = fixture();
  missing.origin = 'ide';
  assert.throws(() => validateSnapshot(missing), /requires raw tool evidence/);
  const summary = ide();
  summary.evidence[0]!.result = { summary: 'A program setting xReady to true.' };
  assert.throws(() => validateSnapshot(summary), /exactly match/);
  const edited = ide();
  edited.objects[0]!.text = source.replace('TRUE', 'FALSE');
  assert.throws(() => validateSnapshot(edited), /exactly match/);
  const substring = ide();
  substring.objects[0]!.text = 'xReady := TRUE;';
  assert.throws(() => validateSnapshot(substring), /exactly match/, 'a source fragment must not pass as complete');
});

test('IDE source proofs bind the exact object path and read tool, even when code is identical', () => {
  const wrongObject = ide();
  wrongObject.evidence[0]!.arguments = { path: 'Device.OtherApplication.PRG_McpSmoke' };
  assert.throws(() => validateSnapshot(wrongObject), /target path differs/);
  const wrongTool = ide(); wrongTool.evidence[0]!.tool = 'search_in_files_by_regex';
  assert.throws(() => validateSnapshot(wrongTool), /actual get_structured_text_content/);
  const missingPath = ide(); missingPath.evidence[0]!.arguments = {};
  assert.throws(() => validateSnapshot(missingPath), /requires path/);
  const extraProof = ide();
  extraProof.evidence.push({ ...extraProof.evidence[0]!, id: 'wrong', arguments: { path: 'Device.Application.Another' } });
  extraProof.objects[0]!.evidenceIds!.push('wrong');
  assert.throws(() => validateSnapshot(extraProof), /target path differs/);
  for (const key of ['objectPath', 'object_path']) {
    const aliased = ide(); aliased.evidence[0]!.arguments = { [key]: aliased.objects[0]!.path };
    assert.equal(validateSnapshot(aliased).objects[0]!.text, source);
  }
});

test('source path bindings support explicit actual-schema pointers but reject multi-object selection', () => {
  const mapped = ide();
  mapped.evidence[0]!.arguments = { target: { 'object/path': mapped.objects[0]!.path } };
  mapped.evidence[0]!.sourceBinding = { pathPointer: '/target/object~1path' };
  assert.equal(validateSnapshot(mapped).objects[0]!.text, source);
  const wrong = structuredClone(mapped); wrong.evidence[0]!.sourceBinding!.pathPointer = '/target/missing';
  assert.throws(() => validateSnapshot(wrong), /does not resolve/);
  const invalid = structuredClone(mapped); invalid.evidence[0]!.sourceBinding!.pathPointer = '/target/~2path';
  assert.throws(() => validateSnapshot(invalid), /RFC 6901/);
  const multiple = ide();
  multiple.evidence[0]!.arguments = { paths: [multiple.objects[0]!.path, 'Device.Application.Other'] };
  multiple.evidence[0]!.sourceBinding = { pathPointer: '/paths/0' };
  assert.throws(() => validateSnapshot(multiple), /multi-object array/);
});

test('truncated or failed raw responses cannot certify complete source', () => {
  for (const marker of [{ truncated: true }, { isTruncated: true }, { hasMore: true }, { complete: false }, { isError: true }]) {
    const input = ide();
    input.evidence[0]!.result = { source, ...marker };
    assert.throws(() => validateSnapshot(input), /non-truncated raw tool result/);
  }
});

test('explicit pages certify complete Chinese CRLF source without modifying line terminators', () => {
  const snapshot = validateSnapshot(paged());
  assert.equal(snapshot.objects[0]!.text, source);
  assert.equal(snapshot.objects[0]!.sha256, fingerprint(source));
  assert.deepEqual(snapshot.objects[0]!.ranges, [{ startLine: 1, endLine: 2 }, { startLine: 3, endLine: 5 }]);
  assert.equal(coverage(snapshot).fullyCovered, true);
  assert.equal(snapshotHash(snapshot), snapshotHash(paged()));
  assert.deepEqual(diffSnapshots(ide(), snapshot).changes, [], 'pagination provenance is not a code edit');
  const resultRanges = paged();
  resultRanges.evidence[0]!.arguments = { path: resultRanges.objects[0]!.path };
  resultRanges.evidence[0]!.result = { source: 'PROGRAM PRG_McpSmoke\r\nVAR\r\n', start_line: 1, end_line: 2, hasMore: true };
  assert.equal(validateSnapshot(resultRanges).objects[0]!.text, source);
});

test('missing, overlapping or reordered pages cannot create complete coverage', () => {
  const missing = paged();
  missing.objects[0]!.chunks!.pop();
  assert.throws(() => validateSnapshot(missing), /final page|missing/);
  const gap = paged(); gap.objects[0]!.chunks![1]!.startLine = 4;
  assert.throws(() => validateSnapshot(gap), /continuous/);
  const overlap = paged(); overlap.objects[0]!.chunks![1]!.startLine = 2;
  assert.throws(() => validateSnapshot(overlap), /non-overlapping/);
  const reordered = paged(); reordered.objects[0]!.chunks!.reverse();
  assert.throws(() => validateSnapshot(reordered), /ordered/);
  const inconsistent = paged(); inconsistent.objects[0]!.ranges = [{ startLine: 1, endLine: 5 }];
  assert.throws(() => validateSnapshot(inconsistent), /ranges must match/);
});

test('page proofs reject truncation, errors, unfinished final pages and altered transcription', () => {
  for (const pageIndex of [0, 1]) {
    for (const marker of [{ truncated: true }, { isError: true }]) {
      const input = paged();
      input.evidence[pageIndex]!.result = { original: input.evidence[pageIndex]!.result, ...marker };
      assert.throws(() => validateSnapshot(input), /page is failed/);
    }
  }
  for (const marker of [{ hasMore: true }, { complete: false }]) {
    const input = paged();
    input.evidence[1]!.result = { original: input.evidence[1]!.result, ...marker };
    assert.throws(() => validateSnapshot(input), /final page/);
  }
  const changed = paged(); changed.objects[0]!.text = source.replace('中文注释', '改写注释');
  assert.throws(() => validateSnapshot(changed), /page text must exactly match/);
  const lineEndings = paged(); lineEndings.objects[0]!.text = source.replaceAll('\r\n', '\n');
  assert.throws(() => validateSnapshot(lineEndings), /line terminators/);
});

test('page ranges require explicit evidence and cannot be inferred from source fragments', () => {
  const noRange = paged(); noRange.evidence[0]!.arguments = { path: noRange.objects[0]!.path };
  assert.throws(() => validateSnapshot(noRange), /explicit one-based/);
  const wrongRange = paged(); wrongRange.evidence[0]!.arguments = { path: wrongRange.objects[0]!.path, startLine: 2, endLine: 3 };
  assert.throws(() => validateSnapshot(wrongRange), /explicit one-based/);
  const unreferenced = paged(); unreferenced.objects[0]!.evidenceIds = ['page-2'];
  assert.throws(() => validateSnapshot(unreferenced), /must also appear in evidenceIds/);
  const noChunks = paged(); delete noChunks.objects[0]!.chunks;
  assert.throws(() => validateSnapshot(noChunks), /complete source must exactly match/);
});

test('duplicate inventory, object and evidence IDs are rejected', () => {
  const inventory = fixture();
  inventory.inventory.push({ ...inventory.inventory[0]! });
  assert.throws(() => validateSnapshot(inventory), /duplicate entry/);
  const objects = fixture();
  objects.objects.push({ ...objects.objects[0]! });
  assert.throws(() => validateSnapshot(objects), /duplicate entry/);
  const evidence = ide();
  evidence.evidence.push({ ...evidence.evidence[0]! });
  assert.throws(() => validateSnapshot(evidence), /duplicate entry/);
});

test('object metadata and references must agree with declared inventory', () => {
  const absent = fixture();
  absent.inventory = [];
  assert.throws(() => validateSnapshot(absent), /absent from inventory/);
  for (const field of ['type', 'language'] as const) {
    const input = fixture();
    input.objects[0]![field] = field === 'type' ? 'GVL' : 'LD';
    assert.throws(() => validateSnapshot(input), /differ from inventory/);
  }
  const evidence = ide();
  evidence.objects[0]!.evidenceIds = ['does-not-exist'];
  assert.throws(() => validateSnapshot(evidence), /unknown evidence/);
  const cycle = fixture();
  cycle.inventory[0]!.parentPath = cycle.inventory[0]!.path;
  assert.throws(() => validateSnapshot(cycle), /own parent/);
});

test('hash, complete declaration, line totals and range gaps cannot silently pass', () => {
  const hash = fixture();
  hash.objects[0]!.sha256 = fingerprint('wrong');
  assert.throws(() => validateSnapshot(hash), /hash mismatch/);
  const incomplete = fixture();
  incomplete.objects[0]!.complete = false;
  assert.throws(() => validateSnapshot(incomplete), /complete:true/);
  const total = fixture();
  total.objects[0]!.totalLines = 20;
  assert.throws(() => validateSnapshot(total), /line count/);
  for (const ranges of [
    [{ startLine: 1, endLine: 2 }, { startLine: 4, endLine: 5 }],
    [{ startLine: 1, endLine: 3 }, { startLine: 3, endLine: 5 }],
    [{ startLine: 1, endLine: 4 }],
    [],
  ]) {
    const input = fixture();
    input.objects[0]!.ranges = ranges;
    assert.throws(() => validateSnapshot(input), /line ranges/);
  }
  const ordered = fixture();
  ordered.objects[0]!.ranges = [{ startLine: 3, endLine: 5 }, { startLine: 1, endLine: 2 }];
  assert.deepEqual(validateSnapshot(ordered).objects[0]!.ranges, [{ startLine: 1, endLine: 2 }, { startLine: 3, endLine: 5 }]);
});

test('identities and ISO dates are strict, and evidence cannot postdate capture', () => {
  for (const timestamp of ['yesterday', '2026-02-30T00:00:00Z', '2026-10-23T10:00:00', '2026-10-23T25:00:00Z']) {
    const input = fixture(); input.capturedAt = timestamp;
    assert.throws(() => validateSnapshot(input), SnapshotValidationError);
  }
  const path = fixture(); path.identity.projectPath = 'relative.project';
  assert.throws(() => validateSnapshot(path), /absolute project path/);
  const after = ide(); after.evidence[0]!.capturedAt = '2026-10-23T11:00:00Z';
  assert.throws(() => validateSnapshot(after), /later than the snapshot/);
  const valid = fixture(); valid.capturedAt = '2024-02-29T18:00:00+08:00';
  assert.equal(validateSnapshot(valid).capturedAt, valid.capturedAt);
});

test('coverage distinguishes known inventory, unknown tree, protected and missing objects', () => {
  const input = fixture();
  const report = coverage(input);
  assert.equal(report.percent, 100);
  assert.equal(report.fullyCovered, true);
  assert.equal(report.origin, 'fixture');
  assert.match(report.issues.join('\n'), /not evidence of a live IDE/);
  input.treeComplete = false;
  const unknown = coverage(input);
  assert.equal(unknown.percent, null);
  assert.equal(unknown.knownInventoryPercent, 100);
  assert.equal(unknown.fullyCovered, false);
  input.treeComplete = true;
  input.inventory.push({ path: 'Device.Application.Library', type: 'POU', language: 'ST' });
  assert.equal(coverage(input).missingCount, 1);
  assert.equal(coverage(input).percent, 50);
  input.objects.push({ path: 'Device.Application.Library', type: 'POU', language: 'ST', status: 'protected', reason: 'Source library is protected.' });
  const partial = coverage(input);
  assert.equal(partial.protectedCount, 1);
  assert.equal(partial.missingCount, 0);
  assert.equal(partial.editablePaths.length, 1);
  const none = fixture(); none.inventory = []; none.objects = [];
  assert.equal(coverage(none).percent, 0);
  assert.equal(coverage(none).fullyCovered, false);
});

test('unread objects require reasons and cannot smuggle a replacement source', () => {
  const input = fixture();
  input.objects[0] = { ...input.inventory[0]!, status: 'unread' };
  assert.throws(() => validateSnapshot(input), /explicit reason/);
  input.objects[0]!.reason = 'The tool returned only a prefix.';
  assert.equal(coverage(input).unreadCount, 1);
  input.objects[0]!.text = 'a fragment';
  assert.throws(() => validateSnapshot(input), /cannot carry source claims/);
});

test('stable artifact hashes ignore object/key order but bind origin and full evidence', () => {
  const first = fixture();
  first.inventory.push({ path: 'Device.Application.GVL', type: 'GVL', language: 'ST' });
  first.objects.push({ path: 'Device.Application.GVL', type: 'GVL', language: 'ST', status: 'read', complete: true, text: 'VAR_GLOBAL\nEND_VAR\n' });
  const reversed = structuredClone(first);
  reversed.inventory.reverse(); reversed.objects.reverse();
  assert.equal(snapshotHash(first), snapshotHash(reversed));
  assert.equal(identityKey(first.identity), identityKey({ pluginVersion: '1.1.0.0', ideVersion: '3.5.22.30', applicationPath: 'Device.Application', projectPath: 'C:\\Projects\\McpSmoke.project' }));
  assert.notEqual(snapshotHash(fixture()), snapshotHash(ide()));
  assert.equal(objectMap(validateSnapshot(first)).size, 2);
  assert.throws(() => canonicalJson({ invalid: undefined }), /JSON-compatible/);
  assert.throws(() => canonicalJson({ invalid: Number.NaN }), /JSON-compatible/);
});

test('diffs show source edits, additions and removals without treating access loss as deletion', () => {
  const before = fixture(), after = fixture(source.replace('TRUE', 'FALSE'));
  const changed = diffSnapshots(before, after);
  assert.equal(changed.identityMatch, true);
  assert.equal(changed.changes[0]!.kind, 'modified');
  assert.match(changed.unifiedDiff, /-xReady := TRUE;/);
  assert.match(changed.unifiedDiff, /\+xReady := FALSE;/);
  const deleted = fixture(); deleted.inventory = []; deleted.objects = [];
  assert.equal(diffSnapshots(before, deleted).changes[0]!.kind, 'removed');
  assert.match(diffSnapshots(before, deleted).unifiedDiff, /\+\+\+ \/dev\/null/);
  assert.equal(diffSnapshots(deleted, before).changes[0]!.kind, 'added');
  const unread = fixture();
  unread.objects[0] = { ...unread.inventory[0]!, status: 'unread', reason: 'Tool timed out.' };
  const lost = diffSnapshots(before, unread);
  assert.equal(lost.changes[0]!.kind, 'status-changed');
  assert.equal(lost.unifiedDiff, '');
});

test('diffs explicitly report cross-identity and fixture versus IDE comparisons', () => {
  const changed = fixture(); changed.identity.applicationPath = 'Device.OtherApplication';
  assert.equal(diffSnapshots(fixture(), changed).identityMatch, false);
  assert.equal(diffSnapshots(fixture(), ide()).originMatch, false);
  const evidenceOnly = ide(); evidenceOnly.evidence[0]!.arguments = { path: 'Device.Application.PRG_McpSmoke', includeNested: false };
  assert.deepEqual(diffSnapshots(ide(), evidenceOnly).changes, []);
  assert.notEqual(snapshotHash(ide()), snapshotHash(evidenceOnly));
  const rangesOnly = fixture(); rangesOnly.objects[0]!.ranges = [{ startLine: 1, endLine: 2 }, { startLine: 3, endLine: 5 }];
  assert.deepEqual(diffSnapshots(fixture(), rangesOnly).changes, []);
});

test('unified presentation retains newline differences and never silently removes empty additions', () => {
  const endings = unifiedTextDiff('a\r\n', 'a\n', 'Application.PRG');
  assert.match(endings, /Line terminators changed/);
  assert.match(unifiedTextDiff('a', 'b\n', 'Application.PRG'), /No newline at end of file/);
  assert.match(unifiedTextDiff(undefined, '', 'Application.GVL'), /--- \/dev\/null/);
  assert.equal(unifiedTextDiff('same', 'same', 'Application.PRG'), '');
});
