// Hermetic unit tests for the Jellyfin payload -> catalog model mapping and
// the content fingerprint.

import test from "node:test";
import assert from "node:assert/strict";
import {
  fingerprintLibrary,
  mapJellyfinItem,
  mapJellyfinLibrary,
  nameKey,
  type JellyfinItemRaw
} from "./model.ts";

function movie(overrides: Partial<JellyfinItemRaw> = {}): JellyfinItemRaw {
  return {
    Id: "m1",
    Name: "A Movie",
    Type: "Movie",
    ProductionYear: 2020,
    ...overrides
  };
}

test("library mapping keeps identity and presentation facts", () => {
  const mapped = mapJellyfinLibrary({
    Id: "lib1",
    Name: "Movies",
    CollectionType: "movies",
    ImageTags: { Primary: "tag1" }
  });
  assert.equal(mapped.outcome, "ok");
  if (mapped.outcome !== "ok") return;
  assert.equal(mapped.model.source, "jellyfin");
  assert.equal(mapped.model.externalId, "lib1");
  assert.equal(mapped.model.name, "Movies");
  assert.equal(mapped.model.collectionType, "movies");
  assert.equal(mapped.model.primaryImageTag, "tag1");
});

test("library mapping skips id-less folders and quarantines name-less ones", () => {
  assert.equal(mapJellyfinLibrary({ Name: "x" }).outcome, "skip");
  const invalid = mapJellyfinLibrary({ Id: "lib2" });
  assert.equal(invalid.outcome, "invalid");
  if (invalid.outcome === "invalid") {
    assert.equal(invalid.externalId, "lib2");
    assert.equal(invalid.reason, "library_without_name");
  }
});

test("item mapping covers every stored content field", () => {
  const mapped = mapJellyfinItem({
    Id: "e1",
    Name: "Pilot",
    Type: "Episode",
    SeriesId: "s1",
    SeasonId: "se1",
    SortName: "pilot",
    OriginalTitle: "Pilot (original)",
    ProductionYear: 1999,
    PremiereDate: "1999-03-01T00:00:00Z",
    Overview: "  The beginning.  ",
    OfficialRating: "TV-14",
    CommunityRating: 8.7,
    RuntimeTicks: 42_000_000 * 10_000,
    IndexNumber: 1,
    ParentIndexNumber: 2,
    Path: "/media/show/pilot.mkv",
    Container: "mkv",
    Size: "123456789",
    DateCreated: "2024-01-02T03:04:05Z",
    ETag: "rev-1",
    ImageTags: { Primary: "img" },
    ProviderIds: { Imdb: " tt0000001 ", tmdb: "999" },
    Genres: [" Drama ", ""],
    Studios: [{ Name: " Studio X " }, { Name: "  " }],
    People: [
      { Name: " Ada A. ", Type: "Actor", Role: "Lead", ProviderIds: { tmdb: "11" } },
      { Name: "  ", Type: "Actor" },
      { Name: "Dir D.", Type: "Director" }
    ]
  });
  assert.equal(mapped.outcome, "mapped");
  if (mapped.outcome !== "mapped") return;
  const m = mapped.model;
  assert.equal(m.kind, "episode");
  assert.equal(m.parentExternalId, "se1");
  assert.equal(m.parentKind, "season");
  assert.equal(m.overview, "The beginning.");
  assert.equal(m.runtimeSeconds, 42_000);
  assert.equal(m.sizeBytes, 123456789);
  assert.equal(m.premiereDate, "1999-03-01");
  assert.deepEqual(m.providerIds, [
    { provider: "imdb", value: "tt0000001" },
    { provider: "tmdb", value: "999" }
  ]);
  assert.deepEqual(m.genres, ["Drama"]);
  assert.deepEqual(m.studios, ["Studio X"]);
  assert.equal(m.people.length, 2);
  assert.equal(m.people[0].roleType, "actor");
  assert.equal(m.people[0].roleName, "Lead");
  assert.deepEqual(m.people[0].providerIds, { tmdb: "11" });
  assert.equal(m.people[1].roleType, "director");
  assert.equal(m.sourceRevision, "rev-1");
});

