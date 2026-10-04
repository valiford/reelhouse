// Household import CLI: a complete household snapshot JSON → PostgreSQL
// household state.
//
//   npm run household:import -- path/to/household.json
//
// The manifest path may also come from HOUSEHOLD_IMPORT_FILE; the CLI
// argument wins. Environment (required — the run fails closed without it):
//   DATABASE_URL        Application role URL (least privilege, DML only).
//
// The snapshot is imported as ONE transaction: either the whole household
// state lands or nothing does. Migrations must already be applied
// (`npm run db:migrate`). Re-importing an unchanged snapshot is a no-op that
// reports zero writes. Every echoed error is scrubbed of the database URL.

import { statSync, readFileSync } from "node:fs";
import { Pool } from "pg";
import { loadDatabaseConfig, redactError } from "../src/lib/db/config.ts";
import { ManifestError, normalizeManifest } from "../src/lib/household/manifest.ts";
import {
  HouseholdImportError,
  runHouseholdImport,
  type HouseholdImportCounters
} from "../src/lib/household/load.ts";
import { createPgSyncExecutor } from "../src/lib/catalog/pg-executor.ts";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

function fail(message: string): never {
  console.error(`household:import ${message}`);
  process.exit(1);
}

const argPath = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const manifestPath = argPath ?? process.env.HOUSEHOLD_IMPORT_FILE?.trim() ?? "";
if (!manifestPath) {
  fail("requires a manifest path argument (or HOUSEHOLD_IMPORT_FILE) — see docs/HOUSEHOLD.md");
}

const dbResult = loadDatabaseConfig(process.env);
if (dbResult.kind === "unconfigured") {
  fail("is not configured: DATABASE_URL (application role) is unset — see docs/HOUSEHOLD.md");
}
if (dbResult.kind === "invalid") {
  fail(`database configuration was rejected: ${dbResult.errors.join("; ")}`);
}
const db = dbResult.config;

let raw: string;
try {
  const stats = statSync(manifestPath);
  if (!stats.isFile()) fail(`manifest path is not a file: ${manifestPath}`);
  if (stats.size > MAX_MANIFEST_BYTES) {
    fail(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes (${stats.size}) — split the snapshot`);
  }
  raw = readFileSync(manifestPath, "utf8");
} catch (error) {
  fail(`cannot read manifest: ${error instanceof Error ? error.message : String(error)}`);
}

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  fail(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

let manifest;
try {
  manifest = normalizeManifest(parsed);
} catch (error) {
  if (error instanceof ManifestError) fail(`manifest was rejected: ${error.message}`);
  fail(`manifest normalization failed: ${error instanceof Error ? error.message : String(error)}`);
}

const pool = new Pool({
  host: db.host,
  port: db.port,
  user: db.user,
  password: db.password,
  database: db.database,
  ssl: db.ssl,
  // The import is one sequential transaction; a spare connection is enough.
  max: 2,
  connectionTimeoutMillis: db.connectionTimeoutMs,
  statement_timeout: db.statementTimeoutMs,
  application_name: "reelhouse-household-import"
});

const secret = process.env.DATABASE_URL?.trim() ?? "";

function describeCounters(counters: HouseholdImportCounters): string {
  return (
    `profiles=${counters.profilesSeen}/${counters.profilesUpserted}w/${counters.profilesArchived}a ` +
    `prefs=${counters.preferencesUpserted}w favs=${counters.favoritesUpserted}w/${counters.favoritesRemoved}r ` +
    `lists=${counters.watchlistsUpserted}w/${counters.watchlistsArchived}a ` +
    `listEntries=${counters.watchlistEntriesUpserted}w/${counters.watchlistEntriesRemoved}r ` +
    `colls=${counters.collectionsUpserted}w/${counters.collectionsArchived}a ` +
    `collEntries=${counters.collectionEntriesUpserted}w/${counters.collectionEntriesRemoved}r ` +
    `homeRows=${counters.homeRowsUpserted}w/${counters.homeRowsArchived}a ` +
    `watchState=${counters.watchStateUpserted}w/${counters.watchStateRemoved}r ` +
    `history=${counters.historyAppended} linksUnresolved=${counters.unresolvedLinks} ` +
    `conflictsSkipped=${counters.conflictsSkipped}`
  );
}

try {
  const result = await runHouseholdImport(manifest, createPgSyncExecutor(pool));
  console.log(
    `household:import succeeded — run #${result.runId} in ${result.durationMs}ms: ${describeCounters(result)}`
  );
} catch (error) {
  if (error instanceof HouseholdImportError) {
    const summary = error.summary;
    console.error(
      `household:import failed — run #${summary.runId} recorded as failed ` +
        `(${describeCounters(summary)}); no partial state was committed`
    );
    console.error(`household:import error: ${redactError(summary.errorDetail, secret)}`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`household:import failed: ${redactError(message, secret)}`);
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
