// Hermetic unit evidence for the RH-0032 change-detection core: content
// diffing against PostgreSQL wire representations, transition planning,
// duplicate policy, watermark windowing, and quarantine payload bounds.

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyDuplicateOccurrence,
  deltaWindowStart,
  nextWatermark,
  planItemChange,
  quarantinePayloadOf,
  stableStringify,
  sourceRevisionOf,
  type ExistingItemRow
} from "./changes.ts";
import { normalizeItem, type NormalizedItem } from "./normalize.ts";

function item(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    source: "jellyfin",
    jellyfinId: "mov-1",
    libraryJellyfinId: "lib-1",
    itemType: "movie",
    name: "Arrival",
    originalTitle: null,
    sortName: null,
    overview: null,
    productionYear: 2016,
    premiereDate: "2016-11-10T00:00:00.000Z",
    communityRating: 7.9,
    officialRating: "PG-13",
    runtimeTicks: 1_830_000_000,
    container: "mkv",
    filePath: "/media/movies/arrival.mkv",
    fileSizeBytes: 3_000_000_000,
    mediaStreams: [{ streamType: "Video", codec: "hevc", language: null, displayTitle: "1080p", isDefault: true }],
    primaryImageTag: null,
    backdropImageTag: null,
    etag: "etag-1",
    dateCreated: null,
    dateLastSaved: "2025-06-01T12:00:00.000Z",
    parentJellyfinId: null,
    seriesJellyfinId: null,
    seriesName: null,
    seasonJellyfinId: null,
    seasonNumber: null,
    episodeNumber: null,
    genres: [],
    studios: [],
    people: [],
    providerIds: [],
    ...overrides
  };
}

// A stored row as pg hands it back: numeric/bigint as strings, timestamps as
// Date, jsonb parsed with jsonb's own key normalization.
function storedRow(overrides: Partial<ExistingItemRow> = {}): ExistingItemRow {
  return {
    id: 11,
    library_id: 1,
    removed_at: null,
    name: "Arrival",
    original_title: null,
    sort_name: null,
    overview: null,
    production_year: 2016,
    premiere_date: new Date("2016-11-10T00:00:00.000Z"),
    community_rating: "7.9",
    official_rating: "PG-13",
    runtime_ticks: "1830000000",
    container: "mkv",
    file_path: "/media/movies/arrival.mkv",
    file_size_bytes: "3000000000",
    media_streams: [{ isDefault: true, codec: "hevc", displayTitle: "1080p", language: null, streamType: "Video" }],
    primary_image_tag: null,
    backdrop_image_tag: null,
    etag: "etag-1",
    date_created: null,
    parent_jellyfin_id: null,
    series_jellyfin_id: null,
    series_name: null,
    season_jellyfin_id: null,
    season_number: null,
    episode_number: null,
    ...overrides
  };
}

test("an unseen item is an addition, a tombstoned one a restore", () => {
  assert.deepEqual(planItemChange(null, item(), 1), { kind: "added", changedFields: [] });
  const tombstoned = storedRow({ removed_at: new Date("2025-01-01T00:00:00.000Z") });
  assert.deepEqual(planItemChange(tombstoned, item(), 1), { kind: "restored", changedFields: [] });
});

test("identical content is unchanged even across PostgreSQL wire representations", () => {
  // jsonb keys come back reordered; numeric/bigint come back as strings;
  // timestamps come back as Date objects — none of that is a change.
  assert.deepEqual(planItemChange(storedRow(), item(), 1), { kind: "unchanged", changedFields: [] });
});

test("column rounding and clock-level timestamp equality are not updates", () => {
  // numeric(3,1) stores 7.99 as 8.0; a re-read payload of 7.99 is the same
  // stored value, not a change.
  const rounded = storedRow({ community_rating: "8.0" });
  assert.equal(planItemChange(rounded, item({ communityRating: 7.99 }), 1).kind, "unchanged");
  // An actually different rating still is one.
  assert.equal(planItemChange(rounded, item({ communityRating: 8.1 }), 1).kind, "updated");
  // Same instant in a non-canonical offset form.
  const offset = storedRow({ premiere_date: new Date("2016-11-10T01:00:00.000+01:00") });
  assert.equal(planItemChange(offset, item(), 1).kind, "unchanged");
});

test("content changes list fields in the fixed projection order", () => {
  const changed = storedRow({
    name: "Arrival (Remastered)",
    official_rating: null,
    file_size_bytes: "2999999999",
    community_rating: "8.0"
  });
  const plan = planItemChange(changed, item({ communityRating: 8.1 }), 1);
  assert.equal(plan.kind, "updated");
  assert.deepEqual(plan.changedFields, ["name", "communityRating", "officialRating", "fileSizeBytes"]);
});

test("a library move is an update naming library first", () => {
  const plan = planItemChange(storedRow({ name: "Moved" }), item(), 7);
  assert.deepEqual(plan.changedFields, ["library", "name"]);
});

