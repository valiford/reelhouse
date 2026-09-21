// Hermetic unit tests for the catalog sync configuration loaders.

import test from "node:test";
import assert from "node:assert/strict";
import {
  loadCatalogDatabaseConfig,
  loadCatalogMigrateConfig,
  loadJellyfinSyncConfig,
  loadCatalogSyncPolicy
} from "./config.ts";

test("catalog database config: unset variable is unconfigured", () => {
  assert.equal(loadCatalogDatabaseConfig({}).kind, "unconfigured");
  assert.equal(loadCatalogDatabaseConfig({ MEDIA_CATALOG_DATABASE_URL: "   " }).kind, "unconfigured");
});

test("catalog database config never falls back to DATABASE_URL", () => {
  // The reelhouse database must never receive catalog writes, so a blank
  // catalog URL stays unconfigured even with the household URL present.
  const result = loadCatalogDatabaseConfig({
    DATABASE_URL: "postgresql://reelhouse_app:pw@nas:5432/reelhouse"
  });
  assert.equal(result.kind, "unconfigured");
});

test("catalog database config parses MEDIA_CATALOG_DATABASE_URL through the shared rules", () => {
  const result = loadCatalogDatabaseConfig({
    MEDIA_CATALOG_DATABASE_URL: "postgresql://catalog_app:pw%40sym@nas.lan:5433/media_catalog?sslmode=require"
  });
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  assert.deepEqual(
    { host: result.config.host, port: result.config.port, database: result.config.database, user: result.config.user },
    { host: "nas.lan", port: 5433, database: "media_catalog", user: "catalog_app" }
  );
  assert.equal(result.config.password, "pw@sym");
  assert.deepEqual(result.config.ssl, { rejectUnauthorized: false });
});

test("catalog database config rejects non-postgres schemes and bad urls", () => {
  const bad = loadCatalogDatabaseConfig({ MEDIA_CATALOG_DATABASE_URL: "mysql://x/y" });
  assert.equal(bad.kind, "invalid");
  if (bad.kind === "invalid") assert.match(bad.errors[0], /postgres/);

  const unparsable = loadCatalogDatabaseConfig({ MEDIA_CATALOG_DATABASE_URL: "not a url" });
  assert.equal(unparsable.kind, "invalid");
});

test("catalog ssl override maps onto the shared parser", () => {
  const result = loadCatalogDatabaseConfig({
    MEDIA_CATALOG_DATABASE_URL: "postgresql://catalog_app:pw@nas:5433/media_catalog",
    MEDIA_CATALOG_DATABASE_SSL: "verify-full"
  });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") assert.deepEqual(result.config.ssl, { rejectUnauthorized: true });
});

test("url sslmode wins over the ssl environment override", () => {
  const result = loadCatalogDatabaseConfig({
    MEDIA_CATALOG_DATABASE_URL: "postgresql://catalog_app:pw@nas:5433/media_catalog?sslmode=disable",
    MEDIA_CATALOG_DATABASE_SSL: "verify-full"
  });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") assert.equal(result.config.ssl, undefined);
});

test("catalog migrate config prefers the explicit owner url", () => {
  const result = loadCatalogMigrateConfig({
    MEDIA_CATALOG_MIGRATE_URL: "postgresql://catalog_owner:pw@nas:5433/media_catalog",
    MEDIA_CATALOG_DATABASE_URL: "postgresql://catalog_app:pw@nas:5433/media_catalog"
  });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") assert.equal(result.config.user, "catalog_owner");
});

test("catalog migrate config falls back to the sync url", () => {
  const result = loadCatalogMigrateConfig({
    MEDIA_CATALOG_DATABASE_URL: "postgresql://catalog_app:pw@nas:5433/media_catalog"
  });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") assert.equal(result.config.user, "catalog_app");
});

test("jellyfin sync config is unconfigured without url or key", () => {
  assert.equal(loadJellyfinSyncConfig({}).kind, "unconfigured");
  assert.equal(loadJellyfinSyncConfig({ JELLYFIN_URL: "http://nas:8096" }).kind, "unconfigured");
  assert.equal(loadJellyfinSyncConfig({ JELLYFIN_API_KEY: "key" }).kind, "unconfigured");
});

test("jellyfin sync config validates scheme, url, and bounded timeout", () => {
  const ok = loadJellyfinSyncConfig({
    JELLYFIN_URL: "http://nas.lan:8096/",
    JELLYFIN_API_KEY: "secret",
    JELLYFIN_SYNC_TIMEOUT_MS: "5000"
  });
  assert.equal(ok.kind, "valid");
  if (ok.kind === "valid") {
    assert.equal(ok.config.baseUrl, "http://nas.lan:8096");
    assert.equal(ok.config.requestTimeoutMs, 5000);
  }

  const scheme = loadJellyfinSyncConfig({ JELLYFIN_URL: "ftp://nas:8096", JELLYFIN_API_KEY: "k" });
  assert.equal(scheme.kind, "invalid");

  const timeout = loadJellyfinSyncConfig({
    JELLYFIN_URL: "http://nas:8096",
    JELLYFIN_API_KEY: "k",
    JELLYFIN_SYNC_TIMEOUT_MS: "10"
  });
  assert.equal(timeout.kind, "invalid");
  if (timeout.kind === "invalid") assert.match(timeout.errors[0], /between 1000 and 120000/);
});

test("sync policy defaults and retirement bound", () => {
  const defaults = loadCatalogSyncPolicy({});
  assert.equal(defaults.kind, "valid");
  if (defaults.kind === "valid") {
    assert.equal(defaults.policy.retirementAfterMs, 30 * 24 * 60 * 60 * 1000);
    assert.equal(defaults.policy.pageSize, 500);
    assert.equal(defaults.policy.maxItemsPerLibrary, 50_000);
  }

  const override = loadCatalogSyncPolicy({ MEDIA_CATALOG_RETIREMENT_DAYS: "7" });
  assert.equal(override.kind, "valid");
  if (override.kind === "valid") assert.equal(override.policy.retirementAfterMs, 7 * 24 * 60 * 60 * 1000);

  const rejected = loadCatalogSyncPolicy({ MEDIA_CATALOG_RETIREMENT_DAYS: "9999" });
  assert.equal(rejected.kind, "invalid");
  if (rejected.kind === "invalid") assert.match(rejected.errors[0], /between 1 and 3650/);
});
