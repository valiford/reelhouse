// Integration tests for backup/restore and disaster recovery (RH-0021)
// against the disposable PostgreSQL 18 instance (same lifecycle as the
// other db suites).
//
//   npm run test:db:up      start the disposable database (docker compose)
//   npm run test:db         run all integration suites (this one included)
//   npm run test:db:down    stop and discard the database
//
// The suite owns its databases inside the disposable container
// (reelhouse_backup_reelhouse, reelhouse_backup_catalog) so it never fights
// the other suites, and it exercises the exact end-to-end path the DR
// runbook prescribes: snapshot -> offline verify -> restore into a
// disposable scratch -> checksum recompute -> resync drill. Jellyfin is
// simulated by a fixture client; nothing here requires network access and
// nothing can touch a production database — the restore phase only ever
// addresses the rh_restore_-shaped scratch database.

import { strict as assert } from "node:assert";
import { before, beforeEach, describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { runCatalogSync, type CatalogSyncMode } from "../catalog/sync.ts";
import type { JellyfinCatalogClient } from "../catalog/jellyfin-client.ts";
import type { JellyfinItemRaw, JellyfinLibraryRaw } from "../catalog/model.ts";
import { runMigrations } from "../db/migrator.ts";
import {
  BACKUP_PATHS,
  isBackupDatabaseId,
  sha256Hex,
  tableFilePath,
  type BackupDatabaseId
} from "./model.ts";
import { runBackup } from "./snapshot.ts";
import { restoreVerify, verifyBackupFiles } from "./restore.ts";

const ADMIN_DATABASE_URL =
  process.env.BACKUP_ADMIN_TEST_DATABASE_URL ?? "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/postgres";

const REELHOUSE_DATABASE_URL =
  process.env.BACKUP_REELHOUSE_TEST_DATABASE_URL ??
  "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_backup_reelhouse";

const CATALOG_DATABASE_URL =
  process.env.BACKUP_CATALOG_TEST_DATABASE_URL ??
  "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_backup_catalog";

const SCRATCH_DATABASE_URL =
  process.env.BACKUP_SCRATCH_TEST_DATABASE_URL ??
  "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/rh_restore_check_inttest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MIGRATIONS_DIRS = {
  migrations: join(REPO_ROOT, "db", "migrations"),
  "migrations-catalog": join(REPO_ROOT, "db", "migrations-catalog")
};

// The disposable credential pair must never appear in any failure output.
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

