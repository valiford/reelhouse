// Hermetic unit matrix for the read-model decision logic (RH-0040).
//
// Everything here runs without a database and without network: the mapping
// and bounding rules are pure, and the payload builders are driven through
// in-memory executor doubles that route canned rows by SQL shape. The SQL
// itself (joins, isolation, indexes, bounds under real data) is the
// integration suite's territory — this file pins the logic around it.

import test from "node:test";
import assert from "node:assert/strict";
import type { QueryResultRow } from "pg";
import {
  READ_MODEL_LIMITS,
  clampInt,
  computeProgress,
  imageUrl,
  kindOf,
  publicJellyfinUrl,
  sanitizeSearchTerm,
  toMediaItem,
  type CatalogItemRow,
  type ReadExecutor
} from "./items.ts";
import { getHomePayload } from "./home.ts";
import { searchCatalog } from "./search.ts";
import { catalogDiagnostics } from "./diagnostics.ts";

test("sanitizeSearchTerm trims, bounds, and escapes LIKE wildcards", () => {
  assert.equal(sanitizeSearchTerm("  Arrival  "), "Arrival");
  assert.equal(sanitizeSearchTerm("100% True"), "100\\% True");
  assert.equal(sanitizeSearchTerm("snake_case"), "snake\\_case");
  assert.equal(sanitizeSearchTerm("back\\slash"), "back\\\\slash");
  assert.equal(sanitizeSearchTerm("   "), null);
  assert.equal(sanitizeSearchTerm(""), null);
  assert.equal(sanitizeSearchTerm(null), null);
  const long = "x".repeat(READ_MODEL_LIMITS.termLength + 50);
  assert.equal(sanitizeSearchTerm(long)?.length, READ_MODEL_LIMITS.termLength);
});

test("clampInt clamps to the bounded window and falls back on junk", () => {
  const limits = { min: 1, max: 100 };
  assert.equal(clampInt(50, limits, 40), 50);
  assert.equal(clampInt(0, limits, 40), 1);
  assert.equal(clampInt(1000, limits, 40), 100);
  assert.equal(clampInt("7", limits, 40), 7);
  assert.equal(clampInt("abc", limits, 40), 40);
  assert.equal(clampInt(1.5, limits, 40), 40);
  assert.equal(clampInt(null, limits, 40), 40);
});

test("computeProgress renders a clamped percentage and refuses junk pairs", () => {
  assert.equal(computeProgress("600000000", "1500000000"), 40);
  assert.equal(computeProgress(1, 3), 33);
  assert.equal(computeProgress("0", "100"), 0);
  assert.equal(computeProgress("500", "100"), 100);
  assert.equal(computeProgress("-10", "100"), 0);
  assert.equal(computeProgress(null, "100"), undefined);
  assert.equal(computeProgress("10", null), undefined);
  assert.equal(computeProgress("10", "0"), undefined);
  assert.equal(computeProgress("10", "not-a-number"), undefined);
});

test("kindOf maps the catalog's closed item-type set", () => {
  assert.equal(kindOf("movie"), "Movie");
  assert.equal(kindOf("series"), "Series");
  assert.equal(kindOf("episode"), "Episode");
  assert.equal(kindOf("season"), "Video");
});

test("imageUrl builds browser-facing image URLs and refuses partial inputs", () => {
  const base = "http://jf:8096";
  assert.equal(
    imageUrl(base, "mov-1", "Primary", "tag-1"),
    "http://jf:8096/Items/mov-1/Images/Primary?maxWidth=600&quality=90&tag=tag-1"
  );
  assert.equal(
    imageUrl(base, "mov 1", "Backdrop", "a b"),
    "http://jf:8096/Items/mov%201/Images/Backdrop?maxWidth=1600&quality=90&tag=a%20b"
  );
  assert.equal(imageUrl(undefined, "mov-1", "Primary", "tag-1"), undefined);
  assert.equal(imageUrl(base, "mov-1", "Primary", null), undefined);
});

test("publicJellyfinUrl prefers the browser-facing URL and strips slashes", () => {
  assert.equal(publicJellyfinUrl({ NEXT_PUBLIC_JELLYFIN_URL: "http://a/", JELLYFIN_URL: "http://b" }), "http://a");
  assert.equal(publicJellyfinUrl({ JELLYFIN_URL: "http://b/" }), "http://b");
  assert.equal(publicJellyfinUrl({}), undefined);
  assert.equal(publicJellyfinUrl({ NEXT_PUBLIC_JELLYFIN_URL: "   " }), undefined);
});

function itemRow(overrides: Partial<CatalogItemRow> = {}): CatalogItemRow {
  return {
    jellyfin_id: "mov-1",
    item_type: "movie",
    name: "Arrival",
    series_name: null,
    production_year: 2016,
    overview: "First contact.",
    community_rating: "7.9",
    primary_image_tag: "p-tag",
    backdrop_image_tag: null,
    genres: ["Drama", "Science fiction"],
    ...overrides
  };
}

