// Deterministic PostgreSQL + Jellyfin integration evidence for RH-0031.
//
// Runs against the disposable loopback PostgreSQL 18 profile
// (docker-compose.dev-db.yml) — never against Synology, and never against a
// live Jellyfin: the Jellyfin side is a fake CatalogSource with canned
// payloads, so every scenario is fully deterministic. Without the two role
// URLs every case skips and the hermetic `npm test` stays hermetic:
//
//   REELHOUSE_TEST_MIGRATE_URL   owner/migrator role
//   REELHOUSE_TEST_DATABASE_URL  application role
//
// Scenarios: catalog migrations apply (idempotently), first full sync under
// the least-privilege app role, idempotent re-run, rename/remove/add
// reconciliation plus resurrection, mid-run source failure with committed
// progress and recorded failure followed by a clean recovery run, the
// zero-library fail-closed guard, tombstone scoping to confirmed libraries
// only, and the app-role DDL rejection on the catalog schema.
//
// This file avoids importing pool.ts (`server-only` throws under plain
// Node) and builds its own single-purpose pools instead. It uses its own
// temporary database so it cannot interfere with the RH-0030 suite's
// bookkeeping on the shared profile, even when the two files run as
// parallel node --test processes.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { loadDatabaseConfig, type DatabaseConfig } from "../db/config.ts";
import { loadMigrationFiles, runMigrations } from "../db/migrator.ts";
import { createPgSyncExecutor } from "./pg-executor.ts";
import { CatalogSyncError, runFullCatalogSync } from "./sync.ts";
import type { CatalogLibrary, CatalogRawItem, CatalogSource, CatalogItemsPage } from "./source.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const TEMP_DB = "reelhouse_rh0031_tmp";

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

// Deterministic Jellyfin double: canned libraries and items, optional
// mid-run fault injection. Explicit fields: Node's TS strip-only mode
// rejects constructor parameter properties.
class FakeCatalogSource implements CatalogSource {
  failOnLibraryId?: string;
  libraries: CatalogLibrary[];
  private readonly itemsByLibrary: Map<string, CatalogRawItem[]>;

  constructor(libraries: CatalogLibrary[], itemsByLibrary: Map<string, CatalogRawItem[]>) {
    this.libraries = libraries;
    this.itemsByLibrary = itemsByLibrary;
  }

  async listLibraries(): Promise<CatalogLibrary[]> {
    return this.libraries.map((library) => ({ ...library }));
  }

  async fetchItemsPage(libraryJellyfinId: string, startIndex: number, limit: number): Promise<CatalogItemsPage> {
    if (this.failOnLibraryId === libraryJellyfinId && startIndex === 0) {
      throw new Error(`simulated Jellyfin outage for library ${libraryJellyfinId}`);
    }
    const items = this.itemsByLibrary.get(libraryJellyfinId) ?? [];
    return { items: items.slice(startIndex, startIndex + limit), totalRecordCount: items.length };
  }

  // The RH-0031 fixtures carry no DateLastSaved, so the delta window of a
  // seeded baseline never selects them — the full-sync scenarios stay
  // exactly as scoped.
  async fetchChangedItemsPage(
    libraryJellyfinId: string,
    sinceIso: string,
    startIndex: number,
    limit: number
  ): Promise<CatalogItemsPage> {
    const threshold = new Date(sinceIso);
    const items = (this.itemsByLibrary.get(libraryJellyfinId) ?? []).filter(
      (entry) => typeof entry.DateLastSaved === "string" && new Date(entry.DateLastSaved) >= threshold
    );
    return { items: items.slice(startIndex, startIndex + limit), totalRecordCount: items.length };
  }

  async fetchLibraryItemIdsPage(
    libraryJellyfinId: string,
    startIndex: number,
    limit: number
  ): Promise<CatalogItemsPage> {
    const items = (this.itemsByLibrary.get(libraryJellyfinId) ?? []).map((entry) => ({ Id: entry.Id }));
    return { items: items.slice(startIndex, startIndex + limit), totalRecordCount: items.length };
  }
}

