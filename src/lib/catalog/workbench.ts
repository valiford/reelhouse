// Media identity conflict repair workbench (RH-0036): operator tooling over
// the RH-0032 quarantine.
//
// The sync pipeline quarantines ambiguous source identities as it sees them
// (duplicate_identity). This module adds the other side of that contract:
//
// - scan: read-only detectors over the ACTIVE catalog find the conflict
//   classes a per-item pipeline cannot see — duplicate_file (two or more
//   active items claiming one file), moved_media (an active item claiming a
//   file a tombstoned identity used to own), and missing_external_id (an
//   active movie/series with no external provider IDs to anchor identity
//   reconciliation). Every finding lands in media_item_quarantine with the
//   same one-open-row-per-(identity, reason) semantics the sync uses: a new
//   conflict opens a row, a known conflict bumps occurrences on the existing
//   row (first-recorded evidence stays). A scan is atomic — detectors and
//   quarantine writes share one transaction and one snapshot — and runs
//   against the least-privilege application role: detection is read-only
//   SQL, writes touch only workbench-owned tables.
// - list/describe: bounded inspection of quarantine rows with the involved
//   catalog items, their recent change history, and the repair audit trail.
// - release/discard/remap: resolution. Every resolution appends exactly one
//   audit row (operator + bounded before/after evidence) to the append-only
//   media_identity_repairs and closes the quarantine row. remap is the one
//   bounded catalog write, and only for duplicate_identity: it re-points the
//   quarantined item's library placement to the operator-chosen library
//   before resolving. Placement stays Jellyfin-owned — the next sync
//   reconciles against the live source and re-quarantines if the operator's
//   choice disagrees with what Jellyfin actually reports, so a remap can
//   never desync the catalog from its authority.
//
// Fail-closed rules: repairs require an operator identity (audit without an
// actor is not audit); resolved rows never resolve again; remap refuses
// missing target libraries, tombstoned items, same-library no-ops, and any
// reason other than duplicate_identity; a failed scan records its failure
// and commits nothing.

import type { QueryResultRow } from "pg";
import type { SyncExecutor } from "./sync.ts";

// The conflict classes the scan detectors can open. duplicate_identity is
// sync-written (RH-0032) and never scan-written.
export const SCAN_REASONS = ["duplicate_file", "moved_media", "missing_external_id"] as const;
export type ScanReason = (typeof SCAN_REASONS)[number];

export const QUARANTINE_REASONS = ["duplicate_identity", ...SCAN_REASONS] as const;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

export const QUARANTINE_STATUSES = ["quarantined", "released", "discarded"] as const;
export type QuarantineStatus = (typeof QUARANTINE_STATUSES)[number];

export type ResolveAction = Exclude<QuarantineStatus, "quarantined">;

// Bounded by construction: a scan may not dominate the database, a payload
// may not dominate a quarantine row, and a listing may not dominate a
// terminal. All caps are fixed constants so evidence stays deterministic.
export const WORKBENCH_LIMITS = {
  // Distinct conflicts recorded per detector per scan.
  maxFindingsPerDetector: 200,
  // Item projections listed inside one conflict's evidence payload.
  payloadItemsPerConflict: 10,
  // Change-history rows attached to a quarantine inspection.
  historyRowsPerDescribe: 20,
  // Catalog item projections attached to a quarantine inspection.
  describeItemsPerQuarantine: 20,
  listDefaultLimit: 50,
  listMaxLimit: 200,
  operatorMaxLength: 100,
  noteMaxLength: 500
} as const;

export class WorkbenchParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbenchParamError";
  }
}

export interface WorkbenchFailure {
  operation: "scan" | "resolve" | "remap";
  scanId?: number;
  errorDetail: string;
}

export class WorkbenchError extends Error {
  readonly summary: WorkbenchFailure;

  constructor(message: string, summary: WorkbenchFailure) {
    super(message);
    this.name = "WorkbenchError";
    this.summary = summary;
  }
}

interface IdRow extends QueryResultRow {
  id: string | number;
}

// ---------------------------------------------------------------------------
// Fixed SQL (all app-role DML; detectors are read-only)
// ---------------------------------------------------------------------------

export const INSERT_RUNNING_SCAN = `INSERT INTO media_identity_scans (status)
  VALUES ('running') RETURNING id, started_at`;

export const COMPLETE_SCAN = `UPDATE media_identity_scans SET
    status = $2, finished_at = now(),
    findings_duplicate_file = $3, findings_moved_media = $4,
    findings_missing_external_id = $5, quarantines_opened = $6,
    quarantines_bumped = $7, truncated = $8, error_detail = $9
  WHERE id = $1`;

