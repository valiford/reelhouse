// Deterministic PostgreSQL integration evidence for the catalog search,
// detail, and freshness read models (RH-0034).
//
// Runs against the disposable loopback PostgreSQL 18 profile
// (docker-compose.dev-db.yml) — never against Synology. Without the two role
// URLs every case skips and the hermetic `npm test` stays hermetic:
//
//   REELHOUSE_TEST_MIGRATE_URL   owner/migrator role
//   REELHOUSE_TEST_DATABASE_URL  application role
//
// Scenarios: migrations 0001–0008 (including the new read-model indexes)
// apply to a fresh database; the read models answer against a catalog seeded
// by the REAL sync runner; every filter axis, all four sorts, and pagination
// (stability across pages, hasMore math, clamped bounds) behave
// deterministically; ILIKE metacharacters match literally; the detail view
// carries bounded facets and provenance; catalog churn (a tombstoned item)
// leaves search and detail on the next read while household references
// survive (covered in home.int.test.ts); the freshness model walks
// never_synced → fresh → stale with an injectable clock; recentRuns stays
// bounded; and everything runs under the least-privilege application role.
//
// Like the other suites this file avoids importing pool.ts (`server-only`
// throws under plain Node) and builds its own pools plus its own temporary
// database, so it cannot interfere with the other suites even across
// parallel node --test processes.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { loadDatabaseConfig, type DatabaseConfig } from "../db/config.ts";
import { loadMigrationFiles, runMigrations } from "../db/migrator.ts";
import { createPgSyncExecutor } from "../catalog/pg-executor.ts";
import { runFullCatalogSync } from "../catalog/sync.ts";
import type { CatalogItemsPage, CatalogLibrary, CatalogRawItem, CatalogSource } from "../catalog/source.ts";
import { createPgReadExecutor, type ReadExecutor } from "./executor.ts";
import { resolvePage, resolveSearchFilters } from "./params.ts";
import { CatalogItemNotFoundError, getCatalogItem, searchCatalogItems } from "./search.ts";
import { catalogStatus } from "./freshness.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const TEMP_DB = "reelhouse_rh0034a_tmp";

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

// Rich deterministic catalog: two libraries; movies spread across years,
// ratings, and genres (including an ILIKE-hostile name and a tie on rating);
// one series with a season and two episodes. DateCreated is set on every
// item so recency ordering is fully deterministic.
function moviePayload(overrides: Record<string, unknown>): Record<string, unknown> {
  return { Type: "Movie", ...overrides };
}

const MOVIES: Record<string, unknown>[] = [
  moviePayload({
    Id: "mov-arrival", Name: "Arrival", ProductionYear: 2016, CommunityRating: 8.1,
    Genres: ["Sci-Fi", "Drama"], OfficialRating: "PG-13",
    DateCreated: "2026-08-01T10:00:00Z", DateLastSaved: "2026-08-01T10:00:00Z",
    Studios: ["Paramount"], ProviderIds: { Imdb: "tt2543164" },
    People: [
      { Name: "Amy Adams", Type: "Actor", Role: "Louise", Id: "p-amy" },
      { Name: "Denis Villeneuve", Type: "Director" }
    ]
  }),
  moviePayload({
    Id: "mov-blade", Name: "Blade Runner", ProductionYear: 1982, CommunityRating: 8.1,
    Genres: ["Sci-Fi"], DateCreated: "2026-08-02T10:00:00Z",
    OriginalTitle: "Blade Runner (The Final Cut)"
  }),
  moviePayload({
    Id: "mov-drama", Name: "Cinema Paradiso", ProductionYear: 1988, CommunityRating: 8.5,
    Genres: ["Drama", "Romance"], DateCreated: "2026-08-03T10:00:00Z"
  }),
  moviePayload({
    Id: "mov-fresh", Name: "100% Fresh", ProductionYear: 2018, CommunityRating: 7.2,
    Genres: ["Comedy"], DateCreated: "2026-08-04T10:00:00Z"
  }),
  moviePayload({
    Id: "mov-unrated", Name: "Ancient Tales", ProductionYear: 1977,
    Genres: ["Documentary"], DateCreated: "2026-08-05T10:00:00Z"
  }),
  moviePayload({
    Id: "mov-recent", Name: "Dune Part Two", ProductionYear: 2024, CommunityRating: 8.5,
    Genres: ["Sci-Fi"], DateCreated: "2026-09-20T10:00:00Z"
  })
];

