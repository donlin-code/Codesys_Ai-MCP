export interface Identity {
  projectPath: string;
  applicationPath: string;
  ideVersion: string;
  pluginVersion: string;
}

export interface InventoryEntry {
  path: string;
  type: string;
  language: string;
  parentPath?: string;
}

/** Inclusive, one-based logical lines. A final newline does not add a line. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

/** Range is one-based and inclusive, and must occur in its raw evidence. */
export interface SourceChunk extends LineRange {
  evidenceId: string;
}

export type ObjectStatus = 'read' | 'unread' | 'unsupported' | 'protected';

export interface SnapshotObject {
  path: string;
  type: string;
  language: string;
  status: ObjectStatus;
  text?: string;
  sha256?: string;
  complete?: boolean;
  totalLines?: number;
  ranges?: LineRange[];
  chunks?: SourceChunk[];
  evidenceIds?: string[];
  reason?: string;
}

export interface Evidence {
  id: string;
  tool: string;
  arguments: unknown;
  result: unknown;
  capturedAt: string;
  /** RFC 6901 pointer inside arguments to the actual scalar object-path parameter. */
  sourceBinding?: { pathPointer: string };
}

export interface Reference {
  path: string;
  sha256: string;
  role: string;
}

export interface Snapshot {
  schemaVersion: 1;
  origin: 'ide' | 'fixture';
  capturedAt: string;
  identity: Identity;
  treeComplete: boolean;
  inventory: InventoryEntry[];
  objects: SnapshotObject[];
  evidence: Evidence[];
  references?: Reference[];
}

export interface CoverageReport {
  origin: Snapshot['origin'];
  inventoryCount: number;
  readCompleteCount: number;
  unreadCount: number;
  unsupportedCount: number;
  protectedCount: number;
  missingCount: number;
  treeComplete: boolean;
  /** Unknown when the tree itself is incomplete. */
  percent: number | null;
  knownInventoryPercent: number;
  completeForInventory: boolean;
  fullyCovered: boolean;
  editablePaths: string[];
  issues: string[];
}

export interface SnapshotChange {
  path: string;
  kind: 'added' | 'removed' | 'modified' | 'status-changed';
  before?: SnapshotObject;
  after?: SnapshotObject;
  beforeInventory?: InventoryEntry;
  afterInventory?: InventoryEntry;
  /** An empty string means no source-text diff is available. */
  unifiedDiff: string;
}

export interface SnapshotDiff {
  identityMatch: boolean;
  originMatch: boolean;
  beforeSnapshotHash: string;
  afterSnapshotHash: string;
  changes: SnapshotChange[];
  unifiedDiff: string;
}