// Active items sharing one file: the file is the conflicting identity.
// Deterministic order (path asc) so a fixed catalog scans to a fixed
// findings list; the LIMIT caps how much one scan may record.
export const DETECT_DUPLICATE_FILES = `
  SELECT m.file_path,
         count(*)::int AS item_count,
         array_agg(m.jellyfin_id ORDER BY m.jellyfin_id) AS jellyfin_ids
  FROM media_items m
  WHERE m.source = 'jellyfin' AND m.removed_at IS NULL AND m.file_path IS NOT NULL
  GROUP BY m.file_path
  HAVING count(DISTINCT m.jellyfin_id) > 1
  ORDER BY m.file_path
  LIMIT $1`;

// An active item claiming a file a DIFFERENT, retired identity used to own:
// the moved/renamed-media signature. Drive-by-active joins only — a path
// shared by two tombstones is history, not a live conflict.
export const DETECT_MOVED_MEDIA = `
  SELECT a.file_path,
         array_agg(DISTINCT a.jellyfin_id) AS active_ids,
         array_agg(DISTINCT t.jellyfin_id) AS tombstoned_ids
  FROM media_items a
  JOIN media_items t
    ON t.source = 'jellyfin'
   AND t.removed_at IS NOT NULL
   AND t.file_path = a.file_path
   AND t.jellyfin_id <> a.jellyfin_id
  WHERE a.source = 'jellyfin' AND a.removed_at IS NULL AND a.file_path IS NOT NULL
  GROUP BY a.file_path
  ORDER BY a.file_path
  LIMIT $1`;

// Movies/series are the identity-reconciled types; episodes/seasons
// legitimately lack provider IDs and are never flagged.
export const DETECT_MISSING_EXTERNAL_IDS = `
  SELECT m.jellyfin_id, m.item_type, m.name, l.jellyfin_id AS library_jellyfin_id, m.file_path
  FROM media_items m
  JOIN media_libraries l ON l.id = m.library_id
  WHERE m.source = 'jellyfin'
    AND m.removed_at IS NULL
    AND m.item_type IN ('movie', 'series')
    AND NOT EXISTS (SELECT 1 FROM media_item_provider_ids p WHERE p.item_id = m.id)
  ORDER BY m.jellyfin_id
  LIMIT $1`;

export interface ItemProjectionRow extends QueryResultRow {
  jellyfin_id: string;
  item_type: string;
  name: string;
  library_jellyfin_id: string;
  file_path: string | null;
  etag: string | null;
  removed_at: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
}

// Bounded projections for evidence payloads and inspection views.
export const SELECT_ITEM_PROJECTIONS = `
  SELECT m.jellyfin_id, m.item_type, m.name, l.jellyfin_id AS library_jellyfin_id,
         m.file_path, m.etag, m.removed_at, m.first_seen_at, m.last_seen_at
  FROM media_items m
  JOIN media_libraries l ON l.id = m.library_id
  WHERE m.source = 'jellyfin' AND m.jellyfin_id = ANY($1::text[])
  ORDER BY m.jellyfin_id
  LIMIT $2`;

// One open row per (source, identity, reason): a new conflict inserts, a
// known conflict bumps the existing row. Like the sync's own quarantine
// upsert, a bump keeps the FIRST-recorded payload as evidence and only
// advances occurrences/last_seen_at/detail/origin.
export const FIND_OPEN_QUARANTINE = `
  SELECT id FROM media_item_quarantine
  WHERE source = 'jellyfin' AND identity = $1 AND reason = $2 AND status = 'quarantined'`;

export const INSERT_SCAN_QUARANTINE = `
  INSERT INTO media_item_quarantine
    (source, reason, identity, scan_id, payload, detail, occurrences, status, first_seen_at, last_seen_at)
  VALUES ('jellyfin', $1, $2, $3, $4::jsonb, $5, 1, 'quarantined', $6, $6)
  RETURNING id`;

export const BUMP_SCAN_QUARANTINE = `
  UPDATE media_item_quarantine SET
    occurrences = occurrences + 1,
    last_seen_at = $3,
    scan_id = $4,
    detail = $5
  WHERE id = $1 AND status = 'quarantined' AND reason = $2`;

export interface QuarantineListRow extends QueryResultRow {
  id: string | number;
  reason: string;
  identity: string;
  status: string;
  occurrences: string | number;
  first_seen_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
  detail: string;
}

export const LIST_QUARANTINES = `
  SELECT q.id, q.reason, q.identity, q.status, q.occurrences,
         q.first_seen_at, q.last_seen_at, q.resolved_at, q.detail
  FROM media_item_quarantine q
  WHERE ($1::text IS NULL OR q.status = $1)
    AND ($2::text IS NULL OR q.reason = $2)
  ORDER BY (q.status = 'quarantined') DESC, q.last_seen_at DESC, q.id DESC
  LIMIT $3`;

export interface QuarantineDetailRow extends QueryResultRow {
  id: string | number;
  source: string;
  reason: string;
  identity: string;
  run_id: string | number | null;
  scan_id: string | number | null;
  payload: unknown;
  detail: string;
  occurrences: string | number;
  status: string;
  first_seen_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
}