test("toMediaItem maps wire shapes onto the UI contract", () => {
  const item = toMediaItem(itemRow(), "http://jf");
  assert.deepEqual(
    item,
    {
      id: "mov-1",
      title: "Arrival",
      subtitle: undefined,
      year: 2016,
      overview: "First contact.",
      kind: "Movie",
      rating: 7.9,
      progress: undefined,
      imageUrl: "http://jf/Items/mov-1/Images/Primary?maxWidth=600&quality=90&tag=p-tag",
      backdropUrl: undefined,
      genres: ["Drama", "Science fiction"]
    }
  );

  const episode = toMediaItem(
    itemRow({
      jellyfin_id: "ep-1",
      item_type: "episode",
      name: "Pilot",
      series_name: "Demo Show",
      production_year: null,
      overview: null,
      community_rating: null,
      primary_image_tag: null,
      genres: null,
      position_ticks: "600000000",
      duration_ticks: "1500000000"
    }),
    undefined,
    "600000000"
  );
  assert.equal(episode.kind, "Episode");
  assert.equal(episode.subtitle, "Demo Show");
  assert.equal(episode.imageUrl, undefined);
  assert.equal(episode.progress, 40);
  assert.equal(episode.genres, undefined);
});

// Executor double: routes canned rows by SQL keyword so each test states
// only the queries it cares about. Unmatched SQL fails loudly — a silent
// empty row would masquerade as a legitimate empty rail.
type SqlRoute = { match: RegExp; rows: QueryResultRow[] | ((params: unknown[]) => QueryResultRow[]) };

function double(routes: SqlRoute[]): ReadExecutor & { calls: string[] } {
  return {
    calls: [],
    async query<R extends QueryResultRow>(text: string, params?: unknown[]) {
      this.calls.push(text);
      for (const route of routes) {
        if (route.match.test(text)) {
          const rows = typeof route.rows === "function" ? route.rows(params ?? []) : route.rows;
          return { rows: rows as R[] };
        }
      }
      throw new Error(`double has no route for SQL: ${text.slice(0, 120)}`);
    }
  } as ReadExecutor & { calls: string[] };
}

const PROFILE_ROUTE: SqlRoute = {
  match: /FROM household_profiles/,
  rows: [{ id: 1, slug: "v_ali", display_name: "V’Ali" }]
};

const CATALOG_PRESENT: SqlRoute = {
  match: /SELECT 1 AS present FROM media_items/,
  rows: [{ present: 1 }]
};

test("getHomePayload maps empty-catalog and profile failures to data, not errors", async () => {
  const empty = double([{ match: /SELECT 1 AS present FROM media_items/, rows: [] }]);
  assert.deepEqual(await getHomePayload(empty), { kind: "empty-catalog" });

  const noProfile = double([CATALOG_PRESENT, { match: /FROM household_profiles/, rows: [] }]);
  const missing = await getHomePayload(noProfile);
  assert.equal(missing.kind, "profile-not-found");

  const archivedTarget = double([
    CATALOG_PRESENT,
    // The fallback (no explicit slug) answered a different profile than asked.
    { match: /FROM household_profiles/, rows: [{ id: 2, slug: "nicole", display_name: "Nicole" }] }
  ]);
  const wrong = await getHomePayload(archivedTarget, { profileSlug: "v_ali" });
  assert.equal(wrong.kind, "profile-not-found");
});

test("getHomePayload falls back to built-in rails when no home rows are configured", async () => {
  const executor = double([
    PROFILE_ROUTE,
    CATALOG_PRESENT,
    { match: /FROM household_home_rows/, rows: [] },
    {
      match: /item_type IN \('movie', 'series'\)/,
      rows: [itemRow({ jellyfin_id: "mov-1", name: "Arrival" })]
    },
    {
      match: /item_type = 'movie'/,
      rows: [itemRow({ jellyfin_id: "mov-1", name: "Arrival" }), itemRow({ jellyfin_id: "mov-2", name: "Bare Movie" })]
    },
    { match: /item_type = 'series'/, rows: [itemRow({ jellyfin_id: "ser-1", item_type: "series", name: "Demo Show" })] },
    {
      match: /FROM household_watch_state w/,
      rows: [
        itemRow({
          jellyfin_id: "ep-1",
          item_type: "episode",
          name: "Pilot",
          series_name: "Demo Show",
          position_ticks: "300000000",
          duration_ticks: "1500000000"
        })
      ]
    }
  ]);
  const result = await getHomePayload(executor, { env: {} });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.payload.source, "catalog");
  assert.deepEqual(
    result.payload.sections.map((section) => section.title),
    ["Continue Watching", "Recently Added", "Movies", "Shows"]
  );
  // Recently added has no backdrop here; the hero still resolves.
  assert.equal(result.payload.hero.id, "mov-1");
  // The continue rail carries computed progress.
  const continueSection = result.payload.sections[0];
  assert.equal(continueSection.items[0].progress, 20);
});

