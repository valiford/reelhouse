// Forward-only migration runner for the ReelHouse PostgreSQL 18 schema.
//
// Split design: the pure functions below (file parsing, checksums, history
// verification, planning) run anywhere including `node --test`; only
// runMigrations() touches PostgreSQL. This module deliberately avoids
// `server-only` and the `@/` alias so both the CLI (scripts/db-migrate.ts)
// and tests can import it under plain Node.
//
// Model (see docs/MIGRATIONS.md):
// - db/migrations/NNNN_title.sql files, applied in strict version order,
//   each inside one transaction together with its schema_migrations row.
// - Applied files are recorded with a checksum; any local tree whose
//   checksums, names, or numbering disagree with recorded history is
//   REFUSED — history is never mutated, only extended.
// - A session advisory lock serializes concurrent runs.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, type QueryResultRow } from "pg";

export const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

// Arbitrary but fixed signed bigint; the value only needs to be unique
// among advisory-lock users of this database. (Built via BigInt() rather
// than an n-literal: the repo's TS target predates ES2020.)
export const MIGRATIONS_ADVISORY_LOCK_KEY = BigInt("726101000726101");

// uuidv7() and the rest of this schema require PostgreSQL 18+.
export const MIN_PG_VERSION_NUM = 180000;

export interface MigrationFile {
  name: string;
  version: number;
  title: string;
  checksum: string;
  sql: string;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
  appliedAt: Date;
  executionMs: number | null;
  pgVersion: string | null;
}

export interface HistoryConflict {
  kind: "missing_file" | "checksum_mismatch" | "unrecorded_old_version" | "duplicate_version" | "invalid_name" | "non_contiguous_versions" | "empty_directory";
  message: string;
}

export interface MigrationPlan {
  applied: AppliedMigration[];
  pending: MigrationFile[];
  conflicts: HistoryConflict[];
}