async function createDatabaseIfMissing(databaseUrl: string, name: string): Promise<void> {
  await withClient(ADMIN_DATABASE_URL, async (client) => {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE ${name}`);
  });
}

async function databaseExists(name: string): Promise<boolean> {
  return withClient(ADMIN_DATABASE_URL, async (client) => {
    const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    return (result.rowCount ?? 0) > 0;
  });
}

async function dropDatabase(name: string): Promise<void> {
  await withClient(ADMIN_DATABASE_URL, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });
}

async function truncateAll(): Promise<void> {
  await withClient(REELHOUSE_DATABASE_URL, async (client) => {
    await client.query(`TRUNCATE
      household_profile, media_item_ref, profile_preferences, jellyfin_account_link,
      sync_cursor, idempotency_record, favorite, watchlist, watchlist_item,
      collection, collection_item, home_row, watch_state, playback_event
      CASCADE`);
  });
  await withClient(CATALOG_DATABASE_URL, async (client) => {
    await client.query(`TRUNCATE
      catalog_library, catalog_item, catalog_provider_id,
      catalog_genre, catalog_studio, catalog_person,
      catalog_item_genre, catalog_item_studio, catalog_item_person,
      catalog_scan, catalog_sync_state, catalog_quarantine
      CASCADE`);
  });
}

// ---- Fixture Jellyfin: an in-memory read-only stand-in for the API ----

class FixtureJellyfin implements JellyfinCatalogClient {
  libraries: JellyfinLibraryRaw[] = [];
  items = new Map<string, JellyfinItemRaw[]>();

  async listLibraries(): Promise<JellyfinLibraryRaw[]> {
    return this.libraries;
  }

  async listItemPage(
    libraryExternalId: string,
    options: { startIndex: number; limit: number; includeTypes: string[] }
  ): Promise<{ items: JellyfinItemRaw[]; totalRecorded: number }> {
    const all = (this.items.get(libraryExternalId) ?? [])
      .filter((item) => item.Type !== undefined && options.includeTypes.includes(item.Type))
      .sort((a, b) => ((a.Id ?? "") < (b.Id ?? "") ? -1 : 1));
    return { items: all.slice(options.startIndex, options.startIndex + options.limit), totalRecorded: all.length };
  }
}

const T0 = "2026-09-19T12:00:00.000Z";

function fixtureJellyfin(movieNameOverride?: string): FixtureJellyfin {
  const fixture = new FixtureJellyfin();
  fixture.libraries = [{ Id: "lib-movies", Name: "Movies", CollectionType: "movies" }];
  const movie = (id: string, name: string): JellyfinItemRaw => ({
    Id: id,
    Name: name,
    Type: "Movie",
    ProductionYear: 2020,
    Overview: `Overview for ${id}`,
    ProviderIds: { Imdb: `tt000000${id}` },
    Genres: ["Drama"],
    Studios: [{ Name: "Studio One" }],
    People: [{ Name: "Ada Reel", Type: "Actor", Role: "Lead" }],
    DateLastSaved: T0
  });
  fixture.items.set("lib-movies", [
    movie("mv-1", "One Fine Feature"),
    movie("mv-2", movieNameOverride ?? "Two Fine Features")
  ]);
  return fixture;
}

async function runCatalogSyncOn(url: string, mode: CatalogSyncMode, fixture: FixtureJellyfin): Promise<string> {
  const result = await runCatalogSync({
    env: { MEDIA_CATALOG_DATABASE_URL: url, MEDIA_CATALOG_RETIREMENT_DAYS: "1" },
    mode,
    client: fixture,
    log: () => {}
  });
  return result.status;
}

// ---- Seeds ------------------------------------------------------------------

async function seedReelhouse(): Promise<void> {
  await withClient(REELHOUSE_DATABASE_URL, async (client) => {
    const profile = await client.query<{ id: string }>(
      "INSERT INTO household_profile (display_name) VALUES ('Living Room') RETURNING id"
    );
    const profileId = profile.rows[0].id;
    const ref = await client.query<{ id: string }>(
      "INSERT INTO media_item_ref (source, external_id) VALUES ('jellyfin', 'mv-1') RETURNING id"
    );
    const refId = ref.rows[0].id;
    await client.query("INSERT INTO favorite (profile_id, media_ref_id) VALUES ($1, $2)", [profileId, refId]);
    // bigint ticks come back from pg as text; the snapshot must preserve that.
    await client.query(
      "INSERT INTO watch_state (profile_id, media_ref_id, position_ticks, duration_ticks, completed) VALUES ($1, $2, $3, $4, true)",
      [profileId, refId, "123456789012", "200000000000"]
    );
    await client.query("INSERT INTO watchlist (profile_id, name) VALUES ($1, 'Family Night')", [profileId]);
  });
}

async function seedCatalog(): Promise<void> {
  const status = await runCatalogSyncOn(CATALOG_DATABASE_URL, "full", fixtureJellyfin());
  assert.equal(status, "succeeded");
}

// ---- Backup directory helpers ------------------------------------------------

interface BackupHandle {
  dir: string;
  cleanup: () => Promise<void>;
}

async function makeBackupDir(label: string): Promise<BackupHandle> {
  const dir = await mkdtemp(join(tmpdir(), `reelhouse-backup-${label}-`));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function takeBackup(label: string): Promise<BackupHandle> {
  const handle = await makeBackupDir(label);
  await runBackup({
    databases: [
      { id: "reelhouse", databaseUrl: REELHOUSE_DATABASE_URL },
      { id: "media_catalog", databaseUrl: CATALOG_DATABASE_URL }
    ],
    outDir: handle.dir
  });
  return handle;
}

type TableChecksums = Map<BackupDatabaseId, Map<string, { rowCount: number; sha256: string }>>;

function tableChecksumsFromManifest(manifestRaw: string): TableChecksums {
  const parsed = JSON.parse(manifestRaw) as {
    databases: Record<string, { tables: { name: string; rowCount: number; sha256: string }[] }>;
  };
  const out: TableChecksums = new Map();
  for (const [id, db] of Object.entries(parsed.databases)) {
    if (!isBackupDatabaseId(id)) continue;
    out.set(
      id,
      new Map(db.tables.map((table) => [table.name, { rowCount: table.rowCount, sha256: table.sha256 }]))
    );
  }
  return out;
}

async function readManifestRaw(dir: string): Promise<string> {
  return readFile(join(dir, BACKUP_PATHS.manifest), "utf8");
}

// Rewrites the manifest for a doctored backup: callers mutate the parsed
// manifest, then this re-serializes and re-signs it exactly like the
// snapshot writer would — proving the tool's verdicts come from content,
// not from an unforgeable file layout.
async function rewriteManifest(dir: string, manifest: unknown): Promise<void> {
  const json = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(join(dir, BACKUP_PATHS.manifest), json, "utf8");
  await writeFile(join(dir, BACKUP_PATHS.manifestChecksum), sha256Hex(json) + "\n", "utf8");
}

interface ParsedManifestTable {
  name: string;
  file: string;
  rowCount: number;
  sha256: string;
  columns: string[];
}

interface ParsedManifest {
  createdAt: string;
  databases: Record<string, {
    urlLabel: string;
    pgVersion: string;
    migrations: { name: string; checksum: string }[];
    freshness: { latestUpdatedAt: string | null; lastSuccessfulScanAt: string | null };
    tables: ParsedManifestTable[];
  }>;
}

async function readParsedManifest(dir: string): Promise<ParsedManifest> {
  return JSON.parse(await readManifestRaw(dir));
}

function tableOf(database: ParsedManifest["databases"][string], name: string): ParsedManifestTable {
  const table = database.tables.find((entry) => entry.name === name);
  assert.ok(table, `manifest must contain table ${name}`);
  return table;
}

// ---- Suites -------------------------------------------------------------------

before(async () => {
  await createDatabaseIfMissing(REELHOUSE_DATABASE_URL, "reelhouse_backup_reelhouse");
  await createDatabaseIfMissing(CATALOG_DATABASE_URL, "reelhouse_backup_catalog");
  await runMigrations({ databaseUrl: REELHOUSE_DATABASE_URL, migrationsDir: MIGRATIONS_DIRS.migrations, log: () => {} });
  await runMigrations({ databaseUrl: CATALOG_DATABASE_URL, migrationsDir: MIGRATIONS_DIRS["migrations-catalog"], log: () => {} });
  // The scratch database is dropped and recreated per verification; make
  // sure no leftover from a crashed run leaks into the first test.
  await dropDatabase("rh_restore_check_inttest");
});

beforeEach(async () => {
  await truncateAll();
});

describe("backup snapshot", () => {
  it("writes a valid manifest, signed sidecar, and per-table files", async () => {
    await seedReelhouse();
    await seedCatalog();
    const backup = await makeBackupDir("manifest");
    try {
      const result = await runBackup({
        databases: [
          { id: "reelhouse", databaseUrl: REELHOUSE_DATABASE_URL },
          { id: "media_catalog", databaseUrl: CATALOG_DATABASE_URL }
        ],
        outDir: backup.dir
      });

      const manifestRaw = await readManifestRaw(backup.dir);
      const sidecar = (await readFile(join(backup.dir, BACKUP_PATHS.manifestChecksum), "utf8")).trim();
      assert.equal(sidecar, sha256Hex(manifestRaw));

      const parsed: ParsedManifest = JSON.parse(manifestRaw);
      const reelhouse = parsed.databases.reelhouse;
      const catalog = parsed.databases.media_catalog;
      assert.equal(tableOf(reelhouse, "household_profile").rowCount, 1);
      assert.equal(tableOf(reelhouse, "favorite").rowCount, 1);
      assert.equal(tableOf(reelhouse, "watch_state").rowCount, 1);
      assert.ok(reelhouse.freshness.latestUpdatedAt, "reelhouse freshness must carry an updated_at probe");
      assert.equal(tableOf(catalog, "catalog_item").rowCount, 2);
      assert.ok(catalog.freshness.lastSuccessfulScanAt, "catalog freshness must carry the last successful scan");
      assert.ok(catalog.migrations.length >= 3);
      assert.ok(!manifestRaw.includes(SECRET_PAIR), "manifest must never carry credentials");

      for (const table of [...reelhouse.tables, ...catalog.tables]) {
        const content = await readFile(join(backup.dir, table.file), "utf8");
        assert.equal(content.split("\n").filter((line) => line !== "").length, table.rowCount, table.file);
      }
      // bigint survives as text so int8 values round-trip exactly.
      const watchState = await readFile(
        join(backup.dir, tableFilePath("reelhouse", 12, "watch_state")),
        "utf8"
      );
      assert.match(watchState, /"position_ticks":"123456789012"/);
      assert.equal(result.manifestSha256, sidecar);
    } finally {
      await backup.cleanup();
    }
  });

  it("is deterministic: two snapshots of unchanged content agree on every checksum", async () => {
    await seedReelhouse();
    await seedCatalog();
    const first = await takeBackup("det1");
    const second = await takeBackup("det2");
    try {
      const a = tableChecksumsFromManifest(await readManifestRaw(first.dir));
      const b = tableChecksumsFromManifest(await readManifestRaw(second.dir));
      assert.equal(a.size, b.size);
      for (const [id, tables] of a) {
        const other = b.get(id);
        assert.ok(other, `missing database ${id} in second snapshot`);
        assert.deepEqual(
          [...tables.entries()].map(([name, facts]) => [name, facts.sha256]),
          [...(other?.entries() ?? [])].map(([name, facts]) => [name, facts.sha256])
        );
      }
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("backs up an empty database without inventing rows", async () => {
    const backup = await takeBackup("empty");
    try {
      const offline = await verifyBackupFiles({ backupDir: backup.dir, maxAgeHours: 168 });
      assert.deepEqual(offline.problems, []);
      const parsed = await readParsedManifest(backup.dir);
      for (const table of parsed.databases.reelhouse.tables) assert.equal(table.rowCount, 0);
    } finally {
      await backup.cleanup();
    }
  });

  it("refuses to overwrite a non-empty output directory", async () => {
    const backup = await takeBackup("refuse");
    try {
      await assert.rejects(
        () =>
          runBackup({
            databases: [{ id: "reelhouse", databaseUrl: REELHOUSE_DATABASE_URL }],
            outDir: backup.dir
          }),
        /not empty/
      );
    } finally {
      await backup.cleanup();
    }
  });
});

describe("restore verification", () => {
  it("restores both databases into a scratch and proves checksums end to end", async () => {
    await seedReelhouse();
    await seedCatalog();
    const backup = await takeBackup("e2e");
    try {
      const report = await restoreVerify({
        backupDir: backup.dir,
        scratchUrl: SCRATCH_DATABASE_URL,
        migrationsDirs: MIGRATIONS_DIRS,
        maxAgeHours: 168
      });
      const problemText = [...report.offline.problems, ...report.databases.flatMap((db) => db.problems)]
        .map((p) => p.message)
        .join("; ");
      assert.equal(report.ok, true, problemText || "restore reported failure without problems");
      assert.equal(report.databases.length, 2);
      assert.ok(report.databases.every((db) => db.ok), report.databases.flatMap((db) => db.problems).map((p) => p.message).join("; "));
      assert.equal(report.scratchDropped, true);
      assert.equal(await databaseExists("rh_restore_check_inttest"), false, "scratch must be dropped after success");
    } finally {
      await backup.cleanup();
    }
  });

  it("fails offline on a tampered data file without touching any database", async () => {
    await seedReelhouse();
    const backup = await takeBackup("tamper-file");
    try {
      const parsed = await readParsedManifest(backup.dir);
      const favorite = tableOf(parsed.databases.reelhouse, "favorite");
      const file = join(backup.dir, favorite.file);
      const original = await readFile(file, "utf8");
      const line = original.split("\n")[0];
      const doctored = original.replace(line, line.replace(/"created_at":"[^"]*"/, '"created_at":"2000-01-01T00:00:00.000Z"'));
      assert.notEqual(doctored, original, "fixture must actually change the file");
      await writeFile(file, doctored, "utf8");

      const offline = await verifyBackupFiles({ backupDir: backup.dir, maxAgeHours: 168 });
      assert.ok(offline.problems.some((p) => p.kind === "checksum" && p.database === "reelhouse" && p.table === "favorite"));

      const report = await restoreVerify({
        backupDir: backup.dir,
        scratchUrl: SCRATCH_DATABASE_URL,
        migrationsDirs: MIGRATIONS_DIRS,
        maxAgeHours: 168
      });
      assert.equal(report.ok, false);
      assert.equal(report.scratchDatabase, null, "a failed offline check must never create a scratch database");
      assert.equal(await databaseExists("rh_restore_check_inttest"), false);
    } finally {
      await backup.cleanup();
    }
  });

  it("fails closed on an edited manifest via the checksum sidecar", async () => {
    await seedReelhouse();
    const backup = await takeBackup("tamper-manifest");
    try {
      const manifest = await readParsedManifest(backup.dir);
      tableOf(manifest.databases.reelhouse, "favorite").rowCount = 999;
      const json = JSON.stringify(manifest, null, 2) + "\n";
      await writeFile(join(backup.dir, BACKUP_PATHS.manifest), json, "utf8");
      // Sidecar intentionally NOT updated: an edit without re-signing is
      // the common corruption case.
      const offline = await verifyBackupFiles({ backupDir: backup.dir, maxAgeHours: 168 });
      assert.ok(offline.problems.some((p) => p.kind === "manifest" && p.message.includes("checksum mismatch")));
    } finally {
      await backup.cleanup();
    }
  });

  it("fails closed on a stale backup before creating a scratch database", async () => {
    await seedReelhouse();
    const backup = await takeBackup("stale");
    try {
      const manifestRaw = await readManifestRaw(backup.dir);
      const createdAt = JSON.parse(manifestRaw).createdAt;
      const later = new Date(Date.parse(createdAt) + 3 * 3_600_000);

      const offline = await verifyBackupFiles({ backupDir: backup.dir, maxAgeHours: 1, now: () => later });
      assert.ok(offline.problems.some((p) => p.kind === "stale"));
      assert.equal(offline.stale, true);

      const report = await restoreVerify({
        backupDir: backup.dir,
        scratchUrl: SCRATCH_DATABASE_URL,
        migrationsDirs: MIGRATIONS_DIRS,
        maxAgeHours: 1,
        now: () => later
      });
      assert.equal(report.ok, false);
      assert.equal(report.scratchDatabase, null);
      assert.equal(await databaseExists("rh_restore_check_inttest"), false);
    } finally {
      await backup.cleanup();
    }
  });

  it("fails the load on duplicate primary keys and rolls the table back", async () => {
    await seedReelhouse();
    const backup = await takeBackup("duplicate");
    try {
      // Forge a fully self-consistent backup whose favorite file carries the
      // same row twice: recomputed checksum, recomputed manifest, re-signed
      // sidecar. Offline verification passes; the database must refuse it.
      const manifest = await readParsedManifest(backup.dir);
      const favorite = tableOf(manifest.databases.reelhouse, "favorite");
      const file = join(backup.dir, favorite.file);
      const original = await readFile(file, "utf8");
      const line = original.split("\n").filter((entry) => entry !== "")[0];
      const duplicated = line + "\n" + line + "\n";
      await writeFile(file, duplicated, "utf8");
      favorite.rowCount = 2;
      favorite.sha256 = sha256Hex(duplicated);
      await rewriteManifest(backup.dir, manifest);

      const offline = await verifyBackupFiles({ backupDir: backup.dir, maxAgeHours: 168 });
      assert.deepEqual(offline.problems, [], "the forged backup must be internally consistent");

      const report = await restoreVerify({
        backupDir: backup.dir,
        scratchUrl: SCRATCH_DATABASE_URL,
        migrationsDirs: MIGRATIONS_DIRS,
        maxAgeHours: 168
      });
      assert.equal(report.ok, false);
      const reelhouse = report.databases.find((db) => db.id === "reelhouse");
      assert.ok(reelhouse && !reelhouse.ok);
      assert.ok(
        reelhouse.problems.some((p) => p.kind === "restore" && /duplicate|unique/i.test(p.message)),
        reelhouse?.problems.map((p) => p.message).join("; ")
      );
      assert.equal(report.scratchDropped, true, "scratch is dropped after a failed verification by default");
      assert.equal(await databaseExists("rh_restore_check_inttest"), false);
    } finally {
      await backup.cleanup();
    }
  });

  it("fails closed when the backup predates a local migration", async () => {
    await seedReelhouse();
    const backup = await takeBackup("drift");
    try {
      const manifest = await readParsedManifest(backup.dir);
      manifest.databases.reelhouse.migrations = manifest.databases.reelhouse.migrations.slice(0, -1);
      await rewriteManifest(backup.dir, manifest);

      const report = await restoreVerify({
        backupDir: backup.dir,
        scratchUrl: SCRATCH_DATABASE_URL,
        migrationsDirs: MIGRATIONS_DIRS,
        maxAgeHours: 168
      });
      assert.equal(report.ok, false);
      assert.equal(report.scratchDatabase, null, "migration drift must be caught before any database is created");
      assert.ok(
        report.offline.problems.some((p) => p.kind === "migration_set" && p.database === "reelhouse"),
        report.offline.problems.map((p) => p.message).join("; ")
      );
    } finally {
      await backup.cleanup();
    }
  });

  it("refuses scratch URLs that do not name a disposable rh_restore_ database", async () => {
    await seedReelhouse();
    const backup = await takeBackup("guard");
    try {
      await assert.rejects(
        () =>
          restoreVerify({
            backupDir: backup.dir,
            scratchUrl: REELHOUSE_DATABASE_URL,
            migrationsDirs: MIGRATIONS_DIRS,
            maxAgeHours: 168
          }),
        /rh_restore/
      );
      assert.equal(await databaseExists("reelhouse_backup_reelhouse"), true, "the mis-targeted database must be untouched");
    } finally {
      await backup.cleanup();
    }
  });
});

describe("disaster recovery drill", () => {
  it("rebuilds a restored catalog from Jellyfin instead of trusting the backup", async () => {
    await seedCatalog();
    const backup = await takeBackup("resync");
    try {
      const report = await restoreVerify({
        backupDir: backup.dir,
        scratchUrl: SCRATCH_DATABASE_URL,
        only: ["media_catalog"],
        migrationsDirs: MIGRATIONS_DIRS,
        maxAgeHours: 168,
        keepScratchOnSuccess: true
      });
      assert.equal(report.ok, true);
      assert.equal(report.scratchDropped, false, "the scratch is kept on request for follow-on drills");

      // The DR-relevant property: the catalog is REBUILDABLE. Wipe the
      // restored copy back to an empty database and re-sync from the fixture
      // Jellyfin — with changed content — proving recovery comes from the
      // source of truth, not from a potentially stale backup.
      await withClient(SCRATCH_DATABASE_URL, async (client) => {
        await client.query(`TRUNCATE catalog_library, catalog_item, catalog_provider_id,
          catalog_genre, catalog_studio, catalog_person,
          catalog_item_genre, catalog_item_studio, catalog_item_person,
          catalog_scan, catalog_sync_state, catalog_quarantine CASCADE`);
      });
      const status = await runCatalogSyncOn(SCRATCH_DATABASE_URL, "rebuild", fixtureJellyfin("Renamed After Recovery"));
      assert.equal(status, "succeeded");
      await withClient(SCRATCH_DATABASE_URL, async (client) => {
        const items = await client.query<{ name: string }>("SELECT name FROM catalog_item ORDER BY name");
        assert.deepEqual(items.rows.map((row) => row.name), ["One Fine Feature", "Renamed After Recovery"]);
      });
    } finally {
      await dropDatabase("rh_restore_check_inttest");
      await backup.cleanup();
    }
  });

  it("keeps the scratch database on failure when asked, for forensics", async () => {
    await seedReelhouse();
    const backup = await takeBackup("keep");
    try {
      // Forge a load-time failure (duplicate primary key) from an
      // internally consistent backup, then ask for the scratch to be kept.
      const manifest = await readParsedManifest(backup.dir);
      const favorite = tableOf(manifest.databases.reelhouse, "favorite");
      const file = join(backup.dir, favorite.file);
      const original = await readFile(file, "utf8");
      const line = original.split("\n").filter((entry) => entry !== "")[0];
      const duplicated = line + "\n" + line + "\n";
      await writeFile(file, duplicated, "utf8");
      favorite.rowCount = 2;
      favorite.sha256 = sha256Hex(duplicated);
      await rewriteManifest(backup.dir, manifest);

      const report = await restoreVerify({
        backupDir: backup.dir,
        scratchUrl: SCRATCH_DATABASE_URL,
        migrationsDirs: MIGRATIONS_DIRS,
        maxAgeHours: 168,
        keepScratchOnFailure: true
      });
      assert.equal(report.ok, false);
      assert.equal(report.scratchDropped, false, "keep-on-failure must retain the scratch for inspection");
      assert.equal(await databaseExists("rh_restore_check_inttest"), true);
    } finally {
      await dropDatabase("rh_restore_check_inttest");
      await backup.cleanup();
    }
  });
});
