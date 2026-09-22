// Hermetic unit tests for the RH-0027 household persistence layer's pure
// modules: input validation (validate.ts, model.ts), PostgreSQL error
// classification (errors.ts), and the pure store helpers (row mappers,
// fingerprints). No database, no network — `npm test` must stay hermetic.

import test from "node:test";
import assert from "node:assert/strict";
import {
  HouseholdConflictError,
  HouseholdInputError,
  HouseholdNotFoundError,
  classifyPgError,
  describePgErrorKind
} from "./errors.ts";
import {
  HOUSEHOLD_LIMITS,
  parseBooleanQuery,
  parseDisplayName,
  parseExternalId,
  parseJellyfinUserId,
  parseLimit,
  parseMediaSource,
  parsePreferences,
  parseProfilePatch,
  parseTicks,
  parseUuid,
  parseWatchProgress
} from "./validate.ts";
import {
  canonicalJsonString,
  fingerprintRequest,
  isUuid,
  parseDescription,
  parseIdempotencyKey,
  parseLimit as parseListLimit,
  parseMediaRef,
  parseMediaRefList,
  parseName,
  parseOptionalPosition,
  parseOptionalUuid,
  parseUuidList
} from "./model.ts";
import {
  fingerprintWatchProgress,
  ticksFromDb,
  toJellyfinLinkJson,
  toProfileJson,
  toWatchStateJson
} from "./store.ts";

// ---------------------------------------------------------------- errors

test("classifyPgError maps SQLSTATE classes to response categories", () => {
  assert.equal(classifyPgError({ code: "23505" })?.kind, "conflict");
  assert.equal(classifyPgError({ code: "23503", constraint: "favorite_profile_id_fkey" })?.kind, "missing-reference");
  assert.equal(classifyPgError({ code: "23514" })?.kind, "input");
  assert.equal(classifyPgError({ code: "23502" })?.kind, "input");
  assert.equal(classifyPgError({ code: "22P02" })?.kind, "input");
  assert.equal(classifyPgError({ code: "22003" })?.kind, "input");
  // Unlisted and non-pg errors are storage / unclassified.
  assert.equal(classifyPgError({ code: "XX999" })?.kind, "storage");
  assert.equal(classifyPgError(new Error("boom")), undefined);
  assert.equal(classifyPgError("boom"), undefined);
  assert.equal(classifyPgError(null), undefined);
});

test("classifyPgError preserves the constraint name when present", () => {
  const classification = classifyPgError({ code: "23505", constraint: "household_profile_display_name_key" });
  assert.equal(classification?.constraint, "household_profile_display_name_key");
});

test("describePgErrorKind stays value-free for every category", () => {
  for (const kind of ["conflict", "missing-reference", "input", "storage"] as const) {
    const text = describePgErrorKind({ kind, code: "23505" });
    assert.ok(text.length > 0 && text.length < 200);
    assert.ok(!text.includes("23505"), "diagnostics must not echo raw SQLSTATE");
  }
});

test("household error classes carry their names for instanceof gates", () => {
  assert.equal(new HouseholdInputError("x").name, "HouseholdInputError");
  assert.equal(new HouseholdNotFoundError("x").name, "HouseholdNotFoundError");
  assert.equal(new HouseholdConflictError("x").name, "HouseholdConflictError");
});

// ---------------------------------------------------------------- validate

test("parseUuid accepts canonical UUIDs and lowercases them", () => {
  assert.equal(parseUuid("018F0000-0000-7000-8000-000000000000", "id").ok, true);
  const parsed = parseUuid("ABCDEF01-2345-6789-ABCD-EF0123456789", "id");
  assert.ok(parsed.ok && parsed.value === "abcdef01-2345-6789-abcd-ef0123456789");
});

test("parseUuid rejects non-UUID input without echoing it", () => {
  const parsed = parseUuid("not-a-uuid; DROP TABLE household_profile", "id");
  assert.ok(!parsed.ok);
  assert.ok(!parsed.errors.join(" ").includes("DROP TABLE"));
});

test("parseDisplayName trims and bounds", () => {
  assert.ok(parseDisplayName("  Vali ").ok);
  assert.ok(!parseDisplayName("   ").ok);
  assert.ok(!parseDisplayName("x".repeat(HOUSEHOLD_LIMITS.displayNameMax + 1)).ok);
  assert.ok(!parseDisplayName(42).ok);
});

