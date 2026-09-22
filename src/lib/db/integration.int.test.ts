// Deterministic PostgreSQL integration evidence for RH-0030.
//
// Runs against the disposable loopback PostgreSQL 18 profile
// (docker-compose.dev-db.yml) — never against Synology. Requires two role
// URLs; without them every case skips so the hermetic `npm test` stays
// hermetic:
//
//   REELHOUSE_TEST_MIGRATE_URL   owner/migrator role, e.g.
//                                postgresql://reelhouse_owner:reelhouse_owner_dev@127.0.0.1:5433/reelhouse
//   REELHOUSE_TEST_DATABASE_URL  application role, e.g.
//                                postgresql://reelhouse_app:reelhouse_app_dev@127.0.0.1:5433/reelhouse
//
// Scenarios: migration apply + idempotence, checksum tamper fail-closed,
// least-privilege role smoke (DML yes, DDL never), migrator-as-app-role
// fail-closed on a fresh database, pool-backed readiness summary, bounded
// connection timeouts, and recovery after authentication failure.
//
// This file deliberately avoids importing pool.ts: that module is
// `server-only` and throws under plain Node. The runtime readiness surface
// it powers is verified live through /api/health (see the worker report).

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { loadDatabaseConfig, type DatabaseConfig } from "./config.ts";
import { checkMigrations, runMigrations, summarizeMigrations } from "./migrator.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const TMP_DB = "reelhouse_rh0030_tmp";

const migrateEnv = process.env.REELHOUSE_TEST_MIGRATE_URL;
const appEnv = process.env.REELHOUSE_TEST_DATABASE_URL;

function clientConfig(url: string, overrides: Record<string, string> = {}): DatabaseConfig {
  const result = loadDatabaseConfig({ DATABASE_URL: url, ...overrides });
  if (result.kind === "invalid") throw new Error(`test URL invalid: ${result.errors.join("; ")}`);
  if (result.kind !== "valid") throw new Error("test URL is blank");
  return result.config;
}

async function withClient(config: DatabaseConfig, fn: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionTimeoutMillis: config.connectionTimeoutMs
  });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

const migrateConfig = migrateEnv ? clientConfig(migrateEnv) : undefined;
const appConfig = appEnv ? clientConfig(appEnv) : undefined;

function needsDb(t: import("node:test").TestContext): { migrate: DatabaseConfig; app: DatabaseConfig } {
  if (!migrateConfig || !appConfig) {
    t.skip("REELHOUSE_TEST_MIGRATE_URL / REELHOUSE_TEST_DATABASE_URL not set (hermetic mode)");
    throw new Error("unreachable");
  }
  return { migrate: migrateConfig, app: appConfig };
}

test("migrations apply as the owner role and re-apply is a no-op", async (t) => {
  const { migrate } = needsDb(t);
  await withClient(migrate, async (client) => {
    await client.query("DROP TABLE IF EXISTS public.schema_migrations");
    await client.query("DROP TABLE IF EXISTS public.rh0030_probe");
  });

  const first = await runMigrations(migrate, MIGRATIONS_DIR, appConfig?.user);
  assert.deepEqual(first.appliedNow, [1]);
  assert.equal(first.skipped, 0);

  const second = await runMigrations(migrate, MIGRATIONS_DIR, appConfig?.user);
  assert.deepEqual(second.appliedNow, []);
  assert.equal(second.skipped, 1);

  await withClient(migrate, async (client) => {
    const rows = await client.query<{ version: number; name: string; checksum: string }>(
      "SELECT version, name, checksum FROM public.schema_migrations ORDER BY version"
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].name, "app_role_grants_baseline");
    assert.match(rows.rows[0].checksum, /^[0-9a-f]{64}$/);
  });
});

