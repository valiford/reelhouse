// Deterministic PostgreSQL integration evidence for RH-0037: household
// backup, verified restore, catalog rebuild, and DR staleness status.
//
// Runs against the disposable loopback PostgreSQL 18 profile — never
// against Synology, and never against a live Jellyfin. The catalog is
// seeded through the REAL full-sync runner with a scripted CatalogSource
// double, the household through the REAL import, so the DR paths are grown
// from what production actually holds:
//
//   REELHOUSE_TEST_MIGRATE_URL   owner/migrator role
//   REELHOUSE_TEST_DATABASE_URL  application role
//
// Scenarios: migration 0010 (ledger shapes and CHECK contracts under the
// least-privilege app role); backup capture with checksum evidence and
// idempotent content; the restore failure matrix (tampered bytes, corrupt
// envelope, unbound restore, dangling ledger binding, checksum mismatch
// against the ledger, zero-profile artifact) each failing closed with a
// recorded run row; a dry run that verifies and persists nothing; the
// capture → restore → capture round-trip proving the artifact is a
// complete, faithful household snapshot on a FRESH database; catalog
// rebuild from empty (verified, bound to its sync run), source-failure
// recording and recovery, and in-place idempotent resync; and dr status
// moving from a full greenfield verdict set to clean, then flagging stale
// data and stale backups.
//
// This file uses its own temporary databases so it cannot interfere with
// the sibling suites under `node --test`.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { loadDatabaseConfig, type DatabaseConfig } from "../db/config.ts";
import { loadMigrationFiles, runMigrations } from "../db/migrator.ts";
import { createPgSyncExecutor } from "../catalog/pg-executor.ts";
import { runFullCatalogSync } from "../catalog/sync.ts";
import type { CatalogItemsPage, CatalogLibrary, CatalogRawItem, CatalogSource } from "../catalog/source.ts";
import { normalizeManifest } from "../household/manifest.ts";
import { runHouseholdImport } from "../household/load.ts";
import { buildHouseholdArtifact, parseHouseholdArtifact, serializeArtifact, sha256Hex } from "./artifact.ts";
import { runHouseholdBackup } from "./backup.ts";
import { DrRestoreError, runHouseholdRestore } from "./restore.ts";
import { DrRebuildError, runCatalogRebuild } from "./rebuild.ts";
import { drStatus } from "./status.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const MAIN_DB = "reelhouse_rh0037_tmp";
const RESTORE_DB = "reelhouse_rh0037_restore_tmp";
const REBUILD_DB = "reelhouse_rh0037_rebuild_tmp";

const migrateEnv = process.env.REELHOUSE_TEST_MIGRATE_URL;
const appEnv = process.env.REELHOUSE_TEST_DATABASE_URL;

function configFrom(url: string): DatabaseConfig {
  const result = loadDatabaseConfig({ DATABASE_URL: url });
  if (result.kind !== "valid") throw new Error(`test URL invalid: ${"errors" in result ? result.errors.join("; ") : "blank"}`);
  return result.config;
}

const migrateBase = migrateEnv ? configFrom(migrateEnv) : undefined;
const appBase = appEnv ? configFrom(appEnv) : undefined;

function needsDb(t: { skip: (message?: string) => void }): { migrate: DatabaseConfig; app: DatabaseConfig } {
  if (!migrateBase || !appBase) {
    t.skip("REELHOUSE_TEST_MIGRATE_URL / REELHOUSE_TEST_DATABASE_URL not set (hermetic mode)");
    throw new Error("unreachable");
  }
  return { migrate: migrateBase, app: appBase };
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

function makePool(config: DatabaseConfig): Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: 2,
    connectionTimeoutMillis: config.connectionTimeoutMs
  });
}

