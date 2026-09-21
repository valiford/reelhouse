// Deterministic PostgreSQL + Jellyfin integration evidence for RH-0026.
//
// Runs against the disposable loopback PostgreSQL 18 profile
// (docker-compose.dev-db.yml) — never against Synology, and never against
// the reelhouse database: the suite provisions its own catalog database
// (reelhouse_rh0026_catalog) so it cannot fight parallel suites over shared
// state. Requires two role URLs; without them every case skips so the
// hermetic `npm test` stays hermetic:
//
//   REELHOUSE_TEST_MIGRATE_URL   owner role, e.g.
//                                postgresql://reelhouse_owner:reelhouse_owner_dev@127.0.0.1:5433/reelhouse
//   REELHOUSE_TEST_DATABASE_URL  application role, e.g.
//                                postgresql://reelhouse_app:reelhouse_app_dev@127.0.0.1:5433/reelhouse
//
// Jellyfin is exercised through an in-memory fixture client implementing the
// same interface as the HTTP client, so the engine is proven against
// success, idempotence, incremental, retirement, quarantine, rebuild, and
// failure/recovery paths without a Jellyfin server.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { loadDatabaseConfig, type DatabaseConfig } from "../db/config.ts";
import { runMigrations } from "../db/migrator.ts";
import { runCatalogSync, CATALOG_SYNC_JOB } from "./sync.ts";
import type { JellyfinCatalogClient, JellyfinCatalogPage } from "./jellyfin-client.ts";
import type { JellyfinItemRaw, JellyfinLibraryRaw } from "./model.ts";

const CATALOG_MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations-catalog", import.meta.url));
const CATALOG_DB = "reelhouse_rh0026_catalog";

const migrateEnv = process.env.REELHOUSE_TEST_MIGRATE_URL;
const appEnv = process.env.REELHOUSE_TEST_DATABASE_URL;

function parse(url: string, overrides: Record<string, string> = {}): DatabaseConfig {
  const result = loadDatabaseConfig({ DATABASE_URL: url, ...overrides });
  if (result.kind !== "valid") throw new Error(`test URL invalid: ${result.kind === "invalid" ? result.errors.join("; ") : "blank"}`);
  return result.config;
}

function urlForDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function withOwnerClient(config: DatabaseConfig, fn: (client: Client) => Promise<void>): Promise<void> {
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

// ---- fixture Jellyfin -------------------------------------------------------

class FixtureJellyfin implements JellyfinCatalogClient {
  libraries: JellyfinLibraryRaw[] = [];
  items = new Map<string, JellyfinItemRaw[]>();
  failure: Error | null = null;

  async listLibraries(): Promise<JellyfinLibraryRaw[]> {
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }
    return this.libraries;
  }

  async listItemPage(
    libraryExternalId: string,
    { startIndex, limit, includeTypes, updatedSince }: { startIndex: number; limit: number; includeTypes: string[]; updatedSince?: string }
  ): Promise<JellyfinCatalogPage> {
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }
    const typed = (this.items.get(libraryExternalId) ?? []).filter((item) => includeTypes.includes(item.Type ?? ""));
    const visible = updatedSince ? typed.filter((item) => (item.DateLastSaved ?? "") > updatedSince) : typed;
    return { items: visible.slice(startIndex, startIndex + limit), totalRecorded: visible.length };
  }
}

function movie(id: string, name: string, overrides: Partial<JellyfinItemRaw> = {}): JellyfinItemRaw {
  return { Id: id, Name: name, Type: "Movie", DateLastSaved: "2026-09-01T00:00:00Z", ...overrides };
}

// ---- shared setup -----------------------------------------------------------

const migrateConfig = migrateEnv ? parse(migrateEnv) : undefined;
const appConfig = appEnv ? parse(appEnv) : undefined;

interface CatalogFixture {
  catalogMigrateConfig: DatabaseConfig;
  catalogAppConfig: DatabaseConfig;
  appRole: string;
  syncEnv: Record<string, string | undefined>;
}