test("episode without a season hangs off the series; child without any parent is still mapped", () => {
  const viaSeries = mapJellyfinItem({ Id: "e2", Name: "x", Type: "Episode", SeriesId: "s1" });
  assert.equal(viaSeries.outcome, "mapped");
  if (viaSeries.outcome === "mapped") {
    assert.equal(viaSeries.model.parentExternalId, "s1");
    assert.equal(viaSeries.model.parentKind, "series");
  }

  const orphan = mapJellyfinItem({ Id: "e3", Name: "y", Type: "Episode" });
  assert.equal(orphan.outcome, "mapped");
  if (orphan.outcome === "mapped") {
    assert.equal(orphan.model.parentExternalId, null);
    assert.equal(orphan.model.parentKind, null);
  }
});

test("untyped or id-less items skip; name-less items are invalid", () => {
  assert.equal(mapJellyfinItem({ Name: "x", Type: "Photo" }).outcome, "skip");
  assert.equal(mapJellyfinItem({ Name: "x", Type: "Movie" }).outcome, "skip");
  assert.equal(mapJellyfinItem({ Type: "Movie" }).outcome, "skip");
  const invalid = mapJellyfinItem({ Id: "m2", Type: "Movie" });
  assert.equal(invalid.outcome, "invalid");
  if (invalid.outcome === "invalid") assert.equal(invalid.reason, "item_without_name");
});

test("unchanged payloads produce identical fingerprints regardless of ordering", () => {
  const base = mapJellyfinItem(
    movie({
      ProviderIds: { tmdb: "1", imdb: "2" },
      Genres: ["Action", "Drama"],
      Studios: [{ Name: "A" }, { Name: "B" }]
    })
  );
  const reordered = mapJellyfinItem(
    movie({
      ProviderIds: { imdb: "2", tmdb: "1" },
      Genres: ["Drama", "Action"],
      Studios: [{ Name: "B" }, { Name: "A" }]
    })
  );
  assert.equal(base.outcome, "mapped");
  assert.equal(reordered.outcome, "mapped");
  if (base.outcome === "mapped" && reordered.outcome === "mapped") {
    assert.equal(base.model.contentHash, reordered.model.contentHash);
  }
});

test("content changes move the fingerprint; an ETag-only change does not", () => {
  const base = mapJellyfinItem(movie());
  const renamed = mapJellyfinItem(movie({ Name: "Renamed" }));
  const reTagged = mapJellyfinItem(movie({ ETag: "rev-2" }));
  assert.ok(base.outcome === "mapped" && renamed.outcome === "mapped" && reTagged.outcome === "mapped");
  if (base.outcome === "mapped" && renamed.outcome === "mapped" && reTagged.outcome === "mapped") {
    assert.notEqual(base.model.contentHash, renamed.model.contentHash);
    assert.equal(base.model.contentHash, reTagged.model.contentHash);
    assert.notEqual(base.model.sourceRevision, reTagged.model.sourceRevision);
  }
});

test("billing order is content: reordered people change the fingerprint", () => {
  const first = mapJellyfinItem(movie({ People: [{ Name: "A", Type: "Actor" }, { Name: "B", Type: "Actor" }] }));
  const second = mapJellyfinItem(movie({ People: [{ Name: "B", Type: "Actor" }, { Name: "A", Type: "Actor" }] }));
  assert.ok(first.outcome === "mapped" && second.outcome === "mapped");
  if (first.outcome === "mapped" && second.outcome === "mapped") {
    assert.notEqual(first.model.contentHash, second.model.contentHash);
  }
});

test("library fingerprint covers name, type, and image tag", () => {
  const a = fingerprintLibrary({ name: "Movies", collectionType: "movies", primaryImageTag: "t" });
  assert.equal(a, fingerprintLibrary({ name: "Movies", collectionType: "movies", primaryImageTag: "t" }));
  assert.notEqual(a, fingerprintLibrary({ name: "Movies", collectionType: "movies", primaryImageTag: "t2" }));
  assert.notEqual(a, fingerprintLibrary({ name: "Movies", collectionType: "tvshows", primaryImageTag: "t" }));
});

test("nameKey folds case and surrounding whitespace", () => {
  assert.equal(nameKey("  Sci-Fi "), "sci-fi");
  assert.equal(nameKey("SCI-FI"), nameKey("sci-fi"));
});
