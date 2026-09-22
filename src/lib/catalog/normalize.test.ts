// Hermetic unit evidence for catalog normalization (RH-0031).
//
// Covers the Jellyfin → normalized-row contract: type mapping, identity
// fail-closed, facet extraction, media-source/file state, and the
// garbage-in-becomes-NULL rules that keep one bad payload from poisoning a
// sync batch.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CatalogIdentityError,
  normalizeItem,
  normalizeLibrary
} from "./normalize.ts";

const LIBRARY_ID = "lib-1";

function baseItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { Id: "item-1", Name: "Sample", Type: "Movie", ...overrides };
}

test("movie payload normalizes every supported field", () => {
  const item = normalizeItem(
    baseItem({
      OriginalTitle: "Sample (Original)",
      SortName: "sample",
      Overview: "A story.",
      ProductionYear: 2019,
      PremiereDate: "2019-06-01T00:00:00Z",
      CommunityRating: 8.2,
      OfficialRating: "PG",
      RunTimeTicks: 7_200_000_000,
      Container: "mp4",
      Path: "/media/sample.mp4",
      Size: 1_500_000_000,
      ImageTags: { Primary: "img-primary" },
      BackdropImageTags: ["img-backdrop", "second"],
      Etag: "e1",
      DateCreated: "2024-01-15T10:00:00.0000000Z",
      ParentId: "folder-1",
      Genres: ["Drama"],
      Studios: ["Studio A"],
      People: [{ Name: "Jane Director", Type: "Director" }, { Name: "John Actor", Type: "Actor", Role: "Lead", Id: "p-2" }],
      ProviderIds: { Imdb: "tt0000001", Tmdb: "123" },
      MediaSources: [
        {
          Container: "mp4",
          Path: "/media/sample.mp4",
          Size: 1_500_000_000,
          MediaStreams: [
            { Type: "Video", Codec: "h264", DisplayTitle: "1080p", IsDefault: true },
            { Type: "Audio", Codec: "aac", Language: "eng" }
          ]
        }
      ]
    }),
    LIBRARY_ID
  );

  assert.ok(item);
  assert.equal(item.itemType, "movie");
  assert.equal(item.jellyfinId, "item-1");
  assert.equal(item.libraryJellyfinId, LIBRARY_ID);
  assert.equal(item.originalTitle, "Sample (Original)");
  assert.equal(item.premiereDate, "2019-06-01T00:00:00.000Z");
  assert.equal(item.communityRating, 8.2);
  assert.equal(item.runtimeTicks, 7_200_000_000);
  assert.equal(item.fileSizeBytes, 1_500_000_000);
  assert.equal(item.primaryImageTag, "img-primary");
  assert.equal(item.backdropImageTag, "img-backdrop");
  assert.equal(item.dateCreated, "2024-01-15T10:00:00.000Z");
  assert.deepEqual(item.genres, ["Drama"]);
  assert.deepEqual(item.studios, ["Studio A"]);
  assert.equal(item.mediaStreams.length, 2);
  assert.deepEqual(item.mediaStreams[0], {
    streamType: "Video",
    codec: "h264",
    language: null,
    displayTitle: "1080p",
    isDefault: true
  });
  assert.deepEqual(
    item.people,
    [
      { name: "Jane Director", jellyfinId: null, personType: "Director", roleName: null },
      { name: "John Actor", jellyfinId: "p-2", personType: "Actor", roleName: "Lead" }
    ]
  );
  assert.deepEqual(item.providerIds, [
    { name: "Imdb", value: "tt0000001" },
    { name: "Tmdb", value: "123" }
  ]);
});

test("series, season, and episode payloads map their hierarchy fields", () => {
  const series = normalizeItem(baseItem({ Id: "s1", Name: "Show", Type: "Series" }), LIBRARY_ID);
  assert.equal(series?.itemType, "series");
  assert.equal(series?.seasonNumber, null);

  // A season carries its own number in IndexNumber.
  const season = normalizeItem(
    baseItem({ Id: "sn1", Name: "Season 1", Type: "Season", IndexNumber: 1, SeriesId: "s1", SeriesName: "Show" }),
    LIBRARY_ID
  );
  assert.equal(season?.itemType, "season");
  assert.equal(season?.seasonNumber, 1);
  assert.equal(season?.episodeNumber, null);
  assert.equal(season?.seriesJellyfinId, "s1");

  // An episode carries its number in IndexNumber and the season number in
  // ParentIndexNumber.
  const episode = normalizeItem(
    baseItem({
      Id: "e1",
      Name: "Pilot",
      Type: "Episode",
      IndexNumber: 3,
      ParentIndexNumber: 2,
      SeasonId: "sn1",
      SeriesId: "s1",
      SeriesName: "Show"
    }),
    LIBRARY_ID
  );
  assert.equal(episode?.itemType, "episode");
  assert.equal(episode?.seasonNumber, 2);
  assert.equal(episode?.episodeNumber, 3);
  assert.equal(episode?.seasonJellyfinId, "sn1");
});

test("Video-type home content normalizes as a movie", () => {
  const item = normalizeItem(baseItem({ Type: "Video" }), LIBRARY_ID);
  assert.equal(item?.itemType, "movie");
});