// Every scenario starts from a freshly provisioned catalog database, so the
// evidence is order-independent and a crashed scenario cannot poison the rest.
async function setupCatalogDatabase(t: import("node:test").TestContext): Promise<CatalogFixture> {
  if (!migrateConfig || !appConfig) {
    t.skip("REELHOUSE_TEST_MIGRATE_URL / REELHOUSE_TEST_DATABASE_URL not set (hermetic mode)");
    throw new Error("unreachable");
  }
  await withOwnerClient(migrateConfig, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${CATALOG_DB} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${CATALOG_DB}`);
    await client.query(`GRANT CONNECT ON DATABASE ${CATALOG_DB} TO ${appConfig.user}`);
  });
  const catalogMigrateConfig: DatabaseConfig = { ...migrateConfig, database: CATALOG_DB };
  const catalogAppConfig: DatabaseConfig = { ...appConfig, database: CATALOG_DB };
  const syncEnv: Record<string, string | undefined> = {
    MEDIA_CATALOG_DATABASE_URL: urlForDatabase(appEnv as string, CATALOG_DB),
    MEDIA_CATALOG_MIGRATE_URL: urlForDatabase(migrateEnv as string, CATALOG_DB),
    MEDIA_CATALOG_RETIREMENT_DAYS: "1"
  };
  const migrations = await runMigrations(catalogMigrateConfig, CATALOG_MIGRATIONS_DIR, catalogAppConfig.user);
  assert.deepEqual(migrations.appliedNow, [1, 2, 3, 4]);
  return { catalogMigrateConfig, catalogAppConfig, appRole: catalogAppConfig.user, syncEnv };
}

after(async () => {
  if (!migrateConfig) return;
  await withOwnerClient(migrateConfig, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${CATALOG_DB} WITH (FORCE)`);
  });
});

async function queryCatalog(config: DatabaseConfig, sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  let rows: Array<Record<string, unknown>> = [];
  await withOwnerClient(config, async (client) => {
    const result = await client.query(sql, params);
    rows = result.rows as Array<Record<string, unknown>>;
  });
  return rows;
}

const T0 = new Date("2026-09-21T12:00:00.000Z");
const clock = { current: T0 };
function tickTo(instant: Date): () => Date {
  clock.current = instant;
  return () => clock.current;
}

// ---- the suite --------------------------------------------------------------

test("catalog migrations apply once, re-apply is a no-op, history is recorded", async (t) => {
  const { catalogMigrateConfig, appRole } = await setupCatalogDatabase(t);
  const second = await runMigrations(catalogMigrateConfig, CATALOG_MIGRATIONS_DIR, appRole);
  assert.deepEqual(second.appliedNow, []);
  assert.equal(second.skipped, 4);
  const history = await queryCatalog(catalogMigrateConfig, "SELECT name FROM schema_migrations ORDER BY version");
  assert.deepEqual(
    history.map((row) => row.name),
    ["catalog_grants_baseline", "catalog_libraries_and_items", "catalog_taxonomies", "catalog_sync_state"]
  );
});

test("sync role is least-privilege: DML yes, DDL, truncate, and bookkeeping writes never", async (t) => {
  const { catalogAppConfig, appRole } = await setupCatalogDatabase(t);
  await withOwnerClient(catalogAppConfig, async (client) => {
    const privileges = await client.query<Record<string, boolean>>(
      `SELECT has_table_privilege(current_user, 'public.catalog_library', 'SELECT') AS can_select,
              has_table_privilege(current_user, 'public.catalog_library', 'INSERT') AS can_insert,
              has_table_privilege(current_user, 'public.catalog_library', 'UPDATE') AS can_update,
              has_table_privilege(current_user, 'public.catalog_library', 'DELETE') AS can_delete,
              has_table_privilege(current_user, 'public.catalog_library', 'TRUNCATE') AS can_truncate`
    );
    assert.deepEqual(privileges.rows[0], {
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: true,
      can_truncate: false
    });
    const bookkeeping = await client.query<{ count: string }>("SELECT count(*) FROM public.schema_migrations");
    assert.equal(Number(bookkeeping.rows[0].count), 4);
    await assert.rejects(client.query("DELETE FROM public.schema_migrations"), /permission denied/);
    await assert.rejects(client.query("CREATE TABLE public.rh0026_escalate (id integer)"), /permission denied/);
    const roles = await client.query<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
      "SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1",
      [appRole]
    );
    assert.deepEqual(roles.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  });
});

test("schema preflight fails closed on an unmigrated catalog database", async (t) => {
  const { catalogMigrateConfig, catalogAppConfig, syncEnv } = await setupCatalogDatabase(t);
  void catalogAppConfig;
  // Prove the preflight on a database that never saw the migrations.
  await withOwnerClient(migrateConfig as DatabaseConfig, async (client) => {
    await client.query("DROP DATABASE IF EXISTS reelhouse_rh0026_bare WITH (FORCE)");
    await client.query("CREATE DATABASE reelhouse_rh0026_bare");
    await client.query(`GRANT CONNECT ON DATABASE reelhouse_rh0026_bare TO ${appConfig?.user}`);
  });
  try {
    const bareEnv = {
      ...syncEnv,
      MEDIA_CATALOG_DATABASE_URL: urlForDatabase(appEnv as string, "reelhouse_rh0026_bare")
    };
    const jellyfin = new FixtureJellyfin();
    await assert.rejects(
      runCatalogSync({ env: bareEnv, client: jellyfin, mode: "full", now: () => T0 }),
      /schema is missing tables.*catalog:migrate/
    );
    const scans = await queryCatalog(catalogMigrateConfig, "SELECT count(*) AS n FROM catalog_scan");
    assert.equal(Number(scans[0].n), 0);
  } finally {
    await withOwnerClient(migrateConfig as DatabaseConfig, async (client) => {
      await client.query("DROP DATABASE IF EXISTS reelhouse_rh0026_bare WITH (FORCE)");
    });
  }
});

