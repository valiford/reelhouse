// Applies pending ReelHouse PostgreSQL migrations.
//
//   npm run db:migrate
//
// Environment:
//   DATABASE_MIGRATE_URL   Owner/migrator role URL (falls back to DATABASE_URL).
//   DATABASE_URL           Provides the application role for {{app_role}}
//                          placeholders when DATABASE_APP_ROLE is unset.
//   DATABASE_APP_ROLE      Explicit application role name override.
//
// Migrations live in db/migrations/NNNN_name.sql. The run is serialized by a
// PostgreSQL advisory lock, each migration commits independently, and any
// verification failure (edited history, missing file) stops the run before
// executing anything. All output is redacted: URLs are never echoed.

import { loadMigrateConfig, loadDatabaseConfig, redactError, type DatabaseConfigResult } from "../src/lib/db/config.ts";
import { resolveAppRole, runMigrations } from "../src/lib/db/migrator.ts";

function fail(message: string): never {
  console.error(`db:migrate ${message}`);
  process.exit(1);
}

function requireConfig(result: DatabaseConfigResult, varName: string) {
  if (result.kind === "unconfigured") {
    fail(`is not configured: set DATABASE_MIGRATE_URL (owner role) or DATABASE_URL. ${varName} is blank.`);
  }
  if (result.kind === "invalid") {
    fail(`configuration was rejected: ${result.errors.join("; ")}`);
  }
  return result.config;
}

const migrateConfig = requireConfig(loadMigrateConfig(process.env), "DATABASE_MIGRATE_URL");
const appConfig = loadDatabaseConfig(process.env);

let appRole: string | undefined;
try {
  appRole = resolveAppRole(
    process.env.DATABASE_APP_ROLE?.trim() || (appConfig.kind === "valid" ? appConfig.config.user : undefined),
    migrateConfig.user
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

try {
  const result = await runMigrations(migrateConfig, "db/migrations", appRole);
  const grantee = appRole ? `(app role: ${appRole})` : "(no app role configured)";
  if (result.appliedNow.length === 0) {
    console.log(`db:migrate up to date — ${result.skipped} migration(s) already applied ${grantee}`);
  } else {
    console.log(
      `db:migrate applied ${result.appliedNow.length} migration(s): ${result.appliedNow.join(", ")} ` +
        `(${result.skipped} already applied) ${grantee}`
    );
  }
} catch (error) {
  const rawUrl = process.env.DATABASE_MIGRATE_URL?.trim() || process.env.DATABASE_URL?.trim();
  fail(`failed: ${redactError(error instanceof Error ? error.message : String(error), rawUrl)}`);
}