// Fresh disposable database: reset to empty public schema, all migrations
// applied, app role able to connect. Returns an app-role pool.
async function freshDatabase(
  migrate: DatabaseConfig,
  app: DatabaseConfig,
  name: string
): Promise<Pool> {
  await withClient(migrate, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${name}`);
    await client.query(`GRANT CONNECT ON DATABASE ${name} TO ${app.user}`);
  });
  const target: DatabaseConfig = { ...migrate, database: name };
  await runMigrations(target, MIGRATIONS_DIR, app.user);
  return makePool({ ...app, database: name });
}

async function dropDatabase(migrate: DatabaseConfig, name: string): Promise<void> {
  await withClient(migrate, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });
}

// Deterministic catalog source double: libraries + raw items per library.
class SeedCatalogSource implements CatalogSource {
  readonly libraries: CatalogLibrary[];
  private readonly itemsByLibrary: Map<string, CatalogRawItem[]>;

  constructor(libraries: CatalogLibrary[], itemsByLibrary: Map<string, CatalogRawItem[]>) {
    this.libraries = libraries;
    this.itemsByLibrary = itemsByLibrary;
  }

  async listLibraries(): Promise<CatalogLibrary[]> {
    return this.libraries.map((library) => ({ ...library }));
  }

  async fetchItemsPage(libraryJellyfinId: string, startIndex: number, limit: number): Promise<CatalogItemsPage> {
    const items = this.itemsByLibrary.get(libraryJellyfinId) ?? [];
    return { items: items.slice(startIndex, startIndex + limit), totalRecordCount: items.length };
  }

  async fetchChangedItemsPage(
    libraryJellyfinId: string,
    _sinceIso: string,
    startIndex: number,
    limit: number
  ): Promise<CatalogItemsPage> {
    return this.fetchItemsPage(libraryJellyfinId, startIndex, limit);
  }

  async fetchLibraryItemIdsPage(
    libraryJellyfinId: string,
    startIndex: number,
    limit: number
  ): Promise<CatalogItemsPage> {
    return this.fetchItemsPage(libraryJellyfinId, startIndex, limit);
  }
}

// Every source call fails the way a dead Jellyfin does.
class FaultSource implements CatalogSource {
  async listLibraries(): Promise<CatalogLibrary[]> {
    throw new Error("Jellyfin answered HTTP 500 for /Library/MediaFolders");
  }
  async fetchItemsPage(): Promise<CatalogItemsPage> {
    throw new Error("Jellyfin answered HTTP 500 for /Items");
  }
  async fetchChangedItemsPage(): Promise<CatalogItemsPage> {
    throw new Error("Jellyfin answered HTTP 500 for /Items");
  }
  async fetchLibraryItemIdsPage(): Promise<CatalogItemsPage> {
    throw new Error("Jellyfin answered HTTP 500 for /Items");
  }
}

// In-memory artifact sink: the backup core never touches the filesystem.
function memorySink(): {
  files: Map<string, string>;
  sink: (filename: string, content: string) => Promise<{ path: string; bytes: number }>;
} {
  const files = new Map<string, string>();
  return {
    files,
    sink: async (filename, content) => {
      files.set(filename, content);
      return { path: `memory://${filename}`, bytes: Buffer.byteLength(content, "utf8") };
    }
  };
}

const FIXED_CLOCK = () => new Date("2026-06-01T12:00:00.000Z");

