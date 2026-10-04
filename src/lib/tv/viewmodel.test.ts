// Hermetic unit tests for the TV view-model mappers (RH-0035).
//
// These pin what the living-room UI shows for every read-model payload it
// consumes: card/rail rendering sets, watch-progress math, image and play
// URL construction from the PUBLIC Jellyfin base only, detail facets, and
// the banner-state matrix that composes /api/catalog/status with
// /api/health. All pure; runs in the hermetic `npm test` pass.

import test from "node:test";
import assert from "node:assert/strict";
import {
  cardFromCatalog,
  cardFromRailItem,
  cardSubtitle,
  detailView,
  heroCard,
  jellyfinImageUrl,
  kindLabel,
  playHref,
  progressPercent,
  statusBanner,
  visibleRails,
  type CatalogCardPayload,
  type HomeFeedPayload,
  type ItemDetailPayload
} from "./viewmodel.ts";

const PUBLIC_URL = "http://jellyfin.lan:8096/";

function cardRow(overrides: Partial<CatalogCardPayload> = {}): CatalogCardPayload {
  return {
    id: 1,
    source: "jellyfin",
    jellyfin_id: "mov-1",
    library_jellyfin_id: "lib-movies",
    library_name: "Movies",
    item_type: "movie",
    name: "Arrival",
    original_title: null,
    production_year: 2016,
    community_rating: "7.9",
    official_rating: "PG-13",
    runtime_ticks: "54000000000",
    primary_image_tag: "primary-tag",
    backdrop_image_tag: "backdrop-tag",
    series_jellyfin_id: null,
    series_name: null,
    season_number: null,
    episode_number: null,
    ...overrides
  };
}

function railFeed(overrides: HomeFeedPayload["rows"] = []): HomeFeedPayload {
  const base: HomeFeedPayload["rows"][number][] = [
    {
      slug: "continue",
      kind: "continue_watching",
      title: "Continue Watching",
      position: 2,
      enabled: true,
      resolved: true,
      items: [cardRow({ jellyfin_id: "ep-1", item_type: "episode", name: "Pilot", series_name: "Dark", season_number: 1, episode_number: 2 })]
    },
    {
      slug: "recent",
      kind: "recently_added",
      title: "Recently Added",
      position: 1,
      enabled: true,
      resolved: true,
      items: [cardRow({ jellyfin_id: "mov-9" })]
    },
    {
      slug: "gone",
      kind: "library",
      title: "Vanished Library",
      position: 3,
      enabled: true,
      resolved: false,
      items: []
    },
    {
      slug: "off",
      kind: "favorites",
      title: "Favorites (disabled)",
      position: 4,
      enabled: false,
      resolved: true,
      items: [cardRow({ jellyfin_id: "mov-x" })]
    },
    {
      slug: "hollow",
      kind: "watchlist",
      title: "Empty Watchlist",
      position: 5,
      enabled: true,
      resolved: true,
      items: []
    }
  ];
  return { profile: null, rows: overrides.length ? overrides : base, perRailLimit: 20 };
}

test("kindLabel maps the closed catalog type set", () => {
  assert.equal(kindLabel("movie"), "Movie");
  assert.equal(kindLabel("series"), "Series");
  assert.equal(kindLabel("season"), "Season");
  assert.equal(kindLabel("episode"), "Episode");
  assert.equal(kindLabel("video"), "video");
});

test("image and play URLs come only from the public Jellyfin base", () => {
  assert.equal(
    jellyfinImageUrl(PUBLIC_URL, "mov-1", "Primary", "tag-1"),
    "http://jellyfin.lan:8096/Items/mov-1/Images/Primary?maxWidth=600&quality=90&tag=tag-1"
  );
  assert.equal(
    jellyfinImageUrl(PUBLIC_URL, "mov-1", "Backdrop", "tag-2"),
    "http://jellyfin.lan:8096/Items/mov-1/Images/Backdrop?maxWidth=1600&quality=90&tag=tag-2"
  );
  // No public URL or no tag → no URL, and the UI falls back to letter tiles.
  assert.equal(jellyfinImageUrl(null, "mov-1", "Primary", "tag-1"), null);
  assert.equal(jellyfinImageUrl(PUBLIC_URL, "mov-1", "Primary", null), null);
  assert.equal(jellyfinImageUrl("   ", "mov-1", "Primary", "tag-1"), null);
  assert.equal(playHref(PUBLIC_URL, "mov 1"), "http://jellyfin.lan:8096/web/index.html#!/details?id=mov%201");
  assert.equal(playHref(undefined, "mov-1"), null);
});

test("progress math clamps to a 0–100 bar and refuses meaningless data", () => {
  assert.equal(progressPercent("25000000000", "100000000000"), 25);
  assert.equal(progressPercent("99999999999", "100000000000"), 100);
  assert.equal(progressPercent("0", "100000000000"), null);
  assert.equal(progressPercent("500", "0"), null);
  assert.equal(progressPercent("500", null), null);
  assert.equal(progressPercent(null, null), null);
  assert.equal(progressPercent("abc", "100"), null);
});

test("episode and season cards carry series context as their subtitle", () => {
  assert.equal(cardSubtitle(cardRow({ item_type: "episode", series_name: "Dark", season_number: 1, episode_number: 2 })), "Dark · S1:E2");
  assert.equal(cardSubtitle(cardRow({ item_type: "episode", series_name: "Dark", season_number: null, episode_number: null })), "Dark ·");
  assert.equal(cardSubtitle(cardRow({ item_type: "season", series_name: "Dark", season_number: 2 })), "Dark");
  assert.equal(cardSubtitle(cardRow({ item_type: "movie" })), null);
});