export const DESCRIBE_QUARANTINE = `
  SELECT id, source, reason, identity, run_id, scan_id, payload, detail,
         occurrences, status, first_seen_at, last_seen_at, resolved_at
  FROM media_item_quarantine
  WHERE id = $1`;

export interface QuarantineHistoryRow extends QueryResultRow {
  change_kind: string;
  jellyfin_id: string;
  source_revision: string | null;
  observed_at: Date;
  changed_fields: unknown;
}

export const DESCRIBE_ITEM_HISTORY = `
  SELECT change_kind, jellyfin_id, source_revision, observed_at, changed_fields
  FROM media_item_changes
  WHERE jellyfin_id = ANY($1::text[])
  ORDER BY id DESC
  LIMIT $2`;

export interface RepairAuditRow extends QueryResultRow {
  action: string;
  operator: string;
  note: string | null;
  evidence: unknown;
  recorded_at: Date;
}

export const DESCRIBE_REPAIRS = `
  SELECT action, operator, note, evidence, recorded_at
  FROM media_identity_repairs
  WHERE quarantine_id = $1
  ORDER BY id`;

export const RESOLVE_QUARANTINE = `
  UPDATE media_item_quarantine
  SET status = $2, resolved_at = $3
  WHERE id = $1 AND status = 'quarantined'
  RETURNING reason, identity, occurrences, payload, detail, first_seen_at, last_seen_at`;

export const REMAP_TARGET_LIBRARY = `
  SELECT id, jellyfin_id FROM media_libraries
  WHERE source = 'jellyfin' AND jellyfin_id = $1 AND removed_at IS NULL`;

export const REMAP_READ_QUARANTINE = `
  SELECT id, reason, identity, status FROM media_item_quarantine
  WHERE id = $1 FOR UPDATE`;

export const REMAP_READ_ITEM = `
  SELECT m.id, m.library_id, m.name, l.jellyfin_id AS library_jellyfin_id
  FROM media_items m
  JOIN media_libraries l ON l.id = m.library_id
  WHERE m.source = 'jellyfin' AND m.jellyfin_id = $1 AND m.removed_at IS NULL`;

export const REMAP_UPDATE_ITEM = `
  UPDATE media_items SET library_id = $2 WHERE id = $1`;

export const INSERT_REPAIR_AUDIT = `
  INSERT INTO media_identity_repairs
    (quarantine_id, action, operator, note, evidence, recorded_at)
  VALUES ($1, $2, $3, $4, $5::jsonb, $6)
  RETURNING id`;

// ---------------------------------------------------------------------------
// Pure helpers (hermetically testable)
// ---------------------------------------------------------------------------

export interface QuarantinedItemRef {
  jellyfinId: string;
  itemType: string;
  name: string;
  libraryJellyfinId: string;
}

export interface TombstonedItemRef {
  jellyfinId: string;
  name: string;
  removedAt: string;
  firstSeenAt: string;
}

const bounded = <T>(items: T[]): T[] => items.slice(0, WORKBENCH_LIMITS.payloadItemsPerConflict);

export function duplicateFilePayload(filePath: string, items: QuarantinedItemRef[]): Record<string, unknown> {
  return {
    filePath,
    itemCount: items.length,
    items: bounded(items).map((item) => ({ ...item }))
  };
}

export function duplicateFileDetail(filePath: string, itemCount: number): string {
  return `${itemCount} active catalog items claim file "${filePath}" — only one can be the true identity; confirm in Jellyfin which item(s) are duplicates of the other`;
}

export function movedMediaPayload(
  filePath: string,
  active: QuarantinedItemRef[],
  tombstoned: TombstonedItemRef[]
): Record<string, unknown> {
  return {
    filePath,
    activeCount: active.length,
    active: bounded(active).map((item) => ({ ...item })),
    tombstonedCount: tombstoned.length,
    tombstoned: bounded(tombstoned).map((item) => ({ ...item }))
  };
}

export function movedMediaDetail(filePath: string, activeCount: number, tombstonedCount: number): string {
  return (
    `file "${filePath}" is live under ${activeCount} newer identit${activeCount === 1 ? "y" : "ies"} ` +
    `while ${tombstonedCount} retired identit${tombstonedCount === 1 ? "y" : "ies"} still claim${tombstonedCount === 1 ? "s" : ""} it — ` +
    `moved/renamed media; confirm the live identity is the same title, then resolve`
  );
}

export function missingExternalIdPayload(ref: QuarantinedItemRef & { filePath: string | null }): Record<string, unknown> {
  return {
    jellyfinId: ref.jellyfinId,
    itemType: ref.itemType,
    name: ref.name,
    libraryJellyfinId: ref.libraryJellyfinId,
    filePath: ref.filePath
  };
}

export function missingExternalIdDetail(ref: { itemType: string; name: string; jellyfinId: string }): string {
  return (
    `active ${ref.itemType} "${ref.name}" (${ref.jellyfinId}) has no external provider IDs — ` +
    `identity reconciliation across renames/moves has no anchor`
  );
}

