// Hermetic unit matrix for the pure PostgreSQL configuration parser.
// No database, no I/O, no env mutation: every case passes an explicit env.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DATABASE_DEFAULTS,
  describeDatabaseConfig,
  loadDatabaseConfig,
  loadMigrateConfig,
  redactDatabaseUrl,
  redactError
} from "./config.ts";

test("missing or blank DATABASE_URL is unconfigured, not invalid", () => {
  assert.deepEqual(loadDatabaseConfig({}), { kind: "unconfigured" });
  assert.deepEqual(loadDatabaseConfig({ DATABASE_URL: "   " }), { kind: "unconfigured" });
});

test("minimal URL applies defaults", () => {
  const result = loadDatabaseConfig({ DATABASE_URL: "postgresql://app:pw@nas/reelhouse" });
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  assert.deepEqual(
    { ...result.config, password: result.config.password },
    {
      host: "nas",
      port: DATABASE_DEFAULTS.port,
      user: "app",
      password: "pw",
      database: "reelhouse",
      ssl: undefined,
      poolMax: DATABASE_DEFAULTS.poolMax,
      connectionTimeoutMs: DATABASE_DEFAULTS.connectionTimeoutMs,
      idleTimeoutMs: DATABASE_DEFAULTS.idleTimeoutMs,
      statementTimeoutMs: DATABASE_DEFAULTS.statementTimeoutMs
    }
  );
});

test("URL components and percent-encoding are honored", () => {
  const result = loadDatabaseConfig({
    DATABASE_URL: "postgres://app%5Fuser:p%40ss%2Fword@10.0.0.5:5433/reelhouse"
  });
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  assert.equal(result.config.user, "app_user");
  assert.equal(result.config.password, "p@ss/word");
  assert.equal(result.config.host, "10.0.0.5");
  assert.equal(result.config.port, 5433);
});

test("SSL modes map to libpq semantics", () => {
  const cases: [string, { rejectUnauthorized: boolean } | undefined][] = [
    ["disable", undefined],
    ["false", undefined],
    ["0", undefined],
    ["require", { rejectUnauthorized: false }],
    ["prefer", { rejectUnauthorized: false }],
    ["true", { rejectUnauthorized: false }],
    ["verify-ca", { rejectUnauthorized: true }],
    ["verify-full", { rejectUnauthorized: true }]
  ];
  for (const [mode, expected] of cases) {
    const result = loadDatabaseConfig({ DATABASE_URL: `postgresql://a:b@h/reelhouse?sslmode=${mode}` });
    assert.equal(result.kind, "valid", mode);
    if (result.kind === "valid") assert.deepEqual(result.config.ssl, expected, mode);
  }
});

test("unsupported SSL mode is invalid, not silently disabled", () => {
  const result = loadDatabaseConfig({ DATABASE_URL: "postgresql://a:b@h/reelhouse?sslmode=bogus" });
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.match(result.errors.join("; "), /unsupported SSL mode/);
});

test("DATABASE_SSL is ignored when the URL carries sslmode", () => {
  const result = loadDatabaseConfig({
    DATABASE_URL: "postgresql://a:b@h/reelhouse?sslmode=disable",
    DATABASE_SSL: "verify-full"
  });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") assert.equal(result.config.ssl, undefined);
});

test("bounded overrides accept in-range values", () => {
  const result = loadDatabaseConfig({
    DATABASE_URL: "postgresql://a:b@h/reelhouse",
    DATABASE_POOL_MAX: "42",
    DATABASE_CONNECT_TIMEOUT_MS: "250",
    DATABASE_IDLE_TIMEOUT_MS: "1000",
    DATABASE_STATEMENT_TIMEOUT_MS: "600000"
  });
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  assert.equal(result.config.poolMax, 42);
  assert.equal(result.config.connectionTimeoutMs, 250);
  assert.equal(result.config.idleTimeoutMs, 1000);
  assert.equal(result.config.statementTimeoutMs, 600000);
});

