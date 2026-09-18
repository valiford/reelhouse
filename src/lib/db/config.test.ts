import test from "node:test";
import assert from "node:assert/strict";
import {
  DATABASE_DEFAULTS,
  describeDatabaseConfig,
  loadDatabaseConfig,
  redactDatabaseUrl,
  redactError
} from "./config.ts";

test("missing or blank DATABASE_URL is unconfigured, not invalid", () => {
  assert.equal(loadDatabaseConfig({}).kind, "unconfigured");
  assert.equal(loadDatabaseConfig({ DATABASE_URL: "" }).kind, "unconfigured");
  assert.equal(loadDatabaseConfig({ DATABASE_URL: "   " }).kind, "unconfigured");
});

test("minimal URL applies defaults", () => {
  const result = loadDatabaseConfig({ DATABASE_URL: "postgres://db.lan/reelhouse" });
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  assert.deepEqual(result.config, {
    host: "db.lan",
    port: DATABASE_DEFAULTS.port,
    user: "",
    password: "",
    database: "reelhouse",
    ssl: undefined,
    poolMax: DATABASE_DEFAULTS.poolMax,
    connectionTimeoutMs: DATABASE_DEFAULTS.connectionTimeoutMs,
    idleTimeoutMs: DATABASE_DEFAULTS.idleTimeoutMs,
    statementTimeoutMs: DATABASE_DEFAULTS.statementTimeoutMs
  });
});

test("URL components are decoded and overrides applied", () => {
  const result = loadDatabaseConfig({
    DATABASE_URL: "postgresql://app:s3cr%2Ft@10.0.0.5:5433/reelhouse?sslmode=require",
    DATABASE_POOL_MAX: "25",
    DATABASE_STATEMENT_TIMEOUT_MS: "5000"
  });
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  assert.equal(result.config.host, "10.0.0.5");
  assert.equal(result.config.port, 5433);
  assert.equal(result.config.user, "app");
  assert.equal(result.config.password, "s3cr/t");
  assert.deepEqual(result.config.ssl, { rejectUnauthorized: false });
  assert.equal(result.config.poolMax, 25);
  assert.equal(result.config.statementTimeoutMs, 5000);
});

test("wrong scheme, unparseable text, and out-of-range ports fail closed", () => {
  const scheme = loadDatabaseConfig({ DATABASE_URL: "mysql://db.lan/reelhouse" });
  assert.equal(scheme.kind, "invalid");
  if (scheme.kind === "invalid") assert.match(scheme.errors[0], /postgres/);

  const garbage = loadDatabaseConfig({ DATABASE_URL: "not a url" });
  assert.equal(garbage.kind, "invalid");

  const port = loadDatabaseConfig({ DATABASE_URL: "postgres://db.lan:70000/reelhouse" });
  assert.equal(port.kind, "invalid");
});

test("missing host or database name is invalid with a named error", () => {
  const noHost = loadDatabaseConfig({ DATABASE_URL: "postgres:///reelhouse" });
  assert.equal(noHost.kind, "invalid");
  if (noHost.kind === "invalid") assert.ok(noHost.errors.some((e) => e.includes("no host")));

  const noDatabase = loadDatabaseConfig({ DATABASE_URL: "postgres://db.lan" });
  assert.equal(noDatabase.kind, "invalid");
  if (noDatabase.kind === "invalid") assert.ok(noDatabase.errors.some((e) => e.includes("database name")));
});

test("malformed percent-encoding in userinfo is invalid, never thrown", () => {
  const result = loadDatabaseConfig({ DATABASE_URL: "postgres://u%ZZ@db.lan/reelhouse" });
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.ok(result.errors.some((e) => e.includes("percent-encoding")));
});

test("sslmode mapping", () => {
  const modes: Array<[string, { rejectUnauthorized: boolean } | undefined, boolean]> = [
    ["disable", undefined, false],
    ["require", { rejectUnauthorized: false }, false],
    ["prefer", { rejectUnauthorized: false }, false],
    ["verify-ca", { rejectUnauthorized: true }, false],
    ["verify-full", { rejectUnauthorized: true }, false],
    ["bogus", undefined, true]
  ];
  for (const [mode, expected, shouldFail] of modes) {
    const result = loadDatabaseConfig({ DATABASE_URL: `postgres://db.lan/reelhouse?sslmode=${mode}` });
    if (shouldFail) {
      assert.equal(result.kind, "invalid", mode);
      if (result.kind === "invalid") assert.ok(result.errors.some((e) => e.includes("SSL mode")));
    } else {
      assert.equal(result.kind, "valid", mode);
      if (result.kind === "valid") assert.deepEqual(result.config.ssl, expected, mode);
    }
  }
});

