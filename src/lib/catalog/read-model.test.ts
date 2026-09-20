// Unit tests for the catalog read model's pure surface (RH-0020): query
// parsing and bounding, the keyset cursor codec, LIKE escaping, image URL
// composition, and the MediaItem mapping. No I/O, no database.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  catalogViewToMediaItem,
  composeImageUrl,
  decodeCursor,
  encodeCursor,
  jellyfinImageBase,
  likePattern,
  parseRailQuery,
  parseSearchQuery,
  type CatalogItemView
} from "./read-model.ts";

function emptyQuery(): Parameters<typeof parseSearchQuery>[0] {
  return { q: null, kind: null, genre: null, year: null, sort: null, limit: null, cursor: null };
}

test("search query defaults are bounded and browse-shaped", () => {
  const parsed = parseSearchQuery(emptyQuery());
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.q, "");
    assert.deepEqual(parsed.value.kinds, ["movie", "series"]);
    assert.equal(parsed.value.genre, null);
    assert.equal(parsed.value.year, null);
    assert.equal(parsed.value.sort, "name");
    assert.equal(parsed.value.limit, 24);
    assert.equal(parsed.value.cursor, null);
  }
});

test("search query bounds every input and refuses instead of clamping", () => {
  const tooLong = parseSearchQuery({ ...emptyQuery(), q: "x".repeat(201) });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.match(tooLong.errors[0], /at most 200 characters/);

  const badKind = parseSearchQuery({ ...emptyQuery(), kind: "movie,document" });
  assert.equal(badKind.ok, false);
  if (!badKind.ok) assert.match(badKind.errors[0], /drawn from/);

  const badSort = parseSearchQuery({ ...emptyQuery(), sort: "vibes" });
  assert.equal(badSort.ok, false);
  if (!badSort.ok) assert.match(badSort.errors[0], /sort must be one of/);

  const badLimit = parseSearchQuery({ ...emptyQuery(), limit: "101" });
  assert.equal(badLimit.ok, false);
  if (!badLimit.ok) assert.match(badLimit.errors[0], /between 1 and 100/);

  const junkLimit = parseSearchQuery({ ...emptyQuery(), limit: "-3" });
  assert.equal(junkLimit.ok, false);

  const badYear = parseSearchQuery({ ...emptyQuery(), year: "20x0" });
  assert.equal(badYear.ok, false);
  const rangeYear = parseSearchQuery({ ...emptyQuery(), year: "3000" });
  assert.equal(rangeYear.ok, false);

  const longGenre = parseSearchQuery({ ...emptyQuery(), genre: "g".repeat(101) });
  assert.equal(longGenre.ok, false);
});

test("search query normalizes kinds, genre, and whitespace", () => {
  const parsed = parseSearchQuery({
    ...emptyQuery(),
    q: "  Star  ",
    kind: "series,movie,series",
    genre: " Sci-Fi ",
    year: "2021",
    sort: "rating",
    limit: "10"
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.q, "Star");
    assert.deepEqual(parsed.value.kinds, ["series", "movie"], "kinds keep client order, deduplicated");
    assert.equal(parsed.value.genre, "sci-fi", "genre folds to its name_key form");
    assert.equal(parsed.value.year, 2021);
    assert.equal(parsed.value.sort, "rating");
    assert.equal(parsed.value.limit, 10);
  }
});

test("cursor codec round-trips every sort, including NULLS LAST zones", () => {
  const cases = [
    { sort: "name" as const, sortValue: "star wars", externalId: "m-1" },
    { sort: "rating" as const, sortValue: 7.5, externalId: "m-2" },
    { sort: "rating" as const, sortValue: null, externalId: "m-3" },
    { sort: "recent" as const, sortValue: "2026-09-19T12:00:00.000Z", externalId: "m-4" },
    { sort: "recent" as const, sortValue: null, externalId: "m-5" },
    { sort: "year" as const, sortValue: 2021, externalId: "m-6" },
    { sort: "year" as const, sortValue: null, externalId: "m-7" }
  ];
  for (const cursor of cases) {
    const decoded = decodeCursor(encodeCursor(cursor));
    assert.equal(decoded.ok, true);
    if (decoded.ok) assert.deepEqual(decoded.value, cursor);
  }
});

test("cursor codec rejects forged and malformed cursors", () => {
  assert.equal(decodeCursor("not-a-cursor").ok, false);
  // Valid base64url of JSON, but wrong envelope version.
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ v: 2, k: "name", s: "a", e: "m-1" })).toString("base64url")).ok, false);
  // Null sort value on a sort that cannot have one.
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ v: 1, k: "name", s: null, e: "m-1" })).toString("base64url")).ok, false);
  // Wrong value type for the sort.
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ v: 1, k: "rating", s: "high", e: "m-1" })).toString("base64url")).ok, false);
  // Unparseable timestamp on the recent sort.
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ v: 1, k: "recent", s: "yesterday", e: "m-1" })).toString("base64url")).ok, false);
  // Empty or oversized external id.
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ v: 1, k: "name", s: "a", e: " " })).toString("base64url")).ok, false);
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ v: 1, k: "name", s: "a", e: "x".repeat(513) })).toString("base64url")).ok, false);
});