test("parseExternalId bounds and trims", () => {
  assert.ok(parseExternalId("  jf-item-1 ").ok);
  assert.ok(!parseExternalId("").ok);
  assert.ok(!parseExternalId("x".repeat(HOUSEHOLD_LIMITS.externalIdMax + 1)).ok);
});

test("parseMediaSource admits only the jellyfin authority", () => {
  assert.ok(parseMediaSource("jellyfin").ok);
  assert.ok(!parseMediaSource("plex").ok);
  assert.ok(!parseMediaSource(undefined).ok);
});

test("parseJellyfinUserId bounds and trims", () => {
  assert.ok(parseJellyfinUserId(" u123 ").ok);
  assert.ok(!parseJellyfinUserId("").ok);
  assert.ok(!parseJellyfinUserId("x".repeat(HOUSEHOLD_LIMITS.jellyfinUserIdMax + 1)).ok);
});

test("parseTicks enforces integer, sign, and JSON-safe range", () => {
  assert.ok(parseTicks(0, "position_ticks").ok);
  assert.ok(parseTicks(100, "position_ticks").ok);
  assert.ok(!parseTicks(-1, "position_ticks").ok);
  assert.ok(!parseTicks(1.5, "position_ticks").ok);
  assert.ok(!parseTicks(Number.MAX_SAFE_INTEGER + 1, "position_ticks").ok);
  assert.ok(!parseTicks(0, "duration_ticks", { allowZero: false }).ok);
  assert.ok(parseTicks(1, "duration_ticks", { allowZero: false }).ok);
});

test("parsePreferences admits objects and refuses arrays, scalars, oversize, and deep nests", () => {
  assert.ok(parsePreferences({}).ok);
  assert.ok(parsePreferences({ theme: "dark", nested: { a: [1, 2, 3] } }).ok);
  assert.ok(!parsePreferences([1, 2]).ok);
  assert.ok(!parsePreferences("dark").ok);
  assert.ok(!parsePreferences(null).ok);

  const bigString = "x".repeat(HOUSEHOLD_LIMITS.preferencesMaxBytes);
  assert.ok(!parsePreferences({ blob: bigString }).ok);

  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let i = 0; i < HOUSEHOLD_LIMITS.preferencesMaxDepth + 2; i++) {
    deep = deep["n"] = {} as Record<string, unknown>;
  }
  assert.ok(!parsePreferences(root).ok);
});

test("parseWatchProgress accepts a valid body and reports every problem at once", () => {
  const ok = parseWatchProgress({
    source: "jellyfin",
    externalId: "jf-1",
    positionTicks: 600,
    durationTicks: 1200,
    completed: false
  });
  assert.ok(ok.ok);
  assert.ok(ok.ok && ok.value.positionTicks === 600);
  assert.ok(ok.ok && ok.value.completed === false);

  const missing = parseWatchProgress({ source: "nope", externalId: "" });
  assert.ok(!missing.ok);
  assert.ok(missing.ok === false && missing.errors.length >= 4, "aggregates all field errors");
});

test("parseWatchProgress refuses position beyond duration", () => {
  const parsed = parseWatchProgress({ source: "jellyfin", externalId: "jf-1", positionTicks: 100, durationTicks: 50 });
  assert.ok(!parsed.ok);
  assert.ok(parsed.ok === false && parsed.errors.some((e) => e.includes("must not exceed")));
});

test("parseProfilePatch requires at least one field and validates types", () => {
  assert.ok(parseProfilePatch({ displayName: "New" }).ok);
  assert.ok(parseProfilePatch({ isActive: false }).ok);
  assert.ok(!parseProfilePatch({}).ok);
  assert.ok(!parseProfilePatch({ displayName: 7 }).ok);
  assert.ok(!parseProfilePatch({ isActive: "yes" }).ok);
  assert.ok(!parseProfilePatch("nope").ok);
});

test("parseLimit refuses out-of-contract values instead of clamping", () => {
  assert.ok(parseLimit(null, 20, 50).ok);
  assert.ok(parseLimit("", 20, 50).ok);
  const parsed = parseLimit("25", 20, 50);
  assert.ok(parsed.ok && parsed.value === 25);
  assert.ok(!parseLimit("0", 20, 50).ok);
  assert.ok(!parseLimit("51", 20, 50).ok);
  assert.ok(!parseLimit("abc", 20, 50).ok);
  assert.ok(!parseLimit("-3", 20, 50).ok);
});