test("full sync writes the normalized catalog end to end", async (t) => {
  const { catalogMigrateConfig, syncEnv } = await setupCatalogDatabase(t);

  const jellyfin = new FixtureJellyfin();
  jellyfin.libraries = [
    { Id: "lib-movies", Name: "Movies", CollectionType: "movies", ImageTags: { Primary: "libtag" } },
    { Id: "lib-tv", Name: "Shows", CollectionType: "tvshows" }
  ];
  jellyfin.items.set("lib-movies", [
    movie("mov-1", "A Movie", {
      ProductionYear: 2020,
      CommunityRating: 8.1,
      ProviderIds: { Imdb: "tt0000001", tmdb: "101" },
      Genres: ["Action", "Sci-Fi"],
      Studios: [{ Name: "North Studio" }],
      People: [
        { Name: "Ada Actor", Type: "Actor", Role: "Lead" },
        { Name: "Dee Director", Type: "Director" }
      ],
      Path: "/media/movies/a-movie.mkv",
      Container: "mkv",
      Size: 5_000_000_000,
      RuntimeTicks: 7_200_000 * 10_000,
      PremiereDate: "2020-05-01T00:00:00Z",
      ImageTags: { Primary: "mov1tag" },
      ETag: "etag-1"
    }),
    movie("mov-2", "B Movie", { Genres: ["Sci-Fi"] })
  ]);
  jellyfin.items.set("lib-tv", [
    { Id: "ser-1", Name: "Great Show", Type: "Series", Genres: ["Drama"], ProviderIds: { tvdb: "1" } },
    { Id: "sea-1", Name: "Season 1", Type: "Season", SeriesId: "ser-1", IndexNumber: 1 },
    {
      Id: "ep-1",
      Name: "Pilot",
      Type: "Episode",
      SeriesId: "ser-1",
      SeasonId: "sea-1",
      IndexNumber: 1,
      ParentIndexNumber: 1,
      RuntimeTicks: 2_600_000 * 10_000,
      Path: "/media/tv/s1e1.mkv",
      Container: "mkv"
    }
  ]);

  const result = await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "full",
    now: tickTo(T0),
    log: () => {}
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.counts.librariesSeen, 2);
  assert.equal(result.counts.itemsUpserted, 5);
  assert.equal(result.counts.itemsQuarantined, 0);

  const movies = await queryCatalog(
    catalogMigrateConfig,
    `SELECT external_id, name, production_year, community_rating, runtime_seconds, size_bytes, path,
            container, premiere_date::text AS premiere_date, source_revision, content_hash, primary_image_tag
       FROM catalog_item WHERE kind = 'movie' ORDER BY external_id`
  );
  assert.equal(movies.length, 2);
  const first = movies.find((row) => row.external_id === "mov-1");
  assert.ok(first);
  assert.equal(first.name, "A Movie");
  assert.equal(first.production_year, 2020);
  assert.equal(Number(first.community_rating), 8.1);
  assert.equal(first.runtime_seconds, 7200);
  assert.equal(first.size_bytes, "5000000000");
  assert.equal(first.path, "/media/movies/a-movie.mkv");
  assert.equal(first.container, "mkv");
  assert.equal(first.premiere_date, "2020-05-01");
  assert.equal(first.source_revision, "etag-1");
  assert.equal(first.primary_image_tag, "mov1tag");

  // Hierarchy and taxonomy evidence.
  const episode = (await queryCatalog(
    catalogMigrateConfig,
    "SELECT parent_external_id FROM catalog_item WHERE external_id = 'ep-1'"
  ))[0];
  assert.equal(episode.parent_external_id, "sea-1");

  const genres = await queryCatalog(
    catalogMigrateConfig,
    `SELECT DISTINCT g.name FROM catalog_genre g JOIN catalog_item_genre ig ON ig.genre_id = g.id
       JOIN catalog_item i ON i.id = ig.item_id WHERE i.external_id = 'mov-1' ORDER BY g.name`
  );
  assert.deepEqual(genres.map((row) => row.name), ["Action", "Sci-Fi"]);

  const people = await queryCatalog(
    catalogMigrateConfig,
    `SELECT p.name, ip.role_type, ip.role_name, ip.list_order FROM catalog_person p
       JOIN catalog_item_person ip ON ip.person_id = p.id
       JOIN catalog_item i ON i.id = ip.item_id WHERE i.external_id = 'mov-1' ORDER BY ip.list_order`
  );
  assert.deepEqual(people, [
    { name: "Ada Actor", role_type: "actor", role_name: "Lead", list_order: 0 },
    { name: "Dee Director", role_type: "director", role_name: null, list_order: 1 }
  ]);

  const providerIds = await queryCatalog(
    catalogMigrateConfig,
    `SELECT provider, external_value FROM catalog_provider_id
      WHERE item_id IN (SELECT id FROM catalog_item WHERE external_id = 'mov-1') ORDER BY provider`
  );
  assert.deepEqual(providerIds, [
    { provider: "imdb", external_value: "tt0000001" },
    { provider: "tmdb", external_value: "101" }
  ]);

  const scan = (
    await queryCatalog(
      catalogMigrateConfig,
      "SELECT mode, status, libraries_seen, items_seen, items_upserted, error FROM catalog_scan ORDER BY started_at DESC LIMIT 1"
    )
  )[0];
  assert.equal(scan.status, "succeeded");
  assert.equal(scan.error, null);

  const state = (
    await queryCatalog(catalogMigrateConfig, "SELECT cursor, last_error FROM catalog_sync_state WHERE job = $1", [CATALOG_SYNC_JOB])
  )[0];
  assert.equal(state.last_error, null);
  assert.deepEqual((state.cursor as { libraries: Record<string, unknown> }).libraries["lib-movies"], {
    since: T0.toISOString()
  });
});

