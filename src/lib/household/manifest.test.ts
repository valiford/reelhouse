// Hermetic unit evidence for the household manifest contract (RH-0033).
//
// Pure validation/normalization only: no database, no network, no clock.
// Covers slug identity policy, fail-closed field/enum/bounds validation,
// first-wins duplicate collapsing with conflict counting, default-profile
// reconciliation, and byte-determinism of the normalized payload.

import test from "node:test";
import assert from "node:assert/strict";
import {
  ManifestError,
  canonicalTimestamp,
  normalizeManifest,
  slugifyName
} from "./manifest.ts";

function fullSnapshot(): Record<string, unknown> {
  return {
    profiles: [
      {
        name: "V’Ali",
        initials: "VA",
        isDefault: true,
        jellyfinUserId: "jf-user-vali",
        preferences: { theme: "dark", autoplay_next: true },
        favorites: [
          { jellyfinId: "mov-arrival", addedAt: "2026-08-01T12:00:00Z" },
          { jellyfinId: "ser-demo" }
        ],
        watchlists: [
          {
            name: "Movie Night",
            entries: [{ jellyfinId: "mov-citizen", addedAt: "2026-08-02T09:30:00Z" }]
          }
        ],
        homeRows: [
          { kind: "continue_watching", title: "Continue Watching" },
          { kind: "library", title: "Movies", config: { library_jellyfin_id: "lib-movies" } },
          { kind: "collection", title: "Family Picks", config: { collection_slug: "family_picks" } }
        ],
        watchState: [
          {
            jellyfinId: "ep-demo-1",
            positionTicks: 600_000_000,
            durationTicks: 1_500_000_000,
            lastPlayedAt: "2026-09-20T02:11:00Z"
          },
          { jellyfinId: "mov-bare", completed: true, hiddenFromContinue: true }
        ],
        playbackHistory: [
          { jellyfinId: "ep-demo-1", playedAt: "2026-09-20T01:40:00Z", positionTicks: 0 },
          { jellyfinId: "ep-demo-1", playedAt: "2026-09-20T02:11:00Z", positionTicks: 600_000_000 }
        ]
      },
      {
        name: "Nicole",
        favorites: [{ jellyfinId: "vid-home", addedAt: "2026-07-15T18:00:00Z" }]
      }
    ],
    collections: [
      {
        name: "Family Picks",
        description: "Household-curated picks",
        entries: [
          { jellyfinId: "mov-arrival" },
          { jellyfinId: "vid-home", addedAt: "2026-07-01T00:00:00Z" }
        ]
      }
    ]
  };
}

test("a full snapshot normalizes deterministically and derives stable slugs", () => {
  const first = normalizeManifest(fullSnapshot());
  const second = normalizeManifest(fullSnapshot());
  assert.deepEqual(first, second, "the same logical snapshot normalizes byte-identically");

  assert.deepEqual(
    first.profiles.map((profile) => [profile.slug, profile.isDefault]),
    [
      [slugifyName("V’Ali"), true],
      ["nicole", false]
    ],
    "payload order and slug derivation (punctuation collapses to a separator, trimmed)"
  );
  assert.equal(first.profiles[0].name, "V’Ali");
  assert.deepEqual(first.profiles[0].preferences, [
    { key: "theme", value: "dark" },
    { key: "autoplay_next", value: true }
  ]);
  assert.deepEqual(
    first.profiles[0].homeRows.map((row) => [row.slug, row.kind, row.config]),
    [
      ["continue_watching", "continue_watching", {}],
      ["movies", "library", { library_jellyfin_id: "lib-movies" }],
      ["family_picks", "collection", { collection_slug: "family_picks" }]
    ]
  );
  assert.equal(first.profiles[0].watchState[0].positionTicks, 600_000_000);
  assert.equal(first.profiles[1].initials, null, "optionals default to null");
  assert.equal(first.conflictsSkipped, 0);
});

test("slugifyName is deterministic and refuses unusable names", () => {
  assert.equal(slugifyName("V’Ali"), "v_ali");
  assert.equal(slugifyName("  Nicole  "), "nicole");
  assert.equal(slugifyName("Dad & Mom"), "dad_mom");
  assert.throws(() => slugifyName("!!!"), ManifestError);
  assert.throws(() => slugifyName("x".repeat(300)), ManifestError);
});

test("ambiguous profile identity (two names, one slug) fails closed", () => {
  const manifest = fullSnapshot();
  (manifest.profiles as Record<string, unknown>[]).push({ name: "Vali Impostor", slug: "v_ali" });
  assert.throws(() => normalizeManifest(manifest), /ambiguous household identity/);
});