const SERIES_ITEMS: Record<string, unknown>[] = [
  { Id: "ser-parallel", Name: "Parallel", Type: "Series", ProductionYear: 2021, CommunityRating: 7.9, Genres: ["Sci-Fi", "Drama"], DateCreated: "2026-07-01T10:00:00Z" },
  { Id: "sea-parallel-1", Name: "Season 1", Type: "Season", ParentId: "ser-parallel", SeriesId: "ser-parallel", SeriesName: "Parallel", IndexNumber: 1, DateCreated: "2026-07-01T10:05:00Z" },
  {
    Id: "ep-parallel-1", Name: "Pilot", Type: "Episode", SeriesId: "ser-parallel", SeriesName: "Parallel",
    SeasonId: "sea-parallel-1", ParentIndexNumber: 1, IndexNumber: 1,
    DateCreated: "2026-07-01T10:10:00Z", DateLastSaved: "2026-08-10T09:00:00Z"
  },
  {
    Id: "ep-parallel-2", Name: "Crossing", Type: "Episode", SeriesId: "ser-parallel", SeriesName: "Parallel",
    SeasonId: "sea-parallel-1", ParentIndexNumber: 1, IndexNumber: 2,
    DateCreated: "2026-07-01T10:11:00Z", DateLastSaved: "2026-08-10T09:05:00Z"
  }
];

class SeedCatalogSource implements CatalogSource {
  async listLibraries(): Promise<CatalogLibrary[]> {
    return [
      { jellyfinId: "lib-movies", name: "Movies", collectionType: "movies" },
      { jellyfinId: "lib-tv", name: "TV Shows", collectionType: "tvshows" }
    ];
  }

  async #itemsFor(libraryJellyfinId: string): Promise<CatalogRawItem[]> {
    if (libraryJellyfinId === "lib-movies") return MOVIES.map((payload) => ({ ...payload }));
    if (libraryJellyfinId === "lib-tv") return SERIES_ITEMS.map((payload) => ({ ...payload }));
    return [];
  }

  async fetchItemsPage(libraryJellyfinId: string, startIndex: number, limit: number): Promise<CatalogItemsPage> {
    const items = await this.#itemsFor(libraryJellyfinId);
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

interface CaseHandle {
  migrate: DatabaseConfig;
  app: DatabaseConfig;
  read: ReadExecutor;
  pool: Pool;
}

async function withFreshCatalog(
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

  const pool = new Pool({
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
      "all on-disk migrations apply to a fresh database (0001–0008)"
    );
    await fn({ migrate: migrateTemp, app: appTemp, read: createPgReadExecutor(pool), pool });
  } finally {
    await pool.end();
    await withClient({ ...migrate, database: "postgres" }, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${TEMP_DB} WITH (FORCE)`);
    });
  }
}

async function seedCatalog(pool: Pool): Promise<void> {
  const result = await runFullCatalogSync(new SeedCatalogSource(), createPgSyncExecutor(pool), { pageSize: 50 });
  assert.equal(result.status, "succeeded");
}

const namesOf = (rows: { name: string }[]) => rows.map((row) => row.name);
const idsOf = (rows: { jellyfin_id: string }[]) => rows.map((row) => row.jellyfin_id);

async function search(
  db: CaseHandle,
  raw: Record<string, unknown>,
  page: Record<string, unknown> = {}
) {
  return searchCatalogItems(db.read, resolveSearchFilters(raw), resolvePage(page));
}

test("migration 0008 adds the read-model indexes and re-running the migrator is a no-op", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await withClient(db.app, async (client) => {
      const expected = [
        "media_items_active_title_idx",
        "media_items_active_added_idx",
        "media_items_active_rating_idx",
        "media_items_active_year_idx"
      ];
      const indexes = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = ANY($1::text[]) ORDER BY indexname`,
        [expected]
      );
      assert.deepEqual(
        indexes.rows.map((row) => row.indexname),
        [...expected].sort()
      );
    });
    const again = await runMigrations(db.migrate, MIGRATIONS_DIR, db.app.user);
    assert.deepEqual(again.appliedNow, []);
  });
});

test("freshness reports never_synced on an empty catalog", async (t) => {
  await withFreshCatalog(t, async (db) => {
    const status = await catalogStatus(db.read, { now: new Date("2026-09-22T12:00:00Z") });
    assert.equal(status.state, "never_synced");
    assert.equal(status.lastSucceededAt, null);
    assert.equal(status.ageMs, null);
    assert.equal(status.itemCounts.total, 0);
    assert.equal(status.household.state, "never_synced");
  });
});

