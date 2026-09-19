// CLI entry point for the Jellyfin -> media_catalog synchronization.
//
//   node scripts/catalog-sync.ts             incremental scan (default)
//   node scripts/catalog-sync.ts --full      full scan; computes retirement
//   node scripts/catalog-sync.ts --rebuild   wipe catalog content, then full scan
//
// Configuration is environment-only (never flags, never arguments):
//   MEDIA_CATALOG_DATABASE_URL      catalog database target
//   JELLYFIN_URL, JELLYFIN_API_KEY  read-only Jellyfin API access
//   MEDIA_CATALOG_RETIREMENT_DAYS   optional retirement threshold (default 30)
// Exit code 0 only for a successful scan; failures are bounded and redacted.
// Jellyfin is never written to; the reelhouse database is never touched.

import { loadJellyfinSyncConfig } from "../src/lib/catalog/config.ts";
import { createHttpJellyfinClient } from "../src/lib/catalog/jellyfin-client.ts";
import { runCatalogSync, type CatalogSyncMode } from "../src/lib/catalog/sync.ts";

const mode: CatalogSyncMode = process.argv.includes("--rebuild")
  ? "rebuild"
  : process.argv.includes("--full")
    ? "full"
    : "incremental";

const env = process.env;
const jellyfin = loadJellyfinSyncConfig(env);
if (jellyfin.kind !== "valid") {
  console.error(
    jellyfin.kind === "unconfigured"
      ? "Jellyfin is not configured for catalog sync: set JELLYFIN_URL and JELLYFIN_API_KEY"
      : `Jellyfin configuration is invalid and was rejected: ${jellyfin.errors.join("; ")}`
  );
  process.exit(1);
}

try {
  const result = await runCatalogSync({
    env,
    mode,
    client: createHttpJellyfinClient(jellyfin.config),
    log: (line) => console.log(line)
  });
  console.log(
    `Scan ${result.scanId}: ${result.status} in ${result.durationMs} ms — ` +
      `${result.counts.librariesSeen} libraries, ${result.counts.itemsUpserted} upserted, ` +
      `${result.counts.itemsUnchanged} unchanged, ${result.counts.itemsMissing} newly missing, ` +
      `${result.counts.itemsRetired} newly retired, ${result.counts.itemsQuarantined} quarantined, ` +
      `${result.counts.itemsSkipped} skipped`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
