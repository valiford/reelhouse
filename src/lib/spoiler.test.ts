import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SPOILER_SHIELD_PREFERENCE,
  SPOILER_SHIELD_STORAGE_KEY,
  isSpoilerShielded,
  migrateProfileSpoilerShieldPreference,
  normalizeSpoilerShieldPreference,
  parseProfileSpoilerShieldPreferences,
  readProfileSpoilerShieldPreference,
  writeProfileSpoilerShieldPreference,
  type SpoilerShieldStore
} from "./spoiler.ts";
import { mapItem } from "./jellyfin.ts";
import { demoLibrary } from "./demo.ts";

const SHIELD = DEFAULT_SPOILER_SHIELD_PREFERENCE;

test("shield default protects unwatched and unknown watch states", () => {
  assert.equal(SHIELD, "shield");
  assert.equal(isSpoilerShielded({ watched: undefined }, SHIELD, false), true);
  assert.equal(isSpoilerShielded({ watched: false }, SHIELD, false), true);
});

test("played content is never shielded while the shield is on", () => {
  assert.equal(isSpoilerShielded({ watched: true }, SHIELD, false), false);
});

test("reveal is deliberate, per item, and reversible", () => {
  const item = { watched: false };
  assert.equal(isSpoilerShielded(item, SHIELD, true), false);
  assert.equal(isSpoilerShielded(item, SHIELD, false), true, "re-masking after reveal must return the item to protection");
});

test("turning the preference off shows everything, including unknown states", () => {
  assert.equal(isSpoilerShielded({ watched: false }, "show", false), false);
  assert.equal(isSpoilerShielded({ watched: undefined }, "show", false), false);
});

test("playback progress alone never marks an item watched", () => {
  const mapped = mapItem({
    Id: "jf-progress",
    Name: "Half Watched",
    Type: "Movie",
    UserData: { PlaybackPositionTicks: 3_600_000_000, PlayedPercentage: 42 }
  });
  assert.equal(mapped.progress, 42);
  assert.equal(mapped.watched, undefined);
  assert.equal(isSpoilerShielded(mapped, SHIELD, false), true);
});

test("Jellyfin UserData.Played maps onto the watch-state contract", () => {
  assert.equal(mapItem({ Id: "a", Name: "Played", Type: "Movie", UserData: { Played: true } }).watched, true);
  assert.equal(mapItem({ Id: "b", Name: "Unplayed", Type: "Movie", UserData: { Played: false } }).watched, false);
  assert.equal(mapItem({ Id: "c", Name: "No UserData", Type: "Movie" }).watched, undefined);
  assert.equal(
    isSpoilerShielded(mapItem({ Id: "d", Name: "Unknown Episode", Type: "Episode" }), SHIELD, false),
    true,
    "unknown watch state stays protected"
  );
});

test("preference normalization fails closed to shield", () => {
  assert.equal(normalizeSpoilerShieldPreference("shield"), "shield");
  assert.equal(normalizeSpoilerShieldPreference("show"), "show");
  assert.equal(normalizeSpoilerShieldPreference("bogus"), "shield");
  assert.equal(normalizeSpoilerShieldPreference(undefined), "shield");
  assert.equal(normalizeSpoilerShieldPreference(null), "shield");
});

test("stored preference payloads are sanitized", () => {
  assert.deepEqual(parseProfileSpoilerShieldPreferences(null), {});
  assert.deepEqual(parseProfileSpoilerShieldPreferences(undefined), {});
  assert.deepEqual(parseProfileSpoilerShieldPreferences(""), {});
  assert.deepEqual(parseProfileSpoilerShieldPreferences("not json"), {});
  assert.deepEqual(parseProfileSpoilerShieldPreferences("[1,2]"), {});
  assert.deepEqual(
    parseProfileSpoilerShieldPreferences('{"weird":true}'),
    { weird: "shield" },
    "invalid stored values normalize to shield rather than leaking through"
  );
  assert.deepEqual(
    parseProfileSpoilerShieldPreferences(JSON.stringify({ "V’Ali": "show", Nicole: "bogus", "": "show" })),
    { "V’Ali": "show", Nicole: "shield" }
  );
});

function memoryStore(entries?: Array<[string, string]>): SpoilerShieldStore {
  const map = new Map<string, string>(entries);
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value)
  };
}

test("preferences persist per profile and stay isolated between profiles", () => {
  const store = memoryStore();
  const key = SPOILER_SHIELD_STORAGE_KEY;
  assert.equal(readProfileSpoilerShieldPreference(store, "V’Ali"), "shield", "unread profiles default to shield");
  writeProfileSpoilerShieldPreference(store, "V’Ali", "show");
  writeProfileSpoilerShieldPreference(store, "Nicole", "shield");
  assert.equal(store.getItem(key), JSON.stringify({ "V’Ali": "show", Nicole: "shield" }));
  assert.equal(readProfileSpoilerShieldPreference(store, "V’Ali"), "show");
  assert.equal(readProfileSpoilerShieldPreference(store, "Nicole"), "shield");
  assert.equal(readProfileSpoilerShieldPreference(store, "Guest"), "shield", "unknown profiles default to shield");
});

