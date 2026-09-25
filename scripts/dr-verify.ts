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
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function assertScratchEmpty(): Promise<void> {
  const tables = await publicTables(scratch);
  if (tables.length > 0) {
    fail(
      `scratch database is not empty (public tables: ${tables.slice(0, 5).join(", ")}${tables.length > 5 ? ", …" : ""}) — refusing to restore into it`
    );
  }
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

function runTool(name: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(name, args, { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) fail(`could not run ${name}: ${scrub(result.error.message)}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(0, 500);
    fail(`${name} exited with status ${result.status}: ${scrub(detail)}`);
  }
}

console.log("dr:verify — ReelHouse backup/restore acceptance");
console.log(`source:  ${redactDatabaseUrl(process.env.DATABASE_MIGRATE_URL ?? "")}`);
console.log(`scratch: ${redactDatabaseUrl(process.env.DATABASE_RESTORE_URL ?? "")}`);

await assertScratchEmpty();

const dumpPath = join(mkdtempSync(join(tmpdir(), "reelhouse-dr-")), "reelhouse-dump.sql");
const dumpStarted = Date.now();
runTool(
  "pg_dump",
  ["--format=plain", "--no-owner", "--no-privileges", "--schema=public", "--file", dumpPath, "--dbname", source.database],
  pgEnv(source)
);
const dumpSeconds = (Date.now() - dumpStarted) / 1000;
const dumpBytes = statSync(dumpPath).size;
console.log(`pg_dump completed in ${dumpSeconds.toFixed(1)}s (${(dumpBytes / 1024 / 1024).toFixed(2)} MiB)`);

const restoreStarted = Date.now();
runTool(
  "psql",
  ["--dbname", scratch.database, "--set", "ON_ERROR_STOP=1", "--quiet", "--file", dumpPath],
  pgEnv(scratch)
);
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

try {
  rmSync(dumpPath, { force: true });
  rmSync(join(dumpPath, ".."), { recursive: true, force: true });
} catch {
  // A temp file that refuses to die is a cleanup note, not a verification
  // failure.
  console.log(`note: could not remove temporary dump ${dumpPath}`);
}

if (mismatches > 0) {
  fail(`restore verification FAILED: ${mismatches} table(s) differ or are missing`);
}

console.log(
  `dr:verify PASSED — ${VERIFIED_TABLES.length} tables identical after dump/restore ` +
    `(dump ${dumpSeconds.toFixed(1)}s, restore ${restoreSeconds.toFixed(1)}s)`
);
console.log("scratch database left in place for inspection; drop it when done (see docs/DR.md).");