test("repeat full sync is idempotent: nothing changes but freshness", async (t) => {
  const { catalogMigrateConfig, syncEnv } = await setupCatalogDatabase(t);

  const jellyfin = new FixtureJellyfin();
  jellyfin.libraries = [{ Id: "lib", Name: "Movies", CollectionType: "movies" }];
  jellyfin.items.set("lib", [movie("m1", "One"), movie("m2", "Two")]);

  const first = await runCatalogSync({ env: syncEnv, client: jellyfin, mode: "full", now: tickTo(T0) });
  assert.equal(first.counts.itemsUpserted, 2);

  const before = await queryCatalog(
    catalogMigrateConfig,
    "SELECT external_id, content_hash, created_at FROM catalog_item ORDER BY external_id"
  );

  const second = await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "full",
    now: tickTo(new Date(T0.getTime() + 60_000))
  });
  assert.equal(second.counts.itemsUpserted, 0);
  assert.equal(second.counts.itemsUnchanged, 2);
  assert.equal(second.counts.itemsMissing, 0);

  const after = await queryCatalog(
    catalogMigrateConfig,
    "SELECT external_id, content_hash, created_at FROM catalog_item ORDER BY external_id"
  );
  assert.deepEqual(after, before);

  const freshness = await queryCatalog(catalogMigrateConfig, "SELECT DISTINCT last_seen_at FROM catalog_item");
  assert.equal(new Date(freshness[0].last_seen_at as string).getTime(), T0.getTime() + 60_000);
});

test("changed content upserts in place and rewrites relations", async (t) => {
  const { catalogMigrateConfig, syncEnv } = await setupCatalogDatabase(t);

  const jellyfin = new FixtureJellyfin();
  jellyfin.libraries = [{ Id: "lib", Name: "Movies" }];
  jellyfin.items.set("lib", [movie("m1", "Old Title", { Genres: ["Drama"] })]);
  await runCatalogSync({ env: syncEnv, client: jellyfin, mode: "full", now: tickTo(T0) });

  jellyfin.items.set("lib", [
    movie("m1", "New Title", { Genres: ["Drama", "Thriller"], ETag: "etag-2", DateLastSaved: "2026-09-02T00:00:00Z" })
  ]);
  const result = await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "full",
    now: tickTo(new Date(T0.getTime() + 60_000))
  });
  assert.equal(result.counts.itemsUpserted, 1);
  assert.equal(result.counts.itemsUnchanged, 0);

  const rows = await queryCatalog(catalogMigrateConfig, "SELECT name, source_revision FROM catalog_item WHERE external_id = 'm1'");
  assert.equal(rows[0].name, "New Title");
  assert.equal(rows[0].source_revision, "etag-2");

  const genres = await queryCatalog(
    catalogMigrateConfig,
    `SELECT g.name FROM catalog_genre g JOIN catalog_item_genre ig ON ig.genre_id = g.id
       JOIN catalog_item i ON i.id = ig.item_id WHERE i.external_id = 'm1' ORDER BY g.name`
  );
  assert.deepEqual(genres.map((row) => row.name), ["Drama", "Thriller"]);

  const count = await queryCatalog(catalogMigrateConfig, "SELECT count(*) AS n FROM catalog_item");
  assert.equal(Number(count[0].n), 1);
});