test("the read models answer through the real sync runner under the app role", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await seedCatalog(db.pool);
    const page = await search(db, {});
    // 6 movies + series + season + 2 episodes = 10 active items.
    assert.equal(page.total, 10);
    assert.equal(page.items.length, 10);
    assert.equal(page.hasMore, false);

    const status = await catalogStatus(db.read, { now: new Date("2026-09-22T12:00:00Z") });
    assert.equal(status.state, "fresh");
    assert.ok(status.lastSucceededAt);
    assert.equal(status.itemCounts.total, 10);
    assert.deepEqual(status.itemCounts.byType, { episode: 2, movie: 6, season: 1, series: 1 });
    assert.equal(status.libraryCount, 2);
    assert.deepEqual(
      status.libraries.map((library) => [library.jellyfin_id, Number(library.item_count)]),
      [
        ["lib-movies", 6],
        ["lib-tv", 4]
      ],
      "libraries ordered by name with their active item counts"
    );
    assert.equal(status.openQuarantines, 0);
    // The sync advances the incremental watermark to the newest source
    // DateLastSaved it covered (ep-parallel-2's), even in full mode.
    assert.equal(status.watermark, "2026-08-10T09:05:00.000Z");
    assert.ok(status.recentRuns.length >= 1);
    assert.equal(status.recentRuns[0].status, "succeeded");
  });
});

test("every filter axis narrows the same deterministic base", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await seedCatalog(db.pool);

    assert.deepEqual(
      idsOf((await search(db, { types: "movie" })).items).every((id) => MOVIES.some((m) => m.Id === id)),
      true
    );
    assert.equal((await search(db, { types: "movie" })).total, 6);
    assert.equal((await search(db, { types: "series,season" })).total, 2);
    assert.equal((await search(db, { libraries: "lib-tv" })).total, 4);
    assert.equal((await search(db, { genres: "Sci-Fi" })).total, 4, "3 movies + the series carry the genre");
    assert.equal((await search(db, { genres: "sci-fi" })).total, 0, "genre match is exact, not fuzzy");
    assert.equal((await search(db, { yearMin: 1980, yearMax: 2000 })).total, 2);
    assert.equal((await search(db, { minRating: 8 })).total, 4, "8.1/8.1/8.5/8.5 >= 8; 7.9 and NULLs out");
    assert.equal((await search(db, { minRating: 9 })).total, 0);
    assert.equal((await search(db, { q: "parallel" })).total, 1, "q matches item names, not hierarchy columns");
    assert.equal((await search(db, { q: "final cut" })).total, 1, "original_title is searchable");
    assert.equal((await search(db, { q: "blade" })).total, 1);
    assert.equal((await search(db, { q: "zzz-nothing" })).total, 0);
    // Filters compose.
    assert.equal((await search(db, { types: "movie", genres: "Sci-Fi", yearMin: 2000 })).total, 2);
  });
});

test("ILIKE metacharacters in the query match literally", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await seedCatalog(db.pool);
    assert.deepEqual(idsOf((await search(db, { q: "100%" })).items), ["mov-fresh"]);
    // Escaped wildcards match literally: % only hits the name that has one.
    assert.equal((await search(db, { q: "%" })).total, 1);
    assert.equal((await search(db, { q: "_" })).total, 0, "no seeded name contains a literal underscore");
  });
});

test("pagination is stable, dup-free, and reports honest bounds", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await seedCatalog(db.pool);
    const filters = resolveSearchFilters({ sort: "title" });

    const full = await searchCatalogItems(db.read, filters, resolvePage({ limit: 100 }));
    const collected: string[] = [];
    let offset = 0;
    let guard = 0;
    while (guard++ < 20) {
      const page = await searchCatalogItems(db.read, filters, { limit: 3, offset });
      assert.ok(page.items.length <= 3);
      assert.equal(page.total, full.total, "every page reports the same total");
      assert.equal(page.hasMore, offset + page.items.length < page.total, "hasMore matches the math");
      collected.push(...idsOf(page.items));
      if (!page.hasMore) break;
      offset += page.items.length;
    }
    assert.deepEqual(collected, idsOf(full.items), "paged walk reproduces the full ordering with no dups or gaps");

    // Offset past the end: empty page, total still honest.
    const past = await searchCatalogItems(db.read, filters, { limit: 10, offset: 999 });
    assert.deepEqual(past.items, []);
    assert.equal(past.total, 10);
    assert.equal(past.hasMore, false);
  });
});

test("the four sorts are deterministic with id tiebreakers", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await seedCatalog(db.pool);

    const byTitle = idsOf((await search(db, { sort: "title" })).items);
    assert.equal(new Set(byTitle).size, byTitle.length);
    const titles = namesOf((await search(db, { sort: "title" })).items);
    assert.deepEqual(
      titles,
      [...titles].sort((a, b) => a.localeCompare(b)),
      "title sort is case-insensitive alphabetical"
    );

    const recent = (await search(db, { sort: "recent" })).items;
    assert.deepEqual(idsOf(recent)[0], "mov-recent", "newest DateCreated leads the recent sort");
    const stamps = recent.map((row) => new Date(row.date_created as string).getTime());
    assert.deepEqual(stamps, [...stamps].sort((a, b) => b - a));

    // mov-arrival and mov-blade share rating 8.1: stable, deterministic order
    // across two calls (id tiebreaker, not server mood).
    const ratingA = idsOf((await search(db, { sort: "rating", types: "movie" })).items);
    const ratingB = idsOf((await search(db, { sort: "rating", types: "movie" })).items);
    assert.deepEqual(ratingA, ratingB);
    const ratings = (await search(db, { sort: "rating", types: "movie" })).items.map(
      (row) => Number(row.community_rating)
    );
    assert.deepEqual(ratings, [...ratings].sort((a, b) => b - a));

    const years = (await search(db, { sort: "year", types: "movie" })).items.map((row) => row.production_year);
    assert.deepEqual(years, [...years].sort((a, b) => Number(b) - Number(a)));
  });
});