test("explicit slugs win over derived ones and must be well-formed", () => {
  const manifest = {
    profiles: [{ name: "V’Ali", slug: "vali_primary" }]
  };
  const normalized = normalizeManifest(manifest);
  assert.equal(normalized.profiles[0].slug, "vali_primary");

  assert.throws(
    () => normalizeManifest({ profiles: [{ name: "X", slug: "Not A Slug" }] }),
    /must match/
  );
});

test("unknown fields fail closed at every level", () => {
  assert.throws(() => normalizeManifest({ profiles: [], favorits: [] }), /manifest has unknown field "favorits"/);
  assert.throws(
    () => normalizeManifest({ profiles: [{ name: "A", favourits: [] }] }),
    /manifest\.profiles\[0\] has unknown field "favourits"/
  );
  assert.throws(
    () => normalizeManifest({ profiles: [{ name: "A", preferences: { them: "dark" } }] }),
    /unknown preference key "them"/
  );
  assert.throws(
    () => normalizeManifest({ profiles: [{ name: "A", homeRows: [{ kind: "banner", title: "B" }] }] }),
    /kind must be one of/
  );
});

test("preference values are validated against the registry", () => {
  const ok = normalizeManifest({
    profiles: [
      {
        name: "A",
        preferences: {
          theme: "light",
          autoplay_next: false,
          reduced_motion: true,
          preferred_audio_language: "eng",
          preferred_subtitle_language: "ger"
        }
      }
    ]
  });
  assert.equal(ok.profiles[0].preferences.length, 5);

  assert.throws(
    () => normalizeManifest({ profiles: [{ name: "A", preferences: { theme: "neon" } }] }),
    /theme must be one of/
  );
  assert.throws(
    () => normalizeManifest({ profiles: [{ name: "A", preferences: { autoplay_next: "yes" } }] }),
    /must be a boolean/
  );
});

test("home-row config shape is bound to the kind", () => {
  assert.throws(
    () => normalizeManifest({ profiles: [{ name: "A", homeRows: [{ kind: "library", title: "L" }] }] }),
    /must provide library_jellyfin_id/
  );
  assert.throws(
    () =>
      normalizeManifest({
        profiles: [{ name: "A", homeRows: [{ kind: "favorites", title: "F", config: { collection_slug: "x" } }] }]
      }),
    /must be empty for kind "favorites"/
  );
  assert.throws(
    () =>
      normalizeManifest({
        profiles: [
          {
            name: "A",
            homeRows: [{ kind: "watchlist", title: "W", config: { watchlist_slug: "a", extra: "b" } }]
          }
        ]
      }),
    /must be exactly \{ watchlist_slug: string \}/
  );
});

test("duplicate list items collapse when identical and count conflicts when they differ", () => {
  const manifest = fullSnapshot();
  const profiles = manifest.profiles as Record<string, unknown>[];
  profiles[0] = {
    ...profiles[0],
    favorites: [
      { jellyfinId: "mov-arrival", addedAt: "2026-08-01T12:00:00Z" },
      { jellyfinId: "mov-arrival", addedAt: "2026-08-01T12:00:00Z" },
      { jellyfinId: "ser-demo", addedAt: "2026-09-01T00:00:00Z" },
      { jellyfinId: "ser-demo" }
    ]
  };
  const normalized = normalizeManifest(manifest);
  assert.deepEqual(
    normalized.profiles[0].favorites.map((entry) => [entry.jellyfinId, entry.addedAt]),
    [
      ["mov-arrival", "2026-08-01T12:00:00.000Z"],
      ["ser-demo", "2026-09-01T00:00:00.000Z"]
    ],
    "first occurrence wins; identical repetitions collapse"
  );
  assert.equal(normalized.conflictsSkipped, 1, "the differing repetition is counted and skipped");
});

test("repeated profile occurrences merge children under first-wins scalars", () => {
  const manifest = {
    profiles: [
      { name: "Nicole", initials: "N", preferences: { theme: "dark" }, favorites: [{ jellyfinId: "a" }] },
      { name: "Nicole", initials: "N", preferences: { theme: "dark" }, favorites: [{ jellyfinId: "a" }, { jellyfinId: "b" }] }
    ]
  };
  const normalized = normalizeManifest(manifest);
  assert.equal(normalized.profiles.length, 1);
  assert.deepEqual(
    normalized.profiles[0].favorites.map((entry) => entry.jellyfinId),
    ["a", "b"],
    "children of both occurrences merge in payload order"
  );
  assert.equal(normalized.conflictsSkipped, 0);

  const conflicting = {
    profiles: [
      { name: "Nicole", initials: "N" },
      { name: "Nicole", initials: "NF" }
    ]
  };
  const conflictingNormalized = normalizeManifest(conflicting);
  assert.equal(conflictingNormalized.profiles[0].initials, "N", "first scalars win");
  assert.equal(conflictingNormalized.conflictsSkipped, 1);
});

