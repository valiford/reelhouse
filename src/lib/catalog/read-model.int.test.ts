// Integration tests for the catalog read model (RH-0020) against the
// disposable PostgreSQL 18 instance (same lifecycle as the other db suites).
//
//   npm run test:db:up      start the disposable database (docker compose)
//   npm run test:db         run all integration suites (this one included)
//   npm run test:db:down    stop and discard the database
//
// The suite drives its own database (reelhouse_catalog_read_test) inside the
// same disposable container so it never fights the other suites and never
// touches the production Synology target. Rows are seeded directly (the sync
// engine's write behavior is covered by the catalog suite); these tests pin
// the READ contract: deterministic keyset ordering under concurrent catalog
// changes, filter bounds, retirement/missing visibility, missing-art facts,
// rails ordering, and explicit freshness states.

import { strict as assert } from "node:assert";
import { before, beforeEach, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, Client } from "pg";
import {
  CatalogUnavailableError,
  catalogLibraryBrowse,
  catalogRails,
  catalogStatus,
  closeCatalogPool,
  getCatalogPool,
  parseSearchQuery,
  searchCatalogItems,
  type CatalogItemView,
  type CatalogSearchQuery
} from "./read-model.ts";
import { runMigrations } from "../db/migrator.ts";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_test";

const READ_DATABASE_URL =
  process.env.CATALOG_READ_TEST_DATABASE_URL ??
  "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_catalog_read_test";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "db", "migrations-catalog");

// Never allowed in any failure output.
const SECRET_PAIR = "reelhouse_test:reelhouse_test";

const T0 = new Date("2026-09-19T12:00:00.000Z");
const STALEHours = 24;
const HOUR_MS = 60 * 60 * 1000;

// env for the read model in these tests: the test catalog plus a Jellyfin
// presentation base; freshness policy stays the 24h default unless overridden.
function readEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    MEDIA_CATALOG_DATABASE_URL: READ_DATABASE_URL,
    JELLYFIN_URL: "http://jf.lan:8096",
    ...extra
  };
}

async function withClient<T>(databaseUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end();
  }
}

function testPool(): Pool {
  return new Pool({ connectionString: READ_DATABASE_URL });
}

interface SeedItem {
  externalId: string;
  name: string;
  kind: "movie" | "series";
  year: number | null;
  rating: number | null;
  dateCreated: string | null;
  art: string | null;
  genre: string | null;
  missing?: boolean;
  retired?: boolean;
  sortName?: string;
}

// The shared fixture. "100% Fresh" exists to prove wildcard escaping; a
// missing, a retired, unrated, and art-less rows cover the visibility and
// presentation contracts.
const SEED: SeedItem[] = [
  { externalId: "m-pct", name: "100% Fresh", kind: "movie", year: 2021, rating: 6.5, dateCreated: "2026-01-05T10:00:00Z", art: "tag-pct", genre: "Comedy" },
  { externalId: "m-a", name: "Alpha Movie", kind: "movie", year: 2020, rating: 7.5, dateCreated: "2026-03-01T10:00:00Z", art: "tag-a", genre: "Drama" },
  { externalId: "m-b", name: "Beta Movie", kind: "movie", year: 2021, rating: 9.0, dateCreated: "2026-02-01T10:00:00Z", art: null, genre: "Drama" },
  { externalId: "m-g", name: "Gamma Movie", kind: "movie", year: 2019, rating: null, dateCreated: null, art: "tag-g", genre: "Sci-Fi" },
  { externalId: "s-z", name: "Zeta Series", kind: "series", year: 2022, rating: 8.0, dateCreated: "2026-04-01T10:00:00Z", art: "tag-z", genre: "Sci-Fi" },
  { externalId: "s-e", name: "Eta Series", kind: "series", year: 2018, rating: null, dateCreated: "2026-05-01T10:00:00Z", art: null, genre: "Comedy" },
  { externalId: "m-star", name: "Star Target", kind: "movie", year: 2020, rating: 8.8, dateCreated: "2026-06-01T10:00:00Z", art: "tag-star", genre: "Sci-Fi" },
  { externalId: "m-miss", name: "Missing Movie", kind: "movie", year: 2020, rating: 6.0, dateCreated: "2026-03-01T10:00:00Z", art: "tag-miss", genre: "Drama", missing: true },
  { externalId: "m-gone", name: "Retired Movie", kind: "movie", year: 2015, rating: 4.0, dateCreated: "2025-01-01T10:00:00Z", art: "tag-gone", genre: "Drama", retired: true }
];

