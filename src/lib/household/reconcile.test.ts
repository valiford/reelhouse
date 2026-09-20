// Unit tests for the RH-0022 watch-state reconciliation logic: Jellyfin
// resume-item parsing, the merge rule, and the playedAt request validation.
// No PostgreSQL and no network here — the end-to-end behavior against a real
// PG18 with a fixture resume client is covered by watch-progress.int.test.ts.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseWatchProgress, PLAYED_AT_FUTURE_SKEW_MS } from "./validate.ts";
import {
  parseJellyfinDate,
  parseJellyfinResumeItem,
  parseJellyfinTicks,
  planJellyfinEntry,
  type JellyfinResumeItem
} from "./reconcile.ts";
import type { WatchStateJson } from "./store.ts";

// ------------------------------------------------------------------ parsing

test("parseJellyfinTicks accepts finite non-negative numbers only", () => {
  assert.equal(parseJellyfinTicks(1200), 1200);
  assert.equal(parseJellyfinTicks(0), 0);
  assert.equal(parseJellyfinTicks(1.9), 1, "ticks are floored to whole units");
  assert.equal(parseJellyfinTicks(-1), null);
  assert.equal(parseJellyfinTicks("1200"), null);
  assert.equal(parseJellyfinTicks(Number.NaN), null);
  assert.equal(parseJellyfinTicks(Number.POSITIVE_INFINITY), null);
  assert.equal(parseJellyfinTicks(undefined), null);
});

test("parseJellyfinDate accepts only strings that parse as dates", () => {
  const parsed = parseJellyfinDate("2026-09-19T12:00:00.000Z");
  assert.ok(parsed instanceof Date);
  assert.equal(parsed?.toISOString(), "2026-09-19T12:00:00.000Z");
  assert.equal(parseJellyfinDate("not a date"), null);
  assert.equal(parseJellyfinDate(1234), null);
  assert.equal(parseJellyfinDate(undefined), null);
});

function resumeItem(overrides: Partial<JellyfinResumeRawShape> = {}): JellyfinResumeRawShape {
  return {
    Id: "jf-item-1",
    RunTimeTicks: 6000,
    UserData: { PlaybackPositionTicks: 300, Played: false, LastPlayedDate: "2026-09-19T10:00:00.000Z" },
    ...overrides
  };
}

interface JellyfinResumeRawShape {
  Id?: unknown;
  RunTimeTicks?: unknown;
  UserData?: { PlaybackPositionTicks?: unknown; Played?: unknown; LastPlayedDate?: unknown };
}

test("parseJellyfinResumeItem maps a well-formed item and rejects malformed ones", () => {
  const item = parseJellyfinResumeItem(resumeItem());
  assert.ok(item);
  assert.equal(item?.externalId, "jf-item-1");
  assert.equal(item?.positionTicks, 300);
  assert.equal(item?.durationTicks, 6000);
  assert.equal(item?.completed, false);
  assert.equal(item?.playedAt?.toISOString(), "2026-09-19T10:00:00.000Z");

  // Trimmed identity, unknown duration, completed flag.
  assert.equal(parseJellyfinResumeItem(resumeItem({ Id: "  jf-2  ", RunTimeTicks: undefined }))?.externalId, "jf-2");
  assert.equal(parseJellyfinResumeItem(resumeItem({ RunTimeTicks: undefined }))?.durationTicks, null);
  const played = parseJellyfinResumeItem(resumeItem({ UserData: { PlaybackPositionTicks: 0, Played: true, LastPlayedDate: undefined } }));
  assert.equal(played?.completed, true);
  assert.equal(played?.playedAt, null);
  assert.equal(played?.positionTicks, 0, "missing progress defaults to zero");

  // Malformed: refused, never half-applied.
  assert.equal(parseJellyfinResumeItem(null), null);
  assert.equal(parseJellyfinResumeItem("item"), null);
  assert.equal(parseJellyfinResumeItem({ Id: "" }), null);
  assert.equal(parseJellyfinResumeItem({ Id: "   " }), null);
  assert.equal(parseJellyfinResumeItem({ Id: 42 }), null);
  assert.equal(
    parseJellyfinResumeItem(resumeItem({ UserData: { PlaybackPositionTicks: -5, Played: false, LastPlayedDate: undefined } })),
    null,
    "present-but-invalid progress is not an identity to trust"
  );
  assert.equal(
    parseJellyfinResumeItem(resumeItem({ RunTimeTicks: -1 })),
    null,
    "present-but-invalid runtime is not an identity to trust"
  );
  assert.equal(
    parseJellyfinResumeItem(resumeItem({ UserData: { PlaybackPositionTicks: 9999, Played: false, LastPlayedDate: undefined } })),
    null,
    "progress past the runtime is ambiguous — skip, never clamp"
  );
});

