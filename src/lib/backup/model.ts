// Pure model for ReelHouse backup/restore and disaster recovery (RH-0021).
//
// Same split as migrator.ts and the sync engine: everything in this module is
// deterministic logic (the table registry, canonical serialization, manifest
// build/validate, staleness, verification diffing) with no I/O and no
// `server-only`, so it runs under `node --test`, the CLI scripts, and the
// integration suites alike.
//
// Design (docs/BACKUP_RESTORE.md):
// - The two databases get separate treatment: `reelhouse` holds household
//   state that exists nowhere else (restore is the only recovery), while
//   `media_catalog` is rebuildable from Jellyfin through the RH-0016 sync
//   (a backup is an optimization, the resync is the authority).
// - A backup is a directory: manifest.json (versioned, self-describing),
//   a manifest.json.sha256 sidecar, and one canonical JSONL file per table.
// - Checksums are computed over the same canonical line serialization that
//   the restore verification recomputes from a restored scratch database, so
//   a passing verification proves the files AND the restore path end to end.
// - Everything fails closed: a manifest that disagrees with this module's
//   registry, migration history that disagrees with the local tree, a stale
//   backup, or a checksum mismatch is an error, never a warning.

import { createHash } from "node:crypto";
import { sha256Hex } from "../db/migrator.ts";

export const BACKUP_MANIFEST_VERSION = 1;
export const BACKUP_TOOL = "reelhouse-backup";

export type BackupDatabaseId = "reelhouse" | "media_catalog";

export interface BackupTableSpec {
  name: string;
  // Primary-key columns; they define both the snapshot ORDER BY (collation-
  // pinned so checksums are reproducible across servers) and the keyset
  // pagination used to stream rows without loading whole tables.
  keyColumns: string[];
}

export interface BackupDatabaseSpec {
  id: BackupDatabaseId;
  // The credential variable that names this database, mirroring the
  // connection layer's env-only configuration rule.
  urlVar: string;
  migrationsDirName: "migrations" | "migrations-catalog";
  // Restore/checksum order: parents before children so inserts satisfy the
  // foreign keys without deferring or disabling anything.
  tables: BackupTableSpec[];
}

// Registered from db/migrations and db/migrations-catalog as of
// 0009/0010 (reelhouse) and 0001–0003 (media_catalog). The restore path
// refuses any database whose migration history differs from the local tree,
// and the manifest validation refuses any table list that differs from this
// registry — a schema change is always also a change to this file.
export const BACKUP_DATABASES: BackupDatabaseSpec[] = [
  {
    id: "reelhouse",
    urlVar: "DATABASE_URL",
    migrationsDirName: "migrations",
    tables: [
      { name: "household_profile", keyColumns: ["id"] },
      { name: "media_item_ref", keyColumns: ["id"] },
      { name: "profile_preferences", keyColumns: ["profile_id"] },
      { name: "jellyfin_account_link", keyColumns: ["id"] },
      { name: "sync_cursor", keyColumns: ["id"] },
      { name: "idempotency_record", keyColumns: ["id"] },
      { name: "favorite", keyColumns: ["profile_id", "media_ref_id"] },
      { name: "watchlist", keyColumns: ["id"] },
      { name: "watchlist_item", keyColumns: ["watchlist_id", "media_ref_id"] },
      { name: "collection", keyColumns: ["id"] },
      { name: "collection_item", keyColumns: ["collection_id", "media_ref_id"] },
      { name: "home_row", keyColumns: ["id"] },
      { name: "watch_state", keyColumns: ["profile_id", "media_ref_id"] },
      { name: "playback_event", keyColumns: ["id"] }
    ]
  },
  {
    id: "media_catalog",
    urlVar: "MEDIA_CATALOG_DATABASE_URL",
    migrationsDirName: "migrations-catalog",
    tables: [
      { name: "catalog_library", keyColumns: ["id"] },
      { name: "catalog_item", keyColumns: ["id"] },
      { name: "catalog_provider_id", keyColumns: ["item_id", "provider"] },
      { name: "catalog_genre", keyColumns: ["id"] },
      { name: "catalog_studio", keyColumns: ["id"] },
      { name: "catalog_person", keyColumns: ["id"] },
      { name: "catalog_item_genre", keyColumns: ["item_id", "genre_id"] },
      { name: "catalog_item_studio", keyColumns: ["item_id", "studio_id"] },
      { name: "catalog_item_person", keyColumns: ["item_id", "person_id", "list_order"] },
      { name: "catalog_scan", keyColumns: ["id"] },
      { name: "catalog_sync_state", keyColumns: ["job"] },
      { name: "catalog_quarantine", keyColumns: ["id"] }
    ]
  }
];

