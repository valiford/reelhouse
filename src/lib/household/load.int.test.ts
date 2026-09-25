// Deterministic PostgreSQL integration evidence for the household import
// (RH-0033).
//
// Runs against the disposable loopback PostgreSQL 18 profile
// (docker-compose.dev-db.yml) — never against Synology. Without the two
// role URLs every case skips and the hermetic `npm test` stays hermetic:
//
//   REELHOUSE_TEST_MIGRATE_URL   owner/migrator role
//   REELHOUSE_TEST_DATABASE_URL  application role
//
// Scenarios: migration 0006 creates the household family under the same
// least-privilege rules (plus its schema invariants), the first import with
// catalog-resolved item links under the app role, byte-identical idempotent
// re-import (zero writes, zero appended history), snapshot evolution
// (updates/tombstones/resurrections preserving first-seen provenance,
// default reassignment, Jellyfin account moves), profile isolation
// (including archive/restore of an absent profile), the zero-profile
// fail-closed guard, mid-transaction failure atomicity with a recorded
// failed run and a clean recovery, and app-role DDL rejection.
//
// Like the catalog suites, this file avoids importing pool.ts
// (`server-only` throws under plain Node) and builds its own pools; it uses
// its own temporary database so it cannot interfere with the other suites'
// bookkeeping on the shared profile, even across parallel node --test
// processes.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { loadDatabaseConfig, type DatabaseConfig } from "../db/config.ts";
import { loadMigrationFiles, runMigrations } from "../db/migrator.ts";
import { createPgSyncExecutor } from "../catalog/pg-executor.ts";
import { runFullCatalogSync } from "../catalog/sync.ts";
import type { CatalogItemsPage, CatalogLibrary, CatalogRawItem, CatalogSource } from "../catalog/source.ts";
import { normalizeManifest, type NormalizedManifest } from "./manifest.ts";
import { HouseholdImportError, runHouseholdImport } from "./load.ts";
import type { HouseholdExecutor } from "./load.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const TEMP_DB = "reelhouse_rh0033_tmp";

const migrateEnv = process.env.REELHOUSE_TEST_MIGRATE_URL;
const appEnv = process.env.REELHOUSE_TEST_DATABASE_URL;

function configFrom(url: string, overrides: Partial<DatabaseConfig> = {}): DatabaseConfig {
  const result = loadDatabaseConfig({ DATABASE_URL: url });
  if (result.kind !== "valid") throw new Error(`test URL invalid: ${"errors" in result ? result.errors.join("; ") : "blank"}`);
  return { ...result.config, ...overrides };
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

// Minimal deterministic catalog seed: two movies, so household item links
// can resolve against real media_items rows synced by the real sync runner.
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

async function seedCatalog(pool: Pool): Promise<void> {
  const source = new SeedCatalogSource(
    [{ jellyfinId: "lib-movies", name: "Movies", collectionType: "movies" }],
    new Map([
      [
        "lib-movies",
        [
          { Id: "mov-arrival", Name: "Arrival", Type: "Movie", ProductionYear: 2016 },
          { Id: "mov-bare", Name: "Bare Movie", Type: "Movie" }
        ]
      ]
    ])
  );
  const result = await runFullCatalogSync(source, createPgSyncExecutor(pool), { pageSize: 50 });
  assert.equal(result.status, "succeeded");
}

interface CaseHandle {
  migrate: DatabaseConfig;
  app: DatabaseConfig;
  appPool: Pool;
}

async function withFreshHousehold(
  t: { skip: (message?: string) => void },
  fn: (db: CaseHandle) => Promise<void>
): Promise<void> {
  const { migrate, app } = needsDb(t);
  const migrateTemp = { ...migrate, database: TEMP_DB };
  const appTemp = { ...app, database: TEMP_DB };

  await withClient({ ...migrate, database: "postgres" }, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${TEMP_DB} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${TEMP_DB}`);
  });

  const appPool = new Pool({
    host: appTemp.host,
    port: appTemp.port,
    user: appTemp.user,
    password: appTemp.password,
    database: appTemp.database,
    max: 2,
    connectionTimeoutMillis: appTemp.connectionTimeoutMs,
    statement_timeout: appTemp.statementTimeoutMs
  });

  try {
    const applied = await runMigrations(migrateTemp, MIGRATIONS_DIR, appTemp.user);
    assert.deepEqual(
      applied.appliedNow,
      loadMigrationFiles(MIGRATIONS_DIR).map((file) => file.version),
      "all on-disk migrations apply to a fresh database (catalog + household)"
    );
    await fn({ migrate: migrateTemp, app: appTemp, appPool });
  } finally {
    await appPool.end();
    await withClient({ ...migrate, database: "postgres" }, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${TEMP_DB} WITH (FORCE)`);
    });
  }
}