test("cards map catalog rows into display-ready data", () => {
  const ui = cardFromCatalog(cardRow(), "k", PUBLIC_URL);
  assert.equal(ui.key, "k:mov-1");
  assert.equal(ui.title, "Arrival");
  assert.equal(ui.year, 2016);
  assert.equal(ui.rating, 7.9);
  assert.equal(ui.kindLabel, "Movie");
  assert.equal(ui.progress, null);
  assert.equal(ui.imageUrl?.includes("Images/Primary"), true);
  assert.equal(ui.playHref?.includes("/web/index.html#!/details?id=mov-1"), true);
});

test("rail items carry watch progress from household ticks", () => {
  const ui = cardFromRailItem(
    { ...cardRow({ jellyfin_id: "ep-1" }), position_ticks: "50000000000", duration_ticks: "100000000000" },
    "k",
    PUBLIC_URL
  );
  assert.equal(ui.progress, 50);
});

test("visibleRails render the enabled, resolved, non-empty rails in household order", () => {
  const rails = visibleRails(railFeed(), PUBLIC_URL);
  assert.deepEqual(
    rails.map((rail) => rail.slug),
    ["recent", "continue"] // position 1 before 2; unresolved/disabled/empty drop out
  );
  assert.equal(rails[1].cards[0].subtitle, "Dark · S1:E2");
  assert.equal(rails[1].cards[0].key, "continue:ep-1");
});

test("visibleRails breaks position ties deterministically by slug", () => {
  const tied = railFeed([
    { slug: "b-rail", kind: "library", title: "B", position: 1, enabled: true, resolved: true, items: [cardRow({ jellyfin_id: "x" })] },
    { slug: "a-rail", kind: "library", title: "A", position: 1, enabled: true, resolved: true, items: [cardRow({ jellyfin_id: "y" })] }
  ]);
  assert.deepEqual(visibleRails(tied, PUBLIC_URL).map((rail) => rail.slug), ["a-rail", "b-rail"]);
});

test("heroCard picks the first card of the first visible rail", () => {
  assert.equal(heroCard(railFeed(), PUBLIC_URL)?.jellyfinId, "mov-9");
  const empty = railFeed([
    { slug: "hollow", kind: "library", title: "Empty", position: 1, enabled: true, resolved: true, items: [] }
  ]);
  assert.equal(heroCard(empty, PUBLIC_URL), null);
});

function detailPayload(overrides: Partial<ItemDetailPayload> = {}): ItemDetailPayload {
  return {
    item: cardRow(),
    overview: "A linguist joins the effort to communicate with alien visitors.",
    container: "mkv",
    filePath: "/media/movies/arrival/arrival.mkv",
    fileSizeBytes: "21474836480",
    etag: "etag-1",
    firstSeenAt: "2026-09-22T00:00:00.000Z",
    genres: ["Drama", "Science fiction"],
    studios: ["Paramount"],
    people: [
      { name: "Denis Villeneuve", personType: "Director", roleName: null },
      { name: "Amy Adams", personType: "Actor", roleName: "Louise Banks" }
    ],
    providerIds: [{ name: "Imdb", value: "tt2543164" }],
    ...overrides
  };
}

test("detailView maps facets, people roles, and a bounded file summary", () => {
  const view = detailView(detailPayload(), PUBLIC_URL);
  assert.equal(view.title, "Arrival");
  assert.equal(view.kindLabel, "Movie");
  assert.deepEqual(view.genres, ["Drama", "Science fiction"]);
  assert.deepEqual(view.studios, ["Paramount"]);
  assert.deepEqual(view.people, ["Denis Villeneuve", "Amy Adams — Louise Banks"]);
  assert.deepEqual(view.providerNames, ["Imdb"]);
  assert.equal(view.fileSummary, "mkv · 20.0 GB");
  assert.equal(view.backdropUrl?.includes("Images/Backdrop"), true);
  assert.equal(view.playHref?.includes("id=mov-1"), true);
  assert.equal(view.officialRating, "PG-13");
});

test("detailView tolerates missing file facets", () => {
  const view = detailView(detailPayload({ container: null, fileSizeBytes: null }), PUBLIC_URL);
  assert.equal(view.fileSummary, null);
});

test("statusBanner composes Jellyfin health and catalog freshness in priority order", () => {
  const stale = { state: "stale" as const, watermark: null, itemCounts: { total: 9, byType: {} }, openQuarantines: 0 };
  const fresh = { ...stale, state: "fresh" as const };

  // Jellyfin down outranks everything: playback authority first.
  assert.equal(statusBanner(stale, { state: "unreachable" })?.tone, "jellyfin_down");
  assert.equal(statusBanner(fresh, { state: "unreachable" })?.tone, "jellyfin_down");
  assert.equal(statusBanner(fresh, { state: "unreachable" })?.message.includes("unreachable"), true);

  // Staleness is reported as data.
  assert.equal(statusBanner(stale, { state: "reachable" })?.tone, "stale");

  // never_synced with items is a real anomaly; with zero items it is the
  // empty-feed state and stays silent.
  assert.equal(
    statusBanner({ ...stale, state: "never_synced", itemCounts: { total: 3, byType: {} } }, { state: "reachable" })?.tone,
    "never_synced"
  );
  assert.equal(
    statusBanner({ ...stale, state: "never_synced", itemCounts: { total: 0, byType: {} } }, { state: "reachable" }),
    null
  );

  // A fresh catalog on a healthy stack renders no banner.
  assert.equal(statusBanner(fresh, { state: "reachable" }), null);
  assert.equal(statusBanner(fresh, { state: "unconfigured" }), null);
  assert.equal(statusBanner(null, null), null);
});
