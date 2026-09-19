// Integration tests for the Jellyfin -> media_catalog synchronization against
// the disposable PostgreSQL 18 instance (same lifecycle as the db suites).
//
//   npm run test:db:up      start the disposable database (docker compose)
//   npm run test:db         run all integration suites (this one included)
//   npm run test:db:down    stop and discard the database
//
// The catalog suite drives its own database (reelhouse_catalog_test) inside
// the same disposable container and creates it on demand, so it never fights
// the other suites and never touches the production Synology target. Jellyfin
// is simulated by a fixture client: nothing here requires network access and
// nothing can modify a real Jellyfin server.

import { strict as assert } from "node:assert";
import { before, beforeEach, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { CATALOG_URL_VAR } from "./config.ts";
import { JellyfinSyncError, type JellyfinCatalogClient } from "./jellyfin-client.ts";
import type { JellyfinItemRaw, JellyfinLibraryRaw } from "./model.ts";
import { runCatalogSync } from "./sync.ts";
import { runMigrations } from "../db/migrator.ts";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_test";

const CATALOG_DATABASE_URL =
  process.env.CATALOG_TEST_DATABASE_URL ??
  "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_catalog_test";

// Fresh, never-migrated database for the missing-schema fail-closed case.
const EMPTY_CATALOG_DATABASE_URL =
  process.env.CATALOG_EMPTY_TEST_DATABASE_URL ??
  "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_catalog_empty";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "db", "migrations-catalog");

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

