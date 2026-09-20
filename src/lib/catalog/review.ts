// Operator workflow over the catalog quarantine (RH-0023, docs/CATALOG_REVIEW.md).
//
// The sync (sync.ts) quarantines ambiguous identities at detection time and
// owns five quarantine reasons. This module adds everything the sync must
// not decide by itself:
//
// - Review: bounded listing and inspection of quarantine entries, including
//   the verbatim payload snapshot the sync stored.
// - Catalog-level detectors for conflicts no single page can see:
//   duplicate_path (two live items sharing one file path) and
//   renamed_identity (a missing/retired item whose path reappeared under a
//   different id). Detector reasons and sync reasons are disjoint and both
//   sides only ever write their own, so re-detection never fights
//   auto-resolution.
// - Resolution: an operator can close an entry with an action, note, and
//   identity. Re-detection re-opens entries rather than letting a stale
//   verdict masquerade as health — except `dismissed`, which is a durable
//   "this conflict is known and accepted" verdict for detector findings.
// - Safe remapping: catalog_identity_override rows are durable identity
//   decisions (a contested provider id belongs to item X; an item belongs
//   to library Y). The sync consults them before its first-writer-wins
//   heuristic, so a remap is enforced deterministically on every later
//   scan. Overrides reference source ids as text (no FKs) on purpose: they
//   must survive rebuilds, which wipe catalog content but keep decisions.
//
// Pure helpers (planning, normalization, bounds) are exported for unit
// tests; database operations take a `pg` pool and never log. Like sync.ts
// this module avoids `server-only`/aliases so the CLI
// (scripts/catalog-review.ts) and tests import it under plain Node.

import { Pool, type PoolClient } from "pg";
import {
  CATALOG_URL_VAR,
  describeCatalogDatabaseConfig,
  loadCatalogDatabaseConfig,
  loadCatalogSyncPolicy
} from "./config.ts";
import { redactError } from "../db/config.ts";

// Ownership of a quarantine reason. The sync writes exactly
// SYNC_QUARANTINE_REASONS (and auto-resolves exactly those); the detectors
// here write exactly DETECTOR_QUARANTINE_REASONS. Together they are the
// vocabulary of the catalog_quarantine_reason_check constraint.
export const SYNC_QUARANTINE_REASONS = [
  "duplicate_provider_id",
  "duplicate_external_id",
  "orphan_parent",
  "invalid_item",
  "library_conflict"
] as const;

export const DETECTOR_QUARANTINE_REASONS = ["duplicate_path", "renamed_identity"] as const;

export type SyncQuarantineReason = (typeof SYNC_QUARANTINE_REASONS)[number];
export type DetectorQuarantineReason = (typeof DETECTOR_QUARANTINE_REASONS)[number];
export type QuarantineReason = SyncQuarantineReason | DetectorQuarantineReason;

export const QUARANTINE_REASONS: QuarantineReason[] = [...SYNC_QUARANTINE_REASONS, ...DETECTOR_QUARANTINE_REASONS];

// `remapped` is set only by the remap flows, never accepted from a bare
// resolve command.
export const RESOLVE_ACTIONS = ["dismissed", "source_fixed", "discarded"] as const;
export const RESOLUTION_ACTIONS = [...RESOLVE_ACTIONS, "remapped"] as const;

export type ResolveAction = (typeof RESOLVE_ACTIONS)[number];

export const RESOLUTION_NOTE_MAX = 1000;
export const RESOLUTION_BY_MAX = 200;
export const PROVIDER_MAX = 100;
export const IDENTITY_MAX = 200;

// Bounds for operator-facing listings and detector output; a quarantine
// backlog large enough to hit these needs triage, not an unbounded dump.
export const LIST_LIMIT_DEFAULT = 100;
export const LIST_LIMIT_MAX = 500;
export const DETECT_MAX_FINDINGS = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Pure helpers (unit-tested without a database) ----

export type ValidationResult<T> = { kind: "invalid"; errors: string[] } | { kind: "valid"; value: T };

export interface ResolutionInput {
  action: ResolveAction;
  note: string | null;
  by: string;
}

function boundedOptionalText(raw: string | undefined, max: number, label: string, errors: string[]): string | null {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return null;
  if (trimmed.length > max) {
    errors.push(`${label} must be at most ${max} characters (got ${trimmed.length})`);
    return null;
  }
  return trimmed;
}

