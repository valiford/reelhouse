// CLI entry point for media_catalog database migrations.
//
//   node scripts/catalog-migrate.ts            apply pending catalog migrations
//   node scripts/catalog-migrate.ts --dry-run  print the plan without changing anything
//
// The catalog database is separate from the reelhouse database
// (docs/ARCHITECTURE.md): it targets MEDIA_CATALOG_DATABASE_URL, with an
// optional CATALOG_MIGRATION_DATABASE_URL owner-role override, mirroring the
// reelhouse migrate contract. The URL is never printed.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/lib/db/migrator.ts";
import { CATALOG_URL_VAR } from "../src/lib/catalog/config.ts";

const dryRun = process.argv.includes("--dry-run");

const databaseUrl = process.env.CATALOG_MIGRATION_DATABASE_URL ?? process.env[CATALOG_URL_VAR];
if (!databaseUrl) {
  console.error(
    `No catalog database configured: set ${CATALOG_URL_VAR} (or CATALOG_MIGRATION_DATABASE_URL) before running catalog migrations`
  );
  process.exit(1);
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations-catalog");

try {
  const result = await runMigrations({
    databaseUrl,
    migrationsDir,
    dryRun,
    log: (line) => console.log(line)
  });
  if (dryRun) {
    console.log(`Catalog dry run complete: ${result.alreadyApplied} applied, ${result.pendingCount} pending`);
  } else {
    console.log(`Catalog migration complete: ${result.applied.length} applied, ${result.alreadyApplied} already applied`);
  }
} catch (error) {
  console.error(`Catalog migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