test("exactly one default survives a snapshot that claims several", () => {
  const manifest = {
    profiles: [
      { name: "V’Ali", isDefault: true },
      { name: "Nicole", isDefault: true },
      { name: "Guest", isDefault: true }
    ]
  };
  const normalized = normalizeManifest(manifest);
  assert.deepEqual(
    normalized.profiles.map((profile) => [profile.slug, profile.isDefault]),
    [["v_ali", true], ["nicole", false], ["guest", false]]
  );
  assert.equal(normalized.conflictsSkipped, 2);
});

test("timestamps canonicalize to UTC ISO-8601 or fail closed", () => {
  assert.equal(canonicalTimestamp("2026-09-22T12:00:00-04:00", "t"), "2026-09-22T16:00:00.000Z");
  assert.equal(canonicalTimestamp("2026-09-22T12:00:00Z", "t"), "2026-09-22T12:00:00.000Z");
  assert.equal(canonicalTimestamp(undefined, "t"), null);
  assert.equal(canonicalTimestamp(null, "t"), null);
  assert.throws(() => canonicalTimestamp("not-a-date", "t"), ManifestError);
  assert.throws(() => canonicalTimestamp(12345, "t"), ManifestError);
  assert.throws(
    () =>
      normalizeManifest({
        profiles: [{ name: "A", playbackHistory: [{ jellyfinId: "x", playedAt: "yesterday-ish" }] }]
      }),
    /playedAt is not a parseable timestamp/
  );
});

test("ticks must be non-negative safe integers", () => {
  const ok = normalizeManifest({
    profiles: [{ name: "A", watchState: [{ jellyfinId: "x", positionTicks: 0, durationTicks: Number.MAX_SAFE_INTEGER }] }]
  });
  assert.equal(ok.profiles[0].watchState[0].durationTicks, Number.MAX_SAFE_INTEGER);
  assert.throws(
    () =>
      normalizeManifest({
        profiles: [{ name: "A", watchState: [{ jellyfinId: "x", positionTicks: -1 }] }]
      }),
    /positionTicks must be a non-negative safe integer/
  );
  assert.throws(
    () =>
      normalizeManifest({
        profiles: [{ name: "A", playbackHistory: [{ jellyfinId: "x", playedAt: "2026-01-01T00:00:00Z", durationTicks: 1.5 }] }]
      }),
    /durationTicks must be a non-negative safe integer/
  );
});

test("bounds fail closed before any write can happen", () => {
  const tooManyProfiles = Array.from({ length: 65 }, (_, index) => ({ name: `P${index}` }));
  assert.throws(() => normalizeManifest({ profiles: tooManyProfiles }), /exceeds 64 profiles/);

  const manyFavorites = Array.from({ length: 5001 }, (_, index) => ({ jellyfinId: `id-${index}` }));
  assert.throws(
    () => normalizeManifest({ profiles: [{ name: "A", favorites: manyFavorites }] }),
    /exceeds 5000 entries/
  );

  const manyCollections = Array.from({ length: 257 }, (_, index) => ({ name: `C${index}` }));
  assert.throws(() => normalizeManifest({ profiles: [], collections: manyCollections }), /exceeds 256 collections/);
});

test("an empty manifest normalizes to an empty household", () => {
  assert.deepEqual(normalizeManifest({}), { profiles: [], collections: [], conflictsSkipped: 0 });
});

test("ambiguous watchlist and collection identities fail closed", () => {
  assert.throws(
    () =>
      normalizeManifest({
        profiles: [
          {
            name: "A",
            watchlists: [{ name: "Movie Night", entries: [] }],
          },
          {
            name: "A",
            watchlists: [{ name: "Movie Nights", slug: "movie_night", entries: [] }]
          }
        ]
      }),
    /ambiguous watchlist identity/
  );
  assert.throws(
    () =>
      normalizeManifest({
        profiles: [],
        collections: [{ name: "Picks" }, { name: "Picks!", slug: "picks" }]
      }),
    /ambiguous collection identity/
  );
});

test("history events dedupe on (item, playedAt) with first-wins conflicts", () => {
  const manifest = {
    profiles: [
      {
        name: "A",
        playbackHistory: [
          { jellyfinId: "x", playedAt: "2026-09-20T01:40:00Z", positionTicks: 0 },
          { jellyfinId: "x", playedAt: "2026-09-20T01:40:00.000Z", positionTicks: 0 },
          { jellyfinId: "x", playedAt: "2026-09-20T01:40:00Z", positionTicks: 5 }
        ]
      }
    ]
  };
  const normalized = normalizeManifest(manifest);
  assert.equal(normalized.profiles[0].playbackHistory.length, 1, "identical replay collapses (canonical instants)");
  assert.equal(normalized.conflictsSkipped, 1, "a differing replay of the same event is counted");
});