// Evidence projection of one resolution: bounded, plain data.
export function resolveEvidence(params: {
  action: ResolveAction;
  reason: string;
  identity: string;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  detail: string;
  payload: unknown;
  note: string | null;
}): Record<string, unknown> {
  return {
    action: params.action,
    quarantine: {
      reason: params.reason,
      identity: params.identity,
      occurrences: params.occurrences,
      firstSeenAt: params.firstSeenAt.toISOString(),
      lastSeenAt: params.lastSeenAt.toISOString(),
      detail: params.detail
    },
    payload: params.payload,
    note: params.note
  };
}

export function remapEvidence(params: {
  reason: string;
  identity: string;
  itemName: string;
  fromLibraryJellyfinId: string;
  toLibraryJellyfinId: string;
  note: string | null;
}): Record<string, unknown> {
  return {
    action: "remapped",
    quarantine: { reason: params.reason, identity: params.identity },
    item: { jellyfinId: params.identity, name: params.itemName },
    placement: {
      from: { libraryJellyfinId: params.fromLibraryJellyfinId },
      to: { libraryJellyfinId: params.toLibraryJellyfinId }
    },
    note: params.note
  };
}

// Trim + bound repair attribution. Fail-closed: audit without an operator
// identity is rejected before anything is written.
export function validateRepairInput(raw: {
  operator: string | undefined;
  note: string | undefined | null;
}): { operator: string; note: string | null } {
  const operator = raw.operator?.trim() ?? "";
  if (!operator) {
    throw new WorkbenchParamError("operator identity is required (set REELHOUSE_OPERATOR) — repairs without an actor are not auditable");
  }
  if (operator.length > WORKBENCH_LIMITS.operatorMaxLength) {
    throw new WorkbenchParamError(
      `operator identity must be at most ${WORKBENCH_LIMITS.operatorMaxLength} characters (got ${operator.length})`
    );
  }
  let note: string | null = null;
  if (raw.note !== undefined && raw.note !== null) {
    const trimmed = raw.note.trim();
    if (!trimmed) {
      throw new WorkbenchParamError("note must be non-empty when provided (omit the flag instead)");
    }
    if (trimmed.length > WORKBENCH_LIMITS.noteMaxLength) {
      throw new WorkbenchParamError(`note must be at most ${WORKBENCH_LIMITS.noteMaxLength} characters (got ${trimmed.length})`);
    }
    note = trimmed;
  }
  return { operator, note };
}

export function parseQuarantineId(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new WorkbenchParamError(`quarantine id must be a positive integer (got "${raw}")`);
  }
  return parsed;
}

export function normalizeTargetLibraryId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new WorkbenchParamError("target library id is required (--library <jellyfin-library-id>)");
  }
  if (trimmed.length > WORKBENCH_LIMITS.operatorMaxLength) {
    throw new WorkbenchParamError(
      `target library id must be at most ${WORKBENCH_LIMITS.operatorMaxLength} characters (got ${trimmed.length})`
    );
  }
  return trimmed;
}

export interface NormalizedListParams {
  status: QuarantineStatus | "all";
  reason: QuarantineReason | "all";
  limit: number;
}

// Closed enums fail closed; unknown values never silently widen the filter.
export function normalizeListParams(raw: {
  status?: string;
  reason?: string;
  limit?: number;
}): NormalizedListParams {
  let status: NormalizedListParams["status"] = "all";
  if (raw.status !== undefined) {
    const candidate = raw.status.trim();
    if (!(QUARANTINE_STATUSES as readonly string[]).includes(candidate) && candidate !== "all") {
      throw new WorkbenchParamError(
        `status filter must be one of ${QUARANTINE_STATUSES.join(", ")}, all (got "${raw.status}")`
      );
    }
    status = candidate as NormalizedListParams["status"];
  }
  let reason: NormalizedListParams["reason"] = "all";
  if (raw.reason !== undefined) {
    const candidate = raw.reason.trim();
    if (!(QUARANTINE_REASONS as readonly string[]).includes(candidate) && candidate !== "all") {
      throw new WorkbenchParamError(
        `reason filter must be one of ${QUARANTINE_REASONS.join(", ")}, all (got "${raw.reason}")`
      );
    }
    reason = candidate as NormalizedListParams["reason"];
  }
  const limit = raw.limit ?? WORKBENCH_LIMITS.listDefaultLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKBENCH_LIMITS.listMaxLimit) {
    throw new WorkbenchParamError(
      `limit must be between 1 and ${WORKBENCH_LIMITS.listMaxLimit} (got ${limit})`
    );
  }
  return { status, reason, limit };
}