async function createDatabaseIfMissing(adminUrl: string, name: string): Promise<void> {
  await withClient(adminUrl, async (client) => {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE ${name}`);
  });
}

async function resetCatalogTables(): Promise<void> {
  await withClient(CATALOG_DATABASE_URL, async (client) => {
    await client.query(
      "TRUNCATE catalog_item, catalog_library, catalog_quarantine, catalog_genre, catalog_studio, catalog_person, catalog_scan, catalog_sync_state CASCADE"
    );
  });
}

// ---- Fixture Jellyfin: an in-memory read-only stand-in for the API ----

class FixtureJellyfin implements JellyfinCatalogClient {
  libraries: JellyfinLibraryRaw[] = [];
  items = new Map<string, JellyfinItemRaw[]>();
  failure: JellyfinSyncError | null = null;
  lastUpdatedSince: string | null = null;

  async listLibraries(): Promise<JellyfinLibraryRaw[]> {
    if (this.failure) throw this.failure;
    return this.libraries;
  }

  async listItemPage(
    libraryExternalId: string,
    options: { startIndex: number; limit: number; includeTypes: string[]; updatedSince?: string }
  ): Promise<{ items: JellyfinItemRaw[]; totalRecorded: number }> {
    if (this.failure) throw this.failure;
    this.lastUpdatedSince = options.updatedSince ?? this.lastUpdatedSince;
    const all = (this.items.get(libraryExternalId) ?? [])
      .filter((item) => item.Type !== undefined && options.includeTypes.includes(item.Type))
      .filter((item) => {
        if (!options.updatedSince) return true;
        const saved = typeof item.DateLastSaved === "string" ? item.DateLastSaved : "";
        return saved !== "" && saved > options.updatedSince;
      })
      .sort((a, b) => (a.Id ?? "") < (b.Id ?? "") ? -1 : 1);
    return { items: all.slice(options.startIndex, options.startIndex + options.limit), totalRecorded: all.length };
  }
}

// ---- Shared fixture data ----

const T0 = new Date("2026-09-19T12:00:00.000Z");

function baseEnv(): Record<string, string> {
  return { [CATALOG_URL_VAR]: CATALOG_DATABASE_URL, MEDIA_CATALOG_RETIREMENT_DAYS: "1" };
}

function movieFixture(id: string, overrides: JellyfinItemRaw = {}): JellyfinItemRaw {
  return {
    Id: id,
    Name: `Movie ${id}`,
    Type: "Movie",
    ProductionYear: 2020,
    Overview: `Overview for ${id}`,
    ProviderIds: { Imdb: `tt0000${id}` },
    Genres: ["Drama"],
    Studios: [{ Name: "Studio One" }],
    People: [{ Name: "Ada Reel", Type: "Actor", Role: "Lead" }],
    DateLastSaved: T0.toISOString(),
    ...overrides
  };
}

async function runSync(fixture: FixtureJellyfin, mode: "incremental" | "full" | "rebuild", clock: Date, env: Record<string, string> = baseEnv()) {
  return runCatalogSync({
    env,
    client: fixture,
    mode,
    now: () => clock,
    log: () => {}
  });
}

async function itemCount(client: Client, where = "true"): Promise<number> {
  const result = await client.query(`SELECT count(*)::int AS n FROM catalog_item WHERE ${where}`);
  return result.rows[0].n;
}

async function itemRow(client: Client, externalId: string) {
  const result = await client.query(
    "SELECT * FROM catalog_item WHERE source = 'jellyfin' AND external_id = $1",
    [externalId]
  );
  return result.rows[0] ?? null;
}

async function lastScan(client: Client) {
  const result = await client.query("SELECT * FROM catalog_scan ORDER BY started_at DESC LIMIT 1");
  return result.rows[0];
}

let fixtureLibraries: JellyfinLibraryRaw[];
let fixtureItems: JellyfinItemRaw[];

before(async () => {
  await withClient(TEST_DATABASE_URL, async () => {});
  await createDatabaseIfMissing(TEST_DATABASE_URL, "reelhouse_catalog_test");
  await createDatabaseIfMissing(TEST_DATABASE_URL, "reelhouse_catalog_empty");
  // Start every run from a truly empty schema so the migration leg below is
  // deterministic even if the disposable container survived a previous run.
  await withClient(CATALOG_DATABASE_URL, async (client) => {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  });
  await runMigrations({ databaseUrl: CATALOG_DATABASE_URL, migrationsDir: MIGRATIONS_DIR, log: () => {} });
  const repeat = await runMigrations({ databaseUrl: CATALOG_DATABASE_URL, migrationsDir: MIGRATIONS_DIR, log: () => {} });
  assert.equal(repeat.applied.length, 0, "catalog migrations must be idempotent on repeat");

  fixtureLibraries = [
    { Id: "lib-movies", Name: "Movies", CollectionType: "movies" },
    { Id: "lib-tv", Name: "Shows", CollectionType: "tvshows" }
  ];
  fixtureItems = [
    movieFixture("m-1"),
    movieFixture("m-2", { ProviderIds: { Imdb: "tt0000m-2", Tmdb: "42" }, Genres: ["Drama", "Sci-Fi"] }),
    { Id: "se-1", Name: "House of Reels", Type: "Series", Genres: ["Sci-Fi"], DateLastSaved: T0.toISOString() },
    { Id: "sn-1", Name: "Season 1", Type: "Season", SeriesId: "se-1", DateLastSaved: T0.toISOString() },
    {
      Id: "ep-1",
      Name: "Pilot",
      Type: "Episode",
      SeriesId: "se-1",
      SeasonId: "sn-1",
      IndexNumber: 1,
      Path: "/media/tv/pilot.mkv",
      Container: "mkv",
      DateLastSaved: T0.toISOString()
    }
  ];
});

// Each test starts from the migrated schema with empty catalog content.
describe("catalog sync", () => {
  beforeEach(async () => {
    await resetCatalogTables();
  });

  it("fails closed with no catalog database configured", async () => {
    const fixture = new FixtureJellyfin();
    await assert.rejects(
      runCatalogSync({ env: {}, client: fixture, mode: "full", now: () => T0, log: () => {} }),
      /MEDIA_CATALOG_DATABASE_URL/
    );
  });

  it("fails closed with a bounded message when the schema was never migrated", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = fixtureLibraries;
    await assert.rejects(
      runCatalogSync({
        env: { [CATALOG_URL_VAR]: EMPTY_CATALOG_DATABASE_URL },
        client: fixture,
        mode: "full",
        now: () => T0,
        log: () => {}
      }),
      /catalog:migrate/
    );
  });

  it("creates libraries, items, taxonomies, and provider ids from a full scan", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = fixtureLibraries;
    fixture.items.set("lib-movies", [fixtureItems[0], fixtureItems[1]]);
    fixture.items.set("lib-tv", fixtureItems.slice(2));

    const result = await runSync(fixture, "full", T0);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.counts, {
      librariesSeen: 2,
      itemsSeen: 5,
      itemsUpserted: 5,
      itemsUnchanged: 0,
      itemsMissing: 0,
      itemsRetired: 0,
      itemsQuarantined: 0,
      itemsSkipped: 0
    });

    await withClient(CATALOG_DATABASE_URL, async (client) => {
      assert.equal(await itemCount(client), 5);
      const movie = await itemRow(client, "m-1");
      assert.equal(movie.name, "Movie m-1");
      assert.equal(movie.kind, "movie");
      assert.equal(movie.observed_at.toISOString(), T0.toISOString());
      assert.equal(movie.source_revision, T0.toISOString());
      const genres = await client.query(
        `SELECT g.name FROM catalog_item_genre ig JOIN catalog_genre g ON g.id = ig.genre_id
          JOIN catalog_item i ON i.id = ig.item_id WHERE i.external_id = 'm-2' ORDER BY g.name`
      );
      assert.deepEqual(genres.rows.map((row) => row.name), ["Drama", "Sci-Fi"]);
      const providers = await client.query(
        `SELECT p.provider, p.external_value FROM catalog_provider_id p JOIN catalog_item i ON i.id = p.item_id
          WHERE i.external_id = 'm-2' ORDER BY p.provider`
      );
      assert.deepEqual(providers.rows.map((row) => [row.provider, row.external_value]), [
        ["imdb", "tt0000m-2"],
        ["tmdb", "42"]
      ]);
      const episode = await itemRow(client, "ep-1");
      assert.equal(episode.parent_external_id, "sn-1");
      assert.equal(episode.path, "/media/tv/pilot.mkv");
      const people = await client.query(
        `SELECT p.name, ip.role_type, ip.role_name FROM catalog_item_person ip
          JOIN catalog_person p ON p.id = ip.person_id JOIN catalog_item i ON i.id = ip.item_id
          WHERE i.external_id = 'm-1'`
      );
      assert.deepEqual(people.rows.map((row) => [row.name, row.role_type, row.role_name]), [
        ["Ada Reel", "actor", "Lead"]
      ]);
      const scan = await lastScan(client);
      assert.equal(scan.status, "succeeded");
      assert.equal(scan.items_upserted, 5);
    });
  });

  it("repeats a full scan with no changes as a pure sighting (idempotent)", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = fixtureLibraries;
    fixture.items.set("lib-movies", [fixtureItems[0]]);
    await runSync(fixture, "full", T0);

    const later = new Date(T0.getTime() + 60_000);
    const result = await runSync(fixture, "full", later);
    assert.equal(result.counts.itemsUpserted, 0);
    assert.equal(result.counts.itemsUnchanged, 1);

    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const movie = await itemRow(client, "m-1");
      assert.equal(movie.observed_at.toISOString(), T0.toISOString(), "observed_at is the first sighting, never moved");
      assert.equal(movie.last_seen_at.toISOString(), later.toISOString(), "last_seen_at tracks the latest sighting");
      assert.equal(movie.content_hash, movie.content_hash);
      assert.equal(await itemCount(client), 1);
    });
  });

  it("updates content when the source changes, preserving the first observation", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [{ Id: "lib-movies", Name: "Movies", CollectionType: "movies" }];
    fixture.items.set("lib-movies", [movieFixture("m-1")]);
    await runSync(fixture, "full", T0);

    const before = await withClient(CATALOG_DATABASE_URL, async (client) => itemRow(client, "m-1"));

    const updated = new Date(T0.getTime() + 120_000);
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { Name: "Movie m-1 (Recut)", ProductionYear: 2021, ETag: "etag-9" })
    ]);
    const result = await runSync(fixture, "full", updated);
    assert.equal(result.counts.itemsUpserted, 1);

    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const after = await itemRow(client, "m-1");
      assert.equal(after.name, "Movie m-1 (Recut)");
      assert.equal(after.production_year, 2021);
      assert.equal(after.source_revision, "etag-9", "source revision tracks the latest content change");
      assert.equal(after.observed_at.toISOString(), before.observed_at.toISOString());
      assert.equal(after.last_seen_at.toISOString(), updated.toISOString());
    });
  });

  it("marks missing items, retires them after the threshold, and restores them on return", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [{ Id: "lib-movies", Name: "Movies", CollectionType: "movies" }];
    fixture.items.set("lib-movies", [movieFixture("m-1"), movieFixture("m-2")]);
    await runSync(fixture, "full", T0);

    // m-2 disappears: first full scan marks it missing (not yet retired).
    fixture.items.set("lib-movies", [movieFixture("m-1")]);
    const scan1 = await runSync(fixture, "full", new Date(T0.getTime() + 60_000));
    assert.equal(scan1.counts.itemsMissing, 1);
    assert.equal(scan1.counts.itemsRetired, 0);

    // Before the threshold elapses nothing is retired and nothing is deleted.
    const mid = new Date(T0.getTime() + 12 * 60 * 60 * 1000);
    const scanMid = await runSync(fixture, "full", mid);
    assert.equal(scanMid.counts.itemsMissing, 0, "already-missing items are not re-marked");
    assert.equal(scanMid.counts.itemsRetired, 0);

    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const missing = await itemRow(client, "m-2");
      assert.equal(missing.missing_since.toISOString(), new Date(T0.getTime() + 60_000).toISOString());
      assert.equal(missing.retired_at, null);
    });

    // Past the 1-day threshold the same scan retires the row (non-destructive).
    const afterThreshold = new Date(T0.getTime() + 2 * 24 * 60 * 60 * 1000);
    const scan2 = await runSync(fixture, "full", afterThreshold);
    assert.equal(scan2.counts.itemsRetired, 1);

    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const retired = await itemRow(client, "m-2");
      assert.ok(retired.retired_at !== null, "missing_since passed the threshold so the item is retired");
      assert.equal(retired.name, "Movie m-2", "retirement keeps the row");
      assert.equal(await itemCount(client), 2, "nothing was deleted");
    });

    // The item reappears: restored in place, not duplicated.
    fixture.items.set("lib-movies", [movieFixture("m-1"), movieFixture("m-2")]);
    const scan3 = await runSync(fixture, "full", new Date(afterThreshold.getTime() + 60_000));
    assert.equal(scan3.counts.itemsUpserted, 0, "restoring unchanged content is a sighting, not a rewrite");
    assert.equal(scan3.counts.itemsUnchanged, 2);
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const restored = await itemRow(client, "m-2");
      assert.equal(restored.retired_at, null);
      assert.equal(restored.missing_since, null);
      assert.equal(await itemCount(client), 2);
    });
  });

  it("quarantines an item claiming a provider id another item already holds", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [{ Id: "lib-movies", Name: "Movies", CollectionType: "movies" }];
    fixture.items.set("lib-movies", [movieFixture("m-1", { ProviderIds: { Imdb: "tt111" } })]);
    await runSync(fixture, "full", T0);

    fixture.items.set("lib-movies", [
      movieFixture("m-1", { ProviderIds: { Imdb: "tt111" } }),
      movieFixture("m-3", { ProviderIds: { Imdb: "tt111" }, Name: "Impostor" })
    ]);
    const result = await runSync(fixture, "full", new Date(T0.getTime() + 60_000));
    assert.equal(result.counts.itemsQuarantined, 1);
    assert.equal(result.counts.itemsUpserted, 0);

    await withClient(CATALOG_DATABASE_URL, async (client) => {
      assert.equal(await itemRow(client, "m-3"), null, "ambiguous identity must not be written");
      const quarantine = await client.query("SELECT * FROM catalog_quarantine WHERE external_id = 'm-3'");
      assert.equal(quarantine.rowCount, 1);
      assert.equal(quarantine.rows[0].reason, "duplicate_provider_id");
      assert.equal(quarantine.rows[0].detail.heldBy, "m-1");
      assert.equal(quarantine.rows[0].resolved_at, null);
      const scan = await lastScan(client);
      assert.equal(scan.status, "succeeded", "a quarantine is a recorded outcome, not a failed scan");
    });

    // The upstream ambiguity is fixed: the item syncs and the record resolves.
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { ProviderIds: { Imdb: "tt111" } }),
      movieFixture("m-3", { ProviderIds: { Imdb: "tt333" }, Name: "Impostor" })
    ]);
    const healed = await runSync(fixture, "full", new Date(T0.getTime() + 120_000));
    assert.equal(healed.counts.itemsUpserted, 1);
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      assert.ok(await itemRow(client, "m-3"), "the challenger syncs once unambiguous");
      const quarantine = await client.query("SELECT resolved_at FROM catalog_quarantine WHERE external_id = 'm-3'");
      assert.equal(quarantine.rowCount, 1);
      assert.ok(quarantine.rows[0].resolved_at !== null, "resolution is recorded once the item syncs");
    });
  });

  it("quarantines an orphaned child and accepts it once its parent exists", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [{ Id: "lib-tv", Name: "Shows", CollectionType: "tvshows" }];
    fixture.items.set("lib-tv", [
      { Id: "ep-9", Name: "Orphan Episode", Type: "Episode", SeriesId: "ghost", SeasonId: "sn-ghost" }
    ]);
    const result = await runSync(fixture, "full", T0);
    assert.equal(result.counts.itemsQuarantined, 1);
    assert.equal(result.counts.itemsUpserted, 0);

    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const quarantine = await client.query("SELECT reason, detail FROM catalog_quarantine WHERE external_id = 'ep-9'");
      assert.equal(quarantine.rowCount, 1);
      assert.equal(quarantine.rows[0].reason, "orphan_parent");
      assert.equal(await itemCount(client), 0);
    });

    fixture.items.set("lib-tv", [
      { Id: "sn-ghost", Name: "Season 1", Type: "Season", SeriesId: "ghost" },
      { Id: "ep-9", Name: "Orphan Episode", Type: "Episode", SeriesId: "ghost", SeasonId: "sn-ghost" }
    ]);
    // The series itself is still missing: the season is a new orphan, and the
    // episode re-quarantines because its parent still is not in the database.
    const scan2 = await runSync(fixture, "full", new Date(T0.getTime() + 60_000));
    assert.equal(scan2.counts.itemsQuarantined, 2);
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const quarantine = await client.query("SELECT external_id FROM catalog_quarantine WHERE resolved_at IS NULL ORDER BY external_id");
      assert.deepEqual(quarantine.rows.map((row) => row.external_id), ["ep-9", "sn-ghost"]);
    });

    fixture.items.set("lib-tv", [
      { Id: "ghost", Name: "Ghost Show", Type: "Series" },
      { Id: "sn-ghost", Name: "Season 1", Type: "Season", SeriesId: "ghost" },
      { Id: "ep-9", Name: "Orphan Episode", Type: "Episode", SeriesId: "ghost", SeasonId: "sn-ghost" }
    ]);
    const healed = await runSync(fixture, "full", new Date(T0.getTime() + 120_000));
    assert.equal(healed.counts.itemsUpserted, 3);
    assert.equal(healed.counts.itemsQuarantined, 0);
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      assert.equal(await itemCount(client), 3);
      const open = await client.query("SELECT count(*)::int AS n FROM catalog_quarantine WHERE resolved_at IS NULL");
      assert.equal(open.rows[0].n, 0, "all quarantine records resolved once the family synced");
    });
  });

  it("quarantines an item that a second library also claims", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = fixtureLibraries;
    fixture.items.set("lib-movies", [movieFixture("m-1")]);
    fixture.items.set("lib-tv", [movieFixture("m-1", { Name: "Duplicate Claim" })]);
    await runSync(fixture, "full", T0);

    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const owner = await itemRow(client, "m-1");
      assert.equal(owner.name, "Movie m-1", "the first sighting keeps the item");
      const quarantine = await client.query("SELECT reason FROM catalog_quarantine WHERE external_id = 'm-1'");
      assert.equal(quarantine.rowCount, 1);
      assert.equal(quarantine.rows[0].reason, "library_conflict");
    });
  });

  it("quarantines a duplicate payload of the same id within one run", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [{ Id: "lib-movies", Name: "Movies", CollectionType: "movies" }];
    fixture.items.set("lib-movies", [movieFixture("m-1"), movieFixture("m-1", { Name: "Twin" })]);
    const result = await runSync(fixture, "full", T0);
    assert.equal(result.counts.itemsUpserted, 1);
    assert.equal(result.counts.itemsQuarantined, 1);
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const quarantine = await client.query("SELECT reason FROM catalog_quarantine WHERE external_id = 'm-1'");
      assert.equal(quarantine.rows[0].reason, "duplicate_external_id");
    });
  });

  it("records a failed, redacted, bounded scan when Jellyfin fails and recovers on rerun", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [{ Id: "lib-movies", Name: "Movies", CollectionType: "movies" }];
    fixture.items.set("lib-movies", [movieFixture("m-1")]);
    fixture.failure = new JellyfinSyncError("Jellyfin API returned 503 Service Unavailable (/Items)", 503);

    await assert.rejects(
      runSync(fixture, "full", T0),
      /Catalog sync failed: Jellyfin API returned 503/
    );
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const scan = await lastScan(client);
      assert.equal(scan.status, "failed");
      assert.match(scan.error, /503/);
      assert.ok(!scan.error.includes(SECRET_PAIR), "failure detail must never carry credentials");
      assert.ok(scan.error.length <= 2000, "failure detail is bounded");
      assert.equal(await itemCount(client), 0);
      const state = await client.query("SELECT last_error FROM catalog_sync_state WHERE job = 'jellyfin_catalog'");
      assert.match(state.rows[0].last_error, /503/);
      assert.ok(!state.rows[0].last_error.includes(SECRET_PAIR));
    });

    fixture.failure = null;
    const healed = await runSync(fixture, "full", new Date(T0.getTime() + 60_000));
    assert.equal(healed.status, "succeeded", "the next scan recovers");
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      assert.equal(await itemCount(client), 1);
      const scans = await client.query("SELECT status FROM catalog_scan ORDER BY started_at");
      assert.deepEqual(scans.rows.map((row) => row.status), ["failed", "succeeded"], "history is kept");
    });
  });

  it("incremental scans use the recorded cursor, touch only changes, and never retire", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [{ Id: "lib-movies", Name: "Movies", CollectionType: "movies" }];
    fixture.items.set("lib-movies", [movieFixture("m-1"), movieFixture("m-2")]);
    await runSync(fixture, "full", T0);

    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const state = await client.query("SELECT cursor FROM catalog_sync_state WHERE job = 'jellyfin_catalog'");
      assert.equal(state.rows[0].cursor.libraries["lib-movies"].since, T0.toISOString());
    });

    const t1 = new Date(T0.getTime() + 120_000);
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { Name: "Movie m-1 (Remastered)", DateLastSaved: t1.toISOString() }),
      // m-2 is unchanged and must not even be returned by the cursor filter.
      movieFixture("m-2")
    ]);
    const incremental = await runSync(fixture, "incremental", t1);
    assert.equal(fixture.lastUpdatedSince, T0.toISOString(), "the fixture received the recorded cursor");
    assert.equal(incremental.counts.itemsSeen, 1);
    assert.equal(incremental.counts.itemsUpserted, 1);

    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const renamed = await itemRow(client, "m-1");
      assert.equal(renamed.name, "Movie m-1 (Remastered)");
      const untouched = await itemRow(client, "m-2");
      assert.equal(untouched.missing_since, null, "incremental scans must never retire");
      const state = await client.query("SELECT cursor FROM catalog_sync_state WHERE job = 'jellyfin_catalog'");
      assert.equal(state.rows[0].cursor.libraries["lib-movies"].since, t1.toISOString());
    });

    // An incremental run with no cursor yet (fresh state) still sees a full
    // library pass and stays non-destructive.
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      await client.query("UPDATE catalog_sync_state SET cursor = '{}'::jsonb WHERE job = 'jellyfin_catalog'");
    });
    const firstIncremental = await runSync(fixture, "incremental", new Date(t1.getTime() + 60_000));
    assert.equal(firstIncremental.counts.itemsSeen, 2);
    assert.equal(firstIncremental.counts.itemsMissing, 0);
  });

  it("rebuild clears catalog content and rebuilds it while keeping scan history", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [{ Id: "lib-movies", Name: "Movies", CollectionType: "movies" }];
    fixture.items.set("lib-movies", [movieFixture("m-1")]);
    await runSync(fixture, "full", T0);

    const t1 = new Date(T0.getTime() + 60_000);
    const rebuild = await runSync(fixture, "rebuild", t1);
    assert.equal(rebuild.status, "succeeded");
    assert.equal(rebuild.counts.itemsUpserted, 1);

    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const movie = await itemRow(client, "m-1");
      assert.equal(movie.observed_at.toISOString(), t1.toISOString(), "the rebuild is the first observation");
      const scans = await client.query("SELECT count(*)::int AS n FROM catalog_scan");
      assert.equal(scans.rows[0].n, 2, "scan history survives a rebuild");
      const state = await client.query("SELECT cursor FROM catalog_sync_state WHERE job = 'jellyfin_catalog'");
      assert.equal(state.rows[0].cursor.libraries["lib-movies"].since, t1.toISOString());
      const genres = await client.query("SELECT count(*)::int AS n FROM catalog_genre");
      assert.equal(genres.rows[0].n, 1, "taxonomy rebuilt with the catalog");
    });
  });

  it("enforces schema guards directly: kinds and the retirement state machine", async () => {
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const lib = await client.query(
        `INSERT INTO catalog_library (source, external_id, name, content_hash)
         VALUES ('jellyfin', 'lib-guard', 'Guard', 'hash-guard') RETURNING id`
      );
      await assert.rejects(
        client.query(
          "INSERT INTO catalog_item (library_id, source, external_id, kind, name, content_hash) VALUES ($1, 'jellyfin', 'x-bad-kind', 'document', 'X', 'h')",
          [lib.rows[0].id]
        ),
        /catalog_item_kind_check/
      );
      await assert.rejects(
        client.query(
          "INSERT INTO catalog_item (library_id, source, external_id, kind, name, content_hash, retired_at) VALUES ($1, 'jellyfin', 'x-bad-retire', 'movie', 'X', 'h', now())",
          [lib.rows[0].id]
        ),
        /catalog_item_retired_requires_missing/
      );
      await assert.rejects(
        client.query(
          "INSERT INTO catalog_quarantine (source, external_id, reason) VALUES ('jellyfin', 'x-q', 'made_up_reason')"
        ),
        /catalog_quarantine_reason_check/
      );
    });
  });
});