// A rich raw household fixture: two profiles (one default, one linked),
// preferences, favorites, a watchlist, home rows, watch state, history, and
// a shared collection.
function householdFixture(): unknown {
  return {
    profiles: [
      {
        name: "Kai",
        initials: "K",
        isDefault: true,
        jellyfinUserId: "jf-user-kai",
        preferences: { theme: "dark", autoplay_next: true },
        favorites: [
          { jellyfinId: "mov-arrival", addedAt: "2026-05-01T00:00:00.000Z" },
          { jellyfinId: "mov-citizen", addedAt: "2026-05-02T06:30:00.000Z" }
        ],
        watchlists: [
          {
            name: "Movie Night",
            entries: [{ jellyfinId: "mov-citizen" }, { jellyfinId: "mov-arrival", addedAt: "2026-05-03T00:00:00.000Z" }]
          }
        ],
        homeRows: [
          { kind: "continue_watching", title: "Continue Watching" },
          { kind: "favorites", title: "Kai's Favorites", enabled: false }
        ],
        watchState: [
          {
            jellyfinId: "mov-arrival",
            positionTicks: 1200000,
            durationTicks: 5400000,
            completed: false,
            hiddenFromContinue: false,
            firstPlayedAt: "2026-05-04T20:00:00.000Z",
            lastPlayedAt: "2026-05-04T20:40:00.000Z"
          },
          {
            jellyfinId: "mov-citizen",
            positionTicks: null,
            durationTicks: null,
            completed: true,
            hiddenFromContinue: true,
            firstPlayedAt: "2026-05-05T21:00:00.000Z",
            lastPlayedAt: "2026-05-05T23:00:00.000Z"
          }
        ],
        playbackHistory: [
          {
            jellyfinId: "mov-arrival",
            playedAt: "2026-05-04T20:00:00.000Z",
            positionTicks: 1200000,
            durationTicks: 5400000,
            completed: false
          },
          {
            jellyfinId: "mov-citizen",
            playedAt: "2026-05-05T21:00:00.000Z",
            positionTicks: null,
            durationTicks: null,
            completed: true
          }
        ]
      },
      {
        name: "River",
        preferences: { reduced_motion: false, preferred_subtitle_language: "en" },
        favorites: [],
        watchlists: [],
        homeRows: [{ kind: "recently_added", title: "Just Added" }],
        watchState: [],
        playbackHistory: []
      }
    ],
    collections: [
      {
        name: "Family Picks",
        description: "Approved for everyone",
        entries: [{ jellyfinId: "mov-arrival" }]
      }
    ]
  };
}

// Simple raw movie items the sync can normalize (same shape the stub uses).
function movieItem(id: string, name: string, savedAt: string): CatalogRawItem {
  return {
    Id: id,
    Name: name,
    Type: "Movie",
    DateLastSaved: savedAt,
    ProductionYear: 2016,
    PremiereDate: "2016-11-10T00:00:00.000Z",
    RunTimeTicks: 1_830_000_000,
    SortName: name.toLowerCase(),
    Genres: ["Drama"],
    ProviderIds: { Imdb: `tt-${id}` },
    MediaSources: [],
    Etag: `etag-${id}`,
    DateCreated: "2023-05-01T12:00:00.000Z"
  };
}

const SAVED = "2025-01-01T00:00:00.000Z";

async function seedCatalogAndHousehold(pool: Pool): Promise<void> {
  const executor = createPgSyncExecutor(pool);
  await runFullCatalogSync(
    new SeedCatalogSource(
      [{ jellyfinId: "lib-movies", name: "Movies", collectionType: "movies" }],
      new Map([["lib-movies", [movieItem("mov-arrival", "Arrival", SAVED), movieItem("mov-citizen", "Citizen Kane", SAVED)]]])
    ),
    executor,
    { clock: FIXED_CLOCK }
  );
  await runHouseholdImport(normalizeManifest(householdFixture()), executor, { clock: FIXED_CLOCK });
}

