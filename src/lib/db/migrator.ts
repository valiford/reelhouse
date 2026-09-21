// Versioned PostgreSQL migration runner for ReelHouse.
//
// Design contract:
// - Migrations live in `db/migrations/NNNN_name.sql`, applied in ascending
//   version order, recorded in `public.schema_migrations` with a checksum.
// - Forward-only. A file whose checksum no longer matches the recorded one,
//   or an applied version whose file has disappeared, fails closed.
// - Each migration runs in its own transaction; a failure leaves earlier
//   migrations applied and the failed one fully rolled back.
// - The whole run holds a fixed advisory lock, so two runners cannot apply
//   concurrently.
// - Diagnostics are bounded: errors name versions and files, never SQL
//   content, URLs, or credentials. Redaction of URL-bearing messages happens
//   in the callers via config.redactError().
//
// This module deliberately avoids `server-only` so the CLI in
// scripts/db-migrate.ts can run it under plain Node; it is still
// server-side-only by convention — nothing here is imported by client code.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { DatabaseConfig } from "./config";

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  sql: string;
  // SHA-256 of the file bytes, before any placeholder substitution, so
  // history stays stable across environments with different role names.
  checksum: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

export interface MigrationPlan {
  pending: MigrationFile[];
  // Applied on the server but its file now hashes differently: history was
  // edited — refuse to run anything.
  conflicts: { version: number; name: string; recordedChecksum: string; fileChecksum: string }[];
  // Applied on the server but no file exists on disk: history was lost.
  unknownApplied: { version: number; name: string }[];
}

export interface MigrationRunResult {
  appliedNow: number[];
  skipped: number;
  lastVersion?: number;
}

const MIGRATIONS_TABLE = "public.schema_migrations";
const MIGRATION_FILENAME = /^(\d{4,})_([a-z0-9_]+)\.sql$/;
const PLACEHOLDER = /\{\{([a-zA-Z0-9_]+)\}\}/g;
// Arbitrary fixed key; only needs to be stable within one database so
// concurrent runners serialize. Chosen once, never reused for other locks.
const ADVISORY_LOCK_KEY = "68213490175543";
// PostgreSQL identifier for the {{app_role}} placeholder. Deliberately
// restrictive: lowercase snake_case, unquoted — anything else fails closed
// rather than being quoted into SQL.
const ROLE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function checksumMigrationSql(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

// Resolves the role that {{app_role}} placeholders refer to. Precedence:
// explicit value, then the application role's user (DATABASE_URL user), then
// the migrator role's own user (single-role local setups).
export function resolveAppRole(
  appUser: string | undefined,
  migrateUser: string | undefined
): string | undefined {
  const candidate = appUser?.trim() || migrateUser?.trim();
  if (!candidate) return undefined;
  if (!ROLE_IDENTIFIER.test(candidate)) {
    throw new Error(
      `Application role name "${candidate}" is not a valid unquoted PostgreSQL identifier (lowercase letters, digits, underscore)`
    );
  }
  return candidate;
}

// Substitutes {{app_role}} and rejects any other or unknown placeholder so a
// typo can never reach the server as raw SQL text.
export function renderMigrationSql(file: MigrationFile, appRole: string): string {
  return file.sql.replace(PLACEHOLDER, (whole, key: string) => {
    if (key !== "app_role") {
      throw new Error(`Migration ${file.filename} uses unsupported placeholder {{${key}}} (only {{app_role}} exists)`);
    }
    return appRole;
  });
}

function validatePlaceholders(file: MigrationFile): void {
  for (const match of file.sql.matchAll(PLACEHOLDER)) {
    const key = match[1];
    if (key !== "app_role") {
      throw new Error(`Migration ${file.filename} uses unsupported placeholder {{${key}}} (only {{app_role}} exists)`);
    }
  }
}

// Reads and validates the migration directory. Any filename that does not
// match NNNN_name.sql, any duplicate version, or any unsupported placeholder
// fails closed — stray or malformed files are never silently skipped.
export function loadMigrationFiles(migrationsDir: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(migrationsDir).sort();
  } catch {
    throw new Error(`Cannot read migrations directory (expected ${migrationsDir})`);
  }

  const files: MigrationFile[] = [];
  const seenVersions = new Map<number, string>();
  for (const filename of entries) {
    if (!filename.endsWith(".sql")) continue;
    const match = MIGRATION_FILENAME.exec(filename);
    if (!match) {
      throw new Error(`Migration filename "${filename}" does not match NNNN_name.sql`);
    }
    const version = Number(match[1]);
    const name = match[2];
    const previous = seenVersions.get(version);
    if (previous) {
      throw new Error(`Duplicate migration version ${version} ("${previous}" and "${filename}")`);
    }
    seenVersions.set(version, filename);
    const sql = readFileSync(join(migrationsDir, filename), "utf8");
    const file: MigrationFile = { version, name, filename, sql, checksum: checksumMigrationSql(sql) };
    validatePlaceholders(file);
    files.push(file);
  }
  return files;
}

