import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checksumMigrationSql,
  loadMigrationFiles,
  planMigrations,
  renderMigrationSql,
  resolveAppRole,
  type AppliedMigration,
  type MigrationFile
} from "./migrator.ts";

function file(version: number, name: string, sql: string): MigrationFile {
  return {
    version,
    name,
    filename: `${String(version).padStart(4, "0")}_${name}.sql`,
    sql,
    checksum: checksumMigrationSql(sql)
  };
}

test("checksums are stable sha-256 over the file bytes", () => {
  const sql = "SELECT 1;\n";
  assert.equal(checksumMigrationSql(sql), checksumMigrationSql(sql));
  assert.equal(checksumMigrationSql(sql), createHash("sha256").update(sql, "utf8").digest("hex"));
  assert.notEqual(checksumMigrationSql(sql), checksumMigrationSql(`${sql}SELECT 2;`));
});

test("resolveAppRole prefers the explicit role and rejects unsafe identifiers", () => {
  assert.equal(resolveAppRole("reelhouse_app", "reelhouse_owner"), "reelhouse_app");
  assert.equal(resolveAppRole(undefined, "reelhouse_owner"), "reelhouse_owner");
  assert.equal(resolveAppRole(undefined, undefined), undefined);
  assert.throws(() => resolveAppRole("ReelHouse App", undefined), /not a valid unquoted PostgreSQL identifier/);
  assert.throws(() => resolveAppRole('app"; DROP TABLE x', undefined), /not a valid unquoted PostgreSQL identifier/);
});

test("renderMigrationSql substitutes only {{app_role}}", () => {
  const f = file(1, "grants", "GRANT USAGE ON SCHEMA public TO {{app_role}};\n-- {{app_role}} again\n");
  assert.equal(
    renderMigrationSql(f, "reelhouse_app"),
    "GRANT USAGE ON SCHEMA public TO reelhouse_app;\n-- reelhouse_app again\n"
  );
  assert.throws(() => renderMigrationSql(file(2, "bad", "SELECT '{{owner}}'"), "app"), /unsupported placeholder/);
});

test("planMigrations orders pending versions ascending", () => {
  const files = [file(3, "c", "SELECT 3"), file(1, "a", "SELECT 1"), file(2, "b", "SELECT 2")];
  const plan = planMigrations(files, []);
  assert.deepEqual(
    plan.pending.map((f) => f.version),
    [1, 2, 3]
  );
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.unknownApplied.length, 0);
});

test("planMigrations skips applied versions and reports nothing else", () => {
  const files = [file(1, "a", "SELECT 1"), file(2, "b", "SELECT 2")];
  const applied: AppliedMigration[] = [{ version: 1, name: "a", checksum: files[0].checksum }];
  const plan = planMigrations(files, applied);
  assert.deepEqual(
    plan.pending.map((f) => f.version),
    [2]
  );
});

test("planMigrations fails closed when applied history was edited", () => {
  const files = [file(1, "a", "SELECT 1")];
  const applied: AppliedMigration[] = [{ version: 1, name: "a", checksum: "0".repeat(64) }];
  const plan = planMigrations(files, applied);
  assert.equal(plan.pending.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].version, 1);
});

test("planMigrations fails closed when an applied file disappeared", () => {
  const files = [file(2, "b", "SELECT 2")];
  const applied: AppliedMigration[] = [{ version: 1, name: "a", checksum: "0".repeat(64) }];
  const plan = planMigrations(files, applied);
  assert.equal(plan.pending.length, 0);
  assert.equal(plan.unknownApplied.length, 1);
});

function withTempMigrations(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "reelhouse-migrations-"));
  try {
    for (const [filename, sql] of Object.entries(files)) {
      writeFileSync(join(dir, filename), sql, "utf8");
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadMigrationFiles reads, orders, and checksums a valid directory", () => {
  withTempMigrations(
    {
      "0001_a.sql": "SELECT 1;",
      "0002_b.sql": "SELECT 2;"
    },
    (dir) => {
      const files = loadMigrationFiles(dir);
      assert.deepEqual(
        files.map((f) => [f.version, f.name]),
        [
          [1, "a"],
          [2, "b"]
        ]
      );
      assert.equal(files[0].checksum, checksumMigrationSql("SELECT 1;"));
    }
  );
});

test("loadMigrationFiles ignores non-SQL entries", () => {
  withTempMigrations({ "0001_a.sql": "SELECT 1;", "README.md": "notes" }, (dir) => {
    assert.equal(loadMigrationFiles(dir).length, 1);
  });
});

test("loadMigrationFiles rejects malformed filenames, duplicates, and bad placeholders", () => {
  withTempMigrations({ "migration_a.sql": "SELECT 1;" }, (dir) => {
    assert.throws(() => loadMigrationFiles(dir), /does not match NNNN_name\.sql/);
  });
  withTempMigrations({ "0001_a.sql": "SELECT 1;", "00001_a.sql": "SELECT 1;" }, (dir) => {
    assert.throws(() => loadMigrationFiles(dir), /Duplicate migration version 1/);
  });
  withTempMigrations({ "0001_a.sql": "SELECT '{{nope}}'" }, (dir) => {
    assert.throws(() => loadMigrationFiles(dir), /unsupported placeholder/);
  });
});

test("loadMigrationFiles reports a missing directory as a bounded error", () => {
  assert.throws(() => loadMigrationFiles(join(tmpdir(), "reelhouse-does-not-exist-xyz")), /Cannot read migrations directory/);
});
