// Deterministic PostgreSQL integration evidence for the RH-0040 read models.
//
// Runs against the disposable loopback PostgreSQL 18 profile — never
// Synology, never a live Jellyfin. The source side is a fake CatalogSource
// with canned payloads (the stub's baseline dataset), so every scenario is
// deterministic. Without the two role URLs every case skips and the
// hermetic `npm test` stays hermetic:
//
//   REELHOUSE_TEST_MIGRATE_URL   owner/migrator role
//   REELHOUSE_TEST_DATABASE_URL  application role
//
// Scenarios: migrations + full sync + household import as the app role, the
// configured-rails home payload (continue-watching progress, library,
// collection, watchlist rails with unresolved links skipped), profile
// isolation and explicit-slug addressing, unknown-profile fail-closed,
// bounded case-insensitive prefix-first search (wildcards escaped, injection
// inert), tombstone exclusion, the unsynced-catalog fallback contract,
// diagnostics freshness, and payload determinism.
//
// Own temporary database (reelhouse_rh0040_tmp) so it cannot collide with
// the other integration suites even as a parallel node --test process.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Client, Pool } from "pg";
import { loadDatabaseConfig, type DatabaseConfig } from "../db/config.ts";
import { loadMigrationFiles, runMigrations } from "../db/migrator.ts";
import { createPgSyncExecutor } from "../catalog/pg-executor.ts";
import { runFullCatalogSync } from "../catalog/sync.ts";
import type { CatalogLibrary, CatalogItemsPage, CatalogRawItem, CatalogSource } from "../catalog/source.ts";
import { normalizeManifest } from "../household/manifest.ts";
import { runHouseholdImport } from "../household/load.ts";
import { catalogHasActiveItems, getHomePayload } from "./home.ts";
import { searchCatalog } from "./search.ts";
import { catalogDiagnostics } from "./diagnostics.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const TEMP_DB = "reelhouse_rh0040_tmp";
const SAMPLE_MANIFEST = fileURLToPath(
  new URL("../../../scripts/dev/household-sample.json", import.meta.url)
);

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

// The stub's baseline dataset (scripts/dev/jellyfin-stub.mjs), embedded so
// the suite stays network-free: fixed DateLastSaved for the watermark,
// image tags and a DateCreated on Arrival for the hero path, one PhotoAlbum
// the sync filters out.
const SAVED = "2024-01-01T00:00:00.000Z";

class BaselineSource implements CatalogSource {
  libraries: CatalogLibrary[] = [
    { jellyfinId: "lib-movies", name: "Movies", collectionType: "movies" },
    { jellyfinId: "lib-tv", name: "TV Shows", collectionType: "tvshows" }
  ];