function boundedRequiredText(raw: string | undefined, max: number, label: string, errors: string[]): string | null {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") {
    errors.push(`${label} is required`);
    return null;
  }
  if (trimmed.length > max) {
    errors.push(`${label} must be at most ${max} characters (got ${trimmed.length})`);
    return null;
  }
  return trimmed;
}

export function normalizeResolution(raw: {
  action?: string;
  note?: string;
  by?: string;
}): ValidationResult<ResolutionInput> {
  const errors: string[] = [];
  const action = raw.action?.trim() ?? "";
  if (!RESOLVE_ACTIONS.includes(action as ResolveAction)) {
    errors.push(`action must be one of ${RESOLVE_ACTIONS.join(", ")} (got "${action || "(none)"}")`);
  }
  const note = boundedOptionalText(raw.note, RESOLUTION_NOTE_MAX, "note", errors);
  const by = boundedRequiredText(raw.by, RESOLUTION_BY_MAX, "by", errors);
  if (errors.length > 0) return { kind: "invalid", errors };
  return { kind: "valid", value: { action: action as ResolveAction, note, by: by as string } };
}

export interface ProviderClaimInput {
  provider: string;
  value: string;
  canonicalExternalId: string;
  note: string | null;
  by: string;
}

export function normalizeProviderClaim(raw: {
  provider?: string;
  value?: string;
  to?: string;
  note?: string;
  by?: string;
}): ValidationResult<ProviderClaimInput> {
  const errors: string[] = [];
  const provider = (raw.provider?.trim() ?? "").toLowerCase();
  if (provider === "") errors.push("provider is required");
  else if (provider.length > PROVIDER_MAX) errors.push(`provider must be at most ${PROVIDER_MAX} characters`);
  const value = boundedRequiredText(raw.value, IDENTITY_MAX, "provider id value", errors);
  const canonicalExternalId = boundedRequiredText(raw.to, IDENTITY_MAX, "canonical item id", errors);
  const note = boundedOptionalText(raw.note, RESOLUTION_NOTE_MAX, "note", errors);
  const by = boundedRequiredText(raw.by, RESOLUTION_BY_MAX, "by", errors);
  if (errors.length > 0) return { kind: "invalid", errors };
  return {
    kind: "valid",
    value: { provider: provider as string, value: value as string, canonicalExternalId: canonicalExternalId as string, note, by: by as string }
  };
}

export interface LibraryPinInput {
  externalId: string;
  libraryExternalId: string;
  note: string | null;
  by: string;
}

export function normalizeLibraryPin(raw: {
  externalId?: string;
  to?: string;
  note?: string;
  by?: string;
}): ValidationResult<LibraryPinInput> {
  const errors: string[] = [];
  const externalId = boundedRequiredText(raw.externalId, IDENTITY_MAX, "item id", errors);
  const libraryExternalId = boundedRequiredText(raw.to, IDENTITY_MAX, "canonical library id", errors);
  const note = boundedOptionalText(raw.note, RESOLUTION_NOTE_MAX, "note", errors);
  const by = boundedRequiredText(raw.by, RESOLUTION_BY_MAX, "by", errors);
  if (externalId !== null && libraryExternalId !== null && externalId === libraryExternalId) {
    errors.push("an item cannot be pinned to itself; the canonical id must be a library id");
  }
  if (errors.length > 0) return { kind: "invalid", errors };
  return {
    kind: "valid",
    value: { externalId: externalId as string, libraryExternalId: libraryExternalId as string, note, by: by as string }
  };
}

export function normalizeQuarantineId(raw: string | undefined): ValidationResult<string> {
  const trimmed = raw?.trim() ?? "";
  if (!UUID_PATTERN.test(trimmed)) {
    return { kind: "invalid", errors: [`quarantine id must be a uuid (got "${trimmed || "(none)"}")`] };
  }
  return { kind: "valid", value: trimmed.toLowerCase() };
}

export function normalizeOverrideId(raw: string | undefined): ValidationResult<string> {
  return normalizeQuarantineId(raw);
}

export function isValidQuarantineReason(raw: string): raw is QuarantineReason {
  return (QUARANTINE_REASONS as string[]).includes(raw);
}