export function backupDatabaseSpec(id: string): BackupDatabaseSpec | null {
  return BACKUP_DATABASES.find((spec) => spec.id === id) ?? null;
}

export function isBackupDatabaseId(value: string): value is BackupDatabaseId {
  return value === "reelhouse" || value === "media_catalog";
}

const MANIFEST_DIR = "manifest.json";
const MANIFEST_CHECKSUM_FILE = "manifest.json.sha256";

export const BACKUP_PATHS = { manifest: MANIFEST_DIR, manifestChecksum: MANIFEST_CHECKSUM_FILE } as const;

// Data files live one directory per database so the two treatments stay
// visibly separate on disk: reelhouse/01-household_profile.jsonl, ...
export function tableFilePath(databaseId: BackupDatabaseId, index: number, tableName: string): string {
  const ordinal = String(index + 1).padStart(2, "0");
  return `${databaseId}/${ordinal}-${tableName}.jsonl`;
}

// ---- Canonical serialization ------------------------------------------------
//
// One canonical text form per row, used identically by snapshot, file
// verification, and restore verification, so all three checksums are
// comparable. Dates become UTC ISO strings (millisecond precision; restore
// stores exactly what the file carries), jsonb objects are key-sorted
// recursively, undefined collapses to null, and keys are sorted so column
// order can never influence a checksum.

export function canonicalValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalValue(source[key]);
    return out;
  }
  return value;
}

export function canonicalRowJson(row: Record<string, unknown>): string {
  return JSON.stringify(canonicalValue(row));
}

export const JSONL_TERMINATOR = "\n";