// Visible (non-retired) rows in deterministic `name` order — the backbone
// expectation for search walks.
const NAME_ORDER = ["m-pct", "m-a", "m-b", "s-e", "m-g", "m-miss", "m-star", "s-z"];

async function resetSchema(client: Client): Promise<void> {
  await client.query(
    "TRUNCATE catalog_item, catalog_library, catalog_quarantine, catalog_genre, catalog_studio, catalog_person, catalog_scan, catalog_sync_state CASCADE"
  );
}

async function insertItem(client: Client, libraryId: string, item: SeedItem): Promise<void> {
  // The schema's retirement state machine: retired_at requires missing_since
  // (and not after it), so a retired row went missing two days before T0.
  const missingSince = item.retired
    ? new Date(T0.getTime() - 2 * 24 * HOUR_MS)
    : item.missing
      ? T0
      : null;
  await client.query(
    `INSERT INTO catalog_item (library_id, source, external_id, kind, name, production_year, community_rating,
                               date_created, primary_image_tag, content_hash, missing_since, retired_at)
     VALUES ($1, 'jellyfin', $2, $3, $4, $5, $6, $7, $8, 'hash-' || $2,
             $9::timestamptz, $10::timestamptz)`,
    [
      libraryId,
      item.externalId,
      item.kind,
      item.name,
      item.year,
      item.rating,
      item.dateCreated,
      item.art,
      missingSince,
      item.retired ? T0 : null
    ]
  );
  if (item.genre !== null) {
    // name_key is folded exactly like the sync engine does (lower + trim) so
    // read-model genre filters match.
    const genre = await client.query<{ id: string }>(
      "INSERT INTO catalog_genre (name, name_key) VALUES ($1, lower($1)) ON CONFLICT (name_key) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [item.genre]
    );
    await client.query(
      "INSERT INTO catalog_item_genre (item_id, genre_id, list_order) SELECT id, $2, 0 FROM catalog_item WHERE external_id = $1",
      [item.externalId, genre.rows[0].id]
    );
  }
}

async function seedCatalog(client: Client, items: SeedItem[] = SEED): Promise<void> {
  const lib = await client.query<{ id: string }>(
    "INSERT INTO catalog_library (source, external_id, name, content_hash) VALUES ('jellyfin', 'lib-read', 'Read Library', 'hash-read') RETURNING id"
  );
  for (const item of items) {
    await insertItem(client, lib.rows[0].id, item);
  }
  await client.query("INSERT INTO catalog_sync_state (job, last_succeeded_at) VALUES ('jellyfin_catalog', $1)", [T0]);
}

function query(overrides: Partial<Parameters<typeof parseSearchQuery>[0]> = {}): Parameters<typeof parseSearchQuery>[0] {
  return { q: null, kind: null, genre: null, year: null, sort: null, limit: null, cursor: null, ...overrides };
}

function parseOrThrow(params: Parameters<typeof parseSearchQuery>[0]): CatalogSearchQuery {
  const parsed = parseSearchQuery(params);
  assert.equal(parsed.ok, true);
  return (parsed as { ok: true; value: CatalogSearchQuery }).value;
}

async function searchIds(pool: Pool, params: Parameters<typeof parseSearchQuery>[0]): Promise<string[]> {
  const page = await searchCatalogItems(pool, readEnv(), parseOrThrow(params));
  return page.items.map((item) => item.externalId);
}

let pool: Pool;

