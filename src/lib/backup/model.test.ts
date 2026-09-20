// Unit tests for the pure backup model: registry integrity, canonical
// serialization, manifest validation, staleness bounds, verification
// diffing, and the scratch-database naming guard. No I/O, no database.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import {
  BACKUP_DATABASES,
  BACKUP_MANIFEST_VERSION,
  BACKUP_MAX_AGE_HOURS_VAR,
  BACKUP_TOOL,
  backupAgeHours,
  backupDatabaseSpec,
  boundedMessage,
  buildBackupManifest,
  canonicalRowJson,
  canonicalValue,
  defaultScratchDatabaseName,
  diffManifestAgainstFileFacts,
  diffManifestAgainstRestoredTable,
  diffMigrationSets,
  isSha256Hex,
  maintenanceUrlFor,
  parseBackupMaxAgeHours,
  parseScratchDatabaseName,
  tableChecksum,
  tableFilePath,
  validateBackupManifest,
  type BackupManifest,
  type TableFileFacts
} from "./model.ts";

const HEX64 = "a".repeat(64);

// A manifest shaped exactly like the registry produces, for validation tests.
function validManifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  const databases: BackupManifest["databases"] = {};
  for (const spec of BACKUP_DATABASES) {
    databases[spec.id] = {
      urlLabel: "db.lan:5432/x",
      pgVersion: "18.2",
      migrations: [{ name: "0001_example", checksum: HEX64 }],
      freshness: { latestUpdatedAt: "2026-09-20T12:00:00.000Z", lastSuccessfulScanAt: null },
      tables: spec.tables.map((table, index) => ({
        name: table.name,
        file: tableFilePath(spec.id, index, table.name),
        rowCount: 0,
        sha256: HEX64,
        columns: ["id"]
      }))
    };
  }
  const manifest = buildBackupManifest({ createdAt: new Date("2026-09-20T12:00:00.000Z"), databases });
  return { ...manifest, ...overrides };
}

describe("backup registry", () => {
  it("registers exactly the two databases with their credential variables", () => {
    assert.deepEqual(
      BACKUP_DATABASES.map((spec) => [spec.id, spec.urlVar, spec.migrationsDirName]),
      [
        ["reelhouse", "DATABASE_URL", "migrations"],
        ["media_catalog", "MEDIA_CATALOG_DATABASE_URL", "migrations-catalog"]
      ]
    );
  });

  it("orders child tables after the tables they reference", () => {
    // Every (child -> parent) edge that the migrations declare; a restore
    // loads in registry order, so parents must come first.
    const edges: [string, string][] = [
      ["profile_preferences", "household_profile"],
      ["jellyfin_account_link", "household_profile"],
      ["favorite", "household_profile"],
      ["favorite", "media_item_ref"],
      ["watchlist", "household_profile"],
      ["watchlist_item", "watchlist"],
      ["watchlist_item", "media_item_ref"],
      ["collection", "household_profile"],
      ["collection_item", "collection"],
      ["collection_item", "media_item_ref"],
      ["home_row", "collection"],
      ["watch_state", "household_profile"],
      ["watch_state", "media_item_ref"],
      ["playback_event", "household_profile"],
      ["playback_event", "media_item_ref"],
      ["catalog_item", "catalog_library"],
      ["catalog_provider_id", "catalog_item"],
      ["catalog_item_genre", "catalog_item"],
      ["catalog_item_genre", "catalog_genre"],
      ["catalog_item_studio", "catalog_item"],
      ["catalog_item_studio", "catalog_studio"],
      ["catalog_item_person", "catalog_item"],
      ["catalog_item_person", "catalog_person"]
    ];
    for (const spec of BACKUP_DATABASES) {
      const order = spec.tables.map((table) => table.name);
      for (const [child, parent] of edges) {
        if (!order.includes(child)) continue;
        assert.ok(
          order.indexOf(parent) < order.indexOf(child),
          `${spec.id}: ${parent} must precede ${child} in restore order`
        );
      }
    }
  });

  it("gives every table a non-empty primary-key definition", () => {
    for (const spec of BACKUP_DATABASES) {
      for (const table of spec.tables) {
        assert.ok(table.keyColumns.length > 0, `${table.name} has key columns`);
        for (const column of table.keyColumns) assert.match(column, /^[a-z_]+$/);
      }
    }
  });

  it("resolves specs by id and rejects unknown ids", () => {
    assert.equal(backupDatabaseSpec("reelhouse")?.urlVar, "DATABASE_URL");
    assert.equal(backupDatabaseSpec("nope"), null);
  });
});

