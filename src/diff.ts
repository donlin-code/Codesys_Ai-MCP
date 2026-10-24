import type { InventoryEntry, Snapshot, SnapshotChange, SnapshotDiff, SnapshotObject } from './model.js';
import { canonicalJson, identityKey, objectMap, snapshotHash, validateSnapshot } from './snapshot.js';

interface DiffLine { body: string; terminator: string }

function lines(text: string): DiffLine[] {
  const result: DiffLine[] = [];
  const regex = /([^\r\n]*)(\r\n|\n|\r|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0] === '') break;
    result.push({ body: match[1]!, terminator: match[2]! });
  }
  return result;
}

function render(line: DiffLine, prefix: string): string[] {
  const output = [`${prefix}${line.body}`];
  if (line.terminator === '') output.push('\\ No newline at end of file');
  return output;
}

/** One focused unified hunk; exact text hashes remain authoritative for line endings. */
export function unifiedTextDiff(before: string | undefined, after: string | undefined, path: string): string {
  if (before === after) return '';
  const oldLines = lines(before ?? ''), newLines = lines(after ?? '');
  const same = (a: DiffLine, b: DiffLine): boolean => a.body === b.body && a.terminator === b.terminator;
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && same(oldLines[prefix]!, newLines[prefix]!)) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && same(oldLines[oldLines.length - suffix - 1]!, newLines[newLines.length - suffix - 1]!)) suffix++;
  const start = Math.max(0, prefix - 3);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
  const oldCount = oldEnd - start, newCount = newEnd - start;
  const label = path.replaceAll('\\', '/');
  const output = [
    `--- ${before === undefined ? '/dev/null' : `a/${label}`}`,
    `+++ ${after === undefined ? '/dev/null' : `b/${label}`}`,
    `@@ -${oldCount === 0 ? start : start + 1},${oldCount} +${newCount === 0 ? start : start + 1},${newCount} @@`,
  ];
  for (let i = start; i < prefix; i++) output.push(...render(oldLines[i]!, ' '));
  for (let i = prefix; i < oldLines.length - suffix; i++) output.push(...render(oldLines[i]!, '-'));
  for (let i = prefix; i < newLines.length - suffix; i++) output.push(...render(newLines[i]!, '+'));
  for (let i = 0; i < oldEnd - (oldLines.length - suffix); i++) output.push(...render(oldLines[oldLines.length - suffix + i]!, ' '));
  if (before !== undefined && after !== undefined
    && before.replace(/\r\n|\r/gu, '\n') === after.replace(/\r\n|\r/gu, '\n')) {
    output.push('# Line terminators changed; exact source bytes and hashes are preserved in the snapshot.');
  }
  return `${output.join('\n')}\n`;
}

function state(object: SnapshotObject | undefined, inventory: InventoryEntry | undefined): string {
  if (!object) return canonicalJson({ inventory: inventory ?? null, object: null });
  // Evidence IDs/timestamps may differ without any code or availability change.
  const { evidenceIds: _evidenceIds, ranges: _ranges, chunks: _chunks, ...rest } = object;
  return canonicalJson({ inventory: inventory ?? null, object: rest });
}

export function diffSnapshots(beforeInput: Snapshot, afterInput: Snapshot): SnapshotDiff {
  const before = validateSnapshot(beforeInput), after = validateSnapshot(afterInput);
  const beforeObjects = objectMap(before), afterObjects = objectMap(after);
  const beforeInventory = new Map(before.inventory.map(item => [item.path, item]));
  const afterInventory = new Map(after.inventory.map(item => [item.path, item]));
  const paths = [...new Set([...beforeInventory.keys(), ...afterInventory.keys()])].sort();
  const changes: SnapshotChange[] = [];
  for (const path of paths) {
    const oldObject = beforeObjects.get(path), newObject = afterObjects.get(path);
    const oldEntry = beforeInventory.get(path), newEntry = afterInventory.get(path);
    if (state(oldObject, oldEntry) === state(newObject, newEntry)) continue;
    let kind: SnapshotChange['kind'];
    if (!oldEntry) kind = 'added';
    else if (!newEntry) kind = 'removed';
    else if (oldObject?.status !== newObject?.status) kind = 'status-changed';
    else kind = 'modified';
    const change: SnapshotChange = { path, kind, unifiedDiff: '' };
    if (oldObject) change.before = oldObject;
    if (newObject) change.after = newObject;
    if (oldEntry) change.beforeInventory = oldEntry;
    if (newEntry) change.afterInventory = newEntry;
    // Losing access is not deletion; never present unread source as an empty replacement.
    const canShowText = (!oldEntry || oldObject?.status === 'read') && (!newEntry || newObject?.status === 'read');
    if (canShowText) change.unifiedDiff = unifiedTextDiff(oldObject?.text, newObject?.text, path);
    changes.push(change);
  }
  return {
    identityMatch: identityKey(before.identity) === identityKey(after.identity),
    originMatch: before.origin === after.origin,
    beforeSnapshotHash: snapshotHash(before),
    afterSnapshotHash: snapshotHash(after),
    changes,
    unifiedDiff: changes.map(change => change.unifiedDiff).filter(Boolean).join('\n'),
  };
}