function library(jellyfinId: string, name: string, collectionType: string | null): CatalogLibrary {
  return { jellyfinId, name, collectionType };
}

function baseFixture(): { libraries: CatalogLibrary[]; items: Map<string, CatalogRawItem[]> } {
  const movies: CatalogRawItem[] = [
    {
      Id: "mov-arrival",
      Name: "Arrival",
      Type: "Movie",
      Overview: "First contact.",
      ProductionYear: 2016,
      PremiereDate: "2016-11-10T00:00:00Z",
      CommunityRating: 7.9,
      OfficialRating: "PG-13",
      RunTimeTicks: 1_830_000_000,
      Genres: ["Science fiction", "Drama"],
      Studios: ["Paramount"],
      People: [
        { Name: "Denis Villeneuve", Type: "Director" },
        { Name: "Amy Adams", Type: "Actor", Role: "Louise", Id: "person-amy" },
        { Name: "Amy Adams", Type: "Actor", Role: "duplicate-entry" }
      ],
      ProviderIds: { Imdb: "tt2543164", Tmdb: "329865" },
      ImageTags: { Primary: "primary-tag" },
      BackdropImageTags: ["backdrop-tag"],
      Etag: "etag-arrival",
      DateCreated: "2023-05-01T12:00:00Z",
      MediaSources: [
        {
          Container: "mkv",
          Path: "/media/movies/arrival.mkv",
          Size: 3_000_000_000,
          MediaStreams: [
            { Type: "Video", Codec: "h264", DisplayTitle: "1080p HEVC", IsDefault: true },
            { Type: "Audio", Codec: "dts", Language: "eng", DisplayTitle: "Eng DTS" },
            { Type: "Subtitle", Codec: "srt", Language: "eng" }
          ]
        }
      ]
    },
    { Id: "mov-bare", Name: "Bare Movie", Type: "Movie" }
  ];
  const tv: CatalogRawItem[] = [
    {
      Id: "ser-demo",
      Name: "Demo Show",
      Type: "Series",
      ProductionYear: 2020,
      Genres: ["Comedy"],
      Studios: ["Demo Studio"],
      ProviderIds: { Tvdb: "12345" }
    },
    {
      Id: "sea-demo-1",
      Name: "Season 1",
      Type: "Season",
      IndexNumber: 1,
      SeriesId: "ser-demo",
      SeriesName: "Demo Show"
    },
    {
      Id: "ep-demo-1",
      Name: "Pilot",
      Type: "Episode",
      IndexNumber: 1,
      ParentIndexNumber: 1,
      SeasonId: "sea-demo-1",
      SeriesId: "ser-demo",
      SeriesName: "Demo Show",
      RunTimeTicks: 1_500_000_000,
      People: [{ Name: "Jane Creator", Type: "Writer" }],
      MediaSources: [{ Container: "mp4", Path: "/media/tv/pilot.mp4", Size: 500_000_000, MediaStreams: [] }]
    },
    { Id: "vid-home", Name: "Home Video", Type: "Video", Path: "/home/clips/clip.mp4" },
    { Id: "pic-album", Name: "Photos", Type: "PhotoAlbum" }
  ];
  return {
    libraries: [library("lib-movies", "Movies", "movies"), library("lib-tv", "TV Shows", "tvshows")],
    items: new Map([
      ["lib-movies", movies],
      ["lib-tv", tv]
    ])
  };
}

function fixtureSource(items: Map<string, CatalogRawItem[]>, libraries: CatalogLibrary[]): FakeCatalogSource {
  return new FakeCatalogSource(libraries, items);
}

interface CaseHandle {
  migrate: DatabaseConfig;
  app: DatabaseConfig;
  appPool: Pool;
}