export interface RunMigrationsOptions {
  databaseUrl: string;
  migrationsDir: string;
  dryRun?: boolean;
  statementTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface RunMigrationsResult {
  applied: MigrationFile[];
  pendingCount: number;
  alreadyApplied: number;
  serverVersion: string;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Checksums are computed over LF-normalized content so a checkout with
// different line endings cannot masquerade as mutated history. .gitattributes
// pins db/migrations/*.sql to LF as well.
export function normalizeSqlContent(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

export function parseMigrationFileName(name: string): { version: number; title: string } | null {
  const match = MIGRATION_FILE_PATTERN.exec(name);
  if (!match) return null;
  return { version: Number.parseInt(match[1], 10), title: match[2] };
}

export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  const seenVersions = new Map<number, string>();

  for (const entry of entries) {
    // Nested directories (editor/OS noise) are ignored; stray FILES are
    // rejected so the migration tree stays exactly deterministic.
    if (!entry.isFile()) continue;
    const parsed = parseMigrationFileName(entry.name);
    if (!parsed) {
      throw new Error(
        `Invalid migration file name "${entry.name}" in ${dir}: expected NNNN_lowercase_snake_title.sql`
      );
    }
    const previous = seenVersions.get(parsed.version);
    if (previous !== undefined) {
      throw new Error(`Duplicate migration version ${parsed.version}: "${previous}" and "${entry.name}"`);
    }
    seenVersions.set(parsed.version, entry.name);
    const raw = await readFile(join(dir, entry.name), "utf8");
    files.push({
      name: entry.name,
      version: parsed.version,
      title: parsed.title,
      checksum: sha256Hex(normalizeSqlContent(raw)),
      sql: normalizeSqlContent(raw)
    });
  }

  if (files.length === 0) {
    throw new Error(`No migration files found in ${dir}`);
  }
  files.sort((a, b) => a.version - b.version);
  for (let i = 1; i < files.length; i += 1) {
    if (files[i].version !== files[i - 1].version + 1) {
      throw new Error(
        `Migration versions must be contiguous: gap between "${files[i - 1].name}" and "${files[i].name}"`
      );
    }
  }
  return files;
}

export function verifyHistory(applied: AppliedMigration[], files: MigrationFile[]): HistoryConflict[] {
  const conflicts: HistoryConflict[] = [];
  const byName = new Map(files.map((file) => [file.name, file]));

  for (const row of applied) {
    const file = byName.get(row.name);
    if (!file) {
      conflicts.push({
        kind: "missing_file",
        message: `Applied migration "${row.name}" is missing from the local migrations directory; migration history cannot be verified`
      });
      continue;
    }
    if (file.checksum !== row.checksum) {
      conflicts.push({
        kind: "checksum_mismatch",
        message: `Applied migration "${row.name}" no longer matches its recorded checksum (recorded ${row.checksum}, local ${file.checksum}); editing applied migrations is refused`
      });
    }
  }

  const appliedNames = new Set(applied.map((row) => row.name));
  const maxAppliedVersion = applied.reduce((max, row) => {
    const parsed = parseMigrationFileName(row.name);
    return parsed ? Math.max(max, parsed.version) : max;
  }, 0);

  for (const file of files) {
    if (file.version <= maxAppliedVersion && !appliedNames.has(file.name)) {
      conflicts.push({
        kind: "unrecorded_old_version",
        message: `Local migration "${file.name}" carries a version at or below the newest applied migration (${maxAppliedVersion}) but has no recorded history; renamed or rewritten old migrations are refused`
      });
    }
  }
  return conflicts;
}

export function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): MigrationPlan {
  const conflicts = verifyHistory(applied, files);
  const appliedNames = new Set(applied.map((row) => row.name));
  return {
    applied,
    pending: conflicts.length === 0 ? files.filter((file) => !appliedNames.has(file.name)) : [],
    conflicts
  };
}

function rowsToApplied(rows: QueryResultRow[]): AppliedMigration[] {
  return rows.map((row) => ({
    name: String(row.name),
    checksum: String(row.checksum),
    appliedAt: new Date(row.applied_at as string | Date),
    executionMs: row.execution_ms === null ? null : Number(row.execution_ms),
    pgVersion: row.pg_version === null ? null : String(row.pg_version)
  }));
}

// "18.2 (Debian 18.2-1.pgdg120+1)" -> 180002; refuses anything unparsable
// or below 18 so uuidv7()-dependent DDL never half-applies on older servers.
export function postgresVersionNum(serverVersion: string): number {
  const match = /^(\d+)(?:\.(\d+))?/.exec(serverVersion.trim());
  if (!match) return 0;
  const major = Number.parseInt(match[1], 10);
  const minor = match[2] ? Number.parseInt(match[2], 10) : 0;
  return major * 10000 + minor * 100;
}

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    name         text PRIMARY KEY,
    checksum     text NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    execution_ms integer,
    pg_version   text NOT NULL
)`.trim();

export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const log = options.log ?? (() => {});
  if (!options.databaseUrl) {
    throw new Error("No database URL provided; set DATABASE_URL and retry (credentials are never logged)");
  }

  const files = await loadMigrationFiles(options.migrationsDir);
  const client = new Client({
    connectionString: options.databaseUrl,
    application_name: "reelhouse-migrations",
    connectionTimeoutMillis: 10_000
  });

  try {
    await client.connect();

    const versionResult = await client.query<{ server_version: string }>("SHOW server_version");
    const serverVersion = versionResult.rows[0].server_version;
    if (postgresVersionNum(serverVersion) < MIN_PG_VERSION_NUM) {
      throw new Error(
        `PostgreSQL 18 or newer is required (server reports ${serverVersion}); refusing to run migrations`
      );
    }
    log(`Server: PostgreSQL ${serverVersion}`);

    await client.query("SELECT pg_advisory_lock($1)", [MIGRATIONS_ADVISORY_LOCK_KEY]);
    try {
      const timeoutMs = options.statementTimeoutMs ?? 60_000;
      // SET cannot take bound parameters; set_config can.
      await client.query("SELECT set_config('statement_timeout', $1, false)", [String(timeoutMs)]);

      await client.query(SCHEMA_MIGRATIONS_DDL);
      const history = await client.query<{ name: string; checksum: string; applied_at: string | Date; execution_ms: number | null; pg_version: string | null }>(
        "SELECT name, checksum, applied_at, execution_ms, pg_version FROM schema_migrations ORDER BY name"
      );
      const plan = planMigrations(files, rowsToApplied(history.rows));

      if (plan.conflicts.length > 0) {
        throw new Error(
          `Migration history verification failed:\n${plan.conflicts.map((c) => `  - ${c.message}`).join("\n")}`
        );
      }

      log(`Applied: ${plan.applied.length}, pending: ${plan.pending.length}`);
      if (plan.pending.length === 0) {
        log("Schema is up to date; nothing to do");
        return { applied: [], pendingCount: 0, alreadyApplied: plan.applied.length, serverVersion };
      }
      if (options.dryRun) {
        for (const file of plan.pending) log(`Would apply: ${file.name}`);
        return {
          applied: [],
          pendingCount: plan.pending.length,
          alreadyApplied: plan.applied.length,
          serverVersion
        };
      }

      for (const file of plan.pending) {
        const startedAt = Date.now();
        await client.query("BEGIN");
        try {
          await client.query(file.sql);
          await client.query(
            "INSERT INTO schema_migrations (name, checksum, execution_ms, pg_version) VALUES ($1, $2, $3, $4)",
            [file.name, file.checksum, Date.now() - startedAt, serverVersion]
          );
          await client.query("COMMIT");
          log(`Applied: ${file.name} (${Date.now() - startedAt} ms)`);
        } catch (error) {
          await client.query("ROLLBACK");
          throw new Error(
            `Migration "${file.name}" failed and was rolled back; no changes were recorded: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      return { applied: plan.pending, pendingCount: plan.pending.length, alreadyApplied: plan.applied.length, serverVersion };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATIONS_ADVISORY_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}