test("grants baseline: app role gets DML on owner tables and never DDL", async (t) => {
  const { migrate, app } = needsDb(t);
  // Created AFTER migration 0001 applied: default privileges must cover it.
  await withClient(migrate, async (client) => {
    await client.query("CREATE TABLE public.rh0030_probe (id integer PRIMARY KEY, label text)");
  });

  try {
    // App role DML succeeds on the owner-created table.
    await withClient(app, async (client) => {
      await client.query("INSERT INTO public.rh0030_probe (id, label) VALUES (1, 'dml-ok')");
      const read = await client.query<{ id: number }>("SELECT id FROM public.rh0030_probe");
      assert.deepEqual(read.rows, [{ id: 1 }]);

      const privileges = await client.query<Record<string, boolean>>(
        `SELECT has_table_privilege(current_user, 'public.rh0030_probe', 'SELECT') AS can_select,
                has_table_privilege(current_user, 'public.rh0030_probe', 'INSERT') AS can_insert,
                has_table_privilege(current_user, 'public.rh0030_probe', 'UPDATE') AS can_update,
                has_table_privilege(current_user, 'public.rh0030_probe', 'DELETE') AS can_delete`
      );
      const priv = privileges.rows[0];
      assert.deepEqual(priv, { can_select: true, can_insert: true, can_update: true, can_delete: true });

      // Migration bookkeeping is readable, never writable.
      const book = await client.query<{ count: string }>("SELECT count(*) FROM public.schema_migrations");
      assert.equal(Number(book.rows[0].count), 1);
      await assert.rejects(client.query("DELETE FROM public.schema_migrations"), /permission denied/);
    });

    // App role DDL is denied at the schema level.
    await withClient(app, async (client) => {
      await assert.rejects(
        client.query("CREATE TABLE public.rh0030_escalate (id integer)"),
        /permission denied for schema public/
      );
    });
  } finally {
    await withClient(migrate, async (client) => {
      await client.query("DROP TABLE IF EXISTS public.rh0030_probe");
    });
  }
});