// Fresh temporary database with catalog migrations applied, an app-role pool,
// and a guaranteed teardown.
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
      "all on-disk migrations apply to a fresh database (catalog + household + incremental)"
    );
    await fn({ migrate: migrateTemp, app: appTemp, appPool });
  } finally {
    await appPool.end();
    await withClient({ ...migrate, database: "postgres" }, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${TEMP_DB} WITH (FORCE)`);
    });
  }
}

type ItemContentRow = Record<string, unknown>;

async function itemContent(pool: Pool): Promise<ItemContentRow[]> {
  const result = await pool.query<ItemContentRow>(
    `SELECT jellyfin_id, item_type, name, original_title, sort_name, overview,
            production_year, premiere_date, community_rating, official_rating,
            runtime_ticks, container, file_path, file_size_bytes, media_streams,
            primary_image_tag, backdrop_image_tag, etag,
            parent_jellyfin_id, series_jellyfin_id, series_name,
            season_jellyfin_id, season_number, episode_number
     FROM media_items ORDER BY jellyfin_id`
  );
  return result.rows;
}

interface FacetGenresRow {
  jellyfin_id: string;
  name: string;
}

interface FacetPeopleRow {
  jellyfin_id: string;
  name: string;
  person_type: string;
  role_name: string | null;
  list_order: number;
}

interface FacetProvidersRow {
  jellyfin_id: string;
  provider_name: string;
  provider_value: string;
}

interface FacetContent {
  genres: FacetGenresRow[];
  studios: FacetGenresRow[];
  people: FacetPeopleRow[];
  providers: FacetProvidersRow[];
}

async function facetContent(pool: Pool): Promise<FacetContent> {
  const genres = await pool.query<FacetGenresRow>(
    `SELECT i.jellyfin_id, g.name FROM media_item_genres ig
     JOIN media_items i ON i.id = ig.item_id JOIN media_genres g ON g.id = ig.genre_id
     ORDER BY i.jellyfin_id, g.name`
  );
  const studios = await pool.query<FacetGenresRow>(
    `SELECT i.jellyfin_id, s.name FROM media_item_studios isx
     JOIN media_items i ON i.id = isx.item_id JOIN media_studios s ON s.id = isx.studio_id
     ORDER BY i.jellyfin_id, s.name`
  );
  const people = await pool.query<FacetPeopleRow>(
    `SELECT i.jellyfin_id, p.name, ip.person_type, ip.role_name, ip.list_order
     FROM media_item_people ip
     JOIN media_items i ON i.id = ip.item_id JOIN media_people p ON p.id = ip.person_id
     ORDER BY i.jellyfin_id, ip.list_order`
  );
  const providers = await pool.query<FacetProvidersRow>(
    `SELECT i.jellyfin_id, pi.provider_name, pi.provider_value
     FROM media_item_provider_ids pi
     JOIN media_items i ON i.id = pi.item_id
     ORDER BY i.jellyfin_id, pi.provider_name`
  );
  return {
    genres: genres.rows,
    studios: studios.rows,
    people: people.rows,
    providers: providers.rows
  };
}

async function firstSeenByItem(pool: Pool): Promise<Map<string, number>> {
  const result = await pool.query<{ jellyfin_id: string; first_seen_at: Date }>(
    "SELECT jellyfin_id, first_seen_at FROM media_items"
  );
  return new Map(result.rows.map((row) => [row.jellyfin_id, row.first_seen_at.getTime()]));
}

async function lastRun(pool: Pool): Promise<Record<string, unknown>> {
  const result = await pool.query<Record<string, unknown>>(
    "SELECT * FROM media_sync_runs ORDER BY id DESC LIMIT 1"
  );
  return result.rows[0];
}

test("catalog migrations apply idempotently and create the media_catalog tables", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await withClient(db.migrate, async (client) => {
      const applied = await client.query<{ version: number; name: string }>(
        "SELECT version, name FROM schema_migrations ORDER BY version"
      );
      assert.deepEqual(
        applied.rows.map((row) => row.version),
        loadMigrationFiles(MIGRATIONS_DIR).map((file) => file.version)
      );
      const expected = [
        "media_libraries",
        "media_items",
        "media_genres",
        "media_studios",
        "media_people",
        "media_item_genres",
        "media_item_studios",
        "media_item_people",
        "media_item_provider_ids",
        "media_sync_runs"
      ];
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name IN ('media_libraries','media_items','media_genres',
           'media_studios','media_people','media_item_genres','media_item_studios','media_item_people',
           'media_item_provider_ids','media_sync_runs')
         ORDER BY table_name`
      );
      assert.deepEqual(
        tables.rows.map((row) => row.table_name),
        [...expected].sort()
      );
    });

    // Re-running the migrator against the live schema is a no-op.
    const again = await runMigrations(db.migrate, MIGRATIONS_DIR, db.app.user);
    assert.deepEqual(again.appliedNow, []);

    // The sync-run status invariant is enforced by the schema.
    await withClient(db.app, async (client) => {
      await assert.rejects(
        client.query("INSERT INTO media_sync_runs (source, mode, status) VALUES ('jellyfin', 'full', 'exploded')"),
        /media_sync_runs_status_check/
      );
    });
  });
});

