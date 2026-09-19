// Integration tests for the database smoke check against the disposable
// PostgreSQL 18 instance (same lifecycle as migrations.int.test.ts).
//
//   npm run test:db:up      start the disposable database (docker compose)
//   npm run test:db         run both integration suites (this one included)
//   npm run test:db:down    stop and discard the database
//
// The smoke suite drives its own database (reelhouse_smoke) inside the same
// disposable container, created on demand here, so it never fights the
// migration suite for reelhouse_test and never touches the production
// Synology target. Migrations applied by the smoke are the only persistent
// change; the container is discarded by test:db:down regardless.

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { loadMigrationFiles } from "./migrator.ts";
import { formatSmokeReport, runSmoke } from "./smoke.ts";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_test";

const SMOKE_DATABASE =
  process.env.SMOKE_DATABASE_URL ??
  "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_smoke";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "db", "migrations");

// The disposable credential pair is user=reelhouse_test password=reelhouse_test;
// the pair together must never appear in any smoke output. (The username alone
// is deliberately visible in redacted summaries.)
const SECRET_PAIR = "reelhouse_test:reelhouse_test";

async function withClient<T>(databaseUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function resetSmokeSchema(): Promise<void> {
  await withClient(SMOKE_DATABASE, async (client) => {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  });
}

let migrationFileCount = 0;

before(async () => {
  migrationFileCount = (await loadMigrationFiles(MIGRATIONS_DIR)).length;
  try {
    await withClient(TEST_DATABASE_URL, async () => {});
  } catch {
    throw new Error(
      "Disposable PostgreSQL 18 is not reachable. Start it with: npm run test:db:up " +
        "(or point TEST_DATABASE_URL at an expendable PostgreSQL 18 database)."
    );
  }
  await withClient(TEST_DATABASE_URL, async (client) => {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", ["reelhouse_smoke"]);
    if (exists.rowCount === 0) {
      await client.query("CREATE DATABASE reelhouse_smoke");
    }
  });
});

describe("smoke: full pass", () => {
  it("passes every stage against an empty schema and applies all migrations", async () => {
    await resetSmokeSchema();
    const report = await runSmoke({
      env: { DATABASE_URL: SMOKE_DATABASE },
      migrationsDir: MIGRATIONS_DIR,
      log: () => {}
    });
    assert.equal(report.ok, true, `expected smoke ok, got:\n${formatSmokeReport(report)}`);
    assert.deepEqual(
      report.stages.map((stage) => stage.stage),
      ["config", "connect", "migrations", "pool", "transactions"]
    );
    for (const stage of report.stages) {
      assert.equal(stage.state, "pass", `stage ${stage.stage}: ${stage.detail}`);
    }
    const migrations = report.stages.find((stage) => stage.stage === "migrations");
    assert.match(migrations!.detail!, new RegExp(`^${migrationFileCount} applied, 0 already applied, repeat run clean`));
    const connect = report.stages.find((stage) => stage.stage === "connect");
    assert.match(connect!.detail!, /server:PostgreSQL 18\./);
    assert.match(connect!.detail!, /latencyMs:\d+/);
  });

  it("is idempotent: an immediate repeat smoke passes with nothing to apply", async () => {
    const report = await runSmoke({
      env: { DATABASE_URL: SMOKE_DATABASE },
      migrationsDir: MIGRATIONS_DIR,
      log: () => {}
    });
    assert.equal(report.ok, true, `expected repeat smoke ok, got:\n${formatSmokeReport(report)}`);
    const migrations = report.stages.find((stage) => stage.stage === "migrations");
    assert.match(
      migrations!.detail!,
      new RegExp(`^0 applied, ${migrationFileCount} already applied, repeat run clean`)
    );
  });
});

describe("smoke: mutated history refusal", () => {
  it("fails the migration stage when a recorded checksum no longer matches", async () => {
    await withClient(SMOKE_DATABASE, async (client) => {
      await client.query(
        "UPDATE schema_migrations SET checksum = 'deadbeef' WHERE name = (SELECT min(name) FROM schema_migrations)"
      );
    });
    const report = await runSmoke({
      env: { DATABASE_URL: SMOKE_DATABASE },
      migrationsDir: MIGRATIONS_DIR,
      log: () => {}
    });
    assert.equal(report.ok, false, "tampered history must fail the smoke");
    const migrations = report.stages.find((stage) => stage.stage === "migrations");
    assert.equal(migrations!.state, "fail");
    assert.match(migrations!.detail!, /checksum_mismatch|recorded checksum/i);
    // Unrelated stages still report: isolation of diagnostics.
    assert.equal(report.stages.find((stage) => stage.stage === "pool")!.state, "pass");
    assert.equal(report.stages.find((stage) => stage.stage === "transactions")!.state, "pass");
  });
});

describe("smoke: fail-closed configuration", () => {
  it("fails at the config stage and skips everything else without a target", async () => {
    const report = await runSmoke({ env: {}, migrationsDir: MIGRATIONS_DIR, log: () => {} });
    assert.equal(report.ok, false);
    assert.equal(report.stages[0].stage, "config");
    assert.equal(report.stages[0].state, "fail");
    assert.match(report.stages[0].detail!, /DATABASE_URL/);
    for (const stage of report.stages.slice(1)) {
      assert.equal(stage.state, "skip", `${stage.stage} should be skipped`);
    }
  });

  it("rejects invalid configuration before any network I/O", async () => {
    const report = await runSmoke({
      env: { DATABASE_URL: "mysql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_smoke" },
      migrationsDir: MIGRATIONS_DIR,
      log: () => {}
    });
    assert.equal(report.ok, false);
    assert.equal(report.stages[0].stage, "config");
    assert.equal(report.stages[0].state, "fail");
    assert.match(report.stages[0].detail!, /must use postgres:\/\/ or postgresql:\/\//);
    assert.equal(report.stages.find((stage) => stage.stage === "connect")!.state, "skip");
  });
});

describe("smoke: unreachable target", () => {
  it("fails bounded and redacted when the server refuses the connection", async () => {
    const unreachable = SMOKE_DATABASE.replace(":55433", ":59999");
    const started = Date.now();
    const report = await runSmoke({
      env: { DATABASE_URL: unreachable, DATABASE_CONNECT_TIMEOUT_MS: "1500" },
      migrationsDir: MIGRATIONS_DIR,
      log: () => {}
    });
    const elapsed = Date.now() - started;
    assert.equal(report.ok, false);
    const connect = report.stages.find((stage) => stage.stage === "connect");
    assert.equal(connect!.state, "fail");
    assert.match(connect!.detail!, /ECONNREFUSED/);
    // Credentials never leak into any reportable surface.
    const formatted = formatSmokeReport(report);
    assert.ok(!formatted.includes(SECRET_PAIR), "smoke output must never contain the credential pair");
    for (const stage of ["migrations", "pool", "transactions"]) {
      assert.equal(report.stages.find((entry) => entry.stage === stage)!.state, "skip");
    }
    // Bounded by the 1500 ms connect timeout plus client overhead.
    assert.ok(elapsed < 15_000, `smoke took ${elapsed} ms; expected a bounded failure`);
  });
});