  private itemsByLibrary = new Map<string, CatalogRawItem[]>([
    [
      "lib-movies",
      [
        {
          Id: "mov-arrival",
          Name: "Arrival",
          Type: "Movie",
          Overview: "A linguist works with the military to communicate with alien lifeforms.",
          ProductionYear: 2016,
          PremiereDate: "2016-11-10T00:00:00.000Z",
          CommunityRating: 7.9,
          OfficialRating: "PG-13",
          RunTimeTicks: 1_830_000_000,
          SortName: "arrival",
          Genres: ["Science fiction", "Drama"],
          Studios: ["Paramount"],
          People: [{ Name: "Amy Adams", Type: "Actor", Role: "Louise Banks", Id: "person-amy" }],
          ProviderIds: { Imdb: "tt2543164", Tmdb: "329865" },
          ImageTags: { Primary: "arrival-primary" },
          BackdropImageTags: ["arrival-backdrop"],
          Etag: "etag-arrival",
          DateCreated: "2023-05-01T12:00:00.000Z",
          DateLastSaved: SAVED,
          MediaSources: [
            { Container: "mkv", Path: "/media/movies/arrival.mkv", Size: 3_000_000_000, MediaStreams: [] }
          ]
        },
        { Id: "mov-bare", Name: "Bare Movie", Type: "Movie", DateLastSaved: SAVED },
        {
          Id: "mov-blank",
          Name: "Blank Check",
          Type: "Movie",
          ProductionYear: 1994,
          CommunityRating: 6.1,
          Genres: ["Comedy", "Family"],
          RunTimeTicks: 1_620_000_000,
          DateLastSaved: SAVED
        }
      ]
    ],
    [
      "lib-tv",
      [
        {
          Id: "ser-demo",
          Name: "Demo Show",
          Type: "Series",
          ProductionYear: 2020,
          Overview: "A deterministic demonstration series.",
          Genres: ["Comedy"],
          Studios: ["Demo Studio"],
          ProviderIds: { Tvdb: "12345" },
          Etag: "etag-demo",
          DateLastSaved: SAVED
        },
        {
          Id: "sea-demo-1",
          Name: "Season 1",
          Type: "Season",
          IndexNumber: 1,
          SeriesId: "ser-demo",
          SeriesName: "Demo Show",
          DateLastSaved: SAVED
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
          DateLastSaved: SAVED,
          MediaSources: [{ Container: "mp4", Path: "/media/tv/demo/s01e01.mp4", Size: 500_000_000, MediaStreams: [] }]
        },
        {
          Id: "ep-demo-2",
          Name: "Episode Two",
          Type: "Episode",
          IndexNumber: 2,
          ParentIndexNumber: 1,
          SeasonId: "sea-demo-1",
          SeriesId: "ser-demo",
          SeriesName: "Demo Show",
          DateLastSaved: SAVED
        },
        { Id: "vid-home", Name: "Home Video Clip", Type: "Video", Path: "/home/clips/clip.mp4", DateLastSaved: SAVED },
        { Id: "pic-album", Name: "Photo Album", Type: "PhotoAlbum", DateLastSaved: SAVED }
      ]
    ]
  ]);

  async listLibraries(): Promise<CatalogLibrary[]> {
    return this.libraries.map((library) => ({ ...library }));
  }

