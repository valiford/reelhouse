// Runs the Jellyfin -> media_catalog synchronization as a batch job.
//
//   npm run catalog:sync            # incremental (MinDateLastSaved cursor)
//   npm run catalog:sync:full       # full scan: everything + retirement pass
//   npm run catalog:sync:rebuild    # wipe catalog content, then full scan
//
// Environment:
//   MEDIA_CATALOG_DATABASE_URL    Catalog database (sync role), required.
//   JELLYFIN_URL + JELLYFIN_API_KEY   Jellyfin server and server-scoped key.
//   JELLYFIN_SYNC_TIMEOUT_MS      Per-request bound (default 30000).
//   MEDIA_CATALOG_RETIREMENT_DAYS Retirement threshold (default 30).
//
// The sync reads Jellyfin through its HTTP API only, never modifies Jellyfin,
// never touches the reelhouse database, and never echoes credentials: every
// failure path exits 1 with a redacted, bounded message.

import { redactError } from "../src/lib/db/config.ts";
import {
  CATALOG_URL_VAR,
  loadJellyfinSyncConfig
} from "../src/lib/catalog/config.ts";
import { createHttpJellyfinClient } from "../src/lib/catalog/jellyfin-client.ts";
import { runCatalogSync, type CatalogSyncMode } from "../src/lib/catalog/sync.ts";

function fail(message: string): never {
  console.error(`catalog:sync ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const modeArgIndex = args.indexOf("--mode");
let mode: CatalogSyncMode = "incremental";
if (modeArgIndex !== -1) {
  const value = args[modeArgIndex + 1]?.trim();
  if (value !== "incremental" && value !== "full" && value !== "rebuild") {
    fail(`unknown --mode "${value ?? ""}" (use incremental, full, or rebuild)`);
  }
  mode = value;
  args.splice(modeArgIndex, 2);
}
if (args.length > 0) {
  fail(`unknown arguments: ${args.join(" ")}`);
}

if (!process.env.MEDIA_CATALOG_DATABASE_URL?.trim()) {
  fail(`is not configured: set ${CATALOG_URL_VAR} (the catalog database is separate from DATABASE_URL)`);
}

const jellyfin = loadJellyfinSyncConfig(process.env);
if (jellyfin.kind === "unconfigured") {
  fail("Jellyfin is not configured: set JELLYFIN_URL and JELLYFIN_API_KEY");
}
if (jellyfin.kind === "invalid") {
  fail(`Jellyfin configuration was rejected: ${jellyfin.errors.join("; ")}`);
}

try {
  const result = await runCatalogSync({
    env: process.env,
    client: createHttpJellyfinClient(jellyfin.config),
    mode,
    log: (line) => console.log(line)
  });

  console.log(
    `catalog:sync ${result.mode} scan ${result.scanId} finished in ${result.durationMs} ms: ` +
      `${result.counts.librariesSeen} libraries, ${result.counts.itemsUpserted} upserted, ` +
      `${result.counts.itemsUnchanged} unchanged, ${result.counts.itemsRetired} retired, ` +
      `${result.counts.itemsQuarantined} quarantined`
  );
} catch (error) {
  const rawUrl = process.env[CATALOG_URL_VAR]?.trim();
  fail(`failed: ${redactError(error instanceof Error ? error.message : String(error), rawUrl)}`);
}