test("migration 0010 creates the DR ledgers and enforces their contracts", async (t) => {
  const { migrate, app } = needsDb(t);
  // Own temporary database: the sibling suites reset the SHARED profile's
  // public schema concurrently, so nothing here may depend on it.
  const pool = await freshDatabase(migrate, app, MAIN_DB);
  try {
    await withClient({ ...app, database: MAIN_DB }, async (client) => {
      // The whole history applies on a fresh database, 0010 included.
      const applied = await client.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version"
      );
      assert.ok(applied.rows.some((row) => row.version === 10), "migration 0010 applies");

      // The least-privilege application role can append to every ledger.
      const backup = await client.query<{ id: string }>(
        "INSERT INTO dr_backup_runs (scope) VALUES ('household') RETURNING id"
      );
      const restore = await client.query<{ id: string }>(
        "INSERT INTO dr_restore_runs (scope, dry_run) VALUES ('household', FALSE) RETURNING id"
      );
      const rebuild = await client.query<{ id: string }>(
        "INSERT INTO dr_rebuild_runs (mode) VALUES ('full_resync') RETURNING id"
      );

      // Status and finished_at move together.
      await assert.rejects(
        client.query("UPDATE dr_backup_runs SET status = 'failed' WHERE id = $1", [backup.rows[0].id]),
        /dr_backup_runs_finished_check/
      );
      await assert.rejects(
        client.query("UPDATE dr_restore_runs SET status = 'succeeded', finished_at = now() WHERE id = $1", [restore.rows[0].id]),
        /dr_restore_runs_checksum_check/
      );
      await assert.rejects(
        client.query(
          "UPDATE dr_rebuild_runs SET status = 'succeeded', finished_at = now(), verified = TRUE WHERE id = $1",
          [rebuild.rows[0].id]
        ),
        /dr_rebuild_runs_sync_check/
      );

      // A succeeded backup carries the full artifact record — or fails.
      await assert.rejects(
        client.query(
          "UPDATE dr_backup_runs SET status = 'succeeded', finished_at = now() WHERE id = $1",
          [backup.rows[0].id]
        ),
        /dr_backup_runs_artifact_check/
      );
      await assert.rejects(
        client.query(
          `UPDATE dr_backup_runs SET status = 'succeeded', finished_at = now(),
             artifact_path = 'x', artifact_sha256 = 'nothex', manifest_sha256 = $2, artifact_bytes = 1
           WHERE id = $1`,
          [backup.rows[0].id, "a".repeat(64)]
        ),
        /dr_backup_runs_sha256_format_check/
      );

      // Closed scopes and modes.
      await assert.rejects(
        client.query("INSERT INTO dr_backup_runs (scope) VALUES ('catalog')"),
        /dr_backup_runs_scope_check/
      );
      await assert.rejects(
        client.query("INSERT INTO dr_rebuild_runs (mode) VALUES ('truncate')"),
        /dr_rebuild_runs_mode_check/
      );

      for (const [table, id] of [
        ["dr_backup_runs", backup.rows[0].id],
        ["dr_restore_runs", restore.rows[0].id],
        ["dr_rebuild_runs", rebuild.rows[0].id]
      ] as const) {
        await client.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      }
    });
  } finally {
    await pool.end();
    await dropDatabase(migrate, MAIN_DB);
  }
});

test("household backup captures active state with checksummed evidence and idempotent content", async (t) => {
  const { migrate, app } = needsDb(t);
  const pool = await freshDatabase(migrate, app, MAIN_DB);
  try {
    await seedCatalogAndHousehold(pool);
    const executor = createPgSyncExecutor(pool);

    const first = memorySink();
    const backup = await runHouseholdBackup(executor, { clock: FIXED_CLOCK, sink: first.sink });
    assert.equal(backup.status, "succeeded");
    assert.equal(backup.artifactFilename, "reelhouse-household-20260601T120000Z.json");
    assert.equal(backup.artifactSha256, sha256Hex(first.files.get(backup.artifactFilename) ?? ""));
    assert.ok(backup.manifestSha256.match(/^[0-9a-f]{64}$/));
    assert.equal(backup.counts.profiles, 2);
    assert.equal(backup.counts.preferences, 4);
    assert.equal(backup.counts.jellyfinAccounts, 1);
    assert.equal(backup.counts.favorites, 2);
    assert.equal(backup.counts.watchlists, 1);
    assert.equal(backup.counts.watchlistEntries, 2);
    assert.equal(backup.counts.collections, 1);
    assert.equal(backup.counts.collectionEntries, 1);
    assert.equal(backup.counts.homeRows, 3);
    assert.equal(backup.counts.watchState, 2);
    assert.equal(backup.counts.history, 2);
    assert.equal(backup.rowsCaptured, 2 + 4 + 1 + 2 + 1 + 2 + 1 + 1 + 3 + 2 + 2);

    // Ledger evidence: one succeeded row with both checksums and counts.
    const ledger = await pool.query<{ artifact_sha256: string; manifest_sha256: string; rows_captured: number; counts: Record<string, number> }>(
      "SELECT artifact_sha256, manifest_sha256, rows_captured, counts FROM dr_backup_runs WHERE id = $1",
      [backup.runId]
    );
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0].artifact_sha256, backup.artifactSha256);
    assert.equal(ledger.rows[0].manifest_sha256, backup.manifestSha256);
    assert.equal(ledger.rows[0].rows_captured, backup.rowsCaptured);
    assert.equal(ledger.rows[0].counts.profiles, 2);

    // Backing up an unchanged household again: new run row, byte-identical
    // artifact (the injected clock pins created_at too).
    const second = memorySink();
    const again = await runHouseholdBackup(executor, { clock: FIXED_CLOCK, sink: second.sink });
    assert.notEqual(again.runId, backup.runId);
    assert.equal(again.manifestSha256, backup.manifestSha256);
    assert.equal(
      second.files.get(again.artifactFilename),
      first.files.get(backup.artifactFilename),
      "unchanged state backs up to byte-identical artifact content"
    );

    // The captured manifest satisfies the household contract, and the
    // artifact content round-trips through the artifact layer untouched
    // (it stores the input shape a restore can load directly).
    assert.doesNotThrow(() => normalizeManifest(backup.manifest));
    const reparsed = parseHouseholdArtifact(first.files.get(backup.artifactFilename) ?? "");
    assert.deepEqual(reparsed.manifest, backup.manifest);
    assert.equal(reparsed.manifest_sha256, backup.manifestSha256);
  } finally {
    await pool.end();
    await dropDatabase(migrate, MAIN_DB);
  }
});