  async fetchItemsPage(libraryJellyfinId: string, startIndex: number, limit: number): Promise<CatalogItemsPage> {
    const items = this.itemsByLibrary.get(libraryJellyfinId) ?? [];
    return { items: items.slice(startIndex, startIndex + limit), totalRecordCount: items.length };
  }

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

interface CaseHandle {
  migrate: DatabaseConfig;
  app: DatabaseConfig;
  appPool: Pool;
}

async function withCase(
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
      "all on-disk migrations apply to a fresh database (incl. 0008 read-model indexes)"
    );
    await fn({ migrate: migrateTemp, app: appTemp, appPool });
  } finally {
    await appPool.end();
    await withClient({ ...migrate, database: "postgres" }, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${TEMP_DB} WITH (FORCE)`);
    });
  }
}

// Shared state for a seeded case: full catalog sync + household sample.
async function seedFixture(appPool: Pool): Promise<void> {
  const executor = createPgSyncExecutor(appPool);
  await runFullCatalogSync(new BaselineSource(), executor);
  const manifest = normalizeManifest(JSON.parse(readFileSync(SAMPLE_MANIFEST, "utf8")));
  await runHouseholdImport(manifest, executor);
}

const IMAGE_ENV = { NEXT_PUBLIC_JELLYFIN_URL: "http://jf:8096" };

test("unsynced catalog: home reports empty-catalog and search stays empty without 404", async (t) => {
  await withCase(t, async ({ appPool }) => {
    const executor = createPgSyncExecutor(appPool);
    assert.equal(await catalogHasActiveItems(executor), false);
    assert.deepEqual(await getHomePayload(executor, { env: IMAGE_ENV }), { kind: "empty-catalog" });

    const page = await searchCatalog(executor, "arrival", { env: IMAGE_ENV });
    assert.deepEqual(page.items, []);
    // Diagnostics read fine against the migrated-but-empty schema.
    const diagnostics = await catalogDiagnostics(executor);
    assert.equal(diagnostics.state, "ok");
    assert.equal(diagnostics.activeItems, 0);
    assert.equal(diagnostics.watermark, undefined);
  });
});

test("configured rails serve the household payload with resolved catalog links", async (t) => {
  await withCase(t, async ({ appPool }) => {
    await seedFixture(appPool);
    const executor = createPgSyncExecutor(appPool);

    const result = await getHomePayload(executor, { env: IMAGE_ENV });
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    const { payload } = result;

    assert.equal(payload.source, "catalog");
    // V’Ali is the default profile; her six configured rows all resolve.
    assert.deepEqual(
      payload.sections.map((section) => section.title),
      ["Continue Watching", "Recently Added", "Movies", "TV Shows", "Family Picks", "Movie Night"]
    );

    const continueSection = payload.sections[0];
    assert.deepEqual(continueSection.items.map((item) => item.id), ["ep-demo-1"]);
    assert.equal(continueSection.items[0].progress, 40); // 600M / 1500M ticks
    // mov-bare is completed AND hidden from continue — never on the rail.

    const recent = payload.sections[1];
    // Arrival carries the fixture's only DateCreated (newest, NULLS LAST for
    // the rest); ties break by id, so the sync's insert order shows through.
    assert.deepEqual(recent.items.map((item) => item.id), [
      "mov-arrival",
      "mov-bare",
      "mov-blank",
      "ser-demo",
      "vid-home"
    ]);

    const movies = payload.sections[2];
    assert.deepEqual(movies.items.map((item) => item.id), ["mov-arrival", "mov-bare", "mov-blank"]);

    const shows = payload.sections[3];
    // lib-tv also holds the home-video clip: Jellyfin's Video items sync as
    // movies (normalize.ts), and the library rail shows its movies + series.
    assert.deepEqual(shows.items.map((item) => item.id), ["ser-demo", "vid-home"]);

    // mov-citizen sits in the collection but the catalog has never seen it:
    // the household reference survives, the read model skips the display.
    const familyPicks = payload.sections[4];
    assert.deepEqual(familyPicks.items.map((item) => item.id), ["mov-arrival", "vid-home", "ser-demo"]);

    // mov-twin is likewise unresolved in the watchlist rail.
    const movieNight = payload.sections[5];
    assert.deepEqual(movieNight.items.map((item) => item.id), ["ep-demo-1"]);

    // Hero: newest recently-added item that carries a backdrop.
    assert.equal(payload.hero.id, "mov-arrival");
    assert.match(payload.hero.imageUrl ?? "", /Items\/mov-arrival\/Images\/Primary.*tag=arrival-primary/);
    assert.match(payload.hero.backdropUrl ?? "", /Images\/Backdrop.*tag=arrival-backdrop/);
  });
});

test("profiles are structurally isolated and explicitly addressable by slug", async (t) => {
  await withCase(t, async ({ appPool }) => {
    await seedFixture(appPool);
    const executor = createPgSyncExecutor(appPool);

    const vali = await getHomePayload(executor, { profileSlug: "v_ali", env: IMAGE_ENV });
    assert.equal(vali.kind, "ok");
    if (vali.kind !== "ok") return;
    const valiIds = new Set(vali.payload.sections.flatMap((section) => section.items.map((item) => item.id)));
    assert.ok(valiIds.has("ep-demo-1"), "V’Ali’s continue item");
    assert.ok(!valiIds.has("ep-demo-2"), "Nicole’s progress never leaks into V’Ali’s payload");

    const nicole = await getHomePayload(executor, { profileSlug: "nicole", env: IMAGE_ENV });
    assert.equal(nicole.kind, "ok");
    if (nicole.kind !== "ok") return;
    assert.deepEqual(
      nicole.payload.sections.map((section) => section.title),
      ["Continue Watching", "Nicole's Favorites", "Family Picks"]
    );
    const nicoleContinue = nicole.payload.sections[0];
    assert.deepEqual(nicoleContinue.items.map((item) => item.id), ["ep-demo-2"]);
    assert.equal(nicoleContinue.items[0].progress, 16); // 240M / 1500M ticks

    // Hero without a recently-added rail: first backdrop-bearing rail item.
    assert.equal(nicole.payload.hero.id, "mov-arrival");

    // Unknown or archived slugs fail closed as data.
    const ghost = await getHomePayload(executor, { profileSlug: "nobody", env: IMAGE_ENV });
    assert.equal(ghost.kind, "profile-not-found");
  });
});

test("search is bounded, case-insensitive, prefix-first, and injection-inert", async (t) => {
  await withCase(t, async ({ appPool }) => {
    await seedFixture(appPool);
    const executor = createPgSyncExecutor(appPool);

    const arrival = await searchCatalog(executor, "arrival", { env: IMAGE_ENV });
    assert.deepEqual(arrival.items.map((item) => item.id), ["mov-arrival"]);

    const shouting = await searchCatalog(executor, "ARRIVAL", { env: IMAGE_ENV });
    assert.deepEqual(shouting.items.map((item) => item.id), ["mov-arrival"]);

    // Prefix matches rank before substring matches, then case-folded name:
    // "a" prefixes Arrival; Bare/Blank/Season 1 merely contain an "a".
    const aPage = await searchCatalog(executor, "a", { env: IMAGE_ENV });
    assert.deepEqual(aPage.items.map((item) => item.title), [
      "Arrival",
      "Bare Movie",
      "Blank Check",
      "Season 1"
    ]);

    // Typed wildcards stay literal: nothing is named "arr%val".
    const wildcard = await searchCatalog(executor, "arr%val", { env: IMAGE_ENV });
    assert.deepEqual(wildcard.items, []);

    const injection = await searchCatalog(executor, "'; DROP TABLE media_items; --", { env: IMAGE_ENV });
    assert.deepEqual(injection.items, []);
    const stillThere = await searchCatalog(executor, "arrival", { env: IMAGE_ENV });
    assert.equal(stillThere.items.length, 1);

    // Bounds: the echoed limit is the clamp, not the request; offsets past
    // the end are empty pages, not errors.
    const bounded = await searchCatalog(executor, "a", { limit: "5000", env: IMAGE_ENV });
    assert.equal(bounded.limit, 100);
    assert.ok(bounded.items.length <= 100);
    const tail = await searchCatalog(executor, "a", { offset: "10000", env: IMAGE_ENV });
    assert.deepEqual(tail.items, []);
    assert.equal(tail.offset, 10000);
  });
});

test("tombstoned catalog rows disappear from every read model", async (t) => {
  await withCase(t, async ({ appPool }) => {
    await seedFixture(appPool);
    const executor = createPgSyncExecutor(appPool);

    await appPool.query("UPDATE media_items SET removed_at = now() WHERE jellyfin_id = 'mov-bare'");

    const result = await getHomePayload(executor, { env: IMAGE_ENV });
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    const movies = result.payload.sections.find((section) => section.title === "Movies");
    assert.deepEqual(movies?.items.map((item) => item.id), ["mov-arrival", "mov-blank"]);

    const bare = await searchCatalog(executor, "bare", { env: IMAGE_ENV });
    assert.deepEqual(bare.items, []);

    const diagnostics = await catalogDiagnostics(executor);
    assert.equal(diagnostics.activeItems, 7);
  });
});

test("payloads are deterministic across repeated reads", async (t) => {
  await withCase(t, async ({ appPool }) => {
    await seedFixture(appPool);
    const executor = createPgSyncExecutor(appPool);
    const first = await getHomePayload(executor, { env: IMAGE_ENV });
    const second = await getHomePayload(executor, { env: IMAGE_ENV });
    assert.deepEqual(first, second);

    const firstPage = await searchCatalog(executor, "a", { env: IMAGE_ENV });
    const secondPage = await searchCatalog(executor, "a", { env: IMAGE_ENV });
    assert.deepEqual(firstPage, secondPage);
  });
});

test("diagnostics report catalog freshness, watermark, and household import", async (t) => {
  await withCase(t, async ({ appPool }) => {
    await seedFixture(appPool);
    const executor = createPgSyncExecutor(appPool);
    const diagnostics = await catalogDiagnostics(executor);

    assert.equal(diagnostics.state, "ok");
    assert.equal(diagnostics.activeItems, 8);
    assert.equal(diagnostics.activeLibraries, 2);
    assert.equal(diagnostics.quarantined, 0);
    assert.equal(diagnostics.activeProfiles, 2);
    assert.equal(diagnostics.lastSyncMode, "full");
    assert.ok(diagnostics.lastSuccessfulSyncAt, "last successful sync recorded");
    assert.ok(diagnostics.lastSuccessfulImportAt, "last successful household import recorded");
    // The stub's baseline DateLastSaved seeds the watermark.
    assert.equal(diagnostics.watermark, "2024-01-01T00:00:00.000Z");
  });
});
