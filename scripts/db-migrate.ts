// CLI entry point for ReelHouse PostgreSQL migrations.
//
//   node scripts/db-migrate.ts            apply pending migrations
//   node scripts/db-migrate.ts --dry-run  print the plan without changing anything
//
// Configuration comes only from DATABASE_URL (a MIGRATION_DATABASE_URL may
// override it so operators can target a disposable database without touching
// the app's URL). The URL itself is never printed; errors surface their
// message without connection secrets.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/lib/db/migrator.ts";

const dryRun = process.argv.includes("--dry-run");

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "No database configured: set DATABASE_URL (or MIGRATION_DATABASE_URL) before running migrations"
  );
  process.exit(1);
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

try {
  const result = await runMigrations({
    databaseUrl,
    migrationsDir,
    dryRun,
    log: (line) => console.log(line)
  });
  if (dryRun) {
    console.log(`Dry run complete: ${result.alreadyApplied} applied, ${result.pendingCount} pending`);
  } else {
    console.log(`Migration complete: ${result.applied.length} applied, ${result.alreadyApplied} already applied`);
  }
} catch (error) {
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