test("parseBooleanQuery admits only the documented spellings", () => {
  assert.equal(parseBooleanQuery("1"), true);
  assert.equal(parseBooleanQuery("true"), true);
  assert.equal(parseBooleanQuery("yes"), false);
  assert.equal(parseBooleanQuery(null), false);
});

// ------------------------------------------------------------------ model

test("isUuid and parseOptionalUuid handle absent vs invalid", () => {
  assert.equal(isUuid("018f0000-0000-7000-8000-000000000000"), true);
  assert.equal(isUuid("nope"), false);
  assert.equal(parseOptionalUuid(undefined, "id"), undefined);
  assert.equal(parseOptionalUuid(null, "id"), undefined);
  assert.throws(() => parseOptionalUuid("nope", "id"), HouseholdInputError);
});

test("parseName and parseDescription bound length and reject blanks", () => {
  assert.equal(parseName("  Movie Night  ", "name"), "Movie Night");
  assert.throws(() => parseName("   ", "name"), HouseholdInputError);
  assert.throws(() => parseName("x".repeat(201), "name"), HouseholdInputError);
  assert.equal(parseDescription("", "description"), "");
  assert.throws(() => parseDescription("x".repeat(2001), "description"), HouseholdInputError);
});

test("parseMediaRef enforces the source domain and external id bounds", () => {
  const ref = parseMediaRef({ source: "jellyfin", id: "jf-9" }, "media");
  assert.deepEqual(ref, { source: "jellyfin", externalId: "jf-9" });
  assert.throws(() => parseMediaRef({ source: "netflix", id: "x" }, "media"), HouseholdInputError);
  assert.throws(() => parseMediaRef({ source: "jellyfin", id: "" }, "media"), HouseholdInputError);
  assert.throws(() => parseMediaRef({ source: "jellyfin", id: "x".repeat(201) }, "media"), HouseholdInputError);
  assert.throws(() => parseMediaRef("jf-9", "media"), HouseholdInputError);
});

test("parseOptionalPosition bounds the splice position", () => {
  assert.equal(parseOptionalPosition(undefined, "position"), undefined);
  assert.equal(parseOptionalPosition(null, "position"), undefined);
  assert.equal(parseOptionalPosition(3, "position"), 3);
  assert.throws(() => parseOptionalPosition(0, "position"), HouseholdInputError);
  assert.throws(() => parseOptionalPosition(1_000_001, "position"), HouseholdInputError);
  assert.throws(() => parseOptionalPosition(1.5, "position"), HouseholdInputError);
});

test("parseListLimit clamps to the documented read cap but refuses garbage", () => {
  assert.equal(parseListLimit(null), 200);
  assert.equal(parseListLimit("50"), 50);
  assert.equal(parseListLimit("100000"), 500);
  assert.throws(() => parseListLimit("abc"), HouseholdInputError);
  assert.throws(() => parseListLimit("0"), HouseholdInputError);
});

test("parseIdempotencyKey trims, bounds, and refuses non-printable ASCII", () => {
  assert.equal(parseIdempotencyKey("  key-1  "), "key-1");
  assert.equal(parseIdempotencyKey(undefined), undefined);
  assert.equal(parseIdempotencyKey("   "), undefined);
  assert.throws(() => parseIdempotencyKey("x".repeat(201)), HouseholdInputError);
  assert.throws(() => parseIdempotencyKey("bad\u0000key"), HouseholdInputError);
});

test("parseMediaRefList refuses empty, oversize, and duplicate entries", () => {
  const ok = parseMediaRefList(
    [
      { source: "jellyfin", id: "a" },
      { source: "jellyfin", id: "b" }
    ],
    "ordered"
  );
  assert.equal(ok.length, 2);
  assert.throws(() => parseMediaRefList([], "ordered"), HouseholdInputError);
  assert.throws(
    () =>
      parseMediaRefList(
        [
          { source: "jellyfin", id: "a" },
          { source: "jellyfin", id: "a" }
        ],
        "ordered"
      ),
    HouseholdInputError
  );
});