test("repeated identical queries return byte-identical results", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await seedCatalog(db.pool);
    const first = await search(db, { q: "a", sort: "rating" }, { limit: 4, offset: 1 });
    const second = await search(db, { q: "a", sort: "rating" }, { limit: 4, offset: 1 });
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });
});

test("the detail view carries bounded facets and provenance", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await seedCatalog(db.pool);
    const detail = await getCatalogItem(db.read, "mov-arrival");
    assert.equal(detail.item.jellyfin_id, "mov-arrival");
    assert.deepEqual(detail.genres, ["Drama", "Sci-Fi"]);
    assert.deepEqual(detail.studios, ["Paramount"]);
    assert.deepEqual(
      detail.people.map((person) => [person.name, person.personType, person.roleName]),
      [
        ["Amy Adams", "Actor", "Louise"],
        ["Denis Villeneuve", "Director", null]
      ],
      "people ordered by list_order with roles"
    );
    assert.deepEqual(detail.providerIds, [{ name: "Imdb", value: "tt2543164" }]);
    assert.equal(detail.item.production_year, 2016);

    await assert.rejects(getCatalogItem(db.read, "mov-missing"), CatalogItemNotFoundError);
  });
});

test("catalog churn tombstones leave search and detail; a failed run is visible in status", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await seedCatalog(db.pool);
    await db.pool.query("UPDATE media_items SET removed_at = now() WHERE jellyfin_id = 'mov-arrival'");

    assert.equal((await search(db, { q: "arrival" })).total, 0, "tombstoned items are not discoverable");
    assert.equal((await search(db, {})).total, 9);
    await assert.rejects(getCatalogItem(db.read, "mov-arrival"), CatalogItemNotFoundError);

    const status = await catalogStatus(db.read, { now: new Date("2026-09-22T12:00:00Z") });
    assert.equal(status.itemCounts.total, 9, "counts reflect the active catalog only");

    // A failed run does not change freshness (the newest SUCCEEDED run
    // decides) but is visible in the bounded recent-runs list.
    await db.pool.query(
      `INSERT INTO media_sync_runs (mode, status, finished_at, error_detail)
       VALUES ('full', 'failed', now(), 'simulated sync failure')`
    );
    const after = await catalogStatus(db.read, { now: new Date("2026-09-22T12:00:00Z") });
    assert.equal(after.state, "fresh", "freshness ignores failed runs");
    assert.equal(after.recentRuns[0].status, "failed", "the failed run is the newest entry");
    assert.match(String(after.recentRuns[0].error_detail), /simulated sync failure/);
  });
});

test("freshness walks fresh → stale with the injectable clock and bounded run list", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await seedCatalog(db.pool);
    const justAfterSync = await db.pool.query<{ finished_at: Date }>(
      "SELECT finished_at FROM media_sync_runs WHERE status = 'succeeded' ORDER BY id DESC LIMIT 1"
    );
    const syncedAt = justAfterSync.rows[0].finished_at;

    const fresh = await catalogStatus(db.read, {
      now: new Date(syncedAt.getTime() + 60_000),
      catalogStaleAfterMs: 60_000 * 10
    });
    assert.equal(fresh.state, "fresh");
    assert.equal(fresh.ageMs, 60_000);

    const stale = await catalogStatus(db.read, {
      now: new Date(syncedAt.getTime() + 60_001),
      catalogStaleAfterMs: 60_000
    });
    assert.equal(stale.state, "stale");
    assert.equal(stale.staleAfterMs, 60_000);

    // Six more runs → recentRuns stays capped at MAX_RECENT_RUNS.
    for (let i = 0; i < 6; i++) {
      await runFullCatalogSync(new SeedCatalogSource(), createPgSyncExecutor(db.pool), { pageSize: 50 });
    }
    const status = await catalogStatus(db.read, { now: new Date(syncedAt.getTime() + 1000) });
    assert.equal(status.recentRuns.length, 5);
    assert.ok(status.recentRuns.every((run) => run.status === "succeeded"));
  });
});
