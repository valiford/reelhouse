// Deterministic PostgreSQL integration evidence for the home-row and
// recommendation read models (RH-0034).
//
// Runs against the disposable loopback PostgreSQL 18 profile — never
// Synology. Without the two role URLs every case skips and the hermetic
// `npm test` stays hermetic:
//
//   REELHOUSE_TEST_MIGRATE_URL   owner/migrator role
//   REELHOUSE_TEST_DATABASE_URL  application role
//
// Scenarios: with a catalog seeded by the REAL sync runner and a household
// landed by the REAL household importer, every home-row kind resolves into a
// bounded, deterministic rail (continue watching excluding completed/hidden
// rows, ordered rails for favorites/library/collection/watchlist,
// recently-added by source date, unresolved config degrading to a flagged
// empty rail, disabled rows rendering empty); profile isolation holds at the
// feed level; recommendation buckets are deterministic and explainable
// (top genres from favorites + bounded recent history, unwatched discovery
// excluding completed items, one next-up card per series, quality-led
// recent); a feed re-render is byte-identical; catalog churn tombstones
// items out of every rail while household rows survive; and an empty
// household fails closed with a typed error. Everything runs under the
// least-privilege application role.

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
import { createPgReadExecutor, type ReadExecutor } from "./executor.ts";
import {
  HouseholdEmptyError,
  HouseholdProfileNotFoundError,
  homeFeed,
  resolveProfile
} from "./home.ts";
import { recommendationInputs } from "./recommendations.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const TEMP_DB = "reelhouse_rh0034b_tmp";

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

function moviePayload(overrides: Record<string, unknown>): Record<string, unknown> {
  return { Type: "Movie", ...overrides };
}

const MOVIES: Record<string, unknown>[] = [
  moviePayload({ Id: "mov-arrival", Name: "Arrival", ProductionYear: 2016, CommunityRating: 8.1, Genres: ["Sci-Fi", "Drama"], DateCreated: "2026-08-01T10:00:00Z" }),
  moviePayload({ Id: "mov-blade", Name: "Blade Runner", ProductionYear: 1982, CommunityRating: 8.1, Genres: ["Sci-Fi"], DateCreated: "2026-08-02T10:00:00Z" }),
  moviePayload({ Id: "mov-drama", Name: "Cinema Paradiso", ProductionYear: 1988, CommunityRating: 8.5, Genres: ["Drama", "Romance"], DateCreated: "2026-08-03T10:00:00Z" }),
  moviePayload({ Id: "mov-fresh", Name: "100% Fresh", ProductionYear: 2018, CommunityRating: 7.2, Genres: ["Comedy"], DateCreated: "2026-08-04T10:00:00Z" }),
  moviePayload({ Id: "mov-unrated", Name: "Ancient Tales", ProductionYear: 1977, Genres: ["Documentary"], DateCreated: "2026-08-05T10:00:00Z" }),
  moviePayload({ Id: "mov-recent", Name: "Dune Part Two", ProductionYear: 2024, CommunityRating: 8.5, Genres: ["Sci-Fi"], DateCreated: "2026-09-20T10:00:00Z" })
];

const SERIES_ITEMS: Record<string, unknown>[] = [
  { Id: "ser-parallel", Name: "Parallel", Type: "Series", ProductionYear: 2021, CommunityRating: 7.9, Genres: ["Sci-Fi", "Drama"], DateCreated: "2026-07-01T10:00:00Z" },
  { Id: "sea-parallel-1", Name: "Season 1", Type: "Season", ParentId: "ser-parallel", SeriesId: "ser-parallel", SeriesName: "Parallel", IndexNumber: 1, DateCreated: "2026-07-01T10:05:00Z" },
  { Id: "ep-parallel-1", Name: "Pilot", Type: "Episode", SeriesId: "ser-parallel", SeriesName: "Parallel", SeasonId: "sea-parallel-1", ParentIndexNumber: 1, IndexNumber: 1, DateCreated: "2026-07-01T10:10:00Z" },
  { Id: "ep-parallel-2", Name: "Crossing", Type: "Episode", SeriesId: "ser-parallel", SeriesName: "Parallel", SeasonId: "sea-parallel-1", ParentIndexNumber: 1, IndexNumber: 2, DateCreated: "2026-07-01T10:11:00Z" }
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

  async fetchChangedItemsPage(libraryJellyfinId: string, _sinceIso: string, startIndex: number, limit: number): Promise<CatalogItemsPage> {
    return this.fetchItemsPage(libraryJellyfinId, startIndex, limit);
  }

  async fetchLibraryItemIdsPage(libraryJellyfinId: string, startIndex: number, limit: number): Promise<CatalogItemsPage> {
    return this.fetchItemsPage(libraryJellyfinId, startIndex, limit);
  }
}