// Pure planner: given on-disk files and the applied history, decide what may
// run. Never contacts the database.
export function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): MigrationPlan {
  const byVersion = new Map(files.map((f) => [f.version, f]));

  const conflicts: MigrationPlan["conflicts"] = [];
  const unknownApplied: MigrationPlan["unknownApplied"] = [];
  for (const row of [...applied].sort((a, b) => a.version - b.version)) {
    const file = byVersion.get(row.version);
    if (!file) {
      unknownApplied.push({ version: row.version, name: row.name });
      continue;
    }
    if (file.checksum !== row.checksum) {
      conflicts.push({
        version: row.version,
        name: row.name,
        recordedChecksum: row.checksum,
        fileChecksum: file.checksum
      });
    }
  }

  if (conflicts.length || unknownApplied.length) {
    return { pending: [], conflicts, unknownApplied };
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = files
    .filter((file) => !appliedVersions.has(file.version))
    .sort((a, b) => a.version - b.version);
  return { pending, conflicts, unknownApplied };
}

function describePlanFailure(plan: MigrationPlan): string {
  const parts: string[] = [];
  for (const conflict of plan.conflicts) {
    parts.push(
      `migration ${conflict.version} (${conflict.name}) changed on disk after being applied (recorded ${conflict.recordedChecksum.slice(0, 12)}, file ${conflict.fileChecksum.slice(0, 12)})`
    );
  }
  for (const row of plan.unknownApplied) {
    parts.push(`migration ${row.version} (${row.name}) is recorded as applied but its file is missing`);
  }
  return `Migration history failed verification and nothing was run: ${parts.join("; ")}`;
}

async function readAppliedMigrations(client: Client): Promise<AppliedMigration[]> {
  const result = await client.query<{ version: number; name: string; checksum: string }>(
    `SELECT version, name, checksum FROM ${MIGRATIONS_TABLE} ORDER BY version`
  );
  return result.rows;
}

async function ensureMigrationsTable(client: Client, appRole: string | undefined): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Recreating the table would re-inherit the owner's default DML
    // privileges, so every runner pass re-asserts that migration
    // bookkeeping stays read-only for the application role.
    if (appRole && appRole !== client.user) {
      await client.query(`REVOKE INSERT, UPDATE, DELETE ON ${MIGRATIONS_TABLE} FROM ${appRole}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function withLockedClient<T>(
  config: DatabaseConfig,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    application_name: "reelhouse-migrate"
  });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      return await fn(client);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

// Applies pending migrations as the configured (owner/migrator) role.
// DDL here is legitimate, so this client deliberately has no statement
// timeout — the app pool's limits must not clip index builds.
export async function runMigrations(
  migrateConfig: DatabaseConfig,
  migrationsDir: string,
  appRole: string | undefined
): Promise<MigrationRunResult> {
  const files = loadMigrationFiles(migrationsDir);
  for (const file of files) {
    const needsRole = /\{\{app_role\}\}/.test(file.sql);
    if (needsRole && !appRole) {
      throw new Error(
        `Migration ${file.filename} grants to {{app_role}} but no application role is configured (set DATABASE_APP_ROLE or DATABASE_URL)`
      );
    }
  }

  return withLockedClient(migrateConfig, async (client) => {
    await ensureMigrationsTable(client, appRole);
    const applied = await readAppliedMigrations(client);
    const plan = planMigrations(files, applied);
    if (plan.conflicts.length || plan.unknownApplied.length) {
      throw new Error(describePlanFailure(plan));
    }

    const appliedNow: number[] = [];
    for (const file of plan.pending) {
      const sql = appRole ? renderMigrationSql(file, appRole) : file.sql;
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
          [file.version, file.name, file.checksum]
        );
        await client.query("COMMIT");
        appliedNow.push(file.version);
      } catch (error) {
        await client.query("ROLLBACK");
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file.version} (${file.filename}) failed and was rolled back: ${message}`);
      }
    }

    const lastVersion = appliedNow.length
      ? appliedNow[appliedNow.length - 1]
      : applied.length
        ? applied[applied.length - 1].version
        : undefined;
    return { appliedNow, skipped: applied.length, lastVersion };
  });
}

// Read-only summary of migration state, for diagnostics. Never applies
// anything; unknown states are reported as data so callers fail closed.
export interface MigrationStatus {
  state: "unconfigured" | "invalid" | "ok" | "unknown";
  applied?: number;
  pending?: number;
  lastVersion?: number;
  detail?: string;
}

export async function checkMigrations(
  migrateConfig: DatabaseConfig,
  migrationsDir: string
): Promise<MigrationStatus> {
  let files: MigrationFile[];
  try {
    files = loadMigrationFiles(migrationsDir);
  } catch (error) {
    return { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
  }

  try {
    return await withLockedClient(migrateConfig, async (client) => {
      const table = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations'`
      );
      if (!table.rowCount) {
        return { state: "ok", applied: 0, pending: files.length };
      }
      const applied = await readAppliedMigrations(client);
      const plan = planMigrations(files, applied);
      if (plan.conflicts.length || plan.unknownApplied.length) {
        return { state: "unknown", detail: describePlanFailure(plan), applied: applied.length, pending: 0 };
      }
      return {
        state: "ok",
        applied: applied.length,
        pending: plan.pending.length,
        lastVersion: applied.length ? applied[applied.length - 1].version : undefined
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: "unknown", detail: message.slice(0, 300) };
  }
}