// Incremental table checksum: hash each canonical line with its terminator
// in row order. Callers feed rows in primary-key order so the digest is a
// deterministic function of table content, independent of heap or plan order.
export function tableChecksum(): { update: (line: string) => void; digest: () => string } {
  const hash = createHash("sha256");
  return {
    update: (line: string) => hash.update(line + JSONL_TERMINATOR),
    digest: () => hash.digest("hex")
  };
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

// ---- Manifest ---------------------------------------------------------------

export interface BackupTableManifest {
  name: string;
  file: string;
  rowCount: number;
  sha256: string;
  columns: string[];
}

export interface BackupDatabaseManifest {
  // Redacted connection summary (never a URL with credentials).
  urlLabel: string;
  pgVersion: string;
  migrations: { name: string; checksum: string }[];
  freshness: {
    // Newest updated_at across tables carrying that column, at snapshot time.
    latestUpdatedAt: string | null;
    // media_catalog only: newest successful catalog_scan finish.
    lastSuccessfulScanAt: string | null;
  };
  tables: BackupTableManifest[];
}

export interface BackupManifest {
  manifestVersion: number;
  tool: string;
  createdAt: string;
  // Only the databases actually included in the backup; at least one.
  databases: Partial<Record<BackupDatabaseId, BackupDatabaseManifest>>;
}

export function buildBackupManifest(input: {
  createdAt: Date;
  databases: Partial<Record<BackupDatabaseId, BackupDatabaseManifest>>;
}): BackupManifest {
  return {
    manifestVersion: BACKUP_MANIFEST_VERSION,
    tool: BACKUP_TOOL,
    createdAt: input.createdAt.toISOString(),
    databases: input.databases
  };
}

export type BackupManifestResult =
  | { kind: "valid"; manifest: BackupManifest }
  | { kind: "invalid"; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isoOrNull(value: unknown): string | null | false {
  if (value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return false;
  return value;
}

// Validates an untrusted parsed manifest against this module's registry.
// Strict on purpose: unknown databases, unknown or reordered tables, wrong
// file paths, non-hex checksums, and malformed timestamps all fail — a
// manifest this tool cannot fully account for is never restored from.
export function validateBackupManifest(raw: unknown): BackupManifestResult {
  const errors: string[] = [];
  if (!isPlainObject(raw)) return { kind: "invalid", errors: ["manifest is not a JSON object"] };

  if (raw.manifestVersion !== BACKUP_MANIFEST_VERSION) {
    errors.push(`unsupported manifestVersion (got ${JSON.stringify(raw.manifestVersion)}, want ${BACKUP_MANIFEST_VERSION})`);
  }
  if (raw.tool !== BACKUP_TOOL) errors.push(`unsupported tool (got ${JSON.stringify(raw.tool)}, want ${BACKUP_TOOL})`);
  if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) {
    errors.push("createdAt is missing or not a timestamp");
  }

  const databases: Partial<Record<BackupDatabaseId, BackupDatabaseManifest>> = {};
  if (!isPlainObject(raw.databases)) {
    errors.push("databases is missing or not an object");
  } else {
    const ids = Object.keys(raw.databases);
    if (ids.length === 0) errors.push("databases is empty");
    for (const id of ids) {
      if (!isBackupDatabaseId(id)) {
        errors.push(`unknown database "${id}" in manifest`);
        continue;
      }
      const spec = backupDatabaseSpec(id);
      const rawDb = (raw.databases as Record<string, unknown>)[id];
      if (!isPlainObject(rawDb)) {
        errors.push(`databases.${id} is not an object`);
        continue;
      }
      const dbErrors: string[] = [];
      if (typeof rawDb.urlLabel !== "string" || rawDb.urlLabel.length === 0) dbErrors.push("urlLabel missing");
      if (typeof rawDb.pgVersion !== "string" || rawDb.pgVersion.length === 0) dbErrors.push("pgVersion missing");

      const migrations: { name: string; checksum: string }[] = [];
      if (!Array.isArray(rawDb.migrations)) dbErrors.push("migrations missing or not an array");
      else {
        for (const entry of rawDb.migrations) {
          if (!isPlainObject(entry) || typeof entry.name !== "string" || !isSha256Hex(entry.checksum)) {
            dbErrors.push("migrations entry malformed");
            break;
          }
          migrations.push({ name: entry.name, checksum: entry.checksum });
        }
      }

      const latestUpdatedAt = isPlainObject(rawDb.freshness) ? isoOrNull(rawDb.freshness.latestUpdatedAt) : false;
      const lastSuccessfulScanAt = isPlainObject(rawDb.freshness) ? isoOrNull(rawDb.freshness.lastSuccessfulScanAt) : false;
      if (latestUpdatedAt === false) dbErrors.push("freshness.latestUpdatedAt missing or not a timestamp");
      if (lastSuccessfulScanAt === false) dbErrors.push("freshness.lastSuccessfulScanAt missing or not a timestamp");

      const tables: BackupTableManifest[] = [];
      if (!Array.isArray(rawDb.tables)) dbErrors.push("tables missing or not an array");
      else if (spec) {
        if (rawDb.tables.length !== spec.tables.length) {
          dbErrors.push(`tables lists ${rawDb.tables.length} entries, registry expects ${spec.tables.length}`);
        }
        rawDb.tables.forEach((entry, index) => {
          const expected = spec.tables[index];
          if (!isPlainObject(entry)) {
            dbErrors.push(`tables[${index}] is not an object`);
            return;
          }
          const name = typeof entry.name === "string" ? entry.name : "";
          if (!expected || name !== expected.name) {
            dbErrors.push(`tables[${index}] is "${name}", registry expects "${expected ? expected.name : "<none>"}"`);
            return;
          }
          const file = typeof entry.file === "string" ? entry.file : "";
          if (file !== tableFilePath(id, index, name)) {
            dbErrors.push(`tables[${index}].file is "${file}", expected "${tableFilePath(id, index, name)}"`);
          }
          if (typeof entry.rowCount !== "number" || !Number.isInteger(entry.rowCount) || entry.rowCount < 0) {
            dbErrors.push(`tables[${index}].rowCount invalid`);
          }
          if (!isSha256Hex(entry.sha256)) dbErrors.push(`table ${name} checksum invalid`);
          const columns = entry.columns;
          if (
            !Array.isArray(columns) ||
            columns.length === 0 ||
            // Column names become quoted identifiers in the restore INSERTs;
            // only plain lowercase identifiers are ever legitimate here.
            columns.some((column) => !/^[a-z_][a-z0-9_]*$/.test(column)) ||
            new Set(columns).size !== columns.length
          ) {
            dbErrors.push(`table ${name} columns invalid`);
          }
          tables.push({
            name,
            file,
            rowCount: typeof entry.rowCount === "number" ? entry.rowCount : -1,
            sha256: typeof entry.sha256 === "string" ? entry.sha256 : "",
            columns: Array.isArray(columns) ? (columns as string[]) : []
          });
        });
      }

      if (dbErrors.length > 0) {
        errors.push(...dbErrors.map((message) => `databases.${id}: ${message}`));
        continue;
      }
      databases[id] = {
        urlLabel: rawDb.urlLabel as string,
        pgVersion: rawDb.pgVersion as string,
        migrations,
        freshness: { latestUpdatedAt: latestUpdatedAt as string | null, lastSuccessfulScanAt: lastSuccessfulScanAt as string | null },
        tables
      };
    }
  }

  if (errors.length > 0) return { kind: "invalid", errors };
  return { kind: "valid", manifest: { manifestVersion: raw.manifestVersion as number, tool: raw.tool as string, createdAt: raw.createdAt as string, databases } };
}

// ---- Freshness / staleness ---------------------------------------------------

export const BACKUP_MAX_AGE_HOURS_VAR = "BACKUP_MAX_AGE_HOURS";

const MAX_AGE_DEFAULT_HOURS = 168; // one week
const MAX_AGE_LIMITS = { min: 1, max: 8760 } as const; // 1 hour .. 1 year

export type BackupMaxAgeResult =
  | { kind: "valid"; hours: number }
  | { kind: "invalid"; errors: string[] };

export function parseBackupMaxAgeHours(env: Record<string, string | undefined>): BackupMaxAgeResult {
  const raw = env[BACKUP_MAX_AGE_HOURS_VAR]?.trim();
  if (!raw) return { kind: "valid", hours: MAX_AGE_DEFAULT_HOURS };
  if (!/^\d+$/.test(raw)) {
    return { kind: "invalid", errors: [`${BACKUP_MAX_AGE_HOURS_VAR} must be a positive integer (got "${raw}")`] };
  }
  const value = Number(raw);
  if (value < MAX_AGE_LIMITS.min || value > MAX_AGE_LIMITS.max) {
    return {
      kind: "invalid",
      errors: [`${BACKUP_MAX_AGE_HOURS_VAR} must be between ${MAX_AGE_LIMITS.min} and ${MAX_AGE_LIMITS.max} hours (got ${value})`]
    };
  }
  return { kind: "valid", hours: value };
}

export function backupAgeHours(manifest: BackupManifest, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(manifest.createdAt)) / 3_600_000);
}