// --------------------------------------------------------------- merge rule

function localState(overrides: Partial<WatchStateJson> = {}): WatchStateJson {
  return {
    profileId: "p1",
    source: "jellyfin",
    externalId: "jf-item-1",
    positionTicks: 300,
    durationTicks: 6000,
    completed: false,
    lastPlayedAt: "2026-09-19T10:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
    ...overrides
  };
}

function remoteItem(overrides: Partial<JellyfinResumeItem> = {}): JellyfinResumeItem {
  return {
    externalId: "jf-item-1",
    positionTicks: 300,
    durationTicks: 6000,
    completed: false,
    playedAt: new Date("2026-09-19T10:00:00.000Z"),
    ...overrides
  };
}

test("planJellyfinEntry: nothing stored yet always applies", () => {
  assert.equal(planJellyfinEntry(null, remoteItem()), "apply");
  assert.equal(planJellyfinEntry(null, remoteItem({ playedAt: null })), "apply");
  assert.equal(planJellyfinEntry(null, remoteItem({ positionTicks: 0, completed: true })), "apply");
});

test("planJellyfinEntry: Jellyfin events are ordered by their timestamp", () => {
  assert.equal(planJellyfinEntry(localState(), remoteItem({ playedAt: new Date("2026-09-19T11:00:00.000Z") })), "apply");
  assert.equal(
    planJellyfinEntry(localState(), remoteItem({ playedAt: new Date("2026-09-19T09:00:00.000Z") })),
    "stale",
    "a strictly older Jellyfin event must never regress local state"
  );
  assert.equal(
    planJellyfinEntry(localState(), remoteItem()),
    "apply",
    "an equal timestamp applies (idempotent rewrite + event dedupe)"
  );
});

test("planJellyfinEntry: items without a timestamp only seed, never overwrite", () => {
  assert.equal(
    planJellyfinEntry(localState(), remoteItem({ playedAt: null })),
    "duplicate",
    "identical state with no ordering information is already applied"
  );
  assert.equal(
    planJellyfinEntry(localState({ positionTicks: 900 }), remoteItem({ playedAt: null })),
    "stale",
    "different state with no ordering information fails closed to local"
  );
  assert.equal(
    planJellyfinEntry(localState({ completed: true }), remoteItem({ playedAt: null })),
    "stale"
  );
  assert.equal(
    planJellyfinEntry(localState({ durationTicks: null }), remoteItem({ playedAt: null, durationTicks: null })),
    "duplicate",
    "unknown durations compare as equal unknowns"
  );
});

// ------------------------------------------------- playedAt request parsing

test("parseWatchProgress accepts an ISO playedAt and normalizes it", () => {
  const parsed = parseWatchProgress({
    source: "jellyfin",
    externalId: "jf-item-1",
    positionTicks: 300,
    completed: false,
    playedAt: "2026-09-19T10:00:00+00:00"
  });
  assert.ok(parsed.ok);
  if (parsed.ok) assert.equal(parsed.value.playedAt, "2026-09-19T10:00:00.000Z");
});

test("parseWatchProgress keeps playedAt optional for RH-0017 clients", () => {
  const parsed = parseWatchProgress({
    source: "jellyfin",
    externalId: "jf-item-1",
    positionTicks: 300,
    completed: false
  });
  assert.ok(parsed.ok);
  if (parsed.ok) assert.equal(parsed.value.playedAt, undefined);
});

test("parseWatchProgress refuses non-ISO, non-string, and future playedAt values", () => {
  for (const bad of [42, "yesterday", "2026-13-45T99:00:00Z"]) {
    const parsed = parseWatchProgress({
      source: "jellyfin",
      externalId: "jf-item-1",
      positionTicks: 300,
      completed: false,
      playedAt: bad
    });
    assert.ok(!parsed.ok, `expected rejection for ${String(bad)}`);
    if (!parsed.ok) assert.deepEqual(parsed.errors, ["played_at must be an ISO 8601 timestamp"]);
  }

  const future = new Date(Date.now() + PLAYED_AT_FUTURE_SKEW_MS + 60_000).toISOString();
  const parsed = parseWatchProgress({
    source: "jellyfin",
    externalId: "jf-item-1",
    positionTicks: 300,
    completed: false,
    playedAt: future
  });
  assert.ok(!parsed.ok);
  if (!parsed.ok) assert.deepEqual(parsed.errors, ["played_at must not be in the future"]);

  // Small clock skew is tolerated.
  const skew = new Date(Date.now() + 30_000).toISOString();
  const tolerated = parseWatchProgress({
    source: "jellyfin",
    externalId: "jf-item-1",
    positionTicks: 300,
    completed: false,
    playedAt: skew
  });
  assert.ok(tolerated.ok);
});