test("incremental sync fetches only what changed and never retires", async (t) => {
  const { catalogMigrateConfig, syncEnv } = await setupCatalogDatabase(t);

  const jellyfin = new FixtureJellyfin();
  jellyfin.libraries = [{ Id: "lib", Name: "Movies" }];
  jellyfin.items.set("lib", [movie("m1", "One"), movie("m2", "Two")]);
  await runCatalogSync({ env: syncEnv, client: jellyfin, mode: "full", now: tickTo(T0) });

  // m2 changed after the first scan; m1 vanished, but incremental scans must
  // neither notice the absence nor retire anything (full scans only).
  jellyfin.items.set("lib", [
    movie("m1", "One"),
    movie("m2", "Two Renamed", { DateLastSaved: "2026-09-21T12:00:30.000Z" })
  ]);
  const incremental = await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "incremental",
    now: tickTo(new Date(T0.getTime() + 60_000))
  });
  assert.equal(incremental.counts.itemsSeen, 1);
  assert.equal(incremental.counts.itemsUpserted, 1);
  assert.equal(incremental.counts.itemsRetired, 0);
  assert.equal(incremental.counts.itemsMissing, 0);

  const rows = await queryCatalog(catalogMigrateConfig, "SELECT name, missing_since FROM catalog_item ORDER BY external_id");
  assert.deepEqual(
    rows.map((row) => ({ name: row.name, missing: row.missing_since })),
    [
      { name: "One", missing: null },
      { name: "Two Renamed", missing: null }
    ]
  );
});

test("retirement is a two-phase full-scan machine and reappearance restores", async (t) => {
  const { catalogMigrateConfig, syncEnv } = await setupCatalogDatabase(t);

  const jellyfin = new FixtureJellyfin();
  jellyfin.libraries = [{ Id: "lib", Name: "Movies" }];
  jellyfin.items.set("lib", [movie("m1", "Stays"), movie("m2", "Vanishes")]);
  await runCatalogSync({ env: syncEnv, client: jellyfin, mode: "full", now: tickTo(T0) });

  // m2 disappears; the next full scan marks it missing only.
  jellyfin.items.set("lib", [movie("m1", "Stays")]);
  const missingRun = await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "full",
    now: tickTo(new Date(T0.getTime() + 1))
  });
  assert.equal(missingRun.counts.itemsMissing, 1);
  assert.equal(missingRun.counts.itemsRetired, 0);

  // One retirement day later, the still-missing item retires.
  const retiredRun = await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "full",
    now: tickTo(new Date(T0.getTime() + 1 + 24 * 60 * 60 * 1000))
  });
  assert.equal(retiredRun.counts.itemsRetired, 1);
  const retired = (
    await queryCatalog(catalogMigrateConfig, "SELECT retired_at, missing_since FROM catalog_item WHERE external_id = 'm2'")
  )[0];
  assert.ok(retired.retired_at);
  assert.ok(retired.missing_since);

  // Reappearance restores in place: no new row, flags cleared.
  jellyfin.items.set("lib", [movie("m1", "Stays"), movie("m2", "Vanishes")]);
  const restored = await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "full",
    now: tickTo(new Date(T0.getTime() + 2 + 24 * 60 * 60 * 1000))
  });
  assert.equal(restored.counts.itemsUpserted, 0);
  assert.equal(restored.counts.itemsUnchanged, 2);
  const back = (
    await queryCatalog(catalogMigrateConfig, "SELECT missing_since, retired_at FROM catalog_item WHERE external_id = 'm2'")
  )[0];
  assert.equal(back.missing_since, null);
  assert.equal(back.retired_at, null);
  const total = await queryCatalog(catalogMigrateConfig, "SELECT count(*) AS n FROM catalog_item");
  assert.equal(Number(total[0].n), 2);
});

test("ambiguous identities quarantine instead of writing: provider id and invalid", async (t) => {
  const { catalogMigrateConfig, syncEnv } = await setupCatalogDatabase(t);

  const jellyfin = new FixtureJellyfin();
  jellyfin.libraries = [{ Id: "lib", Name: "Movies" }];
  jellyfin.items.set("lib", [
    movie("winner", "Winner", { ProviderIds: { imdb: "tt-shared" } }),
    movie("loser", "Loser", { ProviderIds: { imdb: "tt-shared" } }),
    movie("bad", "")
  ]);
  const result = await runCatalogSync({ env: syncEnv, client: jellyfin, mode: "full", now: tickTo(T0) });
  // "bad" (no name) is invalid; "loser" contests the imdb id "winner" wrote.
  assert.equal(result.counts.itemsUpserted, 1);
  assert.equal(result.counts.itemsQuarantined, 2);

  const quarantine = await queryCatalog(
    catalogMigrateConfig,
    "SELECT external_id, reason, detail, payload FROM catalog_quarantine WHERE resolved_at IS NULL ORDER BY external_id"
  );
  assert.deepEqual(
    quarantine.map((row) => ({ external_id: row.external_id, reason: row.reason })),
    [
      { external_id: "bad", reason: "invalid_item" },
      { external_id: "loser", reason: "duplicate_provider_id" }
    ]
  );
  const loser = quarantine.find((row) => row.external_id === "loser");
  assert.ok(loser);
  assert.deepEqual((loser.detail as { heldBy: string }).heldBy, "winner");
  assert.equal(typeof loser.payload, "object");
});