test("ssl alias and DATABASE_SSL fallback, URL parameter wins", () => {
  const alias = loadDatabaseConfig({ DATABASE_URL: "postgres://db.lan/reelhouse?ssl=true" });
  assert.equal(alias.kind, "valid");
  if (alias.kind === "valid") assert.deepEqual(alias.config.ssl, { rejectUnauthorized: false });

  const off = loadDatabaseConfig({ DATABASE_URL: "postgres://db.lan/reelhouse?ssl=0" });
  if (off.kind === "valid") assert.equal(off.config.ssl, undefined);

  const envFallback = loadDatabaseConfig({
    DATABASE_URL: "postgres://db.lan/reelhouse",
    DATABASE_SSL: "verify-ca"
  });
  if (envFallback.kind === "valid") assert.deepEqual(envFallback.config.ssl, { rejectUnauthorized: true });

  const precedence = loadDatabaseConfig({
    DATABASE_URL: "postgres://db.lan/reelhouse?sslmode=disable",
    DATABASE_SSL: "require"
  });
  if (precedence.kind === "valid") assert.equal(precedence.config.ssl, undefined);
});

test("numeric overrides are validated with bounds", () => {
  const bad = loadDatabaseConfig({ DATABASE_URL: "postgres://db.lan/reelhouse", DATABASE_POOL_MAX: "abc" });
  assert.equal(bad.kind, "invalid");
  if (bad.kind === "invalid") assert.ok(bad.errors.some((e) => e.includes("DATABASE_POOL_MAX")));

  const zero = loadDatabaseConfig({ DATABASE_URL: "postgres://db.lan/reelhouse", DATABASE_POOL_MAX: "0" });
  assert.equal(zero.kind, "invalid");

  const over = loadDatabaseConfig({ DATABASE_URL: "postgres://db.lan/reelhouse", DATABASE_POOL_MAX: "101" });
  assert.equal(over.kind, "invalid");

  const blank = loadDatabaseConfig({ DATABASE_URL: "postgres://db.lan/reelhouse", DATABASE_IDLE_TIMEOUT_MS: "  " });
  assert.equal(blank.kind, "valid");
  if (blank.kind === "valid") assert.equal(blank.config.idleTimeoutMs, DATABASE_DEFAULTS.idleTimeoutMs);
});

test("redactDatabaseUrl masks password and drops query string", () => {
  assert.equal(
    redactDatabaseUrl("postgresql://app:super-secret@db.lan:5433/reelhouse?sslmode=require"),
    "postgresql://app:***@db.lan:5433/reelhouse"
  );
  assert.equal(redactDatabaseUrl("postgres://db.lan/reelhouse"), "postgres://db.lan/reelhouse");
  assert.equal(redactDatabaseUrl("::garbage::"), "<unparsable database url>");
});

test("describeDatabaseConfig never contains the password", () => {
  const result = loadDatabaseConfig({ DATABASE_URL: "postgresql://app:hunter2@db.lan/reelhouse" });
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  const summary = describeDatabaseConfig(result.config);
  assert.ok(summary.includes("***"));
  assert.ok(summary.includes("db.lan"));
  assert.ok(summary.includes("/reelhouse"));
  assert.ok(!summary.includes("hunter2"));
});

test("redactError scrubs raw URLs from library messages", () => {
  const raw = "postgresql://app:super-secret@db.lan/reelhouse";
  const scrubbed = redactError(`connection to ${raw} failed`, raw);
  assert.equal(scrubbed, "connection to postgresql://app:***@db.lan/reelhouse failed");
  assert.ok(!scrubbed.includes("super-secret"));

  assert.equal(redactError("ECONNREFUSED", raw), "ECONNREFUSED");
  assert.equal(redactError("anything", undefined), "anything");
});