test("the restore failure matrix fails closed and records evidence", async (t) => {
  const { migrate, app } = needsDb(t);
  const pool = await freshDatabase(migrate, app, MAIN_DB);
  try {
    await seedCatalogAndHousehold(pool);
    const executor = createPgSyncExecutor(pool);
    const sink = memorySink();
    const backup = await runHouseholdBackup(executor, { clock: FIXED_CLOCK, sink: sink.sink });
    const bytes = sink.files.get(backup.artifactFilename) ?? "";
    const before = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM household_sync_runs"
    );

    // (1) Tampered bytes vs the recorded checksum: refused.
    const tampered = bytes.replace("Kai", "Kay");
    assert.notEqual(tampered, bytes);
    await assert.rejects(
      runHouseholdRestore(executor, {
        bytes: tampered,
        artifactPath: "tampered.json",
        expectedSha256: backup.artifactSha256
      }),
      (error: DrRestoreError) => {
        assert.match(error.summary.errorDetail, /do not match the expected checksum/);
        return true;
      }
    );

    // (2) Corrupt envelope with a stale embedded checksum: refused before
    //     any import, even in dry-run mode.
    const corrupted = bytes.replace('"isDefault":true', '"isDefault":false');
    await assert.rejects(
      runHouseholdRestore(executor, { bytes: corrupted, dryRun: true }),
      (error: DrRestoreError) => {
        assert.match(error.summary.errorDetail, /manifest checksum mismatch/);
        return true;
      }
    );

    // (3) A real restore without any binding is refused outright.
    await assert.rejects(
      runHouseholdRestore(executor, { bytes }),
      (error: DrRestoreError) => {
        assert.match(error.summary.errorDetail, /refusing to import an unbound artifact/);
        return true;
      }
    );

    // (4) A ledger binding that points nowhere is refused.
    await assert.rejects(
      runHouseholdRestore(executor, { bytes, backupRunId: 999999 }),
      (error: DrRestoreError) => {
        assert.match(error.summary.errorDetail, /binding points nowhere/);
        return true;
      }
    );

    // (5) A ledger binding against different bytes is refused. The tamper
    //     is OUTSIDE the manifest (created_at), so the envelope stays
    //     internally consistent — this is exactly the case the ledger's
    //     file checksum exists to catch.
    const restamped = bytes.replace(
      '"created_at":"2026-06-01T12:00:00.000Z"',
      '"created_at":"2026-06-01T13:00:00.000Z"'
    );
    assert.notEqual(restamped, bytes);
    await assert.rejects(
      runHouseholdRestore(executor, { bytes: restamped, backupRunId: backup.runId }),
      (error: DrRestoreError) => {
        assert.match(error.summary.errorDetail, /does not match backup run #/);
        return true;
      }
    );

    // (6) A checksum-consistent artifact around a zero-profile manifest
    //     passes verification and is refused by the import's own guard.
    const zero = serializeArtifact(buildHouseholdArtifact({ profiles: [], collections: [] }, FIXED_CLOCK().toISOString()));
    await assert.rejects(
      runHouseholdRestore(executor, { bytes: zero, dryRun: true }),
      (error: DrRestoreError) => {
        assert.match(error.summary.errorDetail, /household import failed:/);
        assert.match(error.summary.errorDetail, /no profiles/);
        return true;
      }
    );

    // Every failure is on the ledger: six failed restore rows, and the
    // household itself untouched (no import run rows, no state changes).
    const ledger = await pool.query<{ status: string; error_detail: string | null }>(
      "SELECT status, error_detail FROM dr_restore_runs ORDER BY id"
    );
    assert.equal(ledger.rows.length, 6);
    assert.ok(ledger.rows.every((row) => row.status === "failed"));
    assert.ok(ledger.rows.every((row) => row.error_detail !== null));
    const after = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM household_sync_runs"
    );
    assert.equal(after.rows[0].count, before.rows[0].count);
    const profiles = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM household_profiles WHERE archived_at IS NULL"
    );
    assert.equal(Number(profiles.rows[0].count), 2);

    // Recovery: the SAME executor accepts the honest artifact immediately.
    const good = await runHouseholdRestore(executor, {
      bytes,
      expectedSha256: backup.artifactSha256,
      clock: FIXED_CLOCK
    });
    assert.equal(good.status, "succeeded");
  } finally {
    await pool.end();
    await dropDatabase(migrate, MAIN_DB);
  }
});