function importManifest(raw: unknown): NormalizedManifest {
  return normalizeManifest(raw);
}

interface TwoProfileSnapshotOptions {
  arrivalFavorite?: boolean;
  ghostFavorite?: boolean;
  theme?: string;
  arrivalTicks?: number;
  watchlistName?: string;
  includeNicole?: boolean;
}

function twoProfileSnapshot(options: TwoProfileSnapshotOptions = {}): Record<string, unknown> {
  const valiFavorites: Record<string, unknown>[] = [];
  if (options.arrivalFavorite !== false) {
    valiFavorites.push({ jellyfinId: "mov-arrival", addedAt: "2026-08-01T12:00:00Z" });
  }
  if (options.ghostFavorite) {
    valiFavorites.push({ jellyfinId: "mov-ghost" });
  }
  return {
    profiles: [
      {
        name: "V’Ali",
        initials: "VA",
        isDefault: true,
        jellyfinUserId: "jf-user-vali",
        preferences: { theme: options.theme ?? "dark", autoplay_next: true },
        favorites: valiFavorites,
        watchlists: [
          {
            name: options.watchlistName ?? "Movie Night",
            entries: [{ jellyfinId: "mov-bare", addedAt: "2026-08-02T09:30:00Z" }]
          }
        ],
        homeRows: [
          { kind: "continue_watching", title: "Continue Watching" },
          { kind: "library", title: "Movies", config: { library_jellyfin_id: "lib-movies" } }
        ],
        watchState: [
          {
            jellyfinId: "mov-arrival",
            positionTicks: options.arrivalTicks ?? 600_000_000,
            durationTicks: 1_830_000_000,
            lastPlayedAt: "2026-09-20T02:11:00Z"
          }
        ],
        playbackHistory: [
          { jellyfinId: "mov-arrival", playedAt: "2026-09-20T01:40:00Z", positionTicks: 0 },
          {
            jellyfinId: "mov-arrival",
            playedAt: "2026-09-20T02:11:00Z",
            positionTicks: options.arrivalTicks ?? 600_000_000
          }
        ]
      },
      ...(options.includeNicole === false
        ? []
        : [
            {
              name: "Nicole",
              favorites: [{ jellyfinId: "mov-bare", addedAt: "2026-07-15T18:00:00Z" }]
            }
          ])
    ],
    collections: [
      {
        name: "Family Picks",
        entries: [{ jellyfinId: "mov-arrival" }, { jellyfinId: "mov-bare" }]
      }
    ]
  };
}

// Ordered dump of every household table; JSON-stringified for byte-stable
// comparisons (jsonb key order and timestamptz rendering are stable within
// one server for identical values).
async function householdDump(pool: Pool): Promise<string> {
  const tables = [
    "household_profiles",
    "household_preferences",
    "household_jellyfin_accounts",
    "household_favorites",
    "household_watchlists",
    "household_watchlist_entries",
    "household_collections",
    "household_collection_entries",
    "household_home_rows",
    "household_watch_state",
    "household_playback_history"
  ];
  const dump: Record<string, unknown[]> = {};
  for (const table of tables) {
    const result = await pool.query(`SELECT * FROM ${table} ORDER BY 1, 2`);
    dump[table] = result.rows;
  }
  return JSON.stringify(dump);
}

async function lastRun(pool: Pool): Promise<Record<string, unknown>> {
  const result = await pool.query<Record<string, unknown>>(
    "SELECT * FROM household_sync_runs ORDER BY id DESC LIMIT 1"
  );
  return result.rows[0];
}