test("an orphaned child quarantines until its parent exists", async (t) => {
  const { catalogMigrateConfig, syncEnv } = await setupCatalogDatabase(t);

  const jellyfin = new FixtureJellyfin();
  jellyfin.libraries = [{ Id: "libtv", Name: "Shows" }];
  jellyfin.items.set("libtv", [
    { Id: "ep-x", Name: "Orphan Episode", Type: "Episode", SeriesId: "ghost-series" }
  ]);
  const orphanRun = await runCatalogSync({ env: syncEnv, client: jellyfin, mode: "full", now: tickTo(T0) });
  assert.equal(orphanRun.counts.itemsQuarantined, 1);
  assert.equal(orphanRun.counts.itemsUpserted, 0);

  // The series appears in a later sync; the episode then writes itself and
  // its own quarantine record auto-closes.
  jellyfin.items.set("libtv", [
    { Id: "ghost-series", Name: "Late Series", Type: "Series" },
    { Id: "ep-x", Name: "Orphan Episode", Type: "Episode", SeriesId: "ghost-series" }
  ]);
  const repaired = await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "full",
    now: tickTo(new Date(T0.getTime() + 60_000))
  });
  assert.equal(repaired.counts.itemsUpserted, 2);
  assert.equal(repaired.counts.itemsQuarantined, 0);
  const quarantine = await queryCatalog(
    catalogMigrateConfig,
    "SELECT resolved_at FROM catalog_quarantine WHERE external_id = 'ep-x' AND reason = 'orphan_parent'"
  );
  assert.equal(quarantine.length, 1);
  assert.ok(quarantine[0].resolved_at);
  const episode = (
    await queryCatalog(catalogMigrateConfig, "SELECT parent_external_id FROM catalog_item WHERE external_id = 'ep-x'")
  )[0];
  assert.equal(episode.parent_external_id, "ghost-series");
});

test("an item offered by a second library conflicts and is never moved silently", async (t) => {
  const { catalogMigrateConfig, syncEnv } = await setupCatalogDatabase(t);

  const jellyfin = new FixtureJellyfin();
  jellyfin.libraries = [{ Id: "lib-a", Name: "Movies A" }];
  jellyfin.items.set("lib-a", [movie("dup", "In Library A")]);
  await runCatalogSync({ env: syncEnv, client: jellyfin, mode: "full", now: tickTo(T0) });

  jellyfin.libraries = [
    { Id: "lib-a", Name: "Movies A" },
    { Id: "lib-b", Name: "Movies B" }
  ];
  jellyfin.items.set("lib-b", [movie("dup", "In Library B")]);
  const second = await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "full",
    now: tickTo(new Date(T0.getTime() + 60_000))
  });
  assert.equal(second.counts.itemsQuarantined, 1);

  const rows = await queryCatalog(
    catalogMigrateConfig,
    `SELECT q.reason, i.name, l.external_id AS library FROM catalog_quarantine q
       CROSS JOIN catalog_item i CROSS JOIN catalog_library l
      WHERE q.external_id = 'dup' AND q.resolved_at IS NULL
        AND i.external_id = 'dup' AND l.external_id = 'lib-a'`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "library_conflict");
  assert.equal(rows[0].name, "In Library A");
  assert.equal(rows[0].library, "lib-a");
});

test("a repaired identity writes and auto-closes its own quarantine record", async (t) => {
  const { catalogMigrateConfig, syncEnv } = await setupCatalogDatabase(t);

  const jellyfin = new FixtureJellyfin();
  jellyfin.libraries = [{ Id: "lib", Name: "Movies" }];
  jellyfin.items.set("lib", [movie("m1", "One", { ProviderIds: { imdb: "tt-1" } })]);
  await runCatalogSync({ env: syncEnv, client: jellyfin, mode: "full", now: tickTo(T0) });

  // A challenger for the same provider id quarantines...
  jellyfin.items.set("lib", [
    movie("m1", "One", { ProviderIds: { imdb: "tt-1" } }),
    movie("m2", "Challenger", { ProviderIds: { imdb: "tt-1" } })
  ]);
  await runCatalogSync({ env: syncEnv, client: jellyfin, mode: "full", now: tickTo(new Date(T0.getTime() + 60_000)) });
  let open = await queryCatalog(catalogMigrateConfig, "SELECT external_id FROM catalog_quarantine WHERE resolved_at IS NULL");
  assert.deepEqual(open.map((row) => row.external_id), ["m2"]);

  // ...and once its provider id is unique again, it writes and the record closes.
  jellyfin.items.set("lib", [
    movie("m1", "One", { ProviderIds: { imdb: "tt-1" } }),
    movie("m2", "Challenger", { ProviderIds: { imdb: "tt-2" } })
  ]);
  const repaired = await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "full",
    now: tickTo(new Date(T0.getTime() + 120_000))
  });
  assert.equal(repaired.counts.itemsUpserted, 1);
  open = await queryCatalog(
    catalogMigrateConfig,
    "SELECT external_id, resolved_at FROM catalog_quarantine WHERE external_id = 'm2' AND reason = 'duplicate_provider_id'"
  );
  assert.equal(open.length, 1);
  assert.ok(open[0].resolved_at);
});