// Two profiles exercising every rail kind and every watch-state variant.
function householdSnapshot(): Record<string, unknown> {
  return {
    profiles: [
      {
        name: "Vali",
        isDefault: true,
        preferences: { theme: "dark", autoplay_next: true },
        favorites: [
          { jellyfinId: "mov-arrival", addedAt: "2026-08-01T12:00:00Z" },
          { jellyfinId: "mov-drama", addedAt: "2026-08-02T12:00:00Z" }
        ],
        watchlists: [
          {
            name: "Movie Night",
            entries: [{ jellyfinId: "mov-fresh", addedAt: "2026-08-03T12:00:00Z" }]
          }
        ],
        homeRows: [
          { kind: "continue_watching", title: "Continue Watching" },
          { kind: "recently_added", title: "Recently Added" },
          { kind: "favorites", title: "Favorites" },
          { kind: "library", title: "Movies", config: { library_jellyfin_id: "lib-movies" } },
          { kind: "collection", title: "Family Picks", config: { collection_slug: "family_picks" } },
          { kind: "watchlist", title: "Movie Night", config: { watchlist_slug: "movie_night" } },
          { kind: "collection", title: "Ghost Rail", config: { collection_slug: "ghost_picks" } },
          { kind: "library", title: "Missing", config: { library_jellyfin_id: "lib-missing" } },
          { kind: "favorites", title: "Off Favorites", enabled: false }
        ],
        watchState: [
          { jellyfinId: "mov-arrival", positionTicks: 600_000_000, durationTicks: 1_830_000_000, completed: false, lastPlayedAt: "2026-09-20T02:11:00Z" },
          { jellyfinId: "mov-fresh", positionTicks: 1_800_000_000, durationTicks: 1_800_000_000, completed: true, lastPlayedAt: "2026-09-19T23:00:00Z" },
          { jellyfinId: "ep-parallel-1", positionTicks: 100_000_000, durationTicks: 2_500_000_000, completed: false, lastPlayedAt: "2026-09-21T01:00:00Z" },
          { jellyfinId: "ep-parallel-2", positionTicks: 900_000_000, durationTicks: 2_400_000_000, completed: false, lastPlayedAt: "2026-09-21T02:00:00Z" },
          { jellyfinId: "mov-blade", positionTicks: 300_000_000, durationTicks: 1_800_000_000, completed: false, hiddenFromContinue: true, lastPlayedAt: "2026-09-18T01:00:00Z" }
        ],
        playbackHistory: [
          { jellyfinId: "mov-arrival", playedAt: "2026-09-20T01:40:00Z", positionTicks: 0 },
          { jellyfinId: "mov-drama", playedAt: "2026-09-18T20:00:00Z", positionTicks: 0 },
          { jellyfinId: "ep-parallel-1", playedAt: "2026-09-21T00:30:00Z", positionTicks: 100_000_000 }
        ]
      },
      {
        name: "Nicole",
        favorites: [{ jellyfinId: "mov-recent", addedAt: "2026-09-01T12:00:00Z" }],
        homeRows: [{ kind: "favorites", title: "Favorites" }],
        watchState: [
          { jellyfinId: "mov-recent", positionTicks: 1_600_000_000, durationTicks: 1_600_000_000, completed: true, lastPlayedAt: "2026-09-15T01:00:00Z" }
        ]
      }
    ],
    collections: [
      {
        name: "Family Picks",
        entries: [
          { jellyfinId: "mov-arrival", addedAt: "2026-08-10T12:00:00Z" },
          { jellyfinId: "mov-drama", addedAt: "2026-08-10T12:01:00Z" },
          { jellyfinId: "mov-recent", addedAt: "2026-08-10T12:02:00Z" }
        ]
      }
    ]
  };
}