test("first full sync loads libraries, items, facets, and file state under the app role", async (t) => {
  await withFreshCatalog(t, async (db) => {
    const fixture = baseFixture();
    const source = fixtureSource(fixture.items, fixture.libraries);
    const result = await runFullCatalogSync(source, createPgSyncExecutor(db.appPool), { pageSize: 50 });

    assert.equal(result.status, "succeeded");
    assert.equal(result.librariesSeen, 2);
    assert.equal(result.itemsSeen, 7);
    assert.equal(result.itemsUpserted, 6);
    assert.equal(result.itemsSkipped, 1);
    assert.equal(result.itemsTombstoned, 0);
    assert.equal(result.pagesFetched, 2, "one bounded page per library at pageSize 50");

    const libraries = await db.appPool.query<{ jellyfin_id: string; name: string; collection_type: string | null; removed_at: Date | null }>(
      "SELECT jellyfin_id, name, collection_type, removed_at FROM media_libraries ORDER BY jellyfin_id"
    );
    assert.deepEqual(libraries.rows, [
      { jellyfin_id: "lib-movies", name: "Movies", collection_type: "movies", removed_at: null },
      { jellyfin_id: "lib-tv", name: "TV Shows", collection_type: "tvshows", removed_at: null }
    ]);

    const items = await itemContent(db.appPool);
    assert.equal(items.length, 6);
    const arrival = items.find((row) => row.jellyfin_id === "mov-arrival") as Record<string, unknown>;
    assert.equal(arrival.item_type, "movie");
    assert.equal(arrival.name, "Arrival");
    assert.equal(arrival.community_rating, "7.9");
    assert.equal(arrival.runtime_ticks, "1830000000");
    assert.equal(arrival.file_path, "/media/movies/arrival.mkv");
    assert.equal(arrival.file_size_bytes, "3000000000");
    assert.equal(arrival.primary_image_tag, "primary-tag");
    const streams = arrival.media_streams as unknown[];
    assert.equal(streams.length, 3);

    const facets = await facetContent(db.appPool);
    assert.deepEqual(facets.genres, [
      { jellyfin_id: "mov-arrival", name: "Drama" },
      { jellyfin_id: "mov-arrival", name: "Science fiction" },
      { jellyfin_id: "ser-demo", name: "Comedy" }
    ]);
    assert.deepEqual(facets.studios, [
      { jellyfin_id: "mov-arrival", name: "Paramount" },
      { jellyfin_id: "ser-demo", name: "Demo Studio" }
    ]);
    assert.deepEqual(facets.providers, [
      { jellyfin_id: "mov-arrival", provider_name: "Imdb", provider_value: "tt2543164" },
      { jellyfin_id: "mov-arrival", provider_name: "Tmdb", provider_value: "329865" },
      { jellyfin_id: "ser-demo", provider_name: "Tvdb", provider_value: "12345" }
    ]);
    // Duplicate people entries collapse; list_order follows payload order (1-based).
    const arrivalPeople = facets.people.filter((row) => row.jellyfin_id === "mov-arrival");
    assert.deepEqual(
      arrivalPeople.map((row) => [row.name, row.person_type, row.role_name]),
      [
        ["Denis Villeneuve", "Director", null],
        ["Amy Adams", "Actor", "Louise"]
      ]
    );
    const episodePeople = facets.people.filter((row) => row.jellyfin_id === "ep-demo-1");
    assert.equal(episodePeople.length, 1);
    assert.equal(episodePeople[0].person_type, "Writer");

    // The home Video item normalized as a movie with its file path.
    const homeVideo = items.find((row) => row.jellyfin_id === "vid-home") as Record<string, unknown>;
    assert.equal(homeVideo.item_type, "movie");
    assert.equal(homeVideo.file_path, "/home/clips/clip.mp4");

    const run = await lastRun(db.appPool);
    assert.equal(run.status, "succeeded");
    assert.equal(run.mode, "full");
    assert.equal(Number(run.libraries_seen), 2);
    assert.equal(Number(run.items_seen), 7);
    assert.equal(Number(run.items_upserted), 6);
    assert.equal(Number(run.items_skipped), 1);
    assert.equal(Number(run.pages_fetched), 2);
    assert.ok(run.finished_at !== null);
    assert.equal(run.error_detail, null);
  });
});