describe("canonical serialization", () => {
  it("normalizes dates to UTC ISO strings and undefined to null", () => {
    const value = canonicalValue({ at: new Date("2026-09-20T12:00:00.000Z"), missing: undefined });
    assert.deepEqual(value, { at: "2026-09-20T12:00:00.000Z", missing: null });
  });

  it("sorts object keys recursively so column and jsonb order cannot shift checksums", () => {
    const a = canonicalRowJson({ id: "x", meta: { b: 1, a: [2, { y: 1, x: 2 }] } });
    const b = canonicalRowJson({ meta: { a: [2, { x: 2, y: 1 }], b: 1 }, id: "x" });
    assert.equal(a, b);
    assert.equal(a, '{"id":"x","meta":{"a":[2,{"x":2,"y":1}],"b":1}}');
  });

  it("hashes lines with terminators exactly like sha256 over the concatenation", () => {
    const checksum = tableChecksum();
    checksum.update('{"a":1}');
    checksum.update('{"a":2}');
    const expected = createHash("sha256").update('{"a":1}\n{"a":2}\n').digest("hex");
    assert.equal(checksum.digest(), expected);
    assert.ok(isSha256Hex(expected));
    assert.equal(tableChecksum().digest(), createHash("sha256").update("").digest("hex"));
  });
});

describe("manifest validation", () => {
  it("accepts a registry-shaped manifest", () => {
    const result = validateBackupManifest(validManifest());
    assert.equal(result.kind, "valid");
    if (result.kind === "valid") {
      assert.equal(result.manifest.manifestVersion, BACKUP_MANIFEST_VERSION);
      assert.equal(result.manifest.tool, BACKUP_TOOL);
      assert.equal(Object.keys(result.manifest.databases).length, 2);
    }
  });

  it("rejects non-objects, wrong versions, and unknown tools", () => {
    assert.equal(validateBackupManifest(null).kind, "invalid");
    assert.equal(validateBackupManifest("x").kind, "invalid");
    const result = validateBackupManifest({ ...validManifest(), manifestVersion: 99, tool: "other" });
    assert.equal(result.kind, "invalid");
    if (result.kind === "invalid") {
      assert.ok(result.errors.some((message) => message.includes("manifestVersion")));
      assert.ok(result.errors.some((message) => message.includes("tool")));
    }
  });

  it("rejects unknown databases and missing databases", () => {
    const withUnknown = validManifest();
    (withUnknown.databases as Record<string, unknown>)["mystery"] = {};
    assert.ok(validateBackupManifest(withUnknown).kind === "invalid");

    const onlyReelhouse = validManifest();
    delete onlyReelhouse.databases.media_catalog;
    const result = validateBackupManifest(onlyReelhouse);
    assert.equal(result.kind, "valid", "a partial backup (one database) is a legitimate manifest");
  });

  it("rejects tables that are missing, renamed, or reordered", () => {
    const manifest = validManifest();
    const reelhouse = manifest.databases.reelhouse;
    if (!reelhouse) throw new Error("fixture must contain reelhouse");
    reelhouse.tables = reelhouse.tables.slice(1);
    assert.ok(validateBackupManifest(manifest).kind === "invalid");

    const renamed = validManifest();
    const tables = renamed.databases.reelhouse?.tables ?? [];
    tables[0] = { ...tables[0], name: "not_a_table" };
    const result = validateBackupManifest(renamed);
    assert.equal(result.kind, "invalid");
    if (result.kind === "invalid") assert.ok(result.errors.some((message) => message.includes("registry expects")));

    const swapped = validManifest();
    const reelhouseTables = swapped.databases.reelhouse?.tables ?? [];
    const first = reelhouseTables[0];
    reelhouseTables[0] = reelhouseTables[1];
    reelhouseTables[1] = first;
    assert.ok(validateBackupManifest(swapped).kind === "invalid");
  });

  it("rejects wrong file paths, bad checksums, bad counts, and duplicate columns", () => {
    const manifest = validManifest();
    const tables = manifest.databases.media_catalog?.tables ?? [];
    tables[0] = { ...tables[0], file: "elsewhere.jsonl" };
    assert.ok(validateBackupManifest(manifest).kind === "invalid");

    const badChecksum = validManifest();
    (badChecksum.databases.media_catalog?.tables ?? [])[0] = { ...(badChecksum.databases.media_catalog?.tables ?? [])[0], sha256: "nothex" };
    assert.ok(validateBackupManifest(badChecksum).kind === "invalid");

    const badCount = validManifest();
    (badCount.databases.reelhouse?.tables ?? [])[0] = { ...(badCount.databases.reelhouse?.tables ?? [])[0], rowCount: -1 };
    assert.ok(validateBackupManifest(badCount).kind === "invalid");

    const dupColumns = validManifest();
    (dupColumns.databases.reelhouse?.tables ?? [])[0] = { ...(dupColumns.databases.reelhouse?.tables ?? [])[0], columns: ["id", "id"] };
    assert.ok(validateBackupManifest(dupColumns).kind === "invalid");
  });

  it("rejects malformed freshness timestamps", () => {
    const manifest = validManifest();
    const reelhouse = manifest.databases.reelhouse;
    if (reelhouse) reelhouse.freshness = { latestUpdatedAt: "yesterday", lastSuccessfulScanAt: null };
    assert.ok(validateBackupManifest(manifest).kind === "invalid");
  });
});