// A row resolved without an operator action was closed automatically: by the
// sync (its own reasons) or by a detector re-scan (detector reasons).
export function describeResolutionState(reason: string, resolvedAt: string | null, action: string | null): string {
  if (resolvedAt === null) return "open";
  if (action !== null) return action;
  return (DETECTOR_QUARANTINE_REASONS as readonly string[]).includes(reason) ? "auto_detect" : "auto_sync";
}

// ---- Detector planning (pure) ----

export interface CatalogPathRow {
  externalId: string;
  path: string;
  observedAt: string;
  missingSince: string | null;
  retiredAt: string | null;
}

export interface QuarantineFinding {
  externalId: string;
  reason: DetectorQuarantineReason;
  detail: Record<string, unknown>;
}

export interface DetectionPlan {
  findings: QuarantineFinding[];
  truncated: boolean;
}

function isActive(row: CatalogPathRow): boolean {
  return row.missingSince === null && row.retiredAt === null;
}

function byObservation(a: CatalogPathRow, b: CatalogPathRow): number {
  if (a.observedAt !== b.observedAt) return a.observedAt < b.observedAt ? -1 : 1;
  return a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0;
}

function boundFindings(findings: QuarantineFinding[], maxFindings: number): DetectionPlan {
  if (findings.length <= maxFindings) return { findings, truncated: false };
  return { findings: findings.slice(0, maxFindings), truncated: true };
}

// Two live items sharing one file path. The incumbent is the earliest
// observation (ties break on id); every later claimant is reported. Missing
// and retired rows are excluded: an item that left and was replaced is a
// rename candidate, not a duplicate.
export function planDuplicatePathFindings(rows: CatalogPathRow[], maxFindings: number): DetectionPlan {
  const byPath = new Map<string, CatalogPathRow[]>();
  for (const row of rows) {
    if (!isActive(row)) continue;
    const bucket = byPath.get(row.path);
    if (bucket === undefined) byPath.set(row.path, [row]);
    else bucket.push(row);
  }
  const paths = [...byPath.keys()].sort();
  const findings: QuarantineFinding[] = [];
  for (const path of paths) {
    const members = (byPath.get(path) as CatalogPathRow[]).sort(byObservation);
    if (members.length < 2) continue;
    const incumbent = members[0];
    for (const claimant of members.slice(1)) {
      findings.push({
        externalId: claimant.externalId,
        reason: "duplicate_path",
        detail: { path, incumbentExternalId: incumbent.externalId, incumbentObservedAt: incumbent.observedAt }
      });
    }
  }
  return boundFindings(findings, maxFindings);
}

// A missing/retired item whose path reappeared under a different live id:
// a rename or identity swap in the source. The successor is the earliest
// live observation on that path; the old id is reported, never rewritten.
export function planRenamedIdentityFindings(
  rows: CatalogPathRow[],
  maxFindings: number
): DetectionPlan {
  const activeByPath = new Map<string, CatalogPathRow[]>();
  for (const row of rows) {
    if (!isActive(row)) continue;
    const bucket = activeByPath.get(row.path);
    if (bucket === undefined) activeByPath.set(row.path, [row]);
    else bucket.push(row);
  }
  const gone = rows
    .filter((row) => !isActive(row))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : byObservation(a, b)));
  const findings: QuarantineFinding[] = [];
  for (const old of gone) {
    const candidates = (activeByPath.get(old.path) ?? [])
      .filter((row) => row.externalId !== old.externalId)
      .sort(byObservation);
    const successor = candidates[0];
    if (successor === undefined) continue;
    findings.push({
      externalId: old.externalId,
      reason: "renamed_identity",
      detail: {
        path: old.path,
        successorExternalId: successor.externalId,
        successorObservedAt: successor.observedAt,
        missingSince: old.missingSince,
        retiredAt: old.retiredAt
      }
    });
  }
  return boundFindings(findings, maxFindings);
}

// ---- Database operations ----

export interface CatalogReviewSession {
  pool: Pool;
  describe: string;
}