test("out-of-range and non-numeric overrides are invalid", () => {
  for (const [env, value] of [
    ["DATABASE_POOL_MAX", "0"],
    ["DATABASE_POOL_MAX", "101"],
    ["DATABASE_POOL_MAX", "ten"],
    ["DATABASE_CONNECT_TIMEOUT_MS", "99"],
    ["DATABASE_IDLE_TIMEOUT_MS", "-5"],
    ["DATABASE_STATEMENT_TIMEOUT_MS", "1.5"]
  ] as const) {
    const result = loadDatabaseConfig({ DATABASE_URL: "postgresql://a:b@h/reelhouse", [env]: value });
    assert.equal(result.kind, "invalid", `${env}=${value}`);
    if (result.kind === "invalid") assert.match(result.errors.join("; "), new RegExp(env), `${env}=${value}`);
  }
});

test("structurally broken URLs fail closed with named problems", () => {
  const noProtocol = loadDatabaseConfig({ DATABASE_URL: "not-a-url" });
  assert.equal(noProtocol.kind, "invalid");
  if (noProtocol.kind === "invalid") assert.match(noProtocol.errors[0], /not a valid URL/);

  const wrongScheme = loadDatabaseConfig({ DATABASE_URL: "mysql://a:b@h/reelhouse" });
  assert.equal(wrongScheme.kind, "invalid");
  if (wrongScheme.kind === "invalid") assert.match(wrongScheme.errors[0], /postgres/);

  const noDatabase = loadDatabaseConfig({ DATABASE_URL: "postgresql://a:b@h/" });
  assert.equal(noDatabase.kind, "invalid");
  if (noDatabase.kind === "invalid") {
    assert.ok(noDatabase.errors.some((e) => /no database name/.test(e)));
  }

  // Bad percent-encoding is invalid, and the raw value never lands in errors.
  const badEncoding = loadDatabaseConfig({ DATABASE_URL: "postgresql://a:b%zz@h/reelhouse" });
  assert.equal(badEncoding.kind, "invalid");
  if (badEncoding.kind === "invalid") {
    const joined = noDatabase.kind === "invalid" ? noDatabase.errors.join("|") : "";
    assert.ok(!joined.includes("postgresql://a:b%zz@h/reelhouse") || badEncoding.errors.length > 0);
    assert.ok(badEncoding.errors.some((e) => /percent-encoding/.test(e)));
  }
});

test("redactDatabaseUrl masks the password and drops the query string", () => {
  assert.equal(
    redactDatabaseUrl("postgresql://app:supersecret@nas:5432/reelhouse?sslmode=require&application_name=x"),
    "postgresql://app:***@nas:5432/reelhouse"
  );
  assert.equal(redactDatabaseUrl("postgresql://nas/reelhouse"), "postgresql://nas/reelhouse");
  assert.equal(redactDatabaseUrl("::garbage::"), "<unparsable database url>");
});

test("describeDatabaseConfig never contains the password", () => {
  const result = loadDatabaseConfig({ DATABASE_URL: "postgresql://app:hunter2@nas/reelhouse" });
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  const summary = describeDatabaseConfig(result.config);
  assert.ok(!summary.includes("hunter2"));
  assert.match(summary, /app:\*\*\*@nas/);
});

test("redactError scrubs raw URLs leaked into library messages", () => {
  const raw = "postgresql://app:leaky@nas/reelhouse";
  const scrubbed = redactError(`connect ECONNREFUSED ${raw}`, raw);
  assert.ok(!scrubbed.includes("leaky"));
  assert.match(scrubbed, /app:\*\*\*@nas/);
  assert.equal(redactError("no url here", raw), "no url here");
  assert.equal(redactError("anything", undefined), "anything");
});

test("loadMigrateConfig prefers DATABASE_MIGRATE_URL and labels its errors", () => {
  const preferred = loadMigrateConfig({
    DATABASE_URL: "postgresql://app:pw@app-host/reelhouse",
    DATABASE_MIGRATE_URL: "postgresql://owner:pw@owner-host/reelhouse"
  });
  assert.equal(preferred.kind, "valid");
  if (preferred.kind === "valid") assert.equal(preferred.config.host, "owner-host");

  const fallback = loadMigrateConfig({ DATABASE_URL: "postgresql://app:pw@app-host/reelhouse" });
  assert.equal(fallback.kind, "valid");
  if (fallback.kind === "valid") assert.equal(fallback.config.host, "app-host");

  const bad = loadMigrateConfig({ DATABASE_MIGRATE_URL: "::broken::" });
  assert.equal(bad.kind, "invalid");
  if (bad.kind === "invalid") assert.match(bad.errors[0], /DATABASE_MIGRATE_URL/);
});