test("a dry run verifies the artifact and persists nothing but its own evidence", async (t) => {
  const { migrate, app } = needsDb(t);
  const pool = await freshDatabase(migrate, app, RESTORE_DB);
  try {
    const executor = createPgSyncExecutor(pool);
    // Build the artifact without a database: envelope + raw fixture
    // manifest (the artifact stores the input shape).
    const bytes = serializeArtifact(buildHouseholdArtifact(householdFixture(), FIXED_CLOCK().toISOString()));

    const profilesBefore = await pool.query<{ count: string }>("SELECT count(*) AS count FROM household_profiles");
    const runsBefore = await pool.query<{ count: string }>("SELECT count(*) AS count FROM household_sync_runs");

    const dry = await runHouseholdRestore(executor, {
      bytes,
      artifactPath: "fixture.json",
      dryRun: true,
      clock: FIXED_CLOCK
    });
    assert.equal(dry.status, "succeeded");
    assert.equal(dry.dryRun, true);
    assert.ok(dry.rowsImported > 0, "the replay reports what a real restore would write");

    const profilesAfter = await pool.query<{ count: string }>("SELECT count(*) AS count FROM household_profiles");
    const runsAfter = await pool.query<{ count: string }>("SELECT count(*) AS count FROM household_sync_runs");
    assert.equal(profilesAfter.rows[0].count, profilesBefore.rows[0].count);
    assert.equal(runsAfter.rows[0].count, runsBefore.rows[0].count);

    const ledger = await pool.query<{ dry_run: boolean; checksum_verified: boolean; rows_imported: number }>(
      "SELECT dry_run, checksum_verified, rows_imported FROM dr_restore_runs ORDER BY id DESC LIMIT 1"
    );
    assert.equal(ledger.rows[0].dry_run, true);
    assert.equal(ledger.rows[0].checksum_verified, true);
    assert.equal(ledger.rows[0].rows_imported, dry.rowsImported);
  } finally {
    await pool.end();
    await dropDatabase(migrate, RESTORE_DB);
  }
});