// Same fail-closed configuration rules as the sync; the review CLI needs no
// Jellyfin credentials — everything it reads lives in the catalog database.
export async function openCatalogReviewSession(env: Record<string, string | undefined>): Promise<CatalogReviewSession> {
  const configResult = loadCatalogDatabaseConfig(env);
  if (configResult.kind === "unconfigured") {
    throw new Error(`No media_catalog database configured: set ${CATALOG_URL_VAR} and retry`);
  }
  if (configResult.kind === "invalid") {
    throw new Error(`media_catalog configuration is invalid and was rejected: ${configResult.errors.join("; ")}`);
  }
  const policyResult = loadCatalogSyncPolicy(env);
  if (policyResult.kind === "invalid") {
    throw new Error(`Catalog policy is invalid and was rejected: ${policyResult.errors.join("; ")}`);
  }
  const config = configResult.config;
  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl,
    max: policyResult.policy.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    statement_timeout: policyResult.policy.statementTimeoutMs,
    query_timeout: policyResult.policy.statementTimeoutMs,
    application_name: "reelhouse-catalog-review"
  });
  return { pool, describe: describeCatalogDatabaseConfig(config) };
}

export async function closeCatalogReviewSession(session: CatalogReviewSession): Promise<void> {
  await session.pool.end();
}

export async function verifyReviewSchema(pool: Pool): Promise<void> {
  const required = [
    "catalog_scan",
    "catalog_sync_state",
    "catalog_library",
    "catalog_item",
    "catalog_provider_id",
    "catalog_genre",
    "catalog_studio",
    "catalog_person",
    "catalog_item_genre",
    "catalog_item_studio",
    "catalog_item_person",
    "catalog_quarantine",
    "catalog_identity_override"
  ];
  const result = await pool.query<{ table_name: string; present: boolean }>(
    `SELECT table_name, (to_regclass('public.' || table_name) IS NOT NULL) AS present
       FROM (VALUES ${required.map((table) => `('${table}')`).join(", ")}) AS v(table_name)`
  );
  const missing = required.filter((table) => {
    const row = result.rows.find((entry) => entry.table_name === table);
    return row === undefined || !row.present;
  });
  if (missing.length > 0) {
    throw new Error(
      `media_catalog schema is missing tables (${missing.join(", ")}); run "npm run catalog:migrate" first and retry`
    );
  }
}

export interface QuarantineEntry {
  id: string;
  source: string;
  externalId: string;
  reason: string;
  detail: Record<string, unknown>;
  firstDetectedAt: string;
  lastDetectedAt: string;
  resolvedAt: string | null;
  resolutionAction: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  state: string;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function mapQuarantineRow(row: {
  id: string;
  source: string;
  external_id: string;
  reason: string;
  detail: Record<string, unknown>;
  first_detected_at: Date;
  last_detected_at: Date;
  resolved_at: Date | null;
  resolution_action: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
}): QuarantineEntry {
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    reason: row.reason,
    detail: row.detail,
    firstDetectedAt: iso(row.first_detected_at) as string,
    lastDetectedAt: iso(row.last_detected_at) as string,
    resolvedAt: iso(row.resolved_at),
    resolutionAction: row.resolution_action,
    resolutionNote: row.resolution_note,
    resolvedBy: row.resolved_by,
    state: describeResolutionState(row.reason, iso(row.resolved_at), row.resolution_action)
  };
}

export type QuarantineStatusFilter = "open" | "resolved" | "all";

export function normalizeListLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return LIST_LIMIT_DEFAULT;
  return Math.max(1, Math.min(LIST_LIMIT_MAX, Math.trunc(raw)));
}

export async function listQuarantine(
  pool: Pool,
  filter: { status: QuarantineStatusFilter; reason: QuarantineReason | null; limit: number }
): Promise<QuarantineEntry[]> {
  if (filter.reason !== null && !isValidQuarantineReason(filter.reason)) {
    throw new Error(`Invalid quarantine reason filter: "${String(filter.reason)}"`);
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status !== "all") {
    clauses.push(filter.status === "open" ? "resolved_at IS NULL" : "resolved_at IS NOT NULL");
  }
  if (filter.reason !== null) {
    params.push(filter.reason);
    clauses.push(`reason = $${params.length}`);
  }
  params.push(normalizeListLimit(filter.limit));
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await pool.query(
    `SELECT id, source, external_id, reason, detail, first_detected_at, last_detected_at,
            resolved_at, resolution_action, resolution_note, resolved_by
       FROM catalog_quarantine ${where}
       ORDER BY last_detected_at DESC, id DESC
       LIMIT $${params.length}`,
    params
  );
  return result.rows.map(mapQuarantineRow);
}