test("unsupported item types are reported as out of scope, not errors", () => {
  assert.equal(normalizeItem(baseItem({ Type: "PhotoAlbum" }), LIBRARY_ID), null);
  assert.equal(normalizeItem(baseItem({ Type: "Folder" }), LIBRARY_ID), null);
  assert.equal(normalizeItem(baseItem({ Type: "" }), LIBRARY_ID), null);
  assert.equal(normalizeItem(baseItem({ Type: undefined }), LIBRARY_ID), null);
});

test("identity fails closed: missing Id or Name aborts normalization", () => {
  assert.throws(() => normalizeItem(baseItem({ Id: "" }), LIBRARY_ID), CatalogIdentityError);
  assert.throws(() => normalizeItem(baseItem({ Id: 42 }), LIBRARY_ID), CatalogIdentityError);
  assert.throws(() => normalizeItem(baseItem({ Name: "  " }), LIBRARY_ID), CatalogIdentityError);
});

test("facets are deduplicated, trimmed, and drop unusable entries", () => {
  const item = normalizeItem(
    baseItem({
      Genres: ["Drama", " Drama ", "", 7, "Comedy", "Drama"],
      Studios: ["Studio A", "Studio A"],
      People: [
        { Name: "Jane" }, // no Type → Actor default
        { Name: "Jane", Type: "Actor", Role: "duplicate" }, // deduped
        { Type: "Actor" }, // no Name → dropped
        { Name: "Ray", Type: "Composer", Role: "" }
      ],
      ProviderIds: { Imdb: "tt1", Empty: "", NotAString: 5 }
    }),
    LIBRARY_ID
  );

  assert.ok(item);
  assert.deepEqual(item.genres, ["Drama", "Comedy"]);
  assert.deepEqual(item.studios, ["Studio A"]);
  assert.deepEqual(
    item.people,
    [
      { name: "Jane", jellyfinId: null, personType: "Actor", roleName: null },
      { name: "Ray", jellyfinId: null, personType: "Composer", roleName: null }
    ]
  );
  assert.deepEqual(item.providerIds, [{ name: "Imdb", value: "tt1" }]);
});

test("invalid optional values become NULL instead of being coerced", () => {
  const item = normalizeItem(
    baseItem({
      ProductionYear: 2019.5, // not an integer
      PremiereDate: "not-a-date",
      CommunityRating: "8.2", // string where a number belongs
      RunTimeTicks: -5, // negative ticks are nonsense
      OfficialRating: 7,
      ImageTags: "not-an-object",
      BackdropImageTags: "not-an-array",
      DateCreated: "2024-13-45T99:00:00Z",
      Genres: "Drama", // string where an array belongs
      Studios: null,
      People: "nonsense",
      ProviderIds: [1, 2],
      MediaSources: "nonsense"
    }),
    LIBRARY_ID
  );

  assert.ok(item);
  assert.equal(item.productionYear, null);
  assert.equal(item.premiereDate, null);
  assert.equal(item.communityRating, null);
  assert.equal(item.runtimeTicks, null);
  assert.equal(item.officialRating, null);
  assert.equal(item.primaryImageTag, null);
  assert.equal(item.backdropImageTag, null);
  assert.equal(item.dateCreated, null);
  assert.deepEqual(item.genres, []);
  assert.deepEqual(item.studios, []);
  assert.deepEqual(item.people, []);
  assert.deepEqual(item.providerIds, []);
  assert.deepEqual(item.mediaStreams, []);
});

test("media state falls back across MediaSources and caps pathological stream lists", () => {
  const streams = Array.from({ length: 40 }, (_, i) => ({ Type: "Audio", Codec: `c${i}` }));
  const item = normalizeItem(
    baseItem({
      Container: undefined,
      Path: undefined,
      MediaSources: [{ Container: "mkv", Path: "/movies/x.mkv", Size: 42, MediaStreams: streams }]
    }),
    LIBRARY_ID
  );

  assert.ok(item);
  assert.equal(item.container, "mkv");
  assert.equal(item.filePath, "/movies/x.mkv");
  assert.equal(item.fileSizeBytes, 42);
  assert.equal(item.mediaStreams.length, 32);
});

test("an empty payload is out of scope, not an identity error", () => {
  assert.equal(normalizeItem({}, LIBRARY_ID), null);
});

test("libraries normalize with identity fail-closed and optional collection type", () => {
  const library = normalizeLibrary({ Id: "lib-1", Name: "Movies", CollectionType: "movies" });
  assert.deepEqual(library, {
    source: "jellyfin",
    jellyfinId: "lib-1",
    name: "Movies",
    collectionType: "movies"
  });

  const mixed = normalizeLibrary({ Id: "lib-2", Name: "Mixed" });
  assert.equal(mixed.collectionType, null);
  assert.equal(mixed.source, "jellyfin");

  assert.throws(() => normalizeLibrary({ Name: "No Id" }), CatalogIdentityError);
  assert.throws(() => normalizeLibrary({ Id: "lib-3" }), CatalogIdentityError);
});