test("capture → restore → capture round-trips the identical manifest onto a fresh database", async (t) => {
  const { migrate, app } = needsDb(t);
  const mainPool = await freshDatabase(migrate, app, MAIN_DB);
  try {
    await seedCatalogAndHousehold(mainPool);
    const mainExecutor = createPgSyncExecutor(mainPool);
    const sink = memorySink();
    const backup = await runHouseholdBackup(mainExecutor, { clock: FIXED_CLOCK, sink: sink.sink });
    const bytes = sink.files.get(backup.artifactFilename) ?? "";

    // The DR scenario: a database lost entirely. The only evidence that
    // survives is the operator's recorded file checksum.
    const restorePool = await freshDatabase(migrate, app, RESTORE_DB);
    try {
      const restoreExecutor = createPgSyncExecutor(restorePool);
      const restore = await runHouseholdRestore(restoreExecutor, {
        bytes,
        artifactPath: `memory://${backup.artifactFilename}`,
        expectedSha256: backup.artifactSha256,
        clock: FIXED_CLOCK
      });
      assert.equal(restore.status, "succeeded");
      assert.equal(restore.dryRun, false);
      assert.equal(restore.manifestSha256, backup.manifestSha256);

      // The restored database captures to the identical snapshot.
      const recaptured = await runHouseholdBackup(restoreExecutor, { clock: FIXED_CLOCK, sink: memorySink().sink });
      assert.equal(recaptured.manifestSha256, backup.manifestSha256);
      assert.deepEqual(recaptured.manifest, backup.manifest);
      assert.deepEqual(recaptured.counts, backup.counts);

      // A SECOND restore of the same artifact is a no-op (idempotent
      // loader): it succeeds with zero writes.
      const again = await runHouseholdRestore(restoreExecutor, {
        bytes,
        expectedSha256: backup.artifactSha256,
        clock: FIXED_CLOCK
      });
      assert.equal(again.status, "succeeded");
      assert.equal(again.rowsImported, 0);
    } finally {
      await restorePool.end();
      await dropDatabase(migrate, RESTORE_DB);
    }
  } finally {
    await mainPool.end();
    await dropDatabase(migrate, MAIN_DB);
  }
});

test("catalog rebuild converges from empty, records source failures, and recovers", async (t) => {
  const { migrate, app } = needsDb(t);
  const pool = await freshDatabase(migrate, app, REBUILD_DB);
  try {
    const executor = createPgSyncExecutor(pool);
    const source = new SeedCatalogSource(
      [
        { jellyfinId: "lib-movies", name: "Movies", collectionType: "movies" },
        { jellyfinId: "lib-tv", name: "TV Shows", collectionType: "tvshows" }
      ],
      new Map([
        ["lib-movies", [movieItem("mov-arrival", "Arrival", SAVED), movieItem("mov-citizen", "Citizen Kane", SAVED)]],
        ["lib-tv", [movieItem("ep-pilot", "Pilot", SAVED)]]
      ])
    );

    // A dead source fails the rebuild, and the failure is on the record:
    // the rebuild row (bound to the sync run it attempted) and the sync's
    // own failed run row.
    await assert.rejects(
      runCatalogRebuild(new FaultSource(), executor, { clock: FIXED_CLOCK }),
      (error: DrRebuildError) => {
        assert.match(error.summary.errorDetail, /catalog sync failed:/);
        return true;
      }
    );
    const failed = await pool.query<{ status: string; error_detail: string | null; sync_run_id: string | null }>(
      "SELECT status, error_detail, sync_run_id FROM dr_rebuild_runs ORDER BY id DESC LIMIT 1"
    );
    assert.equal(failed.rows[0].status, "failed");
    assert.match(failed.rows[0].error_detail ?? "", /HTTP 500/);
    assert.notEqual(failed.rows[0].sync_run_id, null);
    const syncFailed = await pool.query<{ status: string }>(
      "SELECT status FROM media_sync_runs WHERE id = $1",
      [failed.rows[0].sync_run_id]
    );
    assert.equal(syncFailed.rows[0].status, "failed");

    // Recovery: the source comes back and the rebuild converges from
    // empty, verified against what the source reported.
    const rebuild = await runCatalogRebuild(source, executor, { clock: FIXED_CLOCK });
    assert.equal(rebuild.status, "succeeded");
    assert.equal(rebuild.verified, true);
    assert.equal(rebuild.librariesCount, 2);
    assert.equal(rebuild.itemsCount, 3);
    const succeeded = await pool.query<{ status: string; sync_run_id: string; verified: boolean }>(
      "SELECT status, sync_run_id, verified FROM dr_rebuild_runs ORDER BY id DESC LIMIT 1"
    );
    assert.equal(succeeded.rows[0].status, "succeeded");
    assert.equal(succeeded.rows[0].verified, true);
    assert.equal(Number(succeeded.rows[0].sync_run_id), rebuild.syncRunId);

    // An in-place resync over an unchanged source stays converged: same
    // item count, no duplication.
    const again = await runCatalogRebuild(source, executor, { clock: FIXED_CLOCK });
    assert.equal(again.status, "succeeded");
    assert.equal(again.itemsCount, rebuild.itemsCount);
    assert.notEqual(again.runId, rebuild.runId);
  } finally {
    await pool.end();
    await dropDatabase(migrate, REBUILD_DB);
  }
});