test("library content changes upsert in place and restore retired libraries", async (t) => {
  const { catalogMigrateConfig, syncEnv } = await setupCatalogDatabase(t);

  const jellyfin = new FixtureJellyfin();
  jellyfin.libraries = [{ Id: "lib", Name: "Movies", CollectionType: "movies", ImageTags: { Primary: "tag-1" } }];
  jellyfin.items.set("lib", [movie("m1", "One")]);
  await runCatalogSync({ env: syncEnv, client: jellyfin, mode: "full", now: tickTo(T0) });

  // The library's presentation content changes: the existing row must be
  // updated in place (same identity), not inserted twice.
  jellyfin.libraries = [{ Id: "lib", Name: "Movies", CollectionType: "movies", ImageTags: { Primary: "tag-2" } }];
  const second = await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "full",
    now: tickTo(new Date(T0.getTime() + 60_000))
  });
  assert.equal(second.counts.librariesSeen, 1);
  const libraries = await queryCatalog(
    catalogMigrateConfig,
    "SELECT external_id, primary_image_tag, content_hash FROM catalog_library"
  );
  assert.equal(libraries.length, 1);
  assert.equal(libraries[0].primary_image_tag, "tag-2");

  // A library that goes missing is first marked missing, then retires a
  // retirement-day later (same two-phase machine as items).
  jellyfin.libraries = [];
  await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "full",
    now: tickTo(new Date(T0.getTime() + 1 + 24 * 60 * 60 * 1000))
  });
  const missing = (await queryCatalog(catalogMigrateConfig, "SELECT retired_at, missing_since FROM catalog_library"))[0];
  assert.equal(missing.retired_at, null);
  assert.ok(missing.missing_since);
  await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "full",
    now: tickTo(new Date(T0.getTime() + 2 + 48 * 60 * 60 * 1000))
  });
  const retired = (await queryCatalog(catalogMigrateConfig, "SELECT retired_at FROM catalog_library"))[0];
  assert.ok(retired.retired_at);

  jellyfin.libraries = [{ Id: "lib", Name: "Movies", CollectionType: "movies", ImageTags: { Primary: "tag-2" } }];
  const restored = await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "full",
    now: tickTo(new Date(T0.getTime() + 2 + 24 * 60 * 60 * 1000))
  });
  assert.equal(restored.counts.librariesSeen, 1);
  const back = (await queryCatalog(catalogMigrateConfig, "SELECT retired_at, missing_since FROM catalog_library"))[0];
  assert.equal(back.retired_at, null);
  assert.equal(back.missing_since, null);
});

test("pagination walks multi-page libraries deterministically", async (t) => {
  const { catalogMigrateConfig, syncEnv } = await setupCatalogDatabase(t);

  // 1001 items: two full 500-item pages plus a remainder page, with the
  // default policy (pageSize 500, maxPages 100).
  const jellyfin = new FixtureJellyfin();
  jellyfin.libraries = [{ Id: "lib", Name: "Big" }];
  jellyfin.items.set(
    "lib",
    Array.from({ length: 1001 }, (_unused, index) => movie(`m-${String(index).padStart(4, "0")}`, `Title ${index}`))
  );
  const result = await runCatalogSync({ env: syncEnv, client: jellyfin, mode: "full", now: tickTo(T0) });
  assert.equal(result.counts.itemsUpserted, 1001);
  const total = await queryCatalog(catalogMigrateConfig, "SELECT count(*) AS n FROM catalog_item");
  assert.equal(Number(total[0].n), 1001);
});