test("re-running an unchanged sync rewrites nothing and appends only history", async (t) => {
  await withFreshCatalog(t, async (db) => {
    const fixture = baseFixture();
    const source = fixtureSource(fixture.items, fixture.libraries);
    await runFullCatalogSync(source, createPgSyncExecutor(db.appPool), { pageSize: 50 });

    const contentBefore = await itemContent(db.appPool);
    const facetsBefore = await facetContent(db.appPool);
    const firstSeenBefore = await firstSeenByItem(db.appPool);
    const syncedAtBefore = await db.appPool.query<{ synced_at: Date }>(
      "SELECT synced_at FROM media_items WHERE jellyfin_id = 'mov-arrival'"
    );

    const second = await runFullCatalogSync(source, createPgSyncExecutor(db.appPool), { pageSize: 50 });

    assert.equal(second.status, "succeeded");
    assert.equal(second.itemsUpserted, 6);
    assert.equal(second.itemsTombstoned, 0);

    assert.deepEqual(await itemContent(db.appPool), contentBefore);
    assert.deepEqual(await facetContent(db.appPool), facetsBefore);

    // first_seen_at never moves; freshness does.
    const firstSeenAfter = await firstSeenByItem(db.appPool);
    assert.equal(firstSeenAfter.size, firstSeenBefore.size);
    for (const [id, seenAt] of firstSeenBefore) {
      assert.equal(firstSeenAfter.get(id), seenAt);
    }
    const syncedAtAfter = await db.appPool.query<{ synced_at: Date }>(
      "SELECT synced_at FROM media_items WHERE jellyfin_id = 'mov-arrival'"
    );
    assert.ok(
      syncedAtAfter.rows[0].synced_at.getTime() >= syncedAtBefore.rows[0].synced_at.getTime()
    );

    const counts = await db.appPool.query<{ items: string; runs: string }>(
      "SELECT (SELECT count(*) FROM media_items) AS items, (SELECT count(*) FROM media_sync_runs) AS runs"
    );
    assert.equal(Number(counts.rows[0].items), 6, "no new item rows appear");
    assert.equal(Number(counts.rows[0].runs), 2, "one history row per run");
  });
});

