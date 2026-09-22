// Hermetic unit matrix for the migration runner's pure core: checksums,
// role resolution, placeholder rendering, planning, directory loading, and
// the pool-backed readiness summary. No database is contacted.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checksumMigrationSql,
  loadMigrationFiles,
  planMigrations,
  renderMigrationSql,
  resolveAppRole,
  summarizeMigrations,
  type AppliedMigration,
  type MigrationFile
} from "./migrator.ts";

async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "reelhouse-migrator-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function file(version: number, name: string, sql = "SELECT 1;"): MigrationFile {
  return { version, name, filename: `${String(version).padStart(4, "0")}_${name}.sql`, sql, checksum: checksumMigrationSql(sql) };
}

test("checksums are stable sha-256 over the file bytes", () => {
  const sql = "CREATE TABLE demo (id integer);";
  assert.equal(checksumMigrationSql(sql), checksumMigrationSql(sql));
  assert.match(checksumMigrationSql(sql), /^[0-9a-f]{64}$/);
  assert.notEqual(checksumMigrationSql(sql), checksumMigrationSql(`${sql}\n`));
});

test("resolveAppRole prefers the explicit role and rejects unsafe identifiers", () => {
  assert.equal(resolveAppRole("reelhouse_app", "reelhouse_owner"), "reelhouse_app");
  assert.equal(resolveAppRole(undefined, "reelhouse_owner"), "reelhouse_owner");
  assert.equal(resolveAppRole("  ", "  "), undefined);
  assert.throws(() => resolveAppRole("ReelHouse; DROP SCHEMA public", undefined), /identifier/);
  assert.throws(() => resolveAppRole('app"role', undefined), /identifier/);
});

test("renderMigrationSql substitutes only {{app_role}}", () => {
  const f = file(1, "demo", "GRANT USAGE ON SCHEMA public TO {{app_role}};");
  assert.equal(renderMigrationSql(f, "reelhouse_app"), "GRANT USAGE ON SCHEMA public TO reelhouse_app;");
  assert.throws(
    () => renderMigrationSql(file(2, "bad", "SELECT '{{owner}}';"), "reelhouse_app"),
    /unsupported placeholder \{\{owner\}\}/
  );
});

test("planMigrations orders pending versions ascending", () => {
  const files = [file(3, "c"), file(1, "a"), file(2, "b")];
  const plan = planMigrations(files, []);
  assert.deepEqual(plan.pending.map((f) => f.version), [1, 2, 3]);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.unknownApplied, []);
});

test("planMigrations skips applied versions and reports nothing else", () => {
  const files = [file(1, "a"), file(2, "b")];
  const applied: AppliedMigration[] = [{ version: 1, name: "a", checksum: files[0].checksum }];
  const plan = planMigrations(files, applied);
  assert.deepEqual(plan.pending.map((f) => f.version), [2]);
  assert.equal(plan.conflicts.length, 0);
});

test("planMigrations fails closed when applied history was edited", () => {
  const files = [file(1, "a")];
  const plan = planMigrations(files, [{ version: 1, name: "a", checksum: "deadbeef".repeat(8) }]);
  assert.equal(plan.pending.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].version, 1);
});

test("planMigrations fails closed when an applied file disappeared", () => {
  const plan = planMigrations([file(2, "b")], [{ version: 1, name: "gone", checksum: "a".repeat(64) }]);
  assert.equal(plan.pending.length, 0);
  assert.equal(plan.unknownApplied.length, 1);
  assert.equal(plan.unknownApplied[0].version, 1);
});

test("loadMigrationFiles reads, orders, and checksums a valid directory", async () => {
  await withTempDir((dir) => {
    writeFileSync(join(dir, "0002_second.sql"), "SELECT 2;", "utf8");
    writeFileSync(join(dir, "0001_first.sql"), "SELECT 1;", "utf8");
    const files = loadMigrationFiles(dir);
    assert.deepEqual(files.map((f) => f.version), [1, 2]);
    assert.equal(files[0].name, "first");
    assert.equal(files[0].checksum, checksumMigrationSql("SELECT 1;"));
  });
});

test("loadMigrationFiles ignores non-SQL entries", async () => {
  await withTempDir((dir) => {
    writeFileSync(join(dir, "0001_ok.sql"), "SELECT 1;", "utf8");
    writeFileSync(join(dir, "README.md"), "notes", "utf8");
    mkdirSync(join(dir, "subdir"));
    assert.equal(loadMigrationFiles(dir).length, 1);
  });
});

test("loadMigrationFiles rejects malformed filenames, duplicates, and bad placeholders", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "01_short.sql"), "SELECT 1;", "utf8");
    assert.throws(() => loadMigrationFiles(dir), /does not match NNNN_name\.sql/);
  });
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;", "utf8");
    writeFileSync(join(dir, "0001_b.sql"), "SELECT 2;", "utf8");
    assert.throws(() => loadMigrationFiles(dir), /Duplicate migration version 1/);
  });
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "0001_bad.sql"), "SELECT '{{mystery}}';", "utf8");
    assert.throws(() => loadMigrationFiles(dir), /unsupported placeholder/);
  });
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "0001_BIG-NAME.sql"), "SELECT 1;", "utf8");
    assert.throws(() => loadMigrationFiles(dir), /does not match NNNN_name\.sql/);
  });
});

test("loadMigrationFiles reports a missing directory as a bounded error", () => {
  assert.throws(() => loadMigrationFiles(join(tmpdir(), "reelhouse-nope-XYZ")), /Cannot read migrations directory/);
});

test("summarizeMigrations reports applied/pending/last through the pool reader", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;", "utf8");
    writeFileSync(join(dir, "0002_b.sql"), "SELECT 2;", "utf8");
    const applied: AppliedMigration[] = [{ version: 1, name: "a", checksum: checksumMigrationSql("SELECT 1;") }];
    const summary = await summarizeMigrations(dir, async () => applied);
    assert.deepEqual(summary, { state: "ok", applied: 1, pending: 1, lastVersion: 1 });
  });
});

test("summarizeMigrations treats a missing bookkeeping table as nothing applied", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;", "utf8");
    const missing = Object.assign(new Error('relation "public.schema_migrations" does not exist'), { code: "42P01" });
    const summary = await summarizeMigrations(dir, async () => {
      throw missing;
    });
    assert.deepEqual(summary, { state: "ok", applied: 0, pending: 1 });
  });
});

test("summarizeMigrations degrades to unknown on reader errors and history conflicts", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;", "utf8");

    const broken = await summarizeMigrations(dir, async () => {
      throw new Error("connection refused");
    });
    assert.equal(broken.state, "unknown");
    assert.match(broken.detail ?? "", /connection refused/);

    const conflict = await summarizeMigrations(dir, async () => [
      { version: 1, name: "a", checksum: "f".repeat(64) }
    ]);
    assert.equal(conflict.state, "unknown");
    assert.match(conflict.detail ?? "", /changed on disk after being applied/);
  });
});

test("summarizeMigrations degrades to unknown when migrations are not on disk", async () => {
  const summary = await summarizeMigrations(join(tmpdir(), "reelhouse-no-migrations-XYZ"), async () => []);
  assert.equal(summary.state, "unknown");
  assert.match(summary.detail ?? "", /Cannot read migrations directory/);
});