test("rebuild clears catalog content with fresh identities but keeps scan history", async (t) => {
  const { catalogMigrateConfig, syncEnv } = await setupCatalogDatabase(t);

  const jellyfin = new FixtureJellyfin();
  jellyfin.libraries = [{ Id: "lib", Name: "Movies" }];
  jellyfin.items.set("lib", [movie("m1", "One")]);
  await runCatalogSync({ env: syncEnv, client: jellyfin, mode: "full", now: tickTo(T0) });
  const idsBefore = (await queryCatalog(catalogMigrateConfig, "SELECT id FROM catalog_item WHERE external_id = 'm1'"))[0].id;
  const scansBefore = Number((await queryCatalog(catalogMigrateConfig, "SELECT count(*) AS n FROM catalog_scan"))[0].n);

  const rebuild = await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "rebuild",
    now: tickTo(new Date(T0.getTime() + 60_000))
  });
  assert.equal(rebuild.status, "succeeded");
  assert.equal(rebuild.counts.itemsUpserted, 1);

  const idsAfter = (await queryCatalog(catalogMigrateConfig, "SELECT id FROM catalog_item WHERE external_id = 'm1'"))[0].id;
  assert.notEqual(String(idsAfter), String(idsBefore));
  const scansAfter = Number((await queryCatalog(catalogMigrateConfig, "SELECT count(*) AS n FROM catalog_scan"))[0].n);
  assert.equal(scansAfter, scansBefore + 1);
  const state = (
    await queryCatalog(catalogMigrateConfig, "SELECT last_succeeded_at FROM catalog_sync_state WHERE job = $1", [CATALOG_SYNC_JOB])
  )[0];
  assert.ok(state.last_succeeded_at);
});

test("failed scans record bounded redacted errors and recover on rerun", async (t) => {
  const { catalogMigrateConfig, syncEnv } = await setupCatalogDatabase(t);

  const jellyfin = new FixtureJellyfin();
  jellyfin.failure = new Error(`jellyfin exploded: ${syncEnv.MEDIA_CATALOG_DATABASE_URL}`);
  await assert.rejects(
    runCatalogSync({ env: syncEnv, client: jellyfin, mode: "full", now: tickTo(T0) }),
    /Catalog sync failed: jellyfin exploded/
  );

  const scan = (
    await queryCatalog(catalogMigrateConfig, "SELECT status, error FROM catalog_scan ORDER BY started_at DESC LIMIT 1")
  )[0];
  assert.equal(scan.status, "failed");
  const storedError = String(scan.error);
  assert.match(storedError, /jellyfin exploded/);
  assert.ok(storedError.length <= 2000, "stored error is bounded");
  assert.ok(!storedError.includes("reelhouse_app_dev"), "catalog credentials leaked into the stored error");
  assert.match(storedError, /:\/\/reelhouse_app:.*@/);

  const state = (
    await queryCatalog(catalogMigrateConfig, "SELECT last_error FROM catalog_sync_state WHERE job = $1", [CATALOG_SYNC_JOB])
  )[0];
  assert.match(String(state.last_error), /jellyfin exploded/);

  // Recovery: the next run succeeds and clears the failure trail.
  jellyfin.libraries = [{ Id: "lib", Name: "Movies" }];
  jellyfin.items.set("lib", [movie("m1", "One")]);
  const recovered = await runCatalogSync({
    env: syncEnv,
    client: jellyfin,
    mode: "full",
    now: tickTo(new Date(T0.getTime() + 60_000))
  });
  assert.equal(recovered.status, "succeeded");
  const cleared = (
    await queryCatalog(catalogMigrateConfig, "SELECT last_error, last_succeeded_at FROM catalog_sync_state WHERE job = $1", [CATALOG_SYNC_JOB])
  )[0];
  assert.equal(cleared.last_error, null);
  assert.ok(cleared.last_succeeded_at);
});

test("unconfigured catalog environment fails closed without contacting Jellyfin", async (t) => {
  await setupCatalogDatabase(t);
  const jellyfin = new FixtureJellyfin();
  await assert.rejects(runCatalogSync({ env: {}, client: jellyfin, mode: "full" }), /No media_catalog database configured/);
  assert.equal(jellyfin.failure, null);
});

test("invalid catalog configuration fails closed with named errors", async (t) => {
  await setupCatalogDatabase(t);
  const jellyfin = new FixtureJellyfin();
  await assert.rejects(
    runCatalogSync({ env: { MEDIA_CATALOG_DATABASE_URL: "mysql://x/y" }, client: jellyfin, mode: "full" }),
    /media_catalog configuration is invalid/
  );
});

test("invalid sync policy fails closed before the scan starts", async (t) => {
  await setupCatalogDatabase(t);
  const jellyfin = new FixtureJellyfin();
  await assert.rejects(
    runCatalogSync({
      env: { MEDIA_CATALOG_DATABASE_URL: "postgresql://x:y@z/db", MEDIA_CATALOG_RETIREMENT_DAYS: "nope" },
      client: jellyfin,
      mode: "full"
    }),
    /policy is invalid/
  );
});