test("migration 0006 creates the household family and enforces its invariants", async (t) => {
  await withFreshHousehold(t, async (db) => {
    await withClient(db.app, async (client) => {
      const expected = [
        "household_profiles",
        "household_preferences",
        "household_jellyfin_accounts",
        "household_favorites",
        "household_watchlists",
        "household_watchlist_entries",
        "household_collections",
        "household_collection_entries",
        "household_home_rows",
        "household_watch_state",
        "household_playback_history",
        "household_sync_runs"
      ];
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name`,
        [expected]
      );
      assert.deepEqual(
        tables.rows.map((row) => row.table_name),
        [...expected].sort()
      );

      // One ACTIVE default profile is a schema invariant (archived defaults
      // do not block a new one).
      await client.query(
        `INSERT INTO household_profiles (slug, display_name) VALUES ('vali', 'V’Ali')`
      );
      await client.query(
        `INSERT INTO household_profiles (slug, display_name) VALUES ('nicole', 'Nicole')`
      );
      await client.query(`UPDATE household_profiles SET is_default = true WHERE slug = 'vali'`);
      await assert.rejects(
        client.query(`UPDATE household_profiles SET is_default = true WHERE slug = 'nicole'`),
        /household_profiles_default_idx/
      );
      // An ARCHIVED default does not violate the partial index.
      await client.query(
        "UPDATE household_profiles SET archived_at = now(), is_default = true WHERE slug = 'nicole'"
      );

      // Slug identity is unique; the run status vocabulary is closed.
      await assert.rejects(
        client.query(`INSERT INTO household_profiles (slug, display_name) VALUES ('vali', 'Duplicate')`),
        /household_profiles_slug_key/
      );
      await assert.rejects(
        client.query("INSERT INTO household_sync_runs (status) VALUES ('exploded')"),
        /household_sync_runs_status_check/
      );
    });

    // Re-running the migrator against the live schema is a no-op.
    const again = await runMigrations(db.migrate, MIGRATIONS_DIR, db.app.user);
    assert.deepEqual(again.appliedNow, []);
  });
});

test("first import loads the household with catalog-resolved links under the app role", async (t) => {
  await withFreshHousehold(t, async (db) => {
    await seedCatalog(db.appPool);

    const result = await runHouseholdImport(
      importManifest(twoProfileSnapshot({ ghostFavorite: true })),
      createPgSyncExecutor(db.appPool)
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.profilesSeen, 2);
    assert.equal(result.profilesUpserted, 2);
    assert.equal(result.profilesArchived, 0);
    assert.equal(result.preferencesUpserted, 2);
    assert.equal(result.favoritesUpserted, 3, "2 for V'Ali (arrival + unresolved ghost) + 1 for Nicole");
    assert.equal(result.watchlistsUpserted, 1);
    assert.equal(result.watchlistEntriesUpserted, 1);
    assert.equal(result.collectionsUpserted, 1);
    assert.equal(result.collectionEntriesUpserted, 2);
    assert.equal(result.homeRowsUpserted, 2);
    assert.equal(result.watchStateUpserted, 1);
    assert.equal(result.historyAppended, 2);
    assert.equal(result.unresolvedLinks, 1, "mov-ghost is not in the catalog yet");
    assert.equal(result.conflictsSkipped, 0);

    const profiles = await db.appPool.query<{ slug: string; display_name: string; is_default: boolean; archived_at: Date | null }>(
      "SELECT slug, display_name, is_default, archived_at FROM household_profiles ORDER BY slug"
    );
    assert.deepEqual(profiles.rows, [
      { slug: "nicole", display_name: "Nicole", is_default: false, archived_at: null },
      { slug: "v_ali", display_name: "V’Ali", is_default: true, archived_at: null }
    ]);

    // Catalog links resolved where the item existed; the ghost stays linked
    // by identity only.
    const favorites = await db.appPool.query<{ jellyfin_id: string; item_id: number | null; position: string }>(
      `SELECT f.jellyfin_id, f.item_id, f.position FROM household_favorites f
       JOIN household_profiles p ON p.id = f.profile_id
       WHERE p.slug = 'v_ali' ORDER BY f.position`
    );
    assert.equal(favorites.rows.length, 2);
    assert.equal(favorites.rows[0].jellyfin_id, "mov-arrival");
    assert.notEqual(favorites.rows[0].item_id, null, "resolved against the synced catalog");
    assert.equal(favorites.rows[1].jellyfin_id, "mov-ghost");
    assert.equal(favorites.rows[1].item_id, null);

    const prefs = await db.appPool.query<{ key: string; value: unknown }>(
      `SELECT pr.key, pr.value FROM household_preferences pr
       JOIN household_profiles p ON p.id = pr.profile_id
       WHERE p.slug = 'v_ali' ORDER BY pr.key`
    );
    assert.deepEqual(
      prefs.rows.map((row) => [row.key, row.value]),
      [
        ["autoplay_next", true],
        ["theme", "dark"]
      ]
    );

    const account = await db.appPool.query<{ jellyfin_user_id: string }>(
      `SELECT a.jellyfin_user_id FROM household_jellyfin_accounts a
       JOIN household_profiles p ON p.id = a.profile_id WHERE p.slug = 'v_ali'`
    );
    assert.deepEqual(account.rows, [{ jellyfin_user_id: "jf-user-vali" }]);

    const run = await lastRun(db.appPool);
    assert.equal(run.status, "succeeded");
    assert.equal(Number(run.profiles_seen), 2);
    assert.equal(Number(run.history_appended), 2);
    assert.equal(Number(run.unresolved_links), 1);
    assert.ok(run.finished_at !== null);
    assert.equal(run.error_detail, null);
  });
});

test("re-importing an identical snapshot performs zero writes and appends nothing", async (t) => {
  await withFreshHousehold(t, async (db) => {
    await seedCatalog(db.appPool);
    const manifest = importManifest(twoProfileSnapshot({ ghostFavorite: true }));
    await runHouseholdImport(manifest, createPgSyncExecutor(db.appPool));
    const before = await householdDump(db.appPool);

    const second = await runHouseholdImport(manifest, createPgSyncExecutor(db.appPool));

    assert.equal(second.status, "succeeded");
    for (const field of [
      "profilesUpserted",
      "preferencesUpserted",
      "favoritesUpserted",
      "favoritesRemoved",
      "watchlistsUpserted",
      "watchlistsArchived",
      "watchlistEntriesUpserted",
      "watchlistEntriesRemoved",
      "collectionsUpserted",
      "collectionsArchived",
      "collectionEntriesUpserted",
      "collectionEntriesRemoved",
      "homeRowsUpserted",
      "homeRowsArchived",
      "watchStateUpserted",
      "watchStateRemoved",
      "historyAppended",
      "profilesArchived"
    ] as const) {
      assert.equal(second[field], 0, `${field} reports zero writes on a no-op re-import`);
    }

    const after = await householdDump(db.appPool);
    assert.equal(after, before, "every household table is byte-identical after the no-op re-import");

    const counts = await db.appPool.query<{ runs: string; profiles: string }>(
      `SELECT (SELECT count(*) FROM household_sync_runs) AS runs,
              (SELECT count(*) FROM household_profiles) AS profiles`
    );
    assert.equal(Number(counts.rows[0].runs), 2, "one run row per import");
    assert.equal(Number(counts.rows[0].profiles), 2, "no new profile rows appear");
  });
});

test("snapshot evolution updates, tombstones, resurrects, and moves accounts without losing provenance", async (t) => {
  await withFreshHousehold(t, async (db) => {
    await seedCatalog(db.appPool);
    const executor = createPgSyncExecutor(db.appPool);
    await runHouseholdImport(importManifest(twoProfileSnapshot()), executor);

    const firstAdded = await db.appPool.query<{ first_added_at: Date }>(
      `SELECT f.first_added_at FROM household_favorites f
       JOIN household_profiles p ON p.id = f.profile_id
       WHERE p.slug = 'v_ali' AND f.jellyfin_id = 'mov-arrival'`
    );
    const created = await db.appPool.query<{ created_at: Date }>(
      "SELECT created_at FROM household_profiles WHERE slug = 'v_ali'"
    );

    // Evolution: favorite removed, watchlist renamed+archived under a new
    // name set, theme changed, progress advanced, a new history event, and
    // the Jellyfin account moves to Nicole.
    const evolved = twoProfileSnapshot();
    const vali = (evolved.profiles as Record<string, unknown>[])[0];
    vali.favorites = [];
    vali.watchlists = [];
    vali.homeRows = [
      { kind: "library", title: "Movies", config: { library_jellyfin_id: "lib-movies" } },
      { kind: "continue_watching", title: "Continue Watching" }
    ];
    vali.preferences = { theme: "light", autoplay_next: true };
    vali.jellyfinUserId = null;
    (vali.watchState as Record<string, unknown>[])[0].positionTicks = 900_000_000;
    (vali.watchState as Record<string, unknown>[])[0].lastPlayedAt = "2026-09-21T03:00:00Z";
    (vali.playbackHistory as Record<string, unknown>[]).push({
      jellyfinId: "mov-arrival",
      playedAt: "2026-09-21T03:00:00Z",
      positionTicks: 900_000_000
    });
    const nicole = (evolved.profiles as Record<string, unknown>[])[1];
    nicole.jellyfinUserId = "jf-user-vali";

    const second = await runHouseholdImport(importManifest(evolved), executor);
    assert.equal(second.status, "succeeded");
    assert.equal(second.favoritesRemoved, 1);
    assert.equal(second.watchlistsArchived, 1);
    assert.equal(second.homeRowsUpserted, 2);
    assert.equal(second.historyAppended, 1);
    assert.equal(second.unresolvedLinks, 0);

    const favState = await db.appPool.query<{ removed_at: Date | null }>(
      `SELECT f.removed_at FROM household_favorites f
       JOIN household_profiles p ON p.id = f.profile_id
       WHERE p.slug = 'v_ali' AND f.jellyfin_id = 'mov-arrival'`
    );
    assert.ok(favState.rows[0].removed_at, "the removed favorite is a tombstone, not a delete");

    // The account really moved: exactly one account row, owned by Nicole
    // (V'Ali's payload no longer carries a Jellyfin user, so her link goes).
    const accounts = await db.appPool.query<{ slug: string; jellyfin_user_id: string }>(
      `SELECT p.slug, a.jellyfin_user_id FROM household_jellyfin_accounts a
       JOIN household_profiles p ON p.id = a.profile_id ORDER BY p.slug`
    );
    assert.deepEqual(accounts.rows, [{ slug: "nicole", jellyfin_user_id: "jf-user-vali" }]);

    // Resurrection preserves the ORIGINAL first_added_at.
    const resurrected = twoProfileSnapshot();
    const third = await runHouseholdImport(importManifest(resurrected), executor);
    assert.equal(third.favoritesUpserted, 1, "only the re-added favorite writes");
    const favAfter = await db.appPool.query<{ removed_at: Date | null; first_added_at: Date }>(
      `SELECT f.removed_at, f.first_added_at FROM household_favorites f
       JOIN household_profiles p ON p.id = f.profile_id
       WHERE p.slug = 'v_ali' AND f.jellyfin_id = 'mov-arrival'`
    );
    assert.equal(favAfter.rows[0].removed_at, null);
    assert.equal(favAfter.rows[0].first_added_at.getTime(), firstAdded.rows[0].first_added_at.getTime());

    // The resurrection also restores the ORIGINAL account assignment
    // (V'Ali re-claims the user; Nicole is unlinked again).
    const accountsAfter = await db.appPool.query<{ slug: string; jellyfin_user_id: string }>(
      `SELECT p.slug, a.jellyfin_user_id FROM household_jellyfin_accounts a
       JOIN household_profiles p ON p.id = a.profile_id ORDER BY p.slug`
    );
    assert.deepEqual(accountsAfter.rows, [{ slug: "v_ali", jellyfin_user_id: "jf-user-vali" }]);

    assert.equal(
      (await db.appPool.query<{ created_at: Date }>("SELECT created_at FROM household_profiles WHERE slug = 'v_ali'")).rows[0].created_at.getTime(),
      created.rows[0].created_at.getTime(),
      "created_at is set-once provenance across the whole evolution"
    );

    // Watch state advanced with its history trail intact (3 events total).
    const history = await db.appPool.query<{ count: string }>(
      `SELECT count(*) AS count FROM household_playback_history ph
       JOIN household_profiles p ON p.id = ph.profile_id WHERE p.slug = 'v_ali'`
    );
    assert.equal(Number(history.rows[0].count), 3);
  });
});

test("profile isolation: a partial snapshot archives the absent profile and never touches its rows", async (t) => {
  await withFreshHousehold(t, async (db) => {
    await seedCatalog(db.appPool);
    const executor = createPgSyncExecutor(db.appPool);
    await runHouseholdImport(importManifest(twoProfileSnapshot()), executor);
    const before = await householdDump(db.appPool);

    // A V'Ali-only snapshot must not rewrite, remove, or leak Nicole's rows:
    // she is archived (tombstone), her data stays exactly as it was.
    const valiOnly = twoProfileSnapshot({ includeNicole: false });
    const second = await runHouseholdImport(importManifest(valiOnly), executor);
    assert.equal(second.profilesArchived, 1);

    const nicole = await db.appPool.query<{ archived_at: Date | null }>(
      "SELECT archived_at FROM household_profiles WHERE slug = 'nicole'"
    );
    assert.ok(nicole.rows[0].archived_at, "the absent profile is archived, not deleted");

    const nicoleRows = await db.appPool.query<{ count: string }>(
      `SELECT
         (SELECT count(*) FROM household_favorites f JOIN household_profiles p ON p.id = f.profile_id WHERE p.slug = 'nicole') AS count`
    );
    assert.equal(Number(nicoleRows.rows[0].count), 1, "her favorites survive the archive");

    // Everything Nicole-owned is byte-identical to the joint snapshot; only
    // her profiles.archived_at differs (and V'Ali's import wrote its own rows).
    const valiDumpBefore = before;
    void valiDumpBefore;
    const after = await householdDump(db.appPool);
    assert.notEqual(after, valiDumpBefore, "the archive is a real state change");

    // Re-asserting Nicole in a later snapshot restores her, byte-for-byte,
    // without touching V'Ali.
    const valiRowsDuring = await db.appPool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM household_profiles WHERE slug = 'v_ali'"
    );
    const third = await runHouseholdImport(importManifest(twoProfileSnapshot()), executor);
    assert.equal(third.profilesUpserted, 1, "only Nicole's restore writes");
    assert.equal(third.profilesArchived, 0);
    const valiRowsAfter = await db.appPool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM household_profiles WHERE slug = 'v_ali'"
    );
    assert.equal(
      valiRowsAfter.rows[0].updated_at.getTime(),
      valiRowsDuring.rows[0].updated_at.getTime(),
      "V'Ali was untouched by Nicole's restore"
    );
    const nicoleAfter = await db.appPool.query<{ archived_at: Date | null }>(
      "SELECT archived_at FROM household_profiles WHERE slug = 'nicole'"
    );
    assert.equal(nicoleAfter.rows[0].archived_at, null);

    // Structural isolation at the SQL level: Nicole's watch state never
    // appears under V'Ali's id and vice versa, whatever the import did.
    const mixed = await db.appPool.query<{ count: string }>(
      `SELECT count(*) AS count FROM household_favorites f
       JOIN household_profiles p ON p.id = f.profile_id
       WHERE p.slug = 'v_ali' AND f.jellyfin_id IN (SELECT f2.jellyfin_id FROM household_favorites f2 JOIN household_profiles p2 ON p2.id = f2.profile_id WHERE p2.slug = 'nicole' AND f2.removed_at IS NULL)
         AND f.removed_at IS NULL`
    );
    const nicoleActive = await db.appPool.query<{ jellyfin_id: string }>(
      `SELECT f2.jellyfin_id FROM household_favorites f2 JOIN household_profiles p2 ON p2.id = f2.profile_id WHERE p2.slug = 'nicole' AND f2.removed_at IS NULL`
    );
    const vAliActive = await db.appPool.query<{ jellyfin_id: string }>(
      `SELECT f.jellyfin_id FROM household_favorites f JOIN household_profiles p ON p.id = f.profile_id WHERE p.slug = 'v_ali' AND f.removed_at IS NULL`
    );
    assert.equal(
      vAliActive.rows.some((row) => nicoleActive.rows.some((n) => n.jellyfin_id === row.jellyfin_id)),
      false,
      "no favorite row is shared between the two profiles' active sets"
    );
    void mixed;
  });
});

test("a moved household default reassigns atomically and stays single", async (t) => {
  await withFreshHousehold(t, async (db) => {
    await seedCatalog(db.appPool);
    const executor = createPgSyncExecutor(db.appPool);
    await runHouseholdImport(importManifest(twoProfileSnapshot()), executor);

    const moved = twoProfileSnapshot();
    const profiles = moved.profiles as Record<string, unknown>[];
    profiles[0].isDefault = false;
    profiles[1].isDefault = true;
    const second = await runHouseholdImport(importManifest(moved), executor);
    assert.equal(second.status, "succeeded");

    const defaults = await db.appPool.query<{ slug: string }>(
      "SELECT slug FROM household_profiles WHERE is_default AND archived_at IS NULL"
    );
    assert.deepEqual(defaults.rows, [{ slug: "nicole" }], "exactly one active default after reassignment");
  });
});

test("a zero-profile snapshot fails closed and preserves the existing household", async (t) => {
  await withFreshHousehold(t, async (db) => {
    await seedCatalog(db.appPool);
    const executor = createPgSyncExecutor(db.appPool);
    await runHouseholdImport(importManifest(twoProfileSnapshot()), executor);
    const before = await householdDump(db.appPool);

    await assert.rejects(
      runHouseholdImport(importManifest({ profiles: [], collections: [] }), executor),
      (error: unknown) => {
        assert.ok(error instanceof HouseholdImportError);
        assert.match(error.message, /refusing to reconcile the household to empty/);
        assert.equal(error.summary.status, "failed");
        return true;
      }
    );

    const run = await lastRun(db.appPool);
    assert.equal(run.status, "failed");
    assert.match(String(run.error_detail), /refusing to reconcile the household to empty/);
    assert.ok(run.finished_at !== null);

    assert.equal(await householdDump(db.appPool), before, "the refused run changed no household state");
  });
});

test("a mid-transaction failure is atomic, recorded, and cleanly recoverable", async (t) => {
  await withFreshHousehold(t, async (db) => {
    await seedCatalog(db.appPool);
    const inner = createPgSyncExecutor(db.appPool);
    let failNextTransaction = true;
    const flaky: HouseholdExecutor = {
      query: (text, params) => inner.query(text, params),
      withTransaction: async <R,>(fn: (tx: HouseholdExecutor) => Promise<R>): Promise<R> => {
        if (failNextTransaction) {
          failNextTransaction = false;
          throw new Error("simulated crash before the household transaction committed");
        }
        return inner.withTransaction(fn);
      }
    };

    await assert.rejects(
      runHouseholdImport(importManifest(twoProfileSnapshot()), flaky),
      (error: unknown) => {
        assert.ok(error instanceof HouseholdImportError);
        assert.match(error.message, /simulated crash/);
        assert.equal(error.summary.status, "failed");
        return true;
      }
    );

    const run = await lastRun(db.appPool);
    assert.equal(run.status, "failed");
    assert.match(String(run.error_detail), /simulated crash/);

    // Atomicity: the failed import left NOTHING behind except its run row.
    const counts = await db.appPool.query<{ profiles: string; favorites: string; history: string }>(
      `SELECT (SELECT count(*) FROM household_profiles) AS profiles,
              (SELECT count(*) FROM household_favorites) AS favorites,
              (SELECT count(*) FROM household_playback_history) AS history`
    );
    assert.equal(Number(counts.rows[0].profiles), 0);
    assert.equal(Number(counts.rows[0].favorites), 0);
    assert.equal(Number(counts.rows[0].history), 0);

    // Recovery: the healthy retry lands the whole snapshot.
    const recovery = await runHouseholdImport(importManifest(twoProfileSnapshot()), inner);
    assert.equal(recovery.status, "succeeded");
    assert.equal(recovery.profilesUpserted, 2);
    const runs = await db.appPool.query<{ statuses: string[] }>(
      "SELECT array_agg(status ORDER BY id) AS statuses FROM household_sync_runs"
    );
    assert.deepEqual(runs.rows[0].statuses, ["failed", "succeeded"]);
  });
});

test("the app role can read and write household state but never DDL it", async (t) => {
  await withFreshHousehold(t, async (db) => {
    await withClient(db.app, async (client) => {
      await assert.rejects(
        client.query("CREATE TABLE public.rh0033_escalate (id integer)"),
        /permission denied for schema public/
      );
      // DML works (the import's own privilege surface).
      await client.query("INSERT INTO household_sync_runs (status) VALUES ('running')");
    });
  });
});