// ---- Verification diffing -----------------------------------------------------

export type VerifyProblemKind =
  | "manifest"
  | "stale"
  | "migration_set"
  | "file_missing"
  | "line_invalid"
  | "columns"
  | "row_count"
  | "checksum"
  | "restore";

export interface VerifyProblem {
  kind: VerifyProblemKind;
  database: BackupDatabaseId | null;
  table?: string;
  message: string;
}

export interface TableFileFacts {
  name: string;
  rowCount: number;
  sha256: string;
  // Column set observed on the first parsed line (null for an empty table).
  columns: string[] | null;
  // Bounded (first five) per-line parse/column failures.
  lineErrors: string[];
}

// Compares what the files actually contain against what the manifest claims.
// Line errors are reported separately so a corrupt line does not masquerade
// as a checksum mismatch; a table with line errors always fails regardless.
export function diffManifestAgainstFileFacts(
  databaseId: BackupDatabaseId,
  dbManifest: BackupDatabaseManifest,
  facts: Map<string, TableFileFacts>
): VerifyProblem[] {
  const problems: VerifyProblem[] = [];
  for (const table of dbManifest.tables) {
    const fact = facts.get(table.name);
    if (!fact) {
      problems.push({ kind: "file_missing", database: databaseId, table: table.name, message: `data file for table ${table.name} is missing` });
      continue;
    }
    for (const lineError of fact.lineErrors) {
      problems.push({ kind: "line_invalid", database: databaseId, table: table.name, message: lineError });
    }
    const expectedColumns = [...table.columns].sort().join(",");
    const actualColumns = fact.columns === null ? expectedColumns : [...fact.columns].sort().join(",");
    if (actualColumns !== expectedColumns) {
      problems.push({
        kind: "columns",
        database: databaseId,
        table: table.name,
        message: `columns differ from manifest (manifest: ${expectedColumns || "<none>"}, file: ${actualColumns || "<none>"})`
      });
    }
    if (fact.rowCount !== table.rowCount) {
      problems.push({
        kind: "row_count",
        database: databaseId,
        table: table.name,
        message: `row count is ${fact.rowCount}, manifest claims ${table.rowCount}`
      });
    }
    if (fact.lineErrors.length === 0 && fact.sha256 !== table.sha256) {
      problems.push({
        kind: "checksum",
        database: databaseId,
        table: table.name,
        message: `content checksum is ${fact.sha256}, manifest claims ${table.sha256}`
      });
    }
  }
  return problems;
}