test("search query rejects a cursor that does not match the sort", () => {
  const cursor = encodeCursor({ sort: "name", sortValue: "a", externalId: "m-1" });
  const parsed = parseSearchQuery({ ...emptyQuery(), sort: "rating", cursor });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.errors[0], /cursor does not match the requested sort/);

  const matching = parseSearchQuery({ ...emptyQuery(), sort: "name", cursor });
  assert.equal(matching.ok, true);
});

test("LIKE patterns escape wildcards and the escape character", () => {
  assert.equal(likePattern("100%"), "%100\\%%");
  assert.equal(likePattern("under_score"), "%under\\_score%");
  assert.equal(likePattern("back\\slash"), "%back\\\\slash%");
  assert.equal(likePattern("plain"), "%plain%");
});

test("image URLs compose from the presentation base with encoded parts", () => {
  assert.equal(
    composeImageUrl("http://jf.lan:8096", "m-1", "abc123"),
    "http://jf.lan:8096/Items/m-1/Images/Primary?maxWidth=600&quality=90&tag=abc123"
  );
  assert.equal(
    composeImageUrl("http://jf.lan:8096", "m/1", "a&b"),
    "http://jf.lan:8096/Items/m%2F1/Images/Primary?maxWidth=600&quality=90&tag=a%26b"
  );
});

test("the image base prefers the public URL and stays null without one", () => {
  assert.equal(jellyfinImageBase({ NEXT_PUBLIC_JELLYFIN_URL: "http://pub/", JELLYFIN_URL: "http://srv" }), "http://pub");
  assert.equal(jellyfinImageBase({ JELLYFIN_URL: "http://srv/" }), "http://srv");
  assert.equal(jellyfinImageBase({}), null);
});

function view(overrides: Partial<CatalogItemView> = {}): CatalogItemView {
  return {
    source: "jellyfin",
    externalId: "m-1",
    kind: "movie",
    name: "Movie m-1",
    sortName: null,
    year: 2020,
    overview: "Overview",
    officialRating: "PG",
    communityRating: 7.5,
    runtimeSeconds: 5400,
    genres: ["Drama"],
    hasArt: true,
    imageUrl: "http://jf.lan/Items/m-1/Images/Primary?maxWidth=600&quality=90&tag=t",
    missing: false,
    libraryId: "lib-1",
    ...overrides
  };
}

test("MediaItem mapping keeps the household UI contract and adds catalog facts", () => {
  const item = catalogViewToMediaItem(view());
  assert.deepEqual(
    { ...item },
    {
      id: "m-1",
      title: "Movie m-1",
      year: 2020,
      overview: "Overview",
      kind: "Movie",
      rating: 7.5,
      imageUrl: "http://jf.lan/Items/m-1/Images/Primary?maxWidth=600&quality=90&tag=t",
      genres: ["Drama"],
      hasArt: true,
      missing: false
    }
  );

  const bare = catalogViewToMediaItem(
    view({ externalId: "s-9", kind: "series", name: "Show", communityRating: null, genres: [], hasArt: false, imageUrl: null, year: null, overview: null })
  );
  assert.equal(bare.kind, "Series");
  assert.equal(bare.rating, undefined);
  assert.equal(bare.year, undefined);
  assert.equal(bare.overview, undefined);
  assert.equal(bare.genres, undefined, "empty genre lists stay absent, matching the optional field");
  assert.equal(bare.imageUrl, undefined, "no fabricated URL when the item has no art");
  assert.equal(bare.hasArt, false);
});

test("rail query defaults and bounds", () => {
  const blank = parseRailQuery({ genre: null, limit: null });
  assert.equal(blank.ok, true);
  if (blank.ok) {
    assert.equal(blank.value.genre, null);
    assert.equal(blank.value.limit, 12);
  }

  const custom = parseRailQuery({ genre: " Drama ", limit: "5" });
  assert.equal(custom.ok, true);
  if (custom.ok) {
    assert.equal(custom.value.genre, "drama");
    assert.equal(custom.value.limit, 5);
  }

  const big = parseRailQuery({ genre: null, limit: "51" });
  assert.equal(big.ok, false);
  const junk = parseRailQuery({ genre: null, limit: "soon" });
  assert.equal(junk.ok, false);
  const longGenre = parseRailQuery({ genre: "g".repeat(101), limit: null });
  assert.equal(longGenre.ok, false);
});