describe("staleness bounds", () => {
  function hoursOf(result: ReturnType<typeof parseBackupMaxAgeHours>): number {
    assert.equal(result.kind, "valid");
    return result.kind === "valid" ? result.hours : -1;
  }

  it("defaults to one week and validates overrides", () => {
    assert.equal(hoursOf(parseBackupMaxAgeHours({})), 168);
    assert.equal(hoursOf(parseBackupMaxAgeHours({ [BACKUP_MAX_AGE_HOURS_VAR]: "24" })), 24);
    assert.ok(parseBackupMaxAgeHours({ [BACKUP_MAX_AGE_HOURS_VAR]: "soon" }).kind === "invalid");
    assert.ok(parseBackupMaxAgeHours({ [BACKUP_MAX_AGE_HOURS_VAR]: "0" }).kind === "invalid");
    assert.ok(parseBackupMaxAgeHours({ [BACKUP_MAX_AGE_HOURS_VAR]: "9000" }).kind === "invalid");
  });

  it("computes age from the manifest timestamp and clamps future timestamps", () => {
    const manifest = validManifest();
    const now = new Date("2026-09-27T12:00:00.000Z");
    assert.equal(backupAgeHours(manifest, now), 168);
    assert.equal(backupAgeHours(manifest, new Date("2026-09-13T12:00:00.000Z")), 0);
  });
});

