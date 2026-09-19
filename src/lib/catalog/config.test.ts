// Unit tests for catalog sync configuration: pure parsing/validation, no I/O.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CATALOG_URL_VAR,
  describeCatalogDatabaseConfig,
  describeJellyfinSyncConfig,
  loadCatalogDatabaseConfig,
  loadCatalogSyncPolicy,
  loadJellyfinSyncConfig
} from "./config.ts";

test("blank MEDIA_CATALOG_DATABASE_URL is unconfigured, not invalid", () => {
  assert.equal(loadCatalogDatabaseConfig({}).kind, "unconfigured");
  assert.equal(loadCatalogDatabaseConfig({ [CATALOG_URL_VAR]: "   " }).kind, "unconfigured");
});

test("a valid catalog URL parses with the full reelhouse config rules", () => {
  const result = loadCatalogDatabaseConfig({
    [CATALOG_URL_VAR]: "postgresql://catalog_app:s3cr%2Ft@10.0.0.5:5433/media_catalog?sslmode=require"
  });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") {
    assert.equal(result.config.user, "catalog_app");
    assert.equal(result.config.password, "s3cr/t");
    assert.equal(result.config.database, "media_catalog");
    assert.deepEqual(result.config.ssl, { rejectUnauthorized: false });
  }
});

test("catalog URL errors name the catalog variable, never the default one", () => {
  const scheme = loadCatalogDatabaseConfig({ [CATALOG_URL_VAR]: "mysql://db.lan/media_catalog" });
  assert.equal(scheme.kind, "invalid");
  if (scheme.kind === "invalid") {
    assert.match(scheme.errors[0], /MEDIA_CATALOG_DATABASE_URL must use/);
  }

  const garbage = loadCatalogDatabaseConfig({ [CATALOG_URL_VAR]: "not a url" });
  assert.equal(garbage.kind, "invalid");
  if (garbage.kind === "invalid") assert.match(garbage.errors[0], /MEDIA_CATALOG_DATABASE_URL is not a valid URL/);
});

test("redacted summaries mask the password and name the source variable", () => {
  const result = loadCatalogDatabaseConfig({
    [CATALOG_URL_VAR]: "postgresql://catalog_app:hunter2@db.lan/media_catalog"
  });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") {
    const summary = describeCatalogDatabaseConfig(result.config);
    assert.match(summary, /catalog_app:\*\*\*@db\.lan(:\d+)?\/media_catalog/);
    assert.doesNotMatch(summary, /hunter2/);
    assert.match(summary, /MEDIA_CATALOG_DATABASE_URL/);
  }
});

test("blank Jellyfin URL or API key is unconfigured for sync", () => {
  assert.equal(loadJellyfinSyncConfig({}).kind, "unconfigured");
  assert.equal(loadJellyfinSyncConfig({ JELLYFIN_URL: "http://jf.lan:8096" }).kind, "unconfigured");
  assert.equal(loadJellyfinSyncConfig({ JELLYFIN_API_KEY: "key" }).kind, "unconfigured");
});

test("a valid Jellyfin sync config trims the base url and keeps the key", () => {
  const result = loadJellyfinSyncConfig({ JELLYFIN_URL: "http://jf.lan:8096/", JELLYFIN_API_KEY: " k1 " });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") {
    assert.equal(result.config.baseUrl, "http://jf.lan:8096");
    assert.equal(result.config.apiKey, "k1");
    assert.equal(result.config.requestTimeoutMs, 30_000);
  }
});

test("invalid Jellyfin scheme and timeout bounds are rejected with named variables", () => {
  const scheme = loadJellyfinSyncConfig({ JELLYFIN_URL: "ftp://jf.lan", JELLYFIN_API_KEY: "k" });
  assert.equal(scheme.kind, "invalid");
  if (scheme.kind === "invalid") assert.match(scheme.errors[0], /JELLYFIN_URL/);

  const timeout = loadJellyfinSyncConfig({
    JELLYFIN_URL: "http://jf.lan",
    JELLYFIN_API_KEY: "k",
    JELLYFIN_SYNC_TIMEOUT_MS: "0"
  });
  assert.equal(timeout.kind, "invalid");
  if (timeout.kind === "invalid") assert.match(timeout.errors[0], /JELLYFIN_SYNC_TIMEOUT_MS/);

  const notNumber = loadJellyfinSyncConfig({
    JELLYFIN_URL: "http://jf.lan",
    JELLYFIN_API_KEY: "k",
    JELLYFIN_SYNC_TIMEOUT_MS: "soon"
  });
  assert.equal(notNumber.kind, "invalid");
});

test("Jellyfin descriptions never carry the API key", () => {
  const result = loadJellyfinSyncConfig({ JELLYFIN_URL: "http://jf.lan:8096", JELLYFIN_API_KEY: "sekrit" });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") {
    const summary = describeJellyfinSyncConfig(result.config);
    assert.doesNotMatch(summary, /sekrit/);
    assert.match(summary, /jf\.lan:8096/);
  }
});

test("retirement policy defaults to 30 days and validates bounds", () => {
  const blank = loadCatalogSyncPolicy({});
  assert.equal(blank.kind, "valid");
  if (blank.kind === "valid") {
    assert.equal(blank.policy.retirementAfterMs, 30 * 24 * 60 * 60 * 1000);
    assert.equal(blank.policy.maxItemsPerLibrary, 50_000);
    assert.equal(blank.policy.poolMax, 4);
  }

  const custom = loadCatalogSyncPolicy({ MEDIA_CATALOG_RETIREMENT_DAYS: "7" });
  assert.equal(custom.kind, "valid");
  if (custom.kind === "valid") assert.equal(custom.policy.retirementAfterMs, 7 * 24 * 60 * 60 * 1000);

  const zero = loadCatalogSyncPolicy({ MEDIA_CATALOG_RETIREMENT_DAYS: "0" });
  assert.equal(zero.kind, "invalid");
  if (zero.kind === "invalid") assert.match(zero.errors[0], /between 1 and 3650/);

  const junk = loadCatalogSyncPolicy({ MEDIA_CATALOG_RETIREMENT_DAYS: "soon" });
  assert.equal(junk.kind, "invalid");
  if (junk.kind === "invalid") assert.match(junk.errors[0], /positive integer/);
});