test("a total rewrite lists every projection field in the fixed order", () => {
  const everything = storedRow({
    name: "x", original_title: "x", sort_name: "x", overview: "x",
    production_year: 1, premiere_date: new Date("2000-01-01T00:00:00.000Z"),
    community_rating: "1.0", official_rating: "x", runtime_ticks: "1",
    container: "x", file_path: "x", file_size_bytes: "1",
    media_streams: [], primary_image_tag: "x", backdrop_image_tag: "x",
    etag: "x", date_created: new Date("2000-01-01T00:00:00.000Z"),
    parent_jellyfin_id: "x", series_jellyfin_id: "x", series_name: "x",
    season_jellyfin_id: "x", season_number: 1, episode_number: 1
  });
  const plan = planItemChange(everything, item(), 9);
  assert.equal(plan.kind, "updated");
  assert.deepEqual(plan.changedFields, [
    "library",
    "name",
    "originalTitle",
    "sortName",
    "overview",
    "productionYear",
    "premiereDate",
    "communityRating",
    "officialRating",
    "runtimeTicks",
    "container",
    "filePath",
    "fileSizeBytes",
    "mediaStreams",
    "primaryImageTag",
    "backdropImageTag",
    "etag",
    "dateCreated",
    "parentJellyfinId",
    "seriesJellyfinId",
    "seriesName",
    "seasonJellyfinId",
    "seasonNumber",
    "episodeNumber"
  ]);
});

test("stableStringify is invariant under jsonb key reordering but not list order", () => {
  assert.equal(stableStringify([{ b: 1, a: [1, { z: null, y: 2 }] }]), stableStringify([{ a: [1, { y: 2, z: null }], b: 1 }]));
  assert.notEqual(stableStringify([{ a: 1 }, { b: 2 }]), stableStringify([{ b: 2 }, { a: 1 }]));
});

test("the source revision prefers the Etag and falls back to DateLastSaved", () => {
  assert.equal(sourceRevisionOf(item()), "etag-1");
  assert.equal(sourceRevisionOf(item({ etag: null })), "2025-06-01T12:00:00.000Z");
  assert.equal(sourceRevisionOf(item({ etag: null, dateLastSaved: null })), null);
});

test("duplicate policy: identical repetition is benign, any difference conflicts", () => {
  const first = { libraryJellyfinId: "lib-1", name: "Twin", itemType: "movie", etag: "e1" };
  assert.equal(classifyDuplicateOccurrence(first, { ...first }), "benign");
  assert.equal(classifyDuplicateOccurrence(first, { ...first, libraryJellyfinId: "lib-2" }), "conflict");
  assert.equal(classifyDuplicateOccurrence(first, { ...first, name: "Twin II" }), "conflict");
  assert.equal(classifyDuplicateOccurrence(first, { ...first, etag: "e2" }), "conflict");
  assert.equal(classifyDuplicateOccurrence(first, { ...first, itemType: "series" }), "conflict");
});

test("the quarantine payload is a bounded evidence projection", () => {
  const payload = quarantinePayloadOf(item({ overview: "A".repeat(50_000) }), "lib-2");
  assert.deepEqual(payload, {
    jellyfinId: "mov-1",
    itemType: "movie",
    name: "Arrival",
    libraryJellyfinId: "lib-2",
    etag: "etag-1",
    dateLastSaved: "2025-06-01T12:00:00.000Z",
    filePath: "/media/movies/arrival.mkv",
    providerIds: []
  });
  assert.ok(JSON.stringify(payload)!.length < 1000, "payload never carries free-text bulk");
});

test("the delta window overlaps the watermark by one second and never rewinds", () => {
  const watermark = new Date("2025-06-01T12:00:00.000Z");
  assert.equal(deltaWindowStart(watermark), "2025-06-01T11:59:59.000Z");

  // Advances to the newest observed save.
  assert.equal(
    nextWatermark(watermark, [new Date("2025-05-01T00:00:00.000Z"), new Date("2025-07-01T00:00:00.000Z")]).getTime(),
    Date.parse("2025-07-01T00:00:00.000Z")
  );
  // Items without DateLastSaved never pull it back; nothing observed keeps it.
  assert.equal(nextWatermark(watermark, [null, null]).getTime(), watermark.getTime());
  // An older source clock (skewed server) can never rewind coverage.
  assert.equal(
    nextWatermark(watermark, [new Date("2020-01-01T00:00:00.000Z")]).getTime(),
    watermark.getTime()
  );
});

test("normalization carries the source save time and rejects nonsense", () => {
  const normalized = normalizeItem({ Id: "m1", Name: "X", Type: "Movie", DateLastSaved: "2025-06-01T12:00:00Z" }, "lib-1");
  assert.equal(normalized?.dateLastSaved, "2025-06-01T12:00:00.000Z");
  const invalid = normalizeItem({ Id: "m1", Name: "X", Type: "Movie", DateLastSaved: "not-a-date" }, "lib-1");
  assert.equal(invalid?.dateLastSaved, null, "an unparseable save time is NULL, never coerced");
  const absent = normalizeItem({ Id: "m1", Name: "X", Type: "Movie" }, "lib-1");
  assert.equal(absent?.dateLastSaved, null);
});
