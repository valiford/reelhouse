// CLI entry point for the ReelHouse database smoke check.
//
//   node scripts/db-smoke.ts
//
// One bounded, redacted pass over the full database surface against whatever
// target the environment names: configuration, connectivity (PostgreSQL 18
// gate), migrations (applied once, then proven idempotent), pool concurrency
// and bounded statement cancellation, and transaction semantics. See
// docs/DB_SMOKE.md for the runbook and the safety model.
//
// Configuration comes only from the environment: DATABASE_URL is the target
// (the app's own connection path); MIGRATION_DATABASE_URL may override the
// migration stage for owner-role targets, exactly like db-migrate.ts. The
// URLs themselves are never printed.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSmokeReport, runSmoke } from "../src/lib/db/smoke.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

if (!process.env.DATABASE_URL?.trim() && !process.env.MIGRATION_DATABASE_URL?.trim()) {
  console.error(
    "No database configured: set DATABASE_URL (or MIGRATION_DATABASE_URL) before running the smoke check"
  );
  process.exit(1);
}

try {
  const report = await runSmoke({
    env: process.env,
    migrationsDir,
    log: () => {}
  });
  console.log(formatSmokeReport(report));
  if (!report.ok) process.exit(1);
} catch (error) {
  console.error(`Smoke check crashed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