test("parseUuidList normalizes case and refuses duplicates", () => {
  const id = "018f0000-0000-7000-8000-000000000000";
  const other = "018f0000-0000-7000-8000-000000000001";
  const parsed = parseUuidList([id.toUpperCase(), other], "ids");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0], id, "ids are normalized to lowercase");
  assert.throws(() => parseUuidList([id, id.toUpperCase()], "ids"), HouseholdInputError);
});

test("canonicalJsonString sorts keys at every level", () => {
  assert.equal(canonicalJsonString({ b: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"b":1}');
  assert.equal(canonicalJsonString([2, 1]), "[2,1]");
});

test("fingerprintRequest is order-insensitive but content-sensitive", () => {
  const a = fingerprintRequest("watch_progress", { externalId: "jf-1", positionTicks: 5 });
  const b = fingerprintRequest("watch_progress", { positionTicks: 5, externalId: "jf-1" });
  assert.equal(a, b);
  const c = fingerprintRequest("watch_progress", { externalId: "jf-1", positionTicks: 6 });
  assert.notEqual(a, c);
});

test("fingerprintWatchProgress normalizes absent duration", () => {
  const withUndefined = fingerprintWatchProgress({
    profileId: "p",
    source: "jellyfin",
    externalId: "e",
    positionTicks: 1,
    completed: false
  });
  const withNull = fingerprintWatchProgress({
    profileId: "p",
    source: "jellyfin",
    externalId: "e",
    positionTicks: 1,
    durationTicks: undefined,
    completed: false
  });
  assert.equal(withUndefined, withNull);
});

// ------------------------------------------------- store pure row mappers

test("ticksFromDb coerces bigint strings and preserves null", () => {
  assert.equal(ticksFromDb(null), null);
  assert.equal(ticksFromDb(42), 42);
  assert.equal(ticksFromDb("9007199254740991"), 9007199254740991);
});

test("toProfileJson maps database rows to the API shape", () => {
  const created = new Date("2026-09-21T10:00:00Z");
  const json = toProfileJson({
    id: "018f0000-0000-7000-8000-000000000001",
    display_name: "Vali",
    is_active: true,
    preferences: { theme: "dark" },
    created_at: created,
    updated_at: created
  });
  assert.deepEqual(json, {
    id: "018f0000-0000-7000-8000-000000000001",
    displayName: "Vali",
    isActive: true,
    preferences: { theme: "dark" },
    createdAt: "2026-09-21T10:00:00.000Z",
    updatedAt: "2026-09-21T10:00:00.000Z"
  });
});

test("toProfileJson defaults absent preferences to an empty object", () => {
  const json = toProfileJson({
    id: "018f0000-0000-7000-8000-000000000002",
    display_name: "Nicole",
    is_active: false,
    preferences: null,
    created_at: new Date("2026-09-21T10:00:00Z"),
    updated_at: new Date("2026-09-21T10:00:00Z")
  });
  assert.deepEqual(json.preferences, {});
  assert.equal(json.isActive, false);
});

test("toWatchStateJson maps overlay rows including string bigints", () => {
  const played = new Date("2026-09-21T11:00:00Z");
  const json = toWatchStateJson({
    profile_id: "018f0000-0000-7000-8000-000000000003",
    source: "jellyfin",
    external_id: "jf-77",
    position_ticks: "1200",
    duration_ticks: null,
    completed: false,
    last_played_at: played,
    updated_at: played
  });
  assert.equal(json.positionTicks, 1200);
  assert.equal(json.durationTicks, null);
  assert.equal(json.source, "jellyfin");
  assert.equal(json.externalId, "jf-77");
  assert.equal(json.lastPlayedAt, "2026-09-21T11:00:00.000Z");
});

test("toJellyfinLinkJson maps link rows", () => {
  const at = new Date("2026-09-21T09:00:00Z");
  const json = toJellyfinLinkJson({
    profile_id: "018f0000-0000-7000-8000-000000000004",
    jellyfin_user_id: "u42",
    created_at: at,
    updated_at: at
  });
  assert.deepEqual(json, {
    profileId: "018f0000-0000-7000-8000-000000000004",
    jellyfinUserId: "u42",
    createdAt: "2026-09-21T09:00:00.000Z",
    updatedAt: "2026-09-21T09:00:00.000Z"
  });
});