test("app role is least-privilege: no superuser, createdb, createrole, or replication", async (t) => {
  const { app } = needsDb(t);
  await withClient(app, async (client) => {
    const roles = await client.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolcanlogin: boolean;
    }>(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
       FROM pg_roles WHERE rolname = current_user`
    );
    assert.deepEqual(roles.rows[0], {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolcanlogin: true
    });
  });
});

test("edited migration history fails closed before executing anything", async (t) => {
  const { migrate } = needsDb(t);
  const tampered = mkdtempSync(join(tmpdir(), "reelhouse-tampered-"));
  try {
    writeFileSync(join(tampered, "0001_app_role_grants_baseline.sql"), "-- tampered content\nSELECT 1;\n", "utf8");
    await assert.rejects(
      runMigrations(migrate, tampered, appConfig?.user),
      /changed on disk after being applied/
    );
    // Nothing was re-applied or inserted by the rejected run.
    await withClient(migrate, async (client) => {
      const rows = await client.query<{ count: string }>("SELECT count(*) FROM public.schema_migrations");
      assert.equal(Number(rows.rows[0].count), 1);
    });
  } finally {
    rmSync(tampered, { recursive: true, force: true });
  }
});

test("migrator as the app role fails closed on a fresh database", async (t) => {
  const { migrate, app } = needsDb(t);
  await withClient(migrate, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${TMP_DB} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${TMP_DB}`);
    await client.query(`GRANT CONNECT ON DATABASE ${TMP_DB} TO ${app.user}`);
  });
  try {
    const tmpApp: DatabaseConfig = { ...app, database: TMP_DB };
    await assert.rejects(runMigrations(tmpApp, MIGRATIONS_DIR, app.user), /permission denied/);
    // The rejected run must not have left a half-created bookkeeping table.
    const tmpOwner: DatabaseConfig = { ...migrate, database: TMP_DB };
    await withClient(tmpOwner, async (client) => {
      const table = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations'`
      );
      assert.equal(table.rowCount, 0);
    });
    // The owner pipeline on the same fresh database succeeds end to end.
    const run = await runMigrations(tmpOwner, MIGRATIONS_DIR, app.user);
    assert.deepEqual(run.appliedNow, [1]);
    const status = await checkMigrations(tmpOwner, MIGRATIONS_DIR);
    assert.equal(status.state, "ok");
    assert.equal(status.applied, 1);
    assert.equal(status.pending, 0);
  } finally {
    await withClient(migrate, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${TMP_DB} WITH (FORCE)`);
    });
  }
});

test("pool-backed readiness summary matches the owner-role status", async (t) => {
  const { migrate, app } = needsDb(t);
  await runMigrations(migrate, MIGRATIONS_DIR, app.user);

  // Exactly what /api/health does with the application pool.
  const summary = await summarizeMigrations(MIGRATIONS_DIR, async () => {
    const client = await withConnected(app);
    try {
      const result = await client.query<{ version: number; name: string; checksum: string }>(
        "SELECT version, name, checksum FROM public.schema_migrations ORDER BY version"
      );
      return result.rows;
    } finally {
      await client.end();
    }
  });
  assert.equal(summary.state, "ok");
  assert.equal(summary.applied, 1);
  assert.equal(summary.pending, 0);
  assert.equal(summary.lastVersion, 1);

  // The same summary over an app-role connection to a database whose
  // bookkeeping table is missing reports nothing applied, not an error.
  await withClient(migrate, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${TMP_DB} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${TMP_DB}`);
    await client.query(`GRANT CONNECT ON DATABASE ${TMP_DB} TO ${app.user}`);
  });
  try {
    const tmpApp: DatabaseConfig = { ...app, database: TMP_DB };
    const fresh = await summarizeMigrations(MIGRATIONS_DIR, async () => {
      const client = await withConnected(tmpApp);
      try {
        const result = await client.query<{ version: number; name: string; checksum: string }>(
          "SELECT version, name, checksum FROM public.schema_migrations ORDER BY version"
        );
        return result.rows;
      } finally {
        await client.end();
      }
    });
    assert.deepEqual(fresh, { state: "ok", applied: 0, pending: 1 });
  } finally {
    await withClient(migrate, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${TMP_DB} WITH (FORCE)`);
    });
  }
});

test("checkMigrations reports a fresh database as pending, not in error", async (t) => {
  const { migrate } = needsDb(t);
  await withClient(migrate, async (client) => {
    await client.query("DROP TABLE IF EXISTS public.schema_migrations");
  });
  const status = await checkMigrations(migrate, MIGRATIONS_DIR);
  assert.equal(status.state, "ok");
  assert.equal(status.applied, 0);
  assert.equal(status.pending, 1);
  // Restore the applied state for any later inspection.
  await runMigrations(migrate, MIGRATIONS_DIR, appConfig?.user);
});

test("unreachable hosts fail within the configured connect timeout", async (t) => {
  needsDb(t);
  const blackhole = clientConfig("postgresql://reelhouse_app:reelhouse_app_dev@10.255.255.1:5433/reelhouse", {
    DATABASE_CONNECT_TIMEOUT_MS: "1500"
  });
  const started = Date.now();
  await assert.rejects(
    withClient(blackhole, async () => assert.fail("must not connect")),
    (error: Error) => /timeout|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(error.message)
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `connect took ${elapsed}ms, expected the ~1.5s bound`);
});

test("authentication failure is redacted and does not poison later connections", async (t) => {
  const { app } = needsDb(t);
  const wrongPassword: DatabaseConfig = { ...app, password: "definitely-not-the-password" };
  await assert.rejects(
    withClient(wrongPassword, async () => assert.fail("must not authenticate")),
    (error: Error) => {
      assert.match(error.message, /password authentication failed/i);
      assert.ok(!error.message.includes("definitely-not-the-password".slice(0, 8)), "error leaked credentials");
      return true;
    }
  );
  // Recovery path: the very next connection with good credentials succeeds.
  await withClient(app, async (client) => {
    const one = await client.query<{ ok: number }>("SELECT 1 AS ok");
    assert.equal(one.rows[0].ok, 1);
  });
});

async function withConnected(config: DatabaseConfig): Promise<Client> {
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionTimeoutMillis: config.connectionTimeoutMs
  });
  await client.connect();
  return client;
}
