// DR acceptance: PostgreSQL backup/restore validation for ReelHouse (RH-0040).
//
//   npm run dr:verify
//
// Dumps the ReelHouse database with pg_dump, restores the dump into an empty
// scratch database, and verifies that every ReelHouse-owned table arrived
// byte-for-byte (row count + ordered row digest). This is the acceptance
// half of disaster recovery: it proves a backup is restorable and complete,
// before you ever need it for real.
//
// Environment (both required, both owner/migrator-grade roles — the app
// role cannot read pg_dump's catalog probes, and verification is an
// owner-run procedure by design):
//   DATABASE_MIGRATE_URL   Source database to back up (the live `reelhouse`).
//   DATABASE_RESTORE_URL   Scratch database the dump is restored into.
//
// Fail-closed rules:
//   - The scratch database must be EMPTY (no public tables, no migration
//     history). A non-empty target is refused, never merged into.
//   - Any pg_dump or psql failure aborts with a non-zero exit.
//   - Any count/digest mismatch is reported per table and fails the run.
//   - Connection details travel via PG* environment variables to the child
//     processes — never as command-line arguments, so no password can leak
//     into a process listing; echoed messages are scrubbed of both URLs.
//
// Scope notes for reviewers:
//   - The media_catalog (media_*) tables are a rebuildable mirror of the
//     Jellyfin library; the household_* tables are the durable authority.
//     The dump covers both — restoring is the only way to prove the durable
//     half survives, and rebuilding the catalog alone is NOT a backup story.
//   - row digests are computed over row_to_json text ordered by itself, so
//     they are stable for identical data on the same PostgreSQL major
//     version. Cross-version restores are validated by this same script's
//     count/digest run; treat digest drift across majors as expected and
//     rely on the counts plus the rebuild path (docs/DR.md).
//   - This script never writes to the source database, never touches
//     Jellyfin, and never deletes media. The scratch database is left in
//     place for inspection; dropping it is the operator's call.

import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { loadDatabaseConfig, redactDatabaseUrl, type DatabaseConfig } from "../src/lib/db/config.ts";

// Every ReelHouse-owned table, including migration bookkeeping. An unknown
// extra public table is not ignored: it is reported so the operator can
// decide whether the backup scope needs to grow.
const VERIFIED_TABLES = [
  "schema_migrations",
  "media_libraries",
  "media_items",
  "media_genres",
  "media_studios",
  "media_people",
  "media_item_genres",
  "media_item_studios",
  "media_item_people",
  "media_item_provider_ids",
  "media_sync_runs",
  "media_item_changes",
  "media_sync_state",
  "media_item_quarantine",
  "household_profiles",
  "household_preferences",
  "household_jellyfin_accounts",
  "household_favorites",
  "household_watchlists",
  "household_watchlist_entries",
  "household_collections",
  "household_collection_entries",
  "household_home_rows",
  "household_watch_state",
  "household_playback_history",
  "household_sync_runs"
] as const;

function fail(message: string): never {
  console.error(`dr:verify ${message}`);
  process.exit(1);
}

function loadRoleUrl(envValue: string | undefined, label: string): DatabaseConfig {
  const result = loadDatabaseConfig({ DATABASE_URL: envValue?.trim() ?? "" });
  if (result.kind === "unconfigured") fail(`is not configured: ${label} is unset — see docs/DR.md`);
  if (result.kind === "invalid") fail(`${label} was rejected: ${result.errors.join("; ")}`);
  return result.config;
}

const source = loadRoleUrl(process.env.DATABASE_MIGRATE_URL, "DATABASE_MIGRATE_URL");
const scratch = loadRoleUrl(process.env.DATABASE_RESTORE_URL, "DATABASE_RESTORE_URL");
const secrets = [process.env.DATABASE_MIGRATE_URL ?? "", process.env.DATABASE_RESTORE_URL ?? ""];

function scrub(message: string): string {
  let text = message;
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join(redactDatabaseUrl(secret));
  }
  return text;
}

// Child-process connection env: the password rides in PGPASSWORD of the
// child only — never in argv, never in this process's own environment.
function pgEnv(config: DatabaseConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: config.host,
    PGPORT: String(config.port),
    PGUSER: config.user,
    PGPASSWORD: config.password,
    PGSSLMODE: config.ssl ? (config.ssl.rejectUnauthorized ? "verify-full" : "require") : "disable"
  };
}

// The dump/restore tool commands are overridable for environments where the
// client lives elsewhere (e.g. inside the server's container). Auth still
// travels via PG* environment variables by default; an override that routes
// through a container or wrapper must carry its own auth (e.g. -U) — the
// database name is appended as the final argument either way. The dump is
// piped through stdout/stdin, so no file paths cross the tool boundary.
const DUMP_CMD = process.env.DR_PG_DUMP_CMD?.trim() || "pg_dump --no-owner --no-privileges --schema=public";
const RESTORE_CMD = process.env.DR_PSQL_CMD?.trim() || "psql --set ON_ERROR_STOP=1 --quiet";
// The dump buffer is bounded: dr:verify is an acceptance tool for the
// ReelHouse database (household-scale), not a generic backup engine.
const MAX_DUMP_BYTES = 256 * 1024 * 1024;