// The Jellyfin ids a quarantine's evidence points at, deduplicated and
// bounded, for inspection joins.
export function evidenceItemIds(identity: string, reason: string, payload: unknown): string[] {
  const ids: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value && !ids.includes(value)) ids.push(value);
  };
  if (reason === "duplicate_identity" || reason === "missing_external_id") {
    push(identity);
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const entry of Array.isArray(record.items) ? record.items : []) {
      if (entry && typeof entry === "object") push((entry as Record<string, unknown>).jellyfinId);
    }
    const current = record.active;
    for (const entry of Array.isArray(current) ? current : []) {
      if (entry && typeof entry === "object") push((entry as Record<string, unknown>).jellyfinId);
    }
    for (const entry of Array.isArray(record.tombstoned) ? record.tombstoned : []) {
      if (entry && typeof entry === "object") push((entry as Record<string, unknown>).jellyfinId);
    }
  }
  return ids.slice(0, WORKBENCH_LIMITS.describeItemsPerQuarantine);
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export interface IdentityScanFindings {
  duplicateFile: number;
  movedMedia: number;
  missingExternalId: number;
}

export interface IdentityScanResult extends IdentityScanFindings {
  scanId: number;
  status: "succeeded";
  quarantinesOpened: number;
  quarantinesBumped: number;
  // True when a detector hit its per-scan cap: findings are complete for the
  // recorded prefix but the catalog holds more conflicts.
  truncated: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface IdentityScanOptions {
  clock?: () => Date;
}

async function recordFinding(
  tx: SyncExecutor,
  params: {
    scanId: number;
    reason: ScanReason;
    identity: string;
    payload: Record<string, unknown>;
    detail: string;
    seenAt: Date;
  }
): Promise<"opened" | "bumped"> {
  const open = await tx.query<IdRow>(FIND_OPEN_QUARANTINE, [params.identity, params.reason]);
  if (open.rows.length > 0) {
    const existingId = Number(open.rows[0].id);
    await tx.query(BUMP_SCAN_QUARANTINE, [
      existingId,
      params.reason,
      params.seenAt,
      params.scanId,
      params.detail
    ]);
    return "bumped";
  }
  await tx.query(INSERT_SCAN_QUARANTINE, [
    params.reason,
    params.identity,
    params.scanId,
    JSON.stringify(params.payload),
    params.detail,
    params.seenAt
  ]);
  return "opened";
}

function recordScanFailureDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

export async function failScan(
  executor: SyncExecutor,
  scanId: number,
  detail: string
): Promise<void> {
  try {
    await executor.query(COMPLETE_SCAN, [scanId, "failed", 0, 0, 0, 0, 0, false, detail.slice(0, 1000)]);
  } catch {
    /* the original failure is reported instead */
  }
}

export async function runIdentityScan(
  executor: SyncExecutor,
  options: IdentityScanOptions = {}
): Promise<IdentityScanResult> {
  const clock = options.clock ?? (() => new Date());
  const cap = WORKBENCH_LIMITS.maxFindingsPerDetector;

  const startedMs = Date.now();
  const startedAt = new Date().toISOString();
  const runRow = await executor.query<{ id: string | number; started_at: Date }>(INSERT_RUNNING_SCAN);
  const scanId = Number(runRow.rows[0].id);
  const startedAtFromDb = runRow.rows[0].started_at;

  try {
    const findings = await executor.withTransaction(async (tx) => {
      const seenAt = clock();
      let opened = 0;
      let bumped = 0;
      let truncated = false;

      // duplicate_file: group active items by exact path (case-sensitive —
      // that is the source's own semantics), then project the involved items
      // into the evidence payload.
      const dupGroups = await tx.query<{
        file_path: string;
        item_count: number;
        jellyfin_ids: string[];
      }>(DETECT_DUPLICATE_FILES, [cap]);
      if (dupGroups.rows.length === cap) truncated = true;
      for (const group of dupGroups.rows) {
        const projections = await tx.query<ItemProjectionRow>(SELECT_ITEM_PROJECTIONS, [
          group.jellyfin_ids,
          cap
        ]);
        const items: QuarantinedItemRef[] = projections.rows.map((row) => ({
          jellyfinId: row.jellyfin_id,
          itemType: row.item_type,
          name: row.name,
          libraryJellyfinId: row.library_jellyfin_id
        }));
        const verdict = await recordFinding(tx, {
          scanId,
          reason: "duplicate_file",
          identity: group.file_path,
          payload: duplicateFilePayload(group.file_path, items),
          detail: duplicateFileDetail(group.file_path, group.item_count),
          seenAt
        });
        if (verdict === "opened") opened += 1;
        else bumped += 1;
      }

      // moved_media: active identities on a path a retired identity owned.
      const movedGroups = await tx.query<{
        file_path: string;
        active_ids: string[];
        tombstoned_ids: string[];
      }>(DETECT_MOVED_MEDIA, [cap]);
      if (movedGroups.rows.length === cap) truncated = true;
      for (const group of movedGroups.rows) {
        const allIds = [...group.active_ids, ...group.tombstoned_ids];
        const projections = await tx.query<ItemProjectionRow>(SELECT_ITEM_PROJECTIONS, [allIds, cap]);
        const byId = new Map(projections.rows.map((row) => [row.jellyfin_id, row]));
        const active: QuarantinedItemRef[] = group.active_ids
          .map((id) => byId.get(id))
          .filter((row): row is ItemProjectionRow => row !== undefined)
          .map((row) => ({
            jellyfinId: row.jellyfin_id,
            itemType: row.item_type,
            name: row.name,
            libraryJellyfinId: row.library_jellyfin_id
          }));
        const tombstoned: TombstonedItemRef[] = group.tombstoned_ids
          .map((id) => byId.get(id))
          .filter((row): row is ItemProjectionRow => row !== undefined && row.removed_at !== null)
          .map((row) => ({
            jellyfinId: row.jellyfin_id,
            name: row.name,
            removedAt: row.removed_at!.toISOString(),
            firstSeenAt: row.first_seen_at.toISOString()
          }));
        const verdict = await recordFinding(tx, {
          scanId,
          reason: "moved_media",
          identity: group.file_path,
          payload: movedMediaPayload(group.file_path, active, tombstoned),
          detail: movedMediaDetail(group.file_path, group.active_ids.length, group.tombstoned_ids.length),
          seenAt
        });
        if (verdict === "opened") opened += 1;
        else bumped += 1;
      }

      // missing_external_id: rows already carry the whole evidence.
      const missing = await tx.query<{
        jellyfin_id: string;
        item_type: string;
        name: string;
        library_jellyfin_id: string;
        file_path: string | null;
      }>(DETECT_MISSING_EXTERNAL_IDS, [cap]);
      if (missing.rows.length === cap) truncated = true;
      for (const row of missing.rows) {
        const ref = {
          jellyfinId: row.jellyfin_id,
          itemType: row.item_type,
          name: row.name,
          libraryJellyfinId: row.library_jellyfin_id,
          filePath: row.file_path
        };
        const verdict = await recordFinding(tx, {
          scanId,
          reason: "missing_external_id",
          identity: row.jellyfin_id,
          payload: missingExternalIdPayload(ref),
          detail: missingExternalIdDetail(ref),
          seenAt
        });
        if (verdict === "opened") opened += 1;
        else bumped += 1;
      }

      return {
        duplicateFile: dupGroups.rows.length,
        movedMedia: movedGroups.rows.length,
        missingExternalId: missing.rows.length,
        opened,
        bumped,
        truncated
      };
    });

    const finishedAt = new Date().toISOString();
    await executor.query(COMPLETE_SCAN, [
      scanId,
      "succeeded",
      findings.duplicateFile,
      findings.movedMedia,
      findings.missingExternalId,
      findings.opened,
      findings.bumped,
      findings.truncated,
      null
    ]);
    return {
      scanId,
      status: "succeeded",
      duplicateFile: findings.duplicateFile,
      movedMedia: findings.movedMedia,
      missingExternalId: findings.missingExternalId,
      quarantinesOpened: findings.opened,
      quarantinesBumped: findings.bumped,
      truncated: findings.truncated,
      startedAt: (startedAtFromDb ?? new Date(startedAt)).toISOString(),
      finishedAt,
      durationMs: Date.now() - startedMs
    };
  } catch (error) {
    const detail = recordScanFailureDetail(error);
    await failScan(executor, scanId, detail);
    throw new WorkbenchError(`Identity scan failed: ${detail}`, {
      operation: "scan",
      scanId,
      errorDetail: detail
    });
  }
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

export async function listQuarantines(
  executor: SyncExecutor,
  params: { status?: string; reason?: string; limit?: number }
): Promise<QuarantineListRow[]> {
  const normalized = normalizeListParams(params);
  const result = await executor.query<QuarantineListRow>(LIST_QUARANTINES, [
    normalized.status === "all" ? null : normalized.status,
    normalized.reason === "all" ? null : normalized.reason,
    normalized.limit
  ]);
  return result.rows;
}

export interface QuarantineInspection {
  quarantine: QuarantineDetailRow;
  items: ItemProjectionRow[];
  history: QuarantineHistoryRow[];
  repairs: RepairAuditRow[];
}

export async function describeQuarantine(
  executor: SyncExecutor,
  quarantineId: number
): Promise<QuarantineInspection> {
  const quarantine = await executor.query<QuarantineDetailRow>(DESCRIBE_QUARANTINE, [quarantineId]);
  if (quarantine.rows.length === 0) {
    throw new WorkbenchError(`quarantine #${quarantineId} does not exist`, {
      operation: "resolve",
      errorDetail: `quarantine #${quarantineId} does not exist`
    });
  }
  const row = quarantine.rows[0];
  const ids = evidenceItemIds(row.identity, row.reason, row.payload);

  const items = ids.length
    ? await executor.query<ItemProjectionRow>(SELECT_ITEM_PROJECTIONS, [
        ids,
        WORKBENCH_LIMITS.describeItemsPerQuarantine
      ])
    : { rows: [] as ItemProjectionRow[] };
  const history = ids.length
    ? await executor.query<QuarantineHistoryRow>(DESCRIBE_ITEM_HISTORY, [
        ids,
        WORKBENCH_LIMITS.historyRowsPerDescribe
      ])
    : { rows: [] as QuarantineHistoryRow[] };
  const repairs = await executor.query<RepairAuditRow>(DESCRIBE_REPAIRS, [quarantineId]);

  return { quarantine: row, items: items.rows, history: history.rows, repairs: repairs.rows };
}

// ---------------------------------------------------------------------------
// Resolution (release / discard / remap)
// ---------------------------------------------------------------------------

interface ResolvedRow extends QueryResultRow {
  reason: string;
  identity: string;
  occurrences: string | number;
  payload: unknown;
  detail: string;
  first_seen_at: Date;
  last_seen_at: Date;
}

async function resolveOpenQuarantine(
  tx: SyncExecutor,
  params: {
    quarantineId: number;
    status: ResolveAction;
    // What the audit records: the plain resolutions audit their own status;
    // a remap closes the row as released but is audited as 'remapped'.
    auditAction?: "released" | "discarded" | "remapped";
    operator: string;
    note: string | null;
    resolvedAt: Date;
    // Overrides the default from-the-row evidence projection (the remap path
    // records the placement change instead).
    evidence?: Record<string, unknown>;
  }
): Promise<{ row: ResolvedRow; auditId: number }> {
  // Distinguish "missing" from "already resolved" before the conditional
  // update, so the operator gets an actionable message either way.
  const existing = await tx.query<{ status: string }>(
    "SELECT status FROM media_item_quarantine WHERE id = $1 FOR UPDATE",
    [params.quarantineId]
  );
  if (existing.rows.length === 0) {
    throw new WorkbenchError(`quarantine #${params.quarantineId} does not exist`, {
      operation: "resolve",
      errorDetail: `quarantine #${params.quarantineId} does not exist`
    });
  }
  if (existing.rows[0].status !== "quarantined") {
    throw new WorkbenchError(
      `quarantine #${params.quarantineId} is already resolved (status "${existing.rows[0].status}") — resolved rows never resolve again`,
      {
        operation: "resolve",
        errorDetail: `quarantine #${params.quarantineId} already resolved`
      }
    );
  }

  const resolved = await tx.query<ResolvedRow>(RESOLVE_QUARANTINE, [
    params.quarantineId,
    params.status,
    params.resolvedAt
  ]);
  const row = resolved.rows[0];
  const evidence =
    params.evidence ??
    resolveEvidence({
      action: params.status,
      reason: row.reason,
      identity: row.identity,
      occurrences: Number(row.occurrences),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      detail: row.detail,
      payload: row.payload,
      note: params.note
    });
  const audit = await tx.query<IdRow>(INSERT_REPAIR_AUDIT, [
    params.quarantineId,
    params.auditAction ?? params.status,
    params.operator,
    params.note,
    JSON.stringify(evidence),
    params.resolvedAt
  ]);
  return { row, auditId: Number(audit.rows[0].id) };
}

export interface ResolveResult {
  quarantineId: number;
  status: ResolveAction;
  reason: string;
  identity: string;
  auditId: number;
}

export async function releaseQuarantine(
  executor: SyncExecutor,
  params: {
    quarantineId: number;
    operator: string | undefined;
    note?: string;
    clock?: () => Date;
  }
): Promise<ResolveResult> {
  return resolveQuarantine(executor, { ...params, status: "released" });
}

export async function discardQuarantine(
  executor: SyncExecutor,
  params: {
    quarantineId: number;
    operator: string | undefined;
    note?: string;
    clock?: () => Date;
  }
): Promise<ResolveResult> {
  return resolveQuarantine(executor, { ...params, status: "discarded" });
}

async function resolveQuarantine(
  executor: SyncExecutor,
  params: {
    quarantineId: number;
    status: ResolveAction;
    operator: string | undefined;
    note?: string;
    clock?: () => Date;
  }
): Promise<ResolveResult> {
  const { operator, note } = validateRepairInput({ operator: params.operator, note: params.note ?? null });
  const clock = params.clock ?? (() => new Date());
  const resolvedAt = clock();

  try {
    return await executor.withTransaction(async (tx) => {
      const { row, auditId } = await resolveOpenQuarantine(tx, {
        quarantineId: params.quarantineId,
        status: params.status,
        operator,
        note,
        resolvedAt
      });
      return {
        quarantineId: params.quarantineId,
        status: params.status,
        reason: row.reason,
        identity: row.identity,
        auditId
      };
    });
  } catch (error) {
    if (error instanceof WorkbenchError || error instanceof WorkbenchParamError) throw error;
    const detail = recordScanFailureDetail(error);
    throw new WorkbenchError(`resolve failed: ${detail}`, {
      operation: "resolve",
      errorDetail: detail
    });
  }
}

export interface RemapResult extends ResolveResult {
  status: "released";
  itemJellyfinId: string;
  fromLibraryJellyfinId: string;
  toLibraryJellyfinId: string;
}

// The one bounded catalog write in the workbench: re-point a quarantined
// duplicate_identity item to the operator-chosen library, then resolve the
// row as released with a 'remapped' audit entry. Everything — the read, the
// placement write, the resolve, and the audit — happens in one transaction.
export async function remapQuarantineItem(
  executor: SyncExecutor,
  params: {
    quarantineId: number;
    targetLibraryJellyfinId: string;
    operator: string | undefined;
    note?: string;
    clock?: () => Date;
  }
): Promise<RemapResult> {
  const { operator, note } = validateRepairInput({ operator: params.operator, note: params.note ?? null });
  const targetLibraryJellyfinId = normalizeTargetLibraryId(params.targetLibraryJellyfinId);
  const clock = params.clock ?? (() => new Date());
  const resolvedAt = clock();

  try {
    return await executor.withTransaction(async (tx) => {
      const quarantine = await tx.query<{
        id: string | number;
        reason: string;
        identity: string;
        status: string;
      }>(REMAP_READ_QUARANTINE, [params.quarantineId]);
      if (quarantine.rows.length === 0) {
        throw new WorkbenchError(`quarantine #${params.quarantineId} does not exist`, {
          operation: "remap",
          errorDetail: `quarantine #${params.quarantineId} does not exist`
        });
      }
      const row = quarantine.rows[0];
      if (row.status !== "quarantined") {
        throw new WorkbenchError(
          `quarantine #${params.quarantineId} is already resolved (status "${row.status}") — resolved rows never resolve again`,
          {
            operation: "remap",
            errorDetail: `quarantine #${params.quarantineId} already resolved`
          }
        );
      }
      if (row.reason !== "duplicate_identity") {
        throw new WorkbenchError(
          `remap applies only to duplicate_identity quarantines (quarantine #${params.quarantineId} is "${row.reason}")`,
          {
            operation: "remap",
            errorDetail: `remap on non-duplicate_identity quarantine #${params.quarantineId}`
          }
        );
      }

      const target = await tx.query<{ id: string | number; jellyfin_id: string }>(REMAP_TARGET_LIBRARY, [
        targetLibraryJellyfinId
      ]);
      if (target.rows.length === 0) {
        throw new WorkbenchError(
          `target library "${targetLibraryJellyfinId}" does not exist as an active Jellyfin library — refusing to remap into a library the source does not confirm`,
          {
            operation: "remap",
            errorDetail: `unknown target library ${targetLibraryJellyfinId}`
          }
        );
      }

      const item = await tx.query<{
        id: string | number;
        library_id: string | number;
        name: string;
        library_jellyfin_id: string;
      }>(REMAP_READ_ITEM, [row.identity]);
      if (item.rows.length === 0) {
        throw new WorkbenchError(
          `quarantined identity "${row.identity}" has no active catalog item — nothing to remap (sync may have tombstoned it)`,
          {
            operation: "remap",
            errorDetail: `no active item for identity ${row.identity}`
          }
        );
      }
      const itemRow = item.rows[0];
      if (itemRow.library_jellyfin_id === targetLibraryJellyfinId) {
        throw new WorkbenchError(
          `item "${row.identity}" already lives in library "${targetLibraryJellyfinId}" — to confirm the current placement use release instead of remap`,
          {
            operation: "remap",
            errorDetail: `remap target equals current placement for ${row.identity}`
          }
        );
      }

      await tx.query(REMAP_UPDATE_ITEM, [itemRow.id, target.rows[0].id]);
      const { auditId } = await resolveOpenQuarantine(tx, {
        quarantineId: params.quarantineId,
        status: "released",
        auditAction: "remapped",
        operator,
        note,
        evidence: remapEvidence({
          reason: row.reason,
          identity: row.identity,
          itemName: itemRow.name,
          fromLibraryJellyfinId: itemRow.library_jellyfin_id,
          toLibraryJellyfinId: targetLibraryJellyfinId,
          note
        }),
        resolvedAt
      });

      return {
        quarantineId: params.quarantineId,
        status: "released",
        reason: row.reason,
        identity: row.identity,
        auditId,
        itemJellyfinId: row.identity,
        fromLibraryJellyfinId: itemRow.library_jellyfin_id,
        toLibraryJellyfinId: targetLibraryJellyfinId
      };
    });
  } catch (error) {
    if (error instanceof WorkbenchError || error instanceof WorkbenchParamError) throw error;
    const detail = recordScanFailureDetail(error);
    throw new WorkbenchError(`remap failed: ${detail}`, {
      operation: "remap",
      errorDetail: detail
    });
  }
}