test("missing or broken storage keeps the conservative default", () => {
  assert.equal(readProfileSpoilerShieldPreference(null, "V’Ali"), "shield");
  assert.equal(readProfileSpoilerShieldPreference(undefined, "V’Ali"), "shield");
  assert.equal(readProfileSpoilerShieldPreference(memoryStore(), ""), "shield");
  const throwingStore: SpoilerShieldStore = {
    getItem: () => {
      throw new Error("storage blocked");
    },
    setItem: () => undefined
  };
  assert.equal(readProfileSpoilerShieldPreference(throwingStore, "V’Ali"), "shield");
  const readonlyStore: SpoilerShieldStore = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota exceeded");
    }
  };
  assert.doesNotThrow(() => writeProfileSpoilerShieldPreference(readonlyStore, "Nicole", "show"));
});

test("display-name-keyed preferences migrate onto the contractual slug (RH-0043)", () => {
  const key = SPOILER_SHIELD_STORAGE_KEY;
  const store = memoryStore([[key, JSON.stringify({ "V’Ali": "show" })]]);
  const migrated = migrateProfileSpoilerShieldPreference(store, "v_ali", "V’Ali");
  assert.equal(migrated, true);
  const stored = JSON.parse(store.getItem(key) ?? "{}");
  assert.deepEqual(
    stored,
    { v_ali: "show" },
    "the preference now lives under the slug and the display-name key is gone"
  );
  assert.equal(readProfileSpoilerShieldPreference(store, "v_ali"), "show");
  assert.equal(readProfileSpoilerShieldPreference(store, "V’Ali"), "shield", "the display name is no longer a cache key");
});

test("migration never overwrites a slug entry that already exists", () => {
  const key = SPOILER_SHIELD_STORAGE_KEY;
  const store = memoryStore([[key, JSON.stringify({ "V’Ali": "show", v_ali: "shield" })]]);
  const migrated = migrateProfileSpoilerShieldPreference(store, "v_ali", "V’Ali");
  assert.equal(migrated, false, "the slug already owns its preference — only the legacy key is cleaned up");
  assert.deepEqual(JSON.parse(store.getItem(key) ?? "{}"), { v_ali: "shield" });
  assert.equal(readProfileSpoilerShieldPreference(store, "v_ali"), "shield");
});

test("migration is a no-op without a legacy display-name entry", () => {
  const key = SPOILER_SHIELD_STORAGE_KEY;
  const store = memoryStore([[key, JSON.stringify({ nicole: "show" })]]);
  assert.equal(migrateProfileSpoilerShieldPreference(store, "v_ali", "V’Ali"), false);
  assert.deepEqual(JSON.parse(store.getItem(key) ?? "{}"), { nicole: "show" }, "nothing to adopt, nothing rewritten");
  assert.equal(migrateProfileSpoilerShieldPreference(memoryStore(), "v_ali", "V’Ali"), false);
});

test("degenerate migrations do not touch the store", () => {
  const key = SPOILER_SHIELD_STORAGE_KEY;
  const store = memoryStore([[key, JSON.stringify({ demo: "show" })]]);
  assert.equal(migrateProfileSpoilerShieldPreference(null, "v_ali", "V’Ali"), false);
  assert.equal(migrateProfileSpoilerShieldPreference(undefined, "v_ali", "V’Ali"), false);
  assert.equal(migrateProfileSpoilerShieldPreference(store, "", "V’Ali"), false);
  assert.equal(migrateProfileSpoilerShieldPreference(store, "v_ali", ""), false);
  assert.equal(
    migrateProfileSpoilerShieldPreference(store, "demo", "demo"),
    false,
    "identical slug and display name need no migration"
  );
  assert.deepEqual(JSON.parse(store.getItem(key) ?? "{}"), { demo: "show" });
});

test("migration survives broken storage with the conservative default intact", () => {
  const readonlyStore: SpoilerShieldStore = {
    getItem: () => JSON.stringify({ "V’Ali": "show" }),
    setItem: () => {
      throw new Error("quota exceeded");
    }
  };
  assert.equal(migrateProfileSpoilerShieldPreference(readonlyStore, "v_ali", "V’Ali"), false);
  const throwingStore: SpoilerShieldStore = {
    getItem: () => {
      throw new Error("storage blocked");
    },
    setItem: () => undefined
  };
  assert.equal(migrateProfileSpoilerShieldPreference(throwingStore, "v_ali", "V’Ali"), false);
});

test("demo fixtures support the whole shield journey without real outcomes", () => {
  const unique = new Map(demoLibrary.sections.flatMap((s) => s.items).map((item) => [item.id, item]));
  const states = [...unique.values()].map((item) => item.watched);
  assert.ok(states.includes(true), "fixture set needs played items for contrast");
  assert.ok(states.includes(false), "fixture set needs confirmed-unplayed items");
  assert.ok(states.includes(undefined), "fixture set needs unknown-state items");

  const continueWatching = demoLibrary.sections.find((s) => s.title === "Continue Watching")?.items ?? [];
  assert.ok(continueWatching.length > 0);
  for (const item of continueWatching) {
    assert.ok((item.progress ?? 0) > 0, "continue-watching fixture should look in-progress");
    assert.notEqual(item.watched, true, "in-progress fixtures must not be marked watched: progress is not watched");
  }

  for (const item of unique.values()) {
    assert.doesNotMatch(
      item.overview ?? "",
      /\b\d+\s*[-–—]\s*\d+\b/,
      `fixture synopsis for ${item.title} must not contain score-like outcomes`
    );
  }

  const hero = demoLibrary.hero;
  assert.equal(isSpoilerShielded(hero, SHIELD, false), true, "the demo hero must demonstrate the shield by default");
});
