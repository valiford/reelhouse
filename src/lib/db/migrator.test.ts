import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMigrationFiles,
  normalizeSqlContent,
  parseMigrationFileName,
  planMigrations,
  postgresVersionNum,
  sha256Hex,
  verifyHistory,
  type AppliedMigration,
  type MigrationFile
} from "./migrator.ts";

function appliedRow(name: string, checksum: string): AppliedMigration {
  return { name, checksum, appliedAt: new Date(), executionMs: 1, pgVersion: "18.0" };
}

function fileRow(name: string, version: number, sql: string): MigrationFile {
  return {
    name,
    version,
    title: parseMigrationFileName(name)?.title ?? "",
    checksum: sha256Hex(normalizeSqlContent(sql)),
    sql
  };
}

async function withTempMigrations(files: Record<string, string>, fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "reelhouse-migrator-test-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("parseMigrationFileName", () => {
  it("accepts zero-padded snake_case names", () => {
    assert.deepEqual(parseMigrationFileName("0007_watch_state_and_playback.sql"), {
      version: 7,
      title: "watch_state_and_playback"
    });
  });

  it("rejects malformed names", () => {
    for (const bad of [
      "007_missing_padding.sql",
      "7_no_padding.sql",
      "0001-Upper-Case.sql",
      "0001_upper.SQL",
      "0001_.sql",
      "0001_title.sql.bak",
      "README.md"
    ]) {
      assert.equal(parseMigrationFileName(bad), null, `expected rejection: ${bad}`);
    }
  });
});

describe("normalizeSqlContent / sha256Hex", () => {
  it("normalizes CRLF so checkout line endings cannot fake mutations", () => {
    assert.equal(normalizeSqlContent("CREATE TABLE a;\r\nCREATE TABLE b;\r\n"), "CREATE TABLE a;\nCREATE TABLE b;\n");
  });

  it("checksums differ when content differs", () => {
    assert.notEqual(sha256Hex("a"), sha256Hex("b"));
    assert.equal(sha256Hex("stable"), sha256Hex("stable"));
  });
});

describe("loadMigrationFiles", () => {
  it("loads, sorts, and checksums a valid set", async () => {
    await withTempMigrations(
      {
        "0002_second.sql": "CREATE TABLE b();",
        "0001_first.sql": "CREATE TABLE a();"
      },
      async (dir) => {
        const files = await loadMigrationFiles(dir);
        assert.deepEqual(files.map((f) => f.name), ["0001_first.sql", "0002_second.sql"]);
        assert.equal(files[0].checksum, sha256Hex("CREATE TABLE a();"));
      }
    );
  });

  it("refuses duplicate versions, gaps, invalid names, and empty directories", async () => {
    await withTempMigrations({ "0001_a.sql": "a", "0001_b.sql": "b" }, async (dir) => {
      await assert.rejects(loadMigrationFiles(dir), /Duplicate migration version/);
    });
    await withTempMigrations({ "0001_a.sql": "a", "0003_c.sql": "c" }, async (dir) => {
      await assert.rejects(loadMigrationFiles(dir), /versions must be contiguous/);
    });
    await withTempMigrations({ "notes.txt": "hi" }, async (dir) => {
      await assert.rejects(loadMigrationFiles(dir), /Invalid migration file name/);
    });
    await withTempMigrations({}, async (dir) => {
      await assert.rejects(loadMigrationFiles(dir), /No migration files found/);
    });
  });

  it("ignores nested directories like __macosx noise", async () => {
    await withTempMigrations({ "0001_a.sql": "a" }, async (dir) => {
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(join(dir, "sub", "ignored.sql"), "ignored");
      const files = await loadMigrationFiles(dir);
      assert.equal(files.length, 1);
    });
  });
});

describe("verifyHistory", () => {
  const files = [
    fileRow("0001_a.sql", 1, "a-content"),
    fileRow("0002_b.sql", 2, "b-content")
  ];

  it("accepts a matching history", () => {
    assert.deepEqual(verifyHistory([appliedRow("0001_a.sql", files[0].checksum)], files), []);
  });

  it("refuses a missing applied file", () => {
    // Applied 0009 is gone locally, which also leaves local 0001/0002
    // without recorded history — both conflict kinds must fire.
    const conflicts = verifyHistory([appliedRow("0009_gone.sql", "x")], files);
    assert.deepEqual(
      conflicts.map((c) => c.kind).sort(),
      ["missing_file", "unrecorded_old_version", "unrecorded_old_version"]
    );
  });

  it("refuses edited content of an applied migration", () => {
    const conflicts = verifyHistory([appliedRow("0001_a.sql", "stale-checksum")], files);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].kind, "checksum_mismatch");
  });

  it("refuses a renamed file at or below the newest applied version", () => {
    // Applied history knows 0002_b.sql; the local tree now calls it
    // 0002_renamed.sql, which is both a missing file and an unrecorded
    // version-2 migration.
    const renamed = [files[0], fileRow("0002_renamed.sql", 2, "b-content")];
    const conflicts = verifyHistory(
      [appliedRow("0001_a.sql", files[0].checksum), appliedRow("0002_b.sql", files[1].checksum)],
      renamed
    );
    assert.deepEqual(
      conflicts.map((c) => c.kind).sort(),
      ["missing_file", "unrecorded_old_version"]
    );
  });

  it("allows new files above the newest applied version", () => {
    const withNew = [...files, fileRow("0003_c.sql", 3, "c-content")];
    assert.deepEqual(verifyHistory([appliedRow("0001_a.sql", files[0].checksum)], withNew), []);
  });
});

describe("planMigrations", () => {
  it("lists only unapplied files when history is clean", () => {
    const files = [
      fileRow("0001_a.sql", 1, "a"),
      fileRow("0002_b.sql", 2, "b")
    ];
    const plan = planMigrations(files, [appliedRow("0001_a.sql", files[0].checksum)]);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.pending.map((f) => f.name), ["0002_b.sql"]);
  });

  it("returns no pending work when conflicts exist", () => {
    const files = [fileRow("0001_a.sql", 1, "a")];
    const plan = planMigrations(files, [appliedRow("0001_a.sql", "tampered")]);
    assert.equal(plan.conflicts.length, 1);
    assert.deepEqual(plan.pending, []);
  });
});

describe("postgresVersionNum", () => {
  it("parses production-style version strings", () => {
    assert.equal(postgresVersionNum("18.2 (Debian 18.2-1.pgdg120+1)"), 180200);
    assert.equal(postgresVersionNum("18.0"), 180000);
    assert.equal(postgresVersionNum("18beta1"), 180000);
  });

  it("rejects servers below 18", () => {
    assert.equal(postgresVersionNum("17.6"), 170600);
    assert.ok(postgresVersionNum("17.6") < 180000);
  });

  it("returns 0 for garbage", () => {
    assert.equal(postgresVersionNum("not-a-version"), 0);
  });
});