describe("verification diffing", () => {
  const manifest = validManifest();
  const reelhouse = manifest.databases.reelhouse;
  if (!reelhouse) throw new Error("fixture must contain reelhouse");

  function factsFor(overrides: Partial<TableFileFacts> = {}): Map<string, TableFileFacts> {
    const facts = new Map<string, TableFileFacts>();
    for (const table of reelhouse?.tables ?? []) {
      facts.set(table.name, { name: table.name, rowCount: table.rowCount, sha256: table.sha256, columns: table.columns, lineErrors: [], ...overrides });
    }
    return facts;
  }

  it("passes when files match the manifest", () => {
    assert.deepEqual(diffManifestAgainstFileFacts("reelhouse", reelhouse, factsFor()), []);
  });

  it("reports missing files, row counts, checksums, and column drift", () => {
    const missing = new Map<string, TableFileFacts>();
    const problems = diffManifestAgainstFileFacts("reelhouse", reelhouse, missing);
    assert.ok(problems.every((problem) => problem.kind === "file_missing"));
    assert.ok(problems.length === reelhouse.tables.length);

    const drifted = factsFor();
    const first = reelhouse.tables[0];
    drifted.set(first.name, { name: first.name, rowCount: 99, sha256: "b".repeat(64), columns: ["id", "extra"], lineErrors: [] });
    const kinds = diffManifestAgainstFileFacts("reelhouse", reelhouse, drifted).map((problem) => `${problem.kind}:${problem.table}`);
    assert.ok(kinds.includes(`row_count:${first.name}`));
    assert.ok(kinds.includes(`checksum:${first.name}`));
    assert.ok(kinds.includes(`columns:${first.name}`));
  });

  it("reports line errors and skips the derived checksum complaint for them", () => {
    const broken = factsFor();
    const first = reelhouse.tables[0];
    broken.set(first.name, { name: first.name, rowCount: first.rowCount, sha256: first.sha256, columns: first.columns, lineErrors: ["line 2 is not valid JSON"] });
    const problems = diffManifestAgainstFileFacts("reelhouse", reelhouse, broken);
    assert.deepEqual(problems.map((problem) => problem.kind), ["line_invalid"]);
  });

  it("requires migration sets to match in both directions", () => {
    const recorded = [{ name: "0001_a", checksum: HEX64 }, { name: "0002_b", checksum: HEX64 }];
    assert.deepEqual(diffMigrationSets("reelhouse", recorded, recorded), []);
    assert.deepEqual(diffMigrationSets("reelhouse", recorded, [...recorded, { name: "0003_c", checksum: HEX64 }]).map((p) => p.kind), ["migration_set"]);
    assert.deepEqual(diffMigrationSets("reelhouse", recorded, [recorded[0]]).map((p) => p.kind), ["migration_set"]);
    const mismatched = [{ name: "0001_a", checksum: "b".repeat(64) }, { name: "0002_b", checksum: HEX64 }];
    assert.deepEqual(diffMigrationSets("reelhouse", recorded, mismatched).map((p) => p.kind), ["migration_set"]);
  });

  it("compares restored tables against the manifest", () => {
    const table = reelhouse.tables[0];
    assert.deepEqual(diffManifestAgainstRestoredTable("reelhouse", table, { rowCount: table.rowCount, sha256: table.sha256 }), []);
    assert.deepEqual(
      diffManifestAgainstRestoredTable("reelhouse", table, { rowCount: 1, sha256: table.sha256 }).map((p) => p.kind),
      ["row_count"]
    );
  });
});

describe("scratch database guard", () => {
  it("accepts rh_restore_-shaped names only", () => {
    const good = parseScratchDatabaseName("postgresql://u:p@127.0.0.1:55433/rh_restore_check_1");
    assert.equal(good.kind, "valid");
    if (good.kind === "valid") assert.equal(good.name, "rh_restore_check_1");
    for (const bad of [
      "postgresql://u:p@127.0.0.1:55433/reelhouse",
      "postgresql://u:p@127.0.0.1:55433/",
      "postgresql://u:p@127.0.0.1:55433/RH_RESTORE_X",
      "mysql://u:p@127.0.0.1/rh_restore_x",
      "not a url"
    ]) {
      assert.equal(parseScratchDatabaseName(bad).kind, "invalid", bad);
    }
  });

  it("names scratch databases deterministically and derives the maintenance URL", () => {
    assert.equal(defaultScratchDatabaseName(new Date("2026-09-20T17:25:03.000Z")), "rh_restore_check_20260920t172503");
    assert.match(defaultScratchDatabaseName(new Date()), /^rh_restore_check_/);
    const maintenance = maintenanceUrlFor("postgresql://u:p@db.lan:5432/rh_restore_check_1?sslmode=require");
    assert.equal(maintenance.kind, "valid");
    if (maintenance.kind === "valid") assert.equal(new URL(maintenance.url).pathname, "/postgres");
  });
});

describe("bounded diagnostics", () => {
  it("truncates overlong messages", () => {
    assert.equal(boundedMessage("x".repeat(1999)).length, 1999);
    const truncated = boundedMessage("y".repeat(5000));
    assert.ok(truncated.length < 5000 && truncated.includes("(truncated)"));
  });
});