test("a later run updates, tombstones, and resurrects without losing provenance", async (t) => {
  await withFreshCatalog(t, async (db) => {
    const original = baseFixture();
    const executor = createPgSyncExecutor(db.appPool);
    await runFullCatalogSync(fixtureSource(original.items, original.libraries), executor, { pageSize: 50 });
    const firstSeen = await firstSeenByItem(db.appPool);

    // Rename mov-bare in place, remove mov-arrival, add mov-new.
    const mutated = baseFixture();
    const mutatedMovies = (mutated.items.get("lib-movies") ?? [])
      .filter((item) => item.Id !== "mov-arrival")
      .map((item) => (item.Id === "mov-bare" ? { ...item, Name: "Bare Movie (Renamed)" } : item));
    mutatedMovies.push({ Id: "mov-new", Name: "New Arrival", Type: "Movie", ProductionYear: 2026 });
    mutated.items.set("lib-movies", mutatedMovies);

    const second = await runFullCatalogSync(fixtureSource(mutated.items, mutated.libraries), executor, { pageSize: 50 });
    assert.equal(second.itemsUpserted, 6);
    assert.equal(second.itemsTombstoned, 1);

    const rows = await db.appPool.query<{ jellyfin_id: string; name: string; removed_at: Date | null }>(
      "SELECT jellyfin_id, name, removed_at FROM media_items ORDER BY jellyfin_id"
    );
    const byId = new Map(rows.rows.map((row) => [row.jellyfin_id, row]));
    assert.equal(byId.get("mov-bare")?.name, "Bare Movie (Renamed)");
    assert.ok(byId.get("mov-arrival")?.removed_at, "removed item is tombstoned, not deleted");
    assert.ok(byId.get("mov-new"));
    assert.equal(rows.rows.length, 7, "the row count grows by exactly the new item");

    // The tombstoned item's facet joins still exist (provenance preserved).
    const facets = await facetContent(db.appPool);
    assert.ok(facets.genres.some((row) => row.jellyfin_id === "mov-arrival"));

    // Resurrection restores the item and preserves first_seen_at.
    await runFullCatalogSync(fixtureSource(original.items, original.libraries), executor, { pageSize: 50 });
    const resurrected = await db.appPool.query<{ removed_at: Date | null }>(
      "SELECT removed_at FROM media_items WHERE jellyfin_id = 'mov-arrival'"
    );
    assert.equal(resurrected.rows[0].removed_at, null);
    const firstSeenAfter = await firstSeenByItem(db.appPool);
    assert.equal(firstSeenAfter.get("mov-arrival"), firstSeen.get("mov-arrival"));
  });
});

test("a mid-run source failure records a failed run, keeps committed progress, and recovers", async (t) => {
  await withFreshCatalog(t, async (db) => {
    const fixture = baseFixture();
    const failing = fixtureSource(fixture.items, fixture.libraries);
    failing.failOnLibraryId = "lib-tv";
    const executor = createPgSyncExecutor(db.appPool);

    await assert.rejects(
      runFullCatalogSync(failing, executor, { pageSize: 50 }),
      (error: unknown) => {
        assert.ok(error instanceof CatalogSyncError);
        assert.match(error.message, /simulated Jellyfin outage for library lib-tv/);
        assert.equal(error.summary.status, "failed");
        assert.equal(error.summary.itemsUpserted, 2, "only the movies page stayed committed");
        return true;
      }
    );

    const failedRun = await lastRun(db.appPool);
    assert.equal(failedRun.status, "failed");
    assert.match(String(failedRun.error_detail), /simulated Jellyfin outage/);
    assert.ok(failedRun.finished_at !== null);

    const partial = await db.appPool.query<{ count: string }>(
      "SELECT count(*) AS count FROM media_items i JOIN media_libraries l ON l.id = i.library_id WHERE l.jellyfin_id = 'lib-movies'"
    );
    assert.equal(Number(partial.rows[0].count), 2, "the completed batch is durable");

    // Recovery: a healthy source run completes the reconciliation.
    const recovery = await runFullCatalogSync(fixtureSource(fixture.items, fixture.libraries), executor, { pageSize: 50 });
    assert.equal(recovery.status, "succeeded");
    assert.equal(recovery.itemsUpserted, 6);

    const total = await db.appPool.query<{ count: string }>("SELECT count(*) AS count FROM media_items");
    assert.equal(Number(total.rows[0].count), 6);
    const runs = await db.appPool.query<{ statuses: string[] }>(
      "SELECT array_agg(status ORDER BY id) AS statuses FROM media_sync_runs"
    );
    assert.deepEqual(runs.rows[0].statuses, ["failed", "succeeded"]);
  });
});