test("dr status moves from greenfield verdicts to clean, then flags stale data", async (t) => {
  const { migrate, app } = needsDb(t);
  const pool = await freshDatabase(migrate, app, MAIN_DB);
  try {
    const executor = createPgSyncExecutor(pool);
    // Greenfield: every recovery question is outstanding.
    const greenfield = await drStatus(executor, { now: FIXED_CLOCK() });
    assert.deepEqual(greenfield.verdicts, [
      "catalog_never_synced",
      "household_never_imported",
      "household_backup_missing",
      "restore_never_rehearsed",
      "catalog_rebuild_never_rehearsed"
    ]);

    await seedCatalogAndHousehold(pool);
    const sink = memorySink();
    const backup = await runHouseholdBackup(executor, { clock: FIXED_CLOCK, sink: sink.sink });
    const bytes = sink.files.get(backup.artifactFilename) ?? "";
    await runHouseholdRestore(executor, { bytes, expectedSha256: backup.artifactSha256, clock: FIXED_CLOCK });
    await runCatalogRebuild(
      new SeedCatalogSource(
        [{ jellyfinId: "lib-movies", name: "Movies", collectionType: "movies" }],
        new Map([["lib-movies", [movieItem("mov-arrival", "Arrival", SAVED), movieItem("mov-citizen", "Citizen Kane", SAVED)]]])
      ),
      executor,
      { clock: FIXED_CLOCK }
    );

    // Everything rehearsed and fresh: no verdicts.
    const clean = await drStatus(executor, { now: new Date() });
    assert.deepEqual(clean.verdicts, []);
    assert.equal(clean.backup.state, "fresh");
    assert.equal(clean.backup.runId, backup.runId);
    assert.equal(clean.backup.manifestSha256, backup.manifestSha256);
    assert.equal(clean.lastRestore?.status, "succeeded");
    assert.equal(clean.lastRestore?.dryRun, false);
    assert.equal(clean.lastRebuild?.status, "succeeded");
    assert.equal(clean.lastRebuild?.verified, true);
    assert.equal(clean.catalog.state, "fresh");
    assert.equal(clean.household.state, "fresh");

    // Eight days later with nothing re-run: data and backup staleness are
    // both flagged (the 24h catalog window and the 7d backup window).
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const stale = await drStatus(executor, { now: later });
    assert.deepEqual(stale.verdicts.sort(), [
      "catalog_stale",
      "household_backup_stale",
      "household_stale"
    ]);
  } finally {
    await pool.end();
    await dropDatabase(migrate, MAIN_DB);
  }
});

// The migration-file list loader is exercised implicitly by every suite
// above; a direct sanity check keeps a missing 0010 file a loud failure
// even in hermetic mode where the suites above skip.
test("the DR ledgers are declared by migration 0010", () => {
  const files = loadMigrationFiles(MIGRATIONS_DIR);
  const last = files[files.length - 1];
  assert.equal(last.version, 10);
  assert.match(last.filename, /^0010_disaster_recovery_ledgers\.sql$/);
  for (const table of ["dr_backup_runs", "dr_restore_runs", "dr_rebuild_runs"]) {
    assert.ok(last.sql.includes(`CREATE TABLE public.${table}`), `${table} is created by 0010`);
  }
});