before(async () => {
  await withClient(TEST_DATABASE_URL, async () => {});
  await withClient(TEST_DATABASE_URL, async (client) => {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = 'reelhouse_catalog_read_test'");
    if (exists.rowCount === 0) await client.query("CREATE DATABASE reelhouse_catalog_read_test");
  });
  await withClient(READ_DATABASE_URL, async (client) => {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  });
  await runMigrations({ databaseUrl: READ_DATABASE_URL, migrationsDir: MIGRATIONS_DIR, log: () => {} });
  pool = testPool();
});

describe("catalog read model", () => {
  beforeEach(async () => {
    await withClient(READ_DATABASE_URL, async (client) => resetSchema(client));
  });

  it("walks a keyset search with no gaps, duplicates, or off-by-one (name sort)", async () => {
    await withClient(READ_DATABASE_URL, async (client) => seedCatalog(client));
    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page = await searchCatalogItems(pool, readEnv(), parseOrThrow(query({ limit: "3", cursor })));
      collected.push(...page.items.map((item) => item.externalId));
      pages += 1;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      assert.ok(pages <= 10, "walk must terminate");
    }
    assert.deepEqual(collected, NAME_ORDER);
    assert.equal(pages, 3);
  });

  it("reports the unfiltered total and keeps pages stable when the catalog changes mid-walk", async () => {
    await withClient(READ_DATABASE_URL, async (client) => seedCatalog(client));
    const first = await searchCatalogItems(pool, readEnv(), parseOrThrow(query({ limit: "3" })));
    assert.equal(first.total, NAME_ORDER.length);
    assert.deepEqual(first.items.map((item) => item.externalId), NAME_ORDER.slice(0, 3));

    // A new item lands that sorts BEFORE the cursor position ("aardvark"
    // sorts ahead of "alpha"). Offset pagination would shift page two under
    // this insert; keyset pagination must not.
    await withClient(READ_DATABASE_URL, async (client) => {
      const lib = await client.query<{ id: string }>(
        "SELECT id FROM catalog_library WHERE external_id = 'lib-read'"
      );
      await insertItem(client, lib.rows[0].id, {
        externalId: "m-aard",
        name: "Aardvark Movie",
        kind: "movie",
        year: 2024,
        rating: 5.0,
        dateCreated: "2026-07-01T10:00:00Z",
        art: "tag-aard",
        genre: "Drama"
      });
    });

    const second = await searchCatalogItems(pool, readEnv(), parseOrThrow(query({ limit: "3", cursor: first.nextCursor })));
    assert.equal(second.total, NAME_ORDER.length + 1, "the count reflects the changed catalog");
    assert.deepEqual(
      second.items.map((item) => item.externalId),
      NAME_ORDER.slice(3, 6),
      "page two starts exactly after page one, regardless of the insert"
    );
    assert.ok(!second.items.some((item) => item.externalId === "m-aard"));
  });

  it("searches names case-insensitively with escaped wildcard characters", async () => {
    await withClient(READ_DATABASE_URL, async (client) => seedCatalog(client));
    assert.deepEqual(await searchIds(pool, query({ q: "STAR" })), ["m-star"]);
    assert.deepEqual(await searchIds(pool, query({ q: "movie" })), ["m-a", "m-b", "m-g", "m-miss"]);
    // A literal percent must match the literal title, not widen the scan.
    assert.deepEqual(await searchIds(pool, query({ q: "100%" })), ["m-pct"]);
    assert.deepEqual(await searchIds(pool, query({ q: "no-such-title" })), []);
  });

  it("filters by kind, genre, and year in combination", async () => {
    await withClient(READ_DATABASE_URL, async (client) => seedCatalog(client));
    assert.deepEqual(await searchIds(pool, query({ kind: "series" })), ["s-e", "s-z"]);
    assert.deepEqual(await searchIds(pool, query({ kind: "season" })), []);
    assert.deepEqual(await searchIds(pool, query({ genre: "sci-fi" })), ["m-g", "m-star", "s-z"]);
    assert.deepEqual(await searchIds(pool, query({ year: "2020" })), ["m-a", "m-miss", "m-star"]);
    assert.deepEqual(await searchIds(pool, query({ genre: "drama", year: "2021" })), ["m-b"]);
    assert.deepEqual(await searchIds(pool, query({ q: "beta", genre: "drama" })), ["m-b"]);
    assert.deepEqual(await searchIds(pool, query({ genre: "drama", year: "1999" })), []);
  });

  it("orders by rating desc with NULLS LAST and keeps the keyset continuous across the null boundary", async () => {
    await withClient(READ_DATABASE_URL, async (client) => seedCatalog(client));
    const collected: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await searchCatalogItems(pool, readEnv(), parseOrThrow(query({ sort: "rating", limit: "3", cursor })));
      collected.push(...page.items.map((item) => item.externalId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    // Valued rows descend, then the NULLS LAST zone by external id; retired
    // never appears.
    assert.deepEqual(collected, ["m-b", "m-star", "s-z", "m-a", "m-pct", "m-miss", "m-g", "s-e"]);
  });

  it("orders by recency desc NULLS LAST and by year desc NULLS LAST, walked", async () => {
    await withClient(READ_DATABASE_URL, async (client) => seedCatalog(client));
    const recent: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await searchCatalogItems(pool, readEnv(), parseOrThrow(query({ sort: "recent", limit: "4", cursor })));
      recent.push(...page.items.map((item) => item.externalId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    // Recency desc with the tied-timestamp pair ordered by external id, the
    // undated row strictly last; retired never appears.
    assert.deepEqual(recent, ["m-star", "s-e", "s-z", "m-a", "m-miss", "m-b", "m-pct", "m-g"]);

    const yearPage = await searchCatalogItems(pool, readEnv(), parseOrThrow(query({ sort: "year", limit: "3" })));
    assert.deepEqual(yearPage.items.map((item) => item.externalId), ["s-z", "m-b", "m-pct"]);
    assert.equal(yearPage.total, NAME_ORDER.length);
  });

  it("excludes retired rows, flags missing ones, and reports missing-art facts", async () => {
    await withClient(READ_DATABASE_URL, async (client) => seedCatalog(client));
    const page = await searchCatalogItems(pool, readEnv(), parseOrThrow(query({ limit: "100" })));
    const byId = new Map(page.items.map((item) => [item.externalId, item]));
    assert.ok(!byId.has("m-gone"), "retired rows are invisible to readers");

    const missing = byId.get("m-miss") as CatalogItemView;
    assert.equal(missing.missing, true);
    const present = byId.get("m-a") as CatalogItemView;
    assert.equal(present.missing, false);

    const noArt = byId.get("m-b") as CatalogItemView;
    assert.equal(noArt.hasArt, false);
    assert.equal(noArt.imageUrl, null, "no URL is fabricated without a tag");
    const art = byId.get("m-star") as CatalogItemView;
    assert.equal(art.hasArt, true);
    assert.equal(art.imageUrl, "http://jf.lan:8096/Items/m-star/Images/Primary?maxWidth=600&quality=90&tag=tag-star");
    assert.deepEqual(art.genres, ["Sci-Fi"], "genres are joined per page, in list order");
  });

  it("orders recommendation rails art-first, then by the rail key", async () => {
    await withClient(READ_DATABASE_URL, async (client) => seedCatalog(client));
    const rails = await catalogRails(pool, readEnv(), { genre: "sci-fi", limit: 10 });
    assert.deepEqual(
      rails.map((rail) => rail.key),
      ["top_rated", "recently_added", "genre"]
    );

    const topRated = rails[0].items.map((item) => item.externalId);
    assert.deepEqual(
      topRated,
      ["m-star", "s-z", "m-a", "m-pct", "m-miss", "m-g", "m-b", "s-e"],
      "items with art lead (highest rating first, unrated artful still ahead), art-less rows follow"
    );
    const recent = rails[1].items.map((item) => item.externalId);
    assert.deepEqual(recent, ["m-star", "s-z", "m-a", "m-miss", "m-pct", "m-g", "s-e", "m-b"]);
    const genre = rails[2];
    assert.equal(genre.genre, "sci-fi");
    assert.deepEqual(genre.items.map((item) => item.externalId), ["m-star", "s-z", "m-g"]);
  });

  it("browses the library deterministically with an artful hero", async () => {
    await withClient(READ_DATABASE_URL, async (client) => seedCatalog(client));
    const browse = await catalogLibraryBrowse(pool, readEnv(), { limit: 5 });
    assert.ok(browse.hero !== null);
    assert.equal(browse.hero.externalId, "m-star", "the hero is the newest item that actually has art");
    const titles = browse.sections.map((section) => section.title);
    assert.deepEqual(titles, ["Recently Added", "Top Rated", "Movies", "Shows"]);
    const movies = browse.sections.find((section) => section.title === "Movies");
    assert.deepEqual(
      (movies as { items: CatalogItemView[] }).items.map((item) => item.externalId),
      ["m-pct", "m-a", "m-b", "m-g", "m-miss"],
      "name-ordered, retired excluded, bounded by the section limit"
    );
    const shows = browse.sections.find((section) => section.title === "Shows");
    assert.deepEqual((shows as { items: CatalogItemView[] }).items.map((item) => item.externalId), ["s-e", "s-z"]);
  });

  it("reports freshness: empty before the first sync, fresh within, stale beyond the policy", async () => {
    await withClient(READ_DATABASE_URL, async (client) => seedCatalog(client));
    assert.deepEqual(await catalogStatus(pool, readEnv(), { now: new Date(T0.getTime() + STALEHours * HOUR_MS - 1) }), {
      state: "fresh",
      lastSucceededAt: T0.toISOString()
    });
    assert.deepEqual(await catalogStatus(pool, readEnv(), { now: new Date(T0.getTime() + STALEHours * HOUR_MS + 1) }), {
      state: "stale",
      lastSucceededAt: T0.toISOString()
    });
    const tighter = await catalogStatus(pool, readEnv({ MEDIA_CATALOG_STALE_HOURS: "1" }), {
      now: new Date(T0.getTime() + 2 * HOUR_MS)
    });
    assert.equal(tighter.state, "stale", "the policy variable moves the threshold");

    await withClient(READ_DATABASE_URL, async (client) => {
      await client.query("DELETE FROM catalog_sync_state");
    });
    assert.deepEqual(await catalogStatus(pool, readEnv(), { now: new Date() }), {
      state: "empty",
      lastSucceededAt: null
    });
  });

  it("fails closed on unconfigured or unreachable catalog databases, redacted and bounded", async () => {
    assert.throws(() => getCatalogPool({}), /MEDIA_CATALOG_DATABASE_URL/);
    assert.throws(
      () => getCatalogPool({ MEDIA_CATALOG_DATABASE_URL: "mysql://bad" }),
      /invalid and was rejected/
    );
    await closeCatalogPool();

    const secretUrl = "postgresql://catalog_user:sekrit@127.0.0.1:59999/none";
    const dead = new Pool({ connectionString: secretUrl, connectionTimeoutMillis: 800 });
    try {
      await assert.rejects(
        searchCatalogItems(dead, { MEDIA_CATALOG_DATABASE_URL: secretUrl }, parseOrThrow(query())),
        (error: unknown) => {
          assert.ok(error instanceof CatalogUnavailableError);
          assert.ok(!error.message.includes(SECRET_PAIR));
          assert.ok(!error.message.includes("sekrit"), "connection failures must not leak credentials");
          assert.ok(error.message.length <= 2000);
          return true;
        }
      );
      await assert.rejects(
        catalogStatus(dead, { MEDIA_CATALOG_DATABASE_URL: secretUrl }, { now: new Date() }),
        CatalogUnavailableError
      );
    } finally {
      await dead.end().catch(() => {});
    }
  });

  it("rejects an invalid freshness policy instead of guessing a threshold", async () => {
    await withClient(READ_DATABASE_URL, async (client) => seedCatalog(client));
    await assert.rejects(
      catalogStatus(pool, readEnv({ MEDIA_CATALOG_STALE_HOURS: "bogus" }), { now: new Date() }),
      /freshness policy is invalid/
    );
  });
});