test("pagination splits a large library into bounded pages without losing items", async (t) => {
  await withFreshCatalog(t, async (db) => {
    const bulk = Array.from({ length: 55 }, (_, index) => ({
      Id: `mov-bulk-${String(index).padStart(3, "0")}`,
      Name: `Bulk Movie ${index}`,
      Type: "Movie"
    }));
    const source = new FakeCatalogSource(
      [library("lib-bulk", "Bulk", "movies")],
      new Map([["lib-bulk", bulk]])
    );
    const result = await runFullCatalogSync(source, createPgSyncExecutor(db.appPool), { pageSize: 50 });

    assert.equal(result.status, "succeeded");
    assert.equal(result.pagesFetched, 2, "55 items at pageSize 50 need exactly two pages");
    assert.equal(result.itemsUpserted, 55);
    assert.equal(result.itemsTombstoned, 0);
    const count = await db.appPool.query<{ count: string }>("SELECT count(*) AS count FROM media_items");
    assert.equal(Number(count.rows[0].count), 55, "paged upserts lose and duplicate nothing");
  });
});

test("the zero-library guard and tombstone scoping never destroy unconfirmed state", async (t) => {
  await withFreshCatalog(t, async (db) => {
    const fixture = baseFixture();
    const executor = createPgSyncExecutor(db.appPool);
    await runFullCatalogSync(fixtureSource(fixture.items, fixture.libraries), executor, { pageSize: 50 });

    // A library that exists in the database but is not reported by the
    // source, with an item in it.
    await db.appPool.query(
      `INSERT INTO media_libraries (source, jellyfin_id, name) VALUES ('jellyfin', 'lib-ghost', 'Ghost Library')`
    );
    const ghost = await db.appPool.query<{ id: string }>(
      "SELECT id FROM media_libraries WHERE jellyfin_id = 'lib-ghost'"
    );
    await db.appPool.query(
      `INSERT INTO media_items (source, jellyfin_id, library_id, item_type, name)
       VALUES ('jellyfin', 'ghost-item', $1, 'movie', 'Ghost Item')`,
      [Number(ghost.rows[0].id)]
    );

    // A source reporting zero libraries must not wipe the catalog.
    const empty = new FakeCatalogSource([], new Map());
    await assert.rejects(
      runFullCatalogSync(empty, executor, { pageSize: 50 }),
      (error: unknown) => {
        assert.ok(error instanceof CatalogSyncError);
        assert.match(error.message, /refusing to reconcile the catalog to empty/);
        return true;
      }
    );
    const afterEmpty = await db.appPool.query<{ count: string }>(
      "SELECT count(*) AS count FROM media_items WHERE removed_at IS NULL"
    );
    assert.equal(Number(afterEmpty.rows[0].count), 7, "everything survives the refused run");

    // A normal run tombstones the unreported library but never touches items
    // of libraries it did not confirm this run.
    await runFullCatalogSync(fixtureSource(fixture.items, fixture.libraries), executor, { pageSize: 50 });
    const ghostState = await db.appPool.query<{ lib_removed: Date | null; item_removed: Date | null }>(
      `SELECT l.removed_at AS lib_removed, i.removed_at AS item_removed
       FROM media_libraries l JOIN media_items i ON i.library_id = l.id
       WHERE l.jellyfin_id = 'lib-ghost'`
    );
    assert.ok(ghostState.rows[0].lib_removed, "the vanished library is tombstoned");
    assert.equal(ghostState.rows[0].item_removed, null, "unconfirmed items are left untouched");

    // And the DDL lock holds on the catalog schema itself.
    await withClient(db.app, async (client) => {
      await assert.rejects(
        client.query("CREATE TABLE public.rh0031_escalate (id integer)"),
        /permission denied for schema public/
      );
    });
  });
});