async function withClient<T>(
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
    connectionTimeoutMillis: config.connectionTimeoutMs
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function publicTables(config: DatabaseConfig): Promise<string[]> {
  return withClient(config, async (client) => {
    const result = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    return result.rows.map((row) => row.tablename);
  });
}

async function prepareScratch(): Promise<void> {
  const tables = await publicTables(scratch);
  if (tables.length > 0) {
    fail(
      `scratch database is not empty (public tables: ${tables.slice(0, 5).join(", ")}${tables.length > 5 ? ", …" : ""}) — refusing to restore into it`
    );
  }
  // pg_dump's plain output opens with CREATE SCHEMA public (PG15+ emits it
  // unconditionally), so the schema must be ABSENT at restore time. Dropping
  // it also clears any non-table leftovers (views, sequences, functions) the
  // table check could not see — the dump alone defines what the scratch gets.
  await withClient(scratch, async (client) => {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  });
}

interface TableProjection {
  table: string;
  rows: string;
  digest: string;
}

// Deterministic per-table projection: count plus an md5 over the ordered
// row_to_json texts. Ordering by the text itself makes ties harmless and
// the digest reproducible for identical data.
async function projectTables(config: DatabaseConfig, tables: readonly string[]): Promise<Map<string, TableProjection>> {
  return withClient(config, async (client) => {
    const projections = new Map<string, TableProjection>();
    for (const table of tables) {
      const result = await client.query<{ rows: string; digest: string }>(
        `SELECT count(*)::text AS rows,
                md5(coalesce(string_agg(t.r, '' ORDER BY t.r), '')) AS digest
           FROM (SELECT row_to_json(x.*)::text AS r FROM public.${table} x) t`
      );
      projections.set(table, { table, rows: result.rows[0].rows, digest: result.rows[0].digest });
    }
    return projections;
  });
}

function runTool(name: string, command: string, database: string, env: NodeJS.ProcessEnv, input?: string): string {
  // The database name comes from the operator's own DATABASE_*_URL env, the
  // same trust domain as the tool command itself; the command string is the
  // documented override surface (see DR_PG_DUMP_CMD in docs/DR.md).
  const result = spawnSync(`${command} ${database}`, {
    env,
    encoding: "utf8",
    maxBuffer: MAX_DUMP_BYTES,
    input,
    shell: true
  });
  if (result.error) fail(`could not run ${name}: ${scrub(result.error.message)}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(0, 500);
    fail(`${name} exited with status ${result.status}: ${scrub(detail)}`);
  }
  return result.stdout ?? "";
}

console.log("dr:verify — ReelHouse backup/restore acceptance");
console.log(`source:  ${redactDatabaseUrl(process.env.DATABASE_MIGRATE_URL ?? "")}`);
console.log(`scratch: ${redactDatabaseUrl(process.env.DATABASE_RESTORE_URL ?? "")}`);

await prepareScratch();

const dumpStarted = Date.now();
const dumpSql = runTool("pg_dump", DUMP_CMD, source.database, pgEnv(source));
const dumpSeconds = (Date.now() - dumpStarted) / 1000;
const dumpBytes = Buffer.byteLength(dumpSql, "utf8");
console.log(`pg_dump completed in ${dumpSeconds.toFixed(1)}s (${(dumpBytes / 1024 / 1024).toFixed(2)} MiB)`);
if (!dumpSql.trim()) fail("pg_dump produced no output — refusing to verify an empty dump");

const restoreStarted = Date.now();
runTool("psql", RESTORE_CMD, scratch.database, pgEnv(scratch), dumpSql);
const restoreSeconds = (Date.now() - restoreStarted) / 1000;
console.log(`psql restore completed in ${restoreSeconds.toFixed(1)}s`);

const before = await projectTables(source, VERIFIED_TABLES);
const after = await projectTables(scratch, VERIFIED_TABLES);

const extra = (await publicTables(scratch)).filter((table) => !VERIFIED_TABLES.includes(table as never));
if (extra.length) {
  console.log(`note: scratch carries tables outside the verified set: ${extra.join(", ")}`);
}

let mismatches = 0;
for (const table of VERIFIED_TABLES) {
  const sourceProjection = before.get(table);
  const scratchProjection = after.get(table);
  if (!sourceProjection || !scratchProjection) {
    console.log(`  MISSING  ${table}`);
    mismatches += 1;
    continue;
  }
  if (
    sourceProjection.rows === scratchProjection.rows &&
    sourceProjection.digest === scratchProjection.digest
  ) {
    console.log(`  ok       ${table} (${sourceProjection.rows} rows)`);
  } else {
    console.log(
      `  DIFF     ${table} (source ${sourceProjection.rows} rows/${sourceProjection.digest.slice(0, 12)}, scratch ${scratchProjection.rows} rows/${scratchProjection.digest.slice(0, 12)})`
    );
    mismatches += 1;
  }
}

if (mismatches > 0) {
  fail(`restore verification FAILED: ${mismatches} table(s) differ or are missing`);
}

console.log(
  `dr:verify PASSED — ${VERIFIED_TABLES.length} tables identical after dump/restore ` +
    `(dump ${dumpSeconds.toFixed(1)}s, restore ${restoreSeconds.toFixed(1)}s)`
);
console.log("scratch database left in place for inspection; drop it when done (see docs/DR.md).");