// The migration history recorded in the manifest must equal the local tree
// exactly — both directions. A backup taken by different code than this one
// restores into a schema this code does not fully know, which is exactly the
// "migration uncertainty" the worker protocol forbids guessing about.
export function diffMigrationSets(
  databaseId: BackupDatabaseId,
  recorded: { name: string; checksum: string }[],
  localFiles: { name: string; checksum: string }[]
): VerifyProblem[] {
  const recordedByName = new Map(recorded.map((entry) => [entry.name, entry.checksum]));
  const localByName = new Map(localFiles.map((entry) => [entry.name, entry.checksum]));
  const problems: VerifyProblem[] = [];
  for (const [name, checksum] of recordedByName) {
    const local = localByName.get(name);
    if (!local) {
      problems.push({
        kind: "migration_set",
        database: databaseId,
        message: `backup records migration "${name}" that the local tree does not have; restore refuses older-or-divergent backups`
      });
    } else if (local !== checksum) {
      problems.push({
        kind: "migration_set",
        database: databaseId,
        message: `backup records a different checksum for migration "${name}" than the local tree`
      });
    }
  }
  for (const name of localByName.keys()) {
    if (!recordedByName.has(name)) {
      problems.push({
        kind: "migration_set",
        database: databaseId,
        message: `local tree has migration "${name}" that the backup predates; restore would produce an unverified schema`
      });
    }
  }
  return problems;
}

// Compares table content recomputed from a restored scratch database against
// the manifest (which the files already matched). Same failure kinds as the
// file diff, minus file-specific ones.
export function diffManifestAgainstRestoredTable(
  databaseId: BackupDatabaseId,
  table: BackupTableManifest,
  restored: { rowCount: number; sha256: string }
): VerifyProblem[] {
  const problems: VerifyProblem[] = [];
  if (restored.rowCount !== table.rowCount) {
    problems.push({
      kind: "row_count",
      database: databaseId,
      table: table.name,
      message: `restored row count is ${restored.rowCount}, manifest claims ${table.rowCount}`
    });
  }
  if (restored.sha256 !== table.sha256) {
    problems.push({
      kind: "checksum",
      database: databaseId,
      table: table.name,
      message: `restored content checksum is ${restored.sha256}, manifest claims ${table.sha256}`
    });
  }
  return problems;
}

// ---- Disposable restore targets ----------------------------------------------
//
// Restore verification only ever runs against a database whose name carries
// this prefix and matches this shape. That keeps an operator typo in
// RESTORE_VERIFY_DATABASE_URL from pointing the tool at a real database: a
// URL that does not name a scratch-shaped database is refused before any
// connection is opened.

export const RESTORE_SCRATCH_NAME_PATTERN = /^rh_restore_[a-z0-9_]{1,50}$/;

export const RESTORE_VERIFY_URL_VAR = "RESTORE_VERIFY_DATABASE_URL";

export function parseScratchDatabaseName(url: string): { kind: "valid"; name: string } | { kind: "invalid"; errors: string[] } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "invalid", errors: [`${RESTORE_VERIFY_URL_VAR} is not a valid URL`] };
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return { kind: "invalid", errors: [`${RESTORE_VERIFY_URL_VAR} must use postgres:// or postgresql://`] };
  }
  const name = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!RESTORE_SCRATCH_NAME_PATTERN.test(name)) {
    return {
      kind: "invalid",
      errors: [
        `${RESTORE_VERIFY_URL_VAR} must name a disposable database matching ${RESTORE_SCRATCH_NAME_PATTERN} (got "${name}"); the tool drops and recreates it`
      ]
    };
  }
  return { kind: "valid", name };
}

export function defaultScratchDatabaseName(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "t");
  return `rh_restore_check_${stamp}`;
}

// Maintenance connection for CREATE/DROP DATABASE: same server, same
// credentials, standard "postgres" database. The URL is never reassembled
// with credentials into a loggable string — callers only use it to connect.
export function maintenanceUrlFor(scratchUrl: string): { kind: "valid"; url: string } | { kind: "invalid"; errors: string[] } {
  try {
    const parsed = new URL(scratchUrl);
    parsed.pathname = "/postgres";
    return { kind: "valid", url: parsed.toString() };
  } catch {
    return { kind: "invalid", errors: [`${RESTORE_VERIFY_URL_VAR} is not a valid URL`] };
  }
}

// ---- Bounded diagnostics -------------------------------------------------------

export const MAX_PROBLEM_MESSAGE_LENGTH = 2000;

export function boundedMessage(message: string): string {
  return message.length <= MAX_PROBLEM_MESSAGE_LENGTH ? message : `${message.slice(0, MAX_PROBLEM_MESSAGE_LENGTH)}…(truncated)`;
}

export { sha256Hex };