export async function getQuarantine(pool: Pool, id: string): Promise<QuarantineEntry & { payload: Record<string, unknown> }> {
  const result = await pool.query(
    `SELECT id, source, external_id, reason, detail, payload, first_detected_at, last_detected_at,
            resolved_at, resolution_action, resolution_note, resolved_by
       FROM catalog_quarantine WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`No quarantine entry with id ${id}`);
  return { ...mapQuarantineRow(row), payload: row.payload };
}

interface OpenDetectorRow {
  id: string;
  external_id: string;
  reason: string;
}

export interface DetectionResult {
  duplicatePathFindings: number;
  renamedIdentityFindings: number;
  recorded: number;
  closed: number;
  truncated: boolean;
}

// Reconcile detector-owned rows with current catalog reality: record new or
// changed findings, re-open previously closed ones, close stale ones. A
// dismissed finding is a durable operator verdict and is never re-opened;
// when either detector truncates, the close step is skipped for that
// detector so an unlisted finding is never mistaken for a healed one.
export async function runDetectors(pool: Pool, at: Date, log: (line: string) => void): Promise<DetectionResult> {
  const pathsResult = await pool.query<{
    external_id: string;
    path: string;
    observed_at: Date;
    missing_since: Date | null;
    retired_at: Date | null;
  }>("SELECT external_id, path, observed_at, missing_since, retired_at FROM catalog_item WHERE path IS NOT NULL");
  const rows: CatalogPathRow[] = pathsResult.rows.map((row) => ({
    externalId: row.external_id,
    path: row.path,
    observedAt: iso(row.observed_at) as string,
    missingSince: iso(row.missing_since),
    retiredAt: iso(row.retired_at)
  }));

  const duplicatePlan = planDuplicatePathFindings(rows, DETECT_MAX_FINDINGS);
  const renamedPlan = planRenamedIdentityFindings(rows, DETECT_MAX_FINDINGS);
  const findings = [...duplicatePlan.findings, ...renamedPlan.findings];

  const openRows = await pool.query<OpenDetectorRow>(
    `SELECT id, external_id, reason FROM catalog_quarantine
      WHERE resolved_at IS NULL AND reason = ANY($1::text[])`,
    [[...DETECTOR_QUARANTINE_REASONS]]
  );

  let recorded = 0;
  for (const finding of findings) {
    const existing = openRows.rows.find(
      (row) => row.external_id === finding.externalId && row.reason === finding.reason
    );
    const upsert = await pool.query<{ id: string }>(
      `INSERT INTO catalog_quarantine (source, external_id, reason, detail, payload, first_detected_at, last_detected_at)
       VALUES ('jellyfin', $1, $2, $3::jsonb, '{}'::jsonb, $4, $4)
       ON CONFLICT (source, external_id, reason) DO UPDATE
         SET detail = EXCLUDED.detail,
             last_detected_at = EXCLUDED.last_detected_at,
             resolved_at = NULL,
             resolution_action = NULL,
             resolution_note = NULL,
             resolved_by = NULL
       WHERE catalog_quarantine.resolved_at IS NULL
          OR catalog_quarantine.resolution_action IS DISTINCT FROM 'dismissed'
       RETURNING id`,
      [finding.externalId, finding.reason, JSON.stringify(finding.detail), at]
    );
    if (existing === undefined && upsert.rows.length > 0) recorded += 1;
  }

  // Close stale findings only when nothing was truncated: the finding set is
  // then provably complete, so absence means the conflict is really gone.
  let closed = 0;
  const truncated = duplicatePlan.truncated || renamedPlan.truncated;
  if (!truncated) {
    const findingKeys = new Set(findings.map((finding) => `${finding.externalId}\u0000${finding.reason}`));
    const stale = openRows.rows.filter((row) => !findingKeys.has(`${row.external_id}\u0000${row.reason}`));
    if (stale.length > 0) {
      const closeResult = await pool.query(
        "UPDATE catalog_quarantine SET resolved_at = $2 WHERE id = ANY($1::uuid[]) AND resolved_at IS NULL",
        [stale.map((row) => row.id), at]
      );
      closed = closeResult.rowCount ?? 0;
    }
  }
  if (duplicatePlan.truncated || renamedPlan.truncated) {
    log(`Detector output truncated at ${DETECT_MAX_FINDINGS} findings per detector; open rows were not closed this run`);
  }

  return {
    duplicatePathFindings: duplicatePlan.findings.length,
    renamedIdentityFindings: renamedPlan.findings.length,
    recorded,
    closed,
    truncated
  };
}

// Items whose identity rests solely on the Jellyfin item id: no provider id
// (imdb/tmdb/...) corroborates it, so a source-side re-identification is
// invisible to identity matching. Report-only: movies and series are the
// identity-bearing kinds; seasons/episodes inherit from their parents. This
// is advice for review, never a quarantine.
export async function listWeakIdentity(
  pool: Pool,
  limit: number
): Promise<Array<{ externalId: string; kind: string; name: string; path: string | null; lastSeenAt: string }>> {
  const result = await pool.query<{
    external_id: string;
    kind: string;
    name: string;
    path: string | null;
    last_seen_at: Date;
  }>(
    `SELECT ci.external_id, ci.kind, ci.name, ci.path, ci.last_seen_at
       FROM catalog_item ci
      WHERE ci.kind IN ('movie', 'series')
        AND ci.retired_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM catalog_provider_id p WHERE p.item_id = ci.id)
      ORDER BY ci.last_seen_at DESC, ci.external_id
      LIMIT $1`,
    [normalizeListLimit(limit)]
  );
  return result.rows.map((row) => ({
    externalId: row.external_id,
    kind: row.kind,
    name: row.name,
    path: row.path,
    lastSeenAt: iso(row.last_seen_at) as string
  }));
}

export async function resolveQuarantine(
  pool: Pool,
  id: string,
  input: ResolutionInput,
  at: Date
): Promise<QuarantineEntry> {
  const result = await pool.query(
    `UPDATE catalog_quarantine
        SET resolved_at = COALESCE(resolved_at, $2),
            resolution_action = $3,
            resolution_note = $4,
            resolved_by = $5
      WHERE id = $1
      RETURNING id, source, external_id, reason, detail, first_detected_at, last_detected_at,
                resolved_at, resolution_action, resolution_note, resolved_by`,
    [id, at, input.action, input.note, input.by]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`No quarantine entry with id ${id}`);
  return mapQuarantineRow(row);
}

export interface OverrideRecord {
  id: string;
  kind: string;
  provider: string | null;
  externalValue: string | null;
  externalId: string | null;
  canonicalExternalId: string;
  reason: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function mapOverrideRow(row: {
  id: string;
  kind: string;
  provider: string | null;
  external_value: string | null;
  external_id: string | null;
  canonical_external_id: string;
  reason: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}): OverrideRecord {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    externalValue: row.external_value,
    externalId: row.external_id,
    canonicalExternalId: row.canonical_external_id,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string
  };
}

async function requireCatalogItem(client: PoolClient, externalId: string, label: string): Promise<void> {
  const result = await client.query("SELECT 1 FROM catalog_item WHERE source = 'jellyfin' AND external_id = $1", [externalId]);
  if (result.rowCount === 0) throw new Error(`Cannot remap: no catalog item with external id ${externalId} (${label})`);
}

// Remap a contested provider id to its canonical owner. The next sync
// enforces the decision deterministically: any other item still claiming the
// pair quarantines with viaOverride evidence instead of depending on
// first-writer-wins. Open duplicate_provider_id entries for the pair close
// as `remapped`; if the loser keeps claiming, the sync re-opens it.
export async function remapProviderClaim(
  pool: Pool,
  input: ProviderClaimInput,
  at: Date
): Promise<{ override: OverrideRecord; resolvedEntries: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireCatalogItem(client, input.canonicalExternalId, "canonical owner");
    const updated = await client.query<OverrideRowSql>(
      `UPDATE catalog_identity_override
          SET canonical_external_id = $3, reason = $4, created_by = $5
        WHERE source = 'jellyfin' AND kind = 'provider_claim' AND provider = $1 AND external_value = $2
        RETURNING ${OVERRIDE_COLUMNS}`,
      [input.provider, input.value, input.canonicalExternalId, input.note ?? "provider id remap", input.by]
    );
    let row = updated.rows[0];
    if (row === undefined) {
      const inserted = await client.query<OverrideRowSql>(
        `INSERT INTO catalog_identity_override
           (source, kind, provider, external_value, canonical_external_id, reason, created_by)
         VALUES ('jellyfin', 'provider_claim', $1, $2, $3, $4, $5)
         RETURNING ${OVERRIDE_COLUMNS}`,
        [input.provider, input.value, input.canonicalExternalId, input.note ?? "provider id remap", input.by]
      );
      row = inserted.rows[0];
    }
    const resolved = await client.query(
      `UPDATE catalog_quarantine
          SET resolved_at = $3, resolution_action = 'remapped', resolution_note = $4, resolved_by = $5
        WHERE resolved_at IS NULL AND source = 'jellyfin' AND reason = 'duplicate_provider_id'
          AND detail->>'provider' = $1 AND detail->>'value' = $2`,
      [input.provider, input.value, at, input.note, input.by]
    );
    await client.query("COMMIT");
    return { override: mapOverrideRow(row), resolvedEntries: resolved.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Pin an item to its canonical library. A later scan seeing the item in the
// pinned library proceeds (a sanctioned library move is applied); seeing it
// anywhere else quarantines with the pin recorded in the evidence.
export async function pinLibrary(
  pool: Pool,
  input: LibraryPinInput,
  at: Date
): Promise<{ override: OverrideRecord; resolvedEntries: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireCatalogItem(client, input.externalId, "item to pin");
    const library = await client.query(
      "SELECT 1 FROM catalog_library WHERE source = 'jellyfin' AND external_id = $1",
      [input.libraryExternalId]
    );
    if (library.rowCount === 0) {
      throw new Error(`Cannot pin: no catalog library with external id ${input.libraryExternalId}`);
    }
    const updated = await client.query<OverrideRowSql>(
      `UPDATE catalog_identity_override
          SET canonical_external_id = $2, reason = $3, created_by = $4
        WHERE source = 'jellyfin' AND kind = 'library_pin' AND external_id = $1
        RETURNING ${OVERRIDE_COLUMNS}`,
      [input.externalId, input.libraryExternalId, input.note ?? "library pin", input.by]
    );
    let row = updated.rows[0];
    if (row === undefined) {
      const inserted = await client.query<OverrideRowSql>(
        `INSERT INTO catalog_identity_override
           (source, kind, external_id, canonical_external_id, reason, created_by)
         VALUES ('jellyfin', 'library_pin', $1, $2, $3, $4)
         RETURNING ${OVERRIDE_COLUMNS}`,
        [input.externalId, input.libraryExternalId, input.note ?? "library pin", input.by]
      );
      row = inserted.rows[0];
    }
    const resolved = await client.query(
      `UPDATE catalog_quarantine
          SET resolved_at = $2, resolution_action = 'remapped', resolution_note = $3, resolved_by = $4
        WHERE resolved_at IS NULL AND source = 'jellyfin' AND reason = 'library_conflict'
          AND external_id = $1`,
      [input.externalId, at, input.note, input.by]
    );
    await client.query("COMMIT");
    return { override: mapOverrideRow(row), resolvedEntries: resolved.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface OverrideRowSql {
  id: string;
  kind: string;
  provider: string | null;
  external_value: string | null;
  external_id: string | null;
  canonical_external_id: string;
  reason: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const OVERRIDE_COLUMNS =
  "id, kind, provider, external_value, external_id, canonical_external_id, reason, created_by, created_at, updated_at";

export async function listOverrides(pool: Pool, limit: number): Promise<OverrideRecord[]> {
  const result = await pool.query<OverrideRowSql>(
    `SELECT ${OVERRIDE_COLUMNS} FROM catalog_identity_override ORDER BY created_at DESC, id DESC LIMIT $1`,
    [normalizeListLimit(limit)]
  );
  return result.rows.map(mapOverrideRow);
}

export async function removeOverride(pool: Pool, id: string): Promise<OverrideRecord> {
  const result = await pool.query<OverrideRowSql>(
    `DELETE FROM catalog_identity_override WHERE id = $1 RETURNING ${OVERRIDE_COLUMNS}`,
    [id]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`No identity override with id ${id}`);
  return mapOverrideRow(row);
}

// Redact an error at the CLI boundary with the same helper the sync uses,
// scrubbing the catalog database URL from anything this module throws.
export function redactReviewError(message: string, env: Record<string, string | undefined>): string {
  return redactError(message, env[CATALOG_URL_VAR]);
}
