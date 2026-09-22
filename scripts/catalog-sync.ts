// Full-library catalog sync CLI: Jellyfin API → PostgreSQL media_catalog.
//
//   npm run catalog:sync
//
// Environment (all required — the run fails closed without them):
//   DATABASE_URL        Application role URL (least privilege, DML only).
//   JELLYFIN_URL        Base URL of the Jellyfin server.
//   JELLYFIN_API_KEY    Jellyfin API key. Sent only in the X-Emby-Token
//                       header; never echoed, logged, or written to disk.
// Optional:
//   CATALOG_SYNC_HTTP_TIMEOUT_MS   Per-request timeout (1000–300000, default 30000).
//   CATALOG_SYNC_BATCH_SIZE        Page/transaction size (50–1000, default 500).
//   DATABASE_* tuning              See docs/DATABASE.md.
//
// Migrations must already be applied (`npm run db:migrate`). Every echoed
// value is scrubbed of the Jellyfin URL and API key and of the database URL.

import { Pool } from "pg";
import { loadDatabaseConfig } from "../src/lib/db/config.ts";
import { CatalogSyncError, runFullCatalogSync } from "../src/lib/catalog/sync.ts";
import {
  JellyfinCatalogSource,
  readCatalogSyncEnv,
  scrub
} from "../src/lib/catalog/source.ts";
import { createPgSyncExecutor } from "../src/lib/catalog/pg-executor.ts";

function fail(message: string): never {
  console.error(`catalog:sync ${message}`);
  process.exit(1);
}

const dbResult = loadDatabaseConfig(process.env);
if (dbResult.kind === "unconfigured") {
  fail("is not configured: DATABASE_URL (application role) is unset — see docs/CATALOG.md");
}
if (dbResult.kind === "invalid") {
  fail(`database configuration was rejected: ${dbResult.errors.join("; ")}`);
}
const db = dbResult.config;

const jellyfinUrl = process.env.JELLYFIN_URL?.trim() ?? "";
const jellyfinApiKey = process.env.JELLYFIN_API_KEY?.trim() ?? "";
if (!jellyfinUrl) fail("is not configured: JELLYFIN_URL is unset");
if (!jellyfinApiKey) fail("is not configured: JELLYFIN_API_KEY is unset");

let tuning: { timeoutMs: number; pageSize: number };
try {
  tuning = readCatalogSyncEnv(process.env);
} catch (error) {
  fail(`failed: ${error instanceof Error ? error.message : String(error)}`);
}

const pool = new Pool({
  host: db.host,
  port: db.port,
  user: db.user,
  password: db.password,
  database: db.database,
  ssl: db.ssl,
  // The sync is sequential; a spare connection is enough.
  max: 2,
  connectionTimeoutMillis: db.connectionTimeoutMs,
  statement_timeout: db.statementTimeoutMs,
  application_name: "reelhouse-catalog-sync"
});

const secrets = [process.env.JELLYFIN_URL?.trim() ?? "", jellyfinUrl, jellyfinApiKey, process.env.DATABASE_URL?.trim() ?? ""];

try {
  const source = new JellyfinCatalogSource(jellyfinUrl, jellyfinApiKey, fetch, tuning.timeoutMs);
  const result = await runFullCatalogSync(source, createPgSyncExecutor(pool), {
    pageSize: tuning.pageSize
  });
  console.log(
    `catalog:sync succeeded — run #${result.runId} in ${result.durationMs}ms: ` +
      `libraries=${result.librariesSeen} items=${result.itemsSeen} ` +
      `upserted=${result.itemsUpserted} tombstoned=${result.itemsTombstoned} ` +
      `skipped=${result.itemsSkipped} pages=${result.pagesFetched}`
  );
} catch (error) {
  if (error instanceof CatalogSyncError) {
    console.error(
      `catalog:sync failed — run #${error.summary.runId} recorded as failed ` +
        `(libraries=${error.summary.librariesSeen} items=${error.summary.itemsSeen} ` +
        `upserted=${error.summary.itemsUpserted} pages=${error.summary.pagesFetched})`
    );
    console.error(`catalog:sync error: ${scrub(error.summary.errorDetail, secrets)}`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`catalog:sync failed: ${scrub(message, secrets)}`);
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
