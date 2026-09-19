// Unit tests for the Jellyfin payload mapping and content fingerprint.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fingerprintItem, mapJellyfinItem, nameKey, type CatalogItemModel } from "./model.ts";

function movieModel(overrides: Partial<Parameters<typeof mapJellyfinItem>[0]> = {}): CatalogItemModel {
  const mapped = mapJellyfinItem({
    Id: "m1",
    Name: "The Reel House",
    Type: "Movie",
    ...overrides
  });
  assert.equal(mapped.outcome, "mapped");
  return (mapped as { outcome: "mapped"; model: CatalogItemModel }).model;
}

test("movies, series, seasons and episodes map to the four catalog kinds", () => {
  const season = mapJellyfinItem({ Id: "s1", Name: "Season 1", Type: "Season", SeriesId: "series1" });
  const episode = mapJellyfinItem({ Id: "e1", Name: "Pilot", Type: "Episode", SeriesId: "series1", SeasonId: "s1" });
  assert.equal(season.outcome, "mapped");
  assert.equal(episode.outcome, "mapped");
  if (season.outcome === "mapped" && episode.outcome === "mapped") {
    assert.deepEqual([season.model.kind, season.model.parentExternalId, season.model.parentKind], ["season", "series1", "series"]);
    assert.deepEqual([episode.model.kind, episode.model.parentExternalId, episode.model.parentKind], ["episode", "s1", "season"]);
  }
});

test("season-less episodes fall back to the series as parent", () => {
  const episode = mapJellyfinItem({ Id: "e2", Name: "Special", Type: "Episode", SeriesId: "series1" });
  assert.equal(episode.outcome, "mapped");
  if (episode.outcome === "mapped") {
    assert.deepEqual([episode.model.parentExternalId, episode.model.parentKind], ["series1", "series"]);
  }
});

test("series and movies never carry a parent", () => {
  assert.equal(movieModel().parentExternalId, null);
  const series = mapJellyfinItem({ Id: "se1", Name: "House of Reels", Type: "Series" });
  assert.equal(series.outcome, "mapped");
  if (series.outcome === "mapped") assert.equal(series.model.parentExternalId, null);
});

test("payloads without id or kind are skipped, nameless payloads are quarantinable", () => {
  assert.deepEqual(mapJellyfinItem({ Name: "Ghost", Type: "Movie" }), { outcome: "skip", reason: "item_without_id" });
  const mapped = mapJellyfinItem({ Id: "x1", Type: "PhotoAlbum" });
  assert.equal(mapped.outcome, "skip");
  if (mapped.outcome === "skip") assert.match(mapped.reason, /^unsupported_type:/);
  assert.equal(mapJellyfinItem({ Id: "x2", Type: "Movie" }).outcome, "invalid");
});

test("content fields and taxonomies survive the mapping", () => {
  const model = movieModel({
    Overview: "  A film.  ",
    ProductionYear: 2026,
    PremiereDate: "2026-01-02T03:04:05Z",
    CommunityRating: 8.75,
    OfficialRating: "PG-13",
    RuntimeTicks: 9_000_000_000,
    Path: "/media/reelhouse.mkv",
    Container: "mkv",
    Size: 1_000_000,
    DateCreated: "2026-08-01T00:00:00Z",
    ETag: "etag-7",
    ProviderIds: { Imdb: " tt1517268 ", TMDb: "123" },
    Genres: ["Sci-Fi", " Thriller "],
    Studios: [{ Name: " ReelHouse Studios " }],
    People: [
      { Name: "Ada Reel", Type: "Actor", Role: "The Operator" },
      { Name: "Ada Reel", Type: "Actor", Role: "Second Role" },
      { Name: "Bo Cut", Type: "Director" },
      { Name: "  ", Type: "Actor" }
    ],
    ImageTags: { Primary: "img-tag" }
  });
  assert.equal(model.overview, "A film.");
  assert.equal(model.premiereDate, "2026-01-02");
  assert.equal(model.runtimeSeconds, 900);
  assert.deepEqual(model.providerIds, [
    { provider: "imdb", value: "tt1517268" },
    { provider: "tmdb", value: "123" }
  ]);
  assert.deepEqual(model.genres, ["Sci-Fi", "Thriller"]);
  assert.deepEqual(model.studios, ["ReelHouse Studios"]);
  assert.deepEqual(
    model.people.map((p) => [p.name, p.roleType, p.roleName, p.listOrder]),
    [
      ["Ada Reel", "actor", "The Operator", 0],
      ["Ada Reel", "actor", "Second Role", 1],
      ["Bo Cut", "director", null, 2]
    ]
  );
  assert.equal(model.primaryImageTag, "img-tag");
  assert.equal(model.sourceRevision, "etag-7");
});

test("the fingerprint is order-insensitive within taxonomies and sensitive to content", () => {
  const base = movieModel({ Genres: ["A", "B"], ProviderIds: { imdb: "tt1", tmdb: "2" } });
  const reordered = movieModel({ Genres: ["B", "A"], ProviderIds: { tmdb: "2", imdb: "tt1" } });
  const changedTitle = movieModel({ Genres: ["A", "B"], Name: "Different" });
  assert.equal(base.contentHash, reordered.contentHash);
  assert.notEqual(base.contentHash, changedTitle.contentHash);
});

test("people billing order is content: swapping it changes the fingerprint", () => {
  const first = mapJellyfinItem({
    Id: "p1",
    Name: "Cast",
    Type: "Movie",
    People: [
      { Name: "Ada", Type: "Actor", Role: "Lead" },
      { Name: "Bo", Type: "Actor", Role: "Support" }
    ]
  });
  const second = mapJellyfinItem({
    Id: "p1",
    Name: "Cast",
    Type: "Movie",
    People: [
      { Name: "Bo", Type: "Actor", Role: "Support" },
      { Name: "Ada", Type: "Actor", Role: "Lead" }
    ]
  });
  assert.equal(first.outcome, "mapped");
  assert.equal(second.outcome, "mapped");
  if (first.outcome === "mapped" && second.outcome === "mapped") {
    assert.notEqual(first.model.contentHash, second.model.contentHash);
  }
});

test("fingerprintItem is a direct function of its content argument", () => {
  const content = {
    kind: "movie" as const,
    parentExternalId: null,
    parentKind: null,
    name: "N",
    sortName: null,
    originalTitle: null,
    productionYear: null,
    premiereDate: null,
    overview: null,
    officialRating: null,
    communityRating: null,
    runtimeSeconds: null,
    indexNumber: null,
    parentIndexNumber: null,
    path: null,
    container: null,
    sizeBytes: null,
    dateCreated: null,
    primaryImageTag: null,
    providerIds: [],
    genres: [],
    studios: [],
    people: []
  };
  assert.equal(fingerprintItem(content), fingerprintItem({ ...content }));
  assert.notEqual(fingerprintItem(content), fingerprintItem({ ...content, name: "M" }));
});

test("nameKey folds case and surrounding whitespace", () => {
  assert.equal(nameKey("  Sci-Fi "), "sci-fi");
});
