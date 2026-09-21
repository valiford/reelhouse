// Applies pending media_catalog migrations (the catalog database is separate
// from the reelhouse database; see docs/CATALOG_SYNC.md).
//
//   npm run catalog:migrate
//
// Environment:
//   MEDIA_CATALOG_MIGRATE_URL    Catalog owner/migrator role URL (falls back
//                                to MEDIA_CATALOG_DATABASE_URL).
//   MEDIA_CATALOG_DATABASE_URL   Also provides the sync role for
//                                {{app_role}} placeholders when
//                                MEDIA_CATALOG_APP_ROLE is unset.
//   MEDIA_CATALOG_APP_ROLE       Explicit sync role name override.
//
// Migrations live in db/migrations-catalog/NNNN_name.sql and are tracked in
// the catalog database's own public.schema_migrations — a different database,
// so the reelhouse history is untouched. All output is redacted: URLs are
// never echoed.

import {
  loadCatalogMigrateConfig,
  loadCatalogDatabaseConfig,
  CATALOG_MIGRATE_URL_VAR,
  CATALOG_URL_VAR
} from "../src/lib/catalog/config.ts";
import { redactError, type DatabaseConfigResult } from "../src/lib/db/config.ts";
import { resolveAppRole, runMigrations } from "../src/lib/db/migrator.ts";

function fail(message: string): never {
  console.error(`catalog:migrate ${message}`);
  process.exit(1);
}

function requireConfig(result: DatabaseConfigResult, varName: string) {
  if (result.kind === "unconfigured") {
    fail(`is not configured: set ${CATALOG_MIGRATE_URL_VAR} (owner role) or ${CATALOG_URL_VAR}. ${varName} is blank.`);
  }
  if (result.kind === "invalid") {
    fail(`configuration was rejected: ${result.errors.join("; ")}`);
  }
  return result.config;
}

const migrateConfig = requireConfig(loadCatalogMigrateConfig(process.env), CATALOG_MIGRATE_URL_VAR);
const syncConfig = loadCatalogDatabaseConfig(process.env);

let appRole: string | undefined;
try {
  appRole = resolveAppRole(
    process.env.MEDIA_CATALOG_APP_ROLE?.trim() || (syncConfig.kind === "valid" ? syncConfig.config.user : undefined),
    migrateConfig.user
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

try {
  const result = await runMigrations(migrateConfig, "db/migrations-catalog", appRole);
  const grantee = appRole ? `(sync role: ${appRole})` : "(no sync role configured)";
  if (result.appliedNow.length === 0) {
    console.log(`catalog:migrate up to date — ${result.skipped} migration(s) already applied ${grantee}`);
  } else {
    console.log(
      `catalog:migrate applied ${result.appliedNow.length} migration(s): ${result.appliedNow.join(", ")} ` +
        `(${result.skipped} already applied) ${grantee}`
    );
  }
} catch (error) {
  const rawUrl =
    process.env.MEDIA_CATALOG_MIGRATE_URL?.trim() || process.env.MEDIA_CATALOG_DATABASE_URL?.trim();
  fail(`failed: ${redactError(error instanceof Error ? error.message : String(error), rawUrl)}`);
}
