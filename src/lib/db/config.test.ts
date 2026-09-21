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
  assert.equal(loadDatabaseConfig({}).kind, "unconfigured");
  assert.equal(loadDatabaseConfig({ DATABASE_URL: "" }).kind, "unconfigured");
  assert.equal(loadDatabaseConfig({ DATABASE_URL: "   " }).kind, "unconfigured");
});

test("minimal URL applies defaults", () => {
  const result = loadDatabaseConfig({ DATABASE_URL: "postgres://db.lan/reelhouse" });
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  assert.deepEqual(
    { ...result.config, user: result.config.user, password: result.config.password },
    {
      host: "db.lan",
      port: DATABASE_DEFAULTS.port,
      user: "",
      password: "",
      database: "reelhouse",
      ssl: undefined,
      poolMax: 10,
      connectionTimeoutMs: 10_000,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 10_000
    }
  );
});

test("URL components and percent-encoding are honored", () => {
  const result = loadDatabaseConfig({
    DATABASE_URL: "postgresql://reelhouse_app:p%40ss%2Fword@192.168.50.20:5433/reelhouse?sslmode=require"
  });
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  assert.equal(result.config.host, "192.168.50.20");
  assert.equal(result.config.port, 5433);
  assert.equal(result.config.user, "reelhouse_app");
  assert.equal(result.config.password, "p@ss/word");
  assert.deepEqual(result.config.ssl, { rejectUnauthorized: false });
});

test("SSL modes map to libpq semantics", () => {
  const cases: [string, { rejectUnauthorized: boolean } | undefined][] = [
    ["disable", undefined],
    ["require", { rejectUnauthorized: false }],
    ["verify-full", { rejectUnauthorized: true }]
  ];
  for (const [mode, expected] of cases) {
    const result = loadDatabaseConfig({ DATABASE_URL: `postgres://h/reelhouse?sslmode=${mode}` });
    assert.equal(result.kind, "valid");
    if (result.kind !== "valid") return;
    assert.deepEqual(result.config.ssl, expected, `sslmode=${mode}`);
  }
  const envResult = loadDatabaseConfig({ DATABASE_URL: "postgres://h/reelhouse", DATABASE_SSL: "verify-ca" });
  assert.equal(envResult.kind, "valid");
  if (envResult.kind !== "valid") return;
  assert.deepEqual(envResult.config.ssl, { rejectUnauthorized: true });
});

test("unsupported SSL mode is invalid, not silently disabled", () => {
  const result = loadDatabaseConfig({ DATABASE_URL: "postgres://h/reelhouse?sslmode=maybe" });
  assert.equal(result.kind, "invalid");
  if (result.kind !== "invalid") return;
  assert.match(result.errors.join("; "), /unsupported SSL mode/);
});

test("DATABASE_SSL is ignored when the URL carries sslmode", () => {
  const result = loadDatabaseConfig({
    DATABASE_URL: "postgres://h/reelhouse?sslmode=disable",
    DATABASE_SSL: "require"
  });
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  assert.equal(result.config.ssl, undefined);
});

test("bounded overrides accept in-range values", () => {
  const result = loadDatabaseConfig({
    DATABASE_URL: "postgres://h/reelhouse",
    DATABASE_POOL_MAX: "1",
    DATABASE_CONNECT_TIMEOUT_MS: "100",
    DATABASE_IDLE_TIMEOUT_MS: "600000",
    DATABASE_STATEMENT_TIMEOUT_MS: "600000"
  });
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  assert.equal(result.config.poolMax, 1);
  assert.equal(result.config.connectionTimeoutMs, 100);
  assert.equal(result.config.idleTimeoutMs, 600_000);
  assert.equal(result.config.statementTimeoutMs, 600_000);
});

test("out-of-range and non-numeric overrides are invalid", () => {
  const over = loadDatabaseConfig({ DATABASE_URL: "postgres://h/reelhouse", DATABASE_POOL_MAX: "101" });
  assert.equal(over.kind, "invalid");
  const nan = loadDatabaseConfig({ DATABASE_URL: "postgres://h/reelhouse", DATABASE_CONNECT_TIMEOUT_MS: "soon" });
  assert.equal(nan.kind, "invalid");
  if (nan.kind !== "invalid") return;
  assert.match(nan.errors.join(";"), /positive integer/);
});

test("structurally broken URLs fail closed with named problems", () => {
  assert.deepEqual(loadDatabaseConfig({ DATABASE_URL: "not-a-url" }), {
    kind: "invalid",
    errors: ["DATABASE_URL is not a valid URL"]
  });
  const noDb = loadDatabaseConfig({ DATABASE_URL: "postgres://h/" });
  assert.equal(noDb.kind, "invalid");
  if (noDb.kind !== "invalid") return;
  assert.ok(noDb.errors.some((e) => e.includes("no database name")));
  const wrongScheme = loadDatabaseConfig({ DATABASE_URL: "mysql://h/reelhouse" });
  assert.equal(wrongScheme.kind, "invalid");
  const badPort = loadDatabaseConfig({ DATABASE_URL: "postgres://h:99999/reelhouse" });
  assert.equal(badPort.kind, "invalid");
});

test("redactDatabaseUrl masks the password and drops the query string", () => {
  assert.equal(
    redactDatabaseUrl("postgresql://app:secret@synology.lan:5432/reelhouse?sslmode=require&x=1"),
    "postgresql://app:***@synology.lan:5432/reelhouse"
  );
  assert.equal(redactDatabaseUrl("postgresql://synology.lan/reelhouse"), "postgresql://synology.lan/reelhouse");
  assert.equal(redactDatabaseUrl("::garbage::"), "<unparsable database url>");
});

test("describeDatabaseConfig never contains the password", () => {
  const result = loadDatabaseConfig({ DATABASE_URL: "postgres://app:hunter2@h:5433/reelhouse" });
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  const summary = describeDatabaseConfig(result.config);
  assert.match(summary, /app:\*\*\*@h:5433\/reelhouse/);
  assert.ok(!summary.includes("hunter2"));
});

test("redactError scrubs raw URLs leaked into library messages", () => {
  const raw = "postgres://app:secret@h/reelhouse";
  assert.equal(redactError(`connect failed at ${raw}`, raw), `connect failed at ${redactDatabaseUrl(raw)}`);
  assert.equal(redactError("nothing here", raw), "nothing here");
  assert.equal(redactError("nothing here", undefined), "nothing here");
});

test("loadMigrateConfig prefers DATABASE_MIGRATE_URL and labels its errors", () => {
  const both = loadMigrateConfig({
    DATABASE_URL: "postgres://app@db.lan/reelhouse",
    DATABASE_MIGRATE_URL: "postgres://owner@db.lan/reelhouse"
  });
  assert.equal(both.kind, "valid");
  if (both.kind !== "valid") return;
  assert.equal(both.config.user, "owner");

  const fallback = loadMigrateConfig({ DATABASE_URL: "postgres://app@db.lan/reelhouse" });
  assert.equal(fallback.kind, "valid");
  if (fallback.kind !== "valid") return;
  assert.equal(fallback.config.user, "app");

  const broken = loadMigrateConfig({ DATABASE_MIGRATE_URL: "mysql://x/y" });
  assert.equal(broken.kind, "invalid");
  if (broken.kind !== "invalid") return;
  assert.ok(broken.errors.some((e) => e.startsWith("DATABASE_MIGRATE_URL")));

  assert.equal(loadMigrateConfig({}).kind, "unconfigured");
});
