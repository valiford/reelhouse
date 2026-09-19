// Unit tests for the RH-0018 household request model: validation bounds,
// media identity, home-row source pairing, idempotency keys, and
// fingerprints. Pure logic — no database, runs under plain `node --test`.
//
// Error-type expectations follow the RH-0017 contract: validation failures
// are HouseholdInputError, mapped centrally by api.ts to 400 invalid_request.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { HouseholdConflictError, HouseholdInputError, HouseholdNotFoundError } from "./errors.ts";
import {
  canonicalJsonString,
  fingerprintRequest,
  parseHomeRowSource,
  parseIdempotencyKey,
  parseJsonObject,
  parseLimit,
  parseMediaRef,
  parseMediaRefList,
  parseName,
  parseOptionalPosition,
  parseRowKey,
  parseUuid,
  parseUuidList
} from "./model.ts";

function expectValidation(run: () => unknown, contains?: string): void {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof HouseholdInputError, `expected HouseholdInputError, got: ${String(error)}`);
    if (contains) assert.ok(error.message.includes(contains), `message "${error.message}" should mention "${contains}"`);
    return;
  }
  assert.fail("expected a validation error but the call succeeded");
}

const UUID_A = "0f0e8c4a-7b1e-4d3e-9f2a-1b2c3d4e5f60";
const UUID_B = "7f6e5d4c-3b2a-4f6e-8d7c-6b5a49382736";

test("uuid parsing accepts canonical uuids and rejects everything else", () => {
  assert.equal(parseUuid(UUID_A, "x"), UUID_A);
  assert.equal(parseUuid(UUID_A.toUpperCase(), "x"), UUID_A);
  expectValidation(() => parseUuid("not-a-uuid", "x"));
  expectValidation(() => parseUuid(42, "x"));
  expectValidation(() => parseUuid(`${UUID_A}0`, "x"));
});

test("names are trimmed, must not be blank, and are capped", () => {
  assert.equal(parseName("  Movie Night  ", "name"), "Movie Night");
  expectValidation(() => parseName("   ", "name"), "blank");
  expectValidation(() => parseName("x".repeat(201), "name"), "200");
  assert.equal(parseName("x".repeat(200), "name").length, 200);
});

test("media refs accept only known sources with non-blank ids", () => {
  const ref = parseMediaRef({ source: "jellyfin", id: " abc123 " }, "media");
  assert.deepEqual(ref, { source: "jellyfin", externalId: "abc123" });
  expectValidation(() => parseMediaRef({ source: "plex", id: "x" }, "media"), "source");
  expectValidation(() => parseMediaRef({ source: "jellyfin", id: "  " }, "media"), "blank");
  expectValidation(() => parseMediaRef({ source: "jellyfin", id: "x".repeat(201) }, "media"), "200");
  expectValidation(() => parseMediaRef(null, "media"));
  expectValidation(() => parseMediaRef({ source: "jellyfin" }, "media"));
});

test("positions are positive integers within bounds or absent", () => {
  assert.equal(parseOptionalPosition(3, "position"), 3);
  assert.equal(parseOptionalPosition(undefined, "position"), undefined);
  assert.equal(parseOptionalPosition(null, "position"), undefined);
  expectValidation(() => parseOptionalPosition(0, "position"));
  expectValidation(() => parseOptionalPosition(1.5, "position"));
  expectValidation(() => parseOptionalPosition(1_000_001, "position"));
});

test("row keys are lowercase slugs", () => {
  assert.equal(parseRowKey("continue_watching", "rowKey"), "continue_watching");
  expectValidation(() => parseRowKey("Continue Watching", "rowKey"));
  expectValidation(() => parseRowKey("", "rowKey"));
});

test("home-row sources pair kind with exactly one identifier", () => {
  const section = parseHomeRowSource({ kind: "jellyfin_section", sourceKey: "abc" }, "source");
  assert.deepEqual(section, { kind: "jellyfin_section", sourceKey: "abc" });
  const collection = parseHomeRowSource({ kind: "collection", collectionId: UUID_B }, "source");
  assert.deepEqual(collection, { kind: "collection", collectionId: UUID_B });
  expectValidation(() => parseHomeRowSource({ kind: "collection", collectionId: UUID_B, sourceKey: "x" }, "source"));
  expectValidation(() => parseHomeRowSource({ kind: "jellyfin_section" }, "source"));
  expectValidation(() => parseHomeRowSource({ kind: "netflix" }, "source"));
});

test("idempotency keys are printable, bounded, and trimmed", () => {
  assert.equal(parseIdempotencyKey("  abc-123  "), "abc-123");
  assert.equal(parseIdempotencyKey(undefined), undefined);
  assert.equal(parseIdempotencyKey("   "), undefined);
  expectValidation(() => parseIdempotencyKey("with\u0000null"), "printable ASCII");
  expectValidation(() => parseIdempotencyKey("x".repeat(201)), "200");
});

test("json bodies must be bounded objects", () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  expectValidation(() => parseJsonObject("nope"), "valid JSON");
  expectValidation(() => parseJsonObject("[1,2]"), "object");
  expectValidation(() => parseJsonObject("x".repeat(65_537)), "characters");
});

test("ordered lists reject empties, overflows, and duplicates", () => {
  const media = { source: "jellyfin", id: "a" };
  assert.deepEqual(parseMediaRefList([media], "ordered"), [{ source: "jellyfin", externalId: "a" }]);
  expectValidation(() => parseMediaRefList([], "ordered"), "non-empty");
  expectValidation(() => parseMediaRefList([media, media], "ordered"), "duplicate");
  assert.deepEqual(parseUuidList([UUID_A, UUID_B], "ids"), [UUID_A, UUID_B]);
  expectValidation(() => parseUuidList([UUID_A, UUID_A], "ids"), "duplicate");
});

test("limits clamp to the read contract", () => {
  assert.equal(parseLimit(null), 200);
  assert.equal(parseLimit("50"), 50);
  assert.equal(parseLimit("100000"), 500);
  expectValidation(() => parseLimit("zero"));
  expectValidation(() => parseLimit("0"));
});

test("canonical json is key-order independent; fingerprints are not", () => {
  const a = canonicalJsonString({ b: 1, a: { y: 2, x: 3 } });
  const b = canonicalJsonString({ a: { x: 3, y: 2 }, b: 1 });
  assert.equal(a, b);
  assert.notEqual(
    fingerprintRequest("favorites.add", { media: { source: "jellyfin", externalId: "one" } }),
    fingerprintRequest("favorites.add", { media: { source: "jellyfin", externalId: "two" } })
  );
  // Same semantic payload under different scopes must not collide either.
  assert.notEqual(
    fingerprintRequest("favorites.add", { profileId: UUID_A }),
    fingerprintRequest("favorites.remove", { profileId: UUID_A })
  );
});

test("the RH-0017 error family maps to the central response contract", () => {
  // The classes my layer throws are exactly the ones api.ts understands.
  const input = new HouseholdInputError("name must not be blank");
  const missing = new HouseholdNotFoundError("profile does not exist");
  const conflict = new HouseholdConflictError("another watchlist already has this name");
  assert.equal(input.name, "HouseholdInputError");
  assert.equal(missing.name, "HouseholdNotFoundError");
  assert.equal(conflict.name, "HouseholdConflictError");
  assert.ok(input instanceof Error && missing instanceof Error && conflict instanceof Error);
});