test("getHomePayload skips empty and misconfigured rails, picks a backdrop hero", async () => {
  const env = { NEXT_PUBLIC_JELLYFIN_URL: "http://jf" };
  const executor = double([
    PROFILE_ROUTE,
    CATALOG_PRESENT,
    {
      match: /FROM household_home_rows/,
      rows: [
        { slug: "row-cw", kind: "continue_watching", title: "Continue Watching", config: {} },
        { slug: "row-bad", kind: "library", title: "Broken Reference", config: { wrong_key: 7 } },
        { slug: "row-unknown", kind: "mystery", title: "Mystery", config: {} },
        {
          slug: "row-recent",
          kind: "recently_added",
          title: "Recently Added",
          config: {}
        }
      ]
    },
    { match: /FROM household_watch_state w/, rows: [] },
    {
      match: /FROM media_items m/,
      rows: [
        itemRow({ jellyfin_id: "mov-9", name: "Newest", backdrop_image_tag: "bd", primary_image_tag: "pr" }),
        itemRow({ jellyfin_id: "mov-8", name: "Older" })
      ]
    }
  ]);
  const result = await getHomePayload(executor, { env });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  // Empty continue rail, misconfigured library reference, and the unknown
  // kind are all dropped; the payload carries only the populated rail.
  assert.deepEqual(result.payload.sections.map((section) => section.title), ["Recently Added"]);
  assert.equal(result.payload.hero.id, "mov-9");
  assert.equal(result.payload.hero.backdropUrl, "http://jf/Items/mov-9/Images/Backdrop?maxWidth=1600&quality=90&tag=bd");
});

test("getHomePayload hero falls back across rails when recently added is empty", async () => {
  const executor = double([
    PROFILE_ROUTE,
    CATALOG_PRESENT,
    {
      match: /FROM household_home_rows/,
      rows: [
        { slug: "row-recent", kind: "recently_added", title: "Recently Added", config: {} },
        { slug: "row-cw", kind: "continue_watching", title: "Continue Watching", config: {} }
      ]
    },
    { match: /FROM media_items m/, rows: [] },
    {
      match: /FROM household_watch_state w/,
      rows: [itemRow({ jellyfin_id: "ep-2", item_type: "episode", name: "Episode Two", series_name: "Demo Show" })]
    }
  ]);
  const result = await getHomePayload(executor, { env: {} });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(result.payload.sections.map((section) => section.title), ["Continue Watching"]);
  assert.equal(result.payload.hero.id, "ep-2");
});

test("searchCatalog maps rows, echoes bounds, and short-circuits blank terms", async () => {
  const blank = await searchCatalog(double([]), "   ", { env: {} });
  assert.deepEqual(blank, { items: [], limit: 40, offset: 0, term: "" });

  const executor = double([
    {
      match: /FROM media_items m/,
      rows: [itemRow({ jellyfin_id: "mov-1", name: "Arrival" })]
    }
  ]);
  const page = await searchCatalog(executor, "arrival", { limit: 1000, offset: -5, env: {} });
  assert.equal(page.limit, READ_MODEL_LIMITS.searchLimit.max);
  assert.equal(page.offset, 0);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, "mov-1");
  // The prefix-first ORDER BY branch must be present in the issued query.
  assert.match(executor.calls[0], /ORDER BY \(m\.name ILIKE \$2 ESCAPE '\\'\) DESC/);
});

test("catalogDiagnostics maps wire types and degrades to unknown on failure", async () => {
  const ok = await catalogDiagnostics(
    double([
      {
        match: /active_items/,
        rows: [
          {
            active_items: "8",
            active_libraries: "2",
            quarantined: "0",
            last_sync_finished: new Date("2026-09-25T12:00:00Z"),
            last_sync_mode: "full",
            watermark: new Date("2026-09-25T11:00:00Z"),
            active_profiles: "2",
            last_import_finished: null
          }
        ]
      }
    ])
  );
  assert.equal(ok.state, "ok");
  assert.equal(ok.activeItems, 8);
  assert.equal(ok.activeLibraries, 2);
  assert.equal(ok.quarantined, 0);
  assert.equal(ok.activeProfiles, 2);
  assert.equal(ok.lastSuccessfulSyncAt, "2026-09-25T12:00:00.000Z");
  assert.equal(ok.lastSyncMode, "full");
  assert.equal(ok.watermark, "2026-09-25T11:00:00.000Z");
  assert.equal(ok.lastSuccessfulImportAt, undefined);

  const broken = await catalogDiagnostics(
    double([
      {
        match: /active_items/,
        // A function whose CALL throws — the failure happens at query time
        // (inside diagnostics' catch), not at double construction.
        rows: () => {
          throw Object.assign(new Error("relationboom"), { code: "42P01" });
        }
      }
    ])
  );
  assert.equal(broken.state, "unknown");
  assert.match(broken.detail ?? "", /catalog tables not present|migrations not applied|relationboom/);

  // Any other failure degrades to unknown with the bounded detail — it must
  // never throw out of a diagnostics read.
  const failing = await catalogDiagnostics(
    double([
      {
        match: /active_items/,
        rows: () => {
          throw new Error("boom");
        }
      }
    ])
  );
  assert.equal(failing.state, "unknown");
  assert.match(failing.detail ?? "", /boom/);
});