interface CaseHandle {
  read: ReadExecutor;
  pool: Pool;
}

async function withSeededHousehold(
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
    assert.deepEqual(applied.appliedNow, loadMigrationFiles(MIGRATIONS_DIR).map((file) => file.version));
    const sync = await runFullCatalogSync(new SeedCatalogSource(), createPgSyncExecutor(pool), { pageSize: 50 });
    assert.equal(sync.status, "succeeded");
    const imported = await runHouseholdImport(
      normalizeManifest(householdSnapshot()),
      createPgSyncExecutor(pool)
    );
    assert.equal(imported.status, "succeeded");
    await fn({ read: createPgReadExecutor(pool), pool });
  } finally {
    await pool.end();
    await withClient({ ...migrate, database: "postgres" }, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${TEMP_DB} WITH (FORCE)`);
    });
  }
}

async function profileIdOf(db: CaseHandle, slug: string): Promise<number> {
  const result = await db.pool.query<{ id: string }>("SELECT id FROM household_profiles WHERE slug = $1", [slug]);
  return Number(result.rows[0].id);
}

const idsOf = (rows: { jellyfin_id: string }[]) => rows.map((row) => row.jellyfin_id);
const railOf = (feed: Awaited<ReturnType<typeof homeFeed>>, slug: string) => {
  const rail = feed.rows.find((row) => row.slug === slug);
  if (!rail) throw new Error(`rail "${slug}" missing from feed`);
  return rail;
};

async function valiFeed(db: CaseHandle, limit?: number) {
  return homeFeed(db.read, { profileSlug: "vali", limit });
}

test("an empty household fails closed with a typed error; status says never_synced", async (t) => {
  const { migrate, app } = needsDb(t);
  // Dedicated throwaway database so the other cases' seeded state is untouched.
  const emptyDb = `${TEMP_DB}_empty`;
  const migrateTemp = { ...migrate, database: emptyDb };
  const appTemp = { ...app, database: emptyDb };
  await withClient({ ...migrate, database: "postgres" }, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${emptyDb} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${emptyDb}`);
  });
  const pool = new Pool({
    host: appTemp.host, port: appTemp.port, user: appTemp.user,
    password: appTemp.password, database: appTemp.database, max: 1,
    connectionTimeoutMillis: appTemp.connectionTimeoutMs
  });
  try {
    await runMigrations(migrateTemp, MIGRATIONS_DIR, appTemp.user);
    const read = createPgReadExecutor(pool);
    await assert.rejects(homeFeed(read, {}), HouseholdEmptyError);
    await assert.rejects(resolveProfile(read, "nobody"), HouseholdProfileNotFoundError);
  } finally {
    await pool.end();
    await withClient({ ...migrate, database: "postgres" }, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${emptyDb} WITH (FORCE)`);
    });
  }
});

test("profile resolution: default profile, named profile, unknown profile", async (t) => {
  await withSeededHousehold(t, async (db) => {
    const fallback = await resolveProfile(db.read, null);
    assert.equal(fallback.slug, "vali", "the active default is the fallback");
    assert.equal(fallback.is_default, true);

    const named = await resolveProfile(db.read, "nicole");
    assert.equal(named.slug, "nicole");
    assert.equal(named.is_default, false);

    await assert.rejects(resolveProfile(db.read, "ghost"), HouseholdProfileNotFoundError);
  });
});

test("every rail kind resolves against the live household and catalog state", async (t) => {
  await withSeededHousehold(t, async (db) => {
    const feed = await valiFeed(db);
    assert.equal(feed.profile.slug, "vali");
    assert.equal(feed.rows.length, 9, "all nine configured rows render, in position order");
    assert.deepEqual(
      feed.rows.map((row) => row.slug),
      [
        "continue_watching", "recently_added", "favorites", "movies",
        "family_picks", "movie_night", "ghost_rail", "missing", "off_favorites"
      ]
    );

    // Continue watching: in-progress only, newest activity first. Completed
    // (mov-fresh) and hidden (mov-blade) are excluded by the overlay.
    assert.deepEqual(idsOf(railOf(feed, "continue_watching").items), [
      "ep-parallel-2",
      "ep-parallel-1",
      "mov-arrival"
    ]);
    const firstCard = railOf(feed, "continue_watching").items[0];
    assert.equal(String(firstCard.position_ticks), "900000000", "progress rides the rail card");

    // Recently added: source DateCreated desc across all libraries.
    assert.deepEqual(idsOf(railOf(feed, "recently_added").items), [
      "mov-recent", "mov-unrated", "mov-fresh", "mov-drama", "mov-blade", "mov-arrival",
      "ep-parallel-2", "ep-parallel-1", "sea-parallel-1", "ser-parallel"
    ]);

    // Favorites: household position order.
    assert.deepEqual(idsOf(railOf(feed, "favorites").items), ["mov-arrival", "mov-drama"]);

    // Library rail: the library's active movies by title (case-insensitive,
    // "100% Fresh" sorts before letters).
    assert.deepEqual(idsOf(railOf(feed, "movies").items), [
      "mov-fresh", "mov-unrated", "mov-arrival", "mov-blade", "mov-drama", "mov-recent"
    ]);

    // Collection rail: curated household order (household-scoped, visible
    // to every profile).
    assert.deepEqual(idsOf(railOf(feed, "family_picks").items), ["mov-arrival", "mov-drama", "mov-recent"]);

    // Watchlist rail: profile-scoped list membership.
    assert.deepEqual(idsOf(railOf(feed, "movie_night").items), ["mov-fresh"]);

    // Editorial config pointing at missing targets degrades to a flagged
    // empty rail — data, not an error.
    assert.equal(railOf(feed, "ghost_rail").resolved, false);
    assert.deepEqual(railOf(feed, "ghost_rail").items, []);
    assert.equal(railOf(feed, "missing").resolved, false);
    assert.deepEqual(railOf(feed, "missing").items, []);

    // Disabled rows render empty and keep their enabled=false flag.
    assert.equal(railOf(feed, "off_favorites").enabled, false);
    assert.deepEqual(railOf(feed, "off_favorites").items, []);

    // Rail bounds: every rail is capped at the requested window.
    const capped = await valiFeed(db, 2);
    assert.equal(capped.perRailLimit, 2);
    for (const rail of capped.rows) {
      assert.ok(rail.items.length <= 2, `rail ${rail.slug} respects the cap`);
    }
    assert.deepEqual(idsOf(railOf(capped, "recently_added").items), ["mov-recent", "mov-unrated"]);
  });
});

test("the feed is profile-isolated and deterministic", async (t) => {
  await withSeededHousehold(t, async (db) => {
    const nicole = await homeFeed(db.read, { profileSlug: "nicole" });
    assert.deepEqual(nicole.rows.map((row) => row.slug), ["favorites"]);
    assert.deepEqual(idsOf(railOf(nicole, "favorites").items), ["mov-recent"], "only her favorites");

    // No rail anywhere in Nicole's feed leaks Vali's items.
    const valiIds = new Set(idsOf(railOf(await valiFeed(db), "favorites").items));
    for (const rail of nicole.rows) {
      for (const item of rail.items) {
        assert.equal(valiIds.has(item.jellyfin_id), false, "no cross-profile leakage");
      }
    }

    // Deterministic re-render: identical state → identical payload bytes.
    const first = JSON.stringify(await valiFeed(db));
    const second = JSON.stringify(await valiFeed(db));
    assert.equal(second, first);
  });
});

test("recommendation buckets are deterministic, explainable, and bounded", async (t) => {
  await withSeededHousehold(t, async (db) => {
    const valiId = await profileIdOf(db, "vali");
    const inputs = await recommendationInputs(db.read, valiId);

    // Top genres: favorites weight 2, recent history weight 1 per title.
    // Vali: favorites give Drama 2+2, Romance 2, Sci-Fi 2; the bounded recent
    // history adds Drama 1+1, Romance 1, Sci-Fi 1 → Drama 6, Romance 3,
    // Sci-Fi 3 (episode history carries no genres). Ties break A→Z.
    assert.deepEqual(
      inputs.topGenres.map((genre) => [genre.name, Number(genre.weight)]),
      [["Drama", 6], ["Romance", 3], ["Sci-Fi", 3]]
    );

    // Unwatched discovery: active movies/series in the top genres without a
    // completed watch-state row, rating then recency. Completed mov-fresh is
    // absent (and out of genres anyway); in-progress titles stay candidates.
    assert.deepEqual(idsOf(inputs.unwatchedInGenres), [
      "mov-recent", "mov-drama", "mov-blade", "mov-arrival", "ser-parallel"
    ]);

    // Next up: exactly one card per in-progress series — the newest activity.
    assert.deepEqual(idsOf(inputs.nextUpEpisodes), ["ep-parallel-2"]);

    // Quality-led recent: active movies/series, rating desc then recency
    // (both 8.5s order by DateCreated desc); NULL ratings last; seasons and
    // episodes never clutter the bucket.
    assert.deepEqual(idsOf(inputs.highlyRatedRecent), [
      "mov-recent", "mov-drama", "mov-blade", "mov-arrival", "ser-parallel", "mov-fresh", "mov-unrated"
    ]);

    // Bucket bound.
    const capped = await recommendationInputs(db.read, valiId, 3);
    assert.ok(capped.highlyRatedRecent.length <= 3);
    assert.ok(capped.unwatchedInGenres.length <= 3);

    // Deterministic re-render.
    assert.equal(
      JSON.stringify(await recommendationInputs(db.read, valiId)),
      JSON.stringify(inputs)
    );

    // Nicole's taste differs → different (still deterministic) buckets.
    const nicoleId = await profileIdOf(db, "nicole");
    const nicoleInputs = await recommendationInputs(db.read, nicoleId);
    assert.deepEqual(
      nicoleInputs.topGenres.map((genre) => [genre.name, Number(genre.weight)]),
      [["Sci-Fi", 2]]
    );
    assert.deepEqual(idsOf(nicoleInputs.unwatchedInGenres), ["mov-blade", "mov-arrival", "ser-parallel"],
      "her completed mov-recent is not recommended back to her");
  });
});

test("catalog churn drops items from rails without touching household rows", async (t) => {
  await withSeededHousehold(t, async (db) => {
    await db.pool.query("UPDATE media_items SET removed_at = now() WHERE jellyfin_id = 'mov-arrival'");

    const feed = await valiFeed(db);
    assert.deepEqual(idsOf(railOf(feed, "continue_watching").items), [
      "ep-parallel-2", "ep-parallel-1"
    ], "the removed movie leaves continue watching");
    assert.deepEqual(idsOf(railOf(feed, "favorites").items), ["mov-drama"]);
    assert.deepEqual(idsOf(railOf(feed, "family_picks").items), ["mov-drama", "mov-recent"]);
    assert.deepEqual(idsOf(railOf(feed, "recently_added").items).includes("mov-arrival"), false);

    // The household rows themselves survive the churn (tombstones, never
    // deletes) — ReelHouse state and catalog state stay separate authorities.
    const favorites = await db.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM household_favorites f
       JOIN household_profiles p ON p.id = f.profile_id
       WHERE p.slug = 'vali' AND f.removed_at IS NULL`
    );
    assert.equal(Number(favorites.rows[0].count), 2, "the household favorite row is intact");

    // And the rails recover when the catalog restores the item.
    await db.pool.query("UPDATE media_items SET removed_at = NULL WHERE jellyfin_id = 'mov-arrival'");
    const restored = await valiFeed(db);
    assert.deepEqual(idsOf(railOf(restored, "favorites").items), ["mov-arrival", "mov-drama"]);
  });
});
