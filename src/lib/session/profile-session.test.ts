import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PROFILE_SLUG_LENGTH,
  createGenerationGuard,
  normalizeProfileSlug,
  profileQueryParam
} from "./profile-session.ts";

test("the asserted identity is read from the URL, blank means none", () => {
  assert.equal(normalizeProfileSlug("v_ali"), "v_ali");
  assert.equal(normalizeProfileSlug("  nicole "), "nicole", "surrounding whitespace is not identity");
  assert.equal(normalizeProfileSlug(""), null);
  assert.equal(normalizeProfileSlug("   "), null, "a blank slug asserts no identity");
  assert.equal(normalizeProfileSlug(null), null);
  assert.equal(normalizeProfileSlug(undefined), null);
});

test("unparsable slugs pass through so the server stays the identity authority", () => {
  // A malformed or over-long slug must reach the server and fail closed
  // there (404/400 → the profile-error panel); silently dropping it would
  // fall back to the unscoped default profile — a fail-open identity.
  const hostile = "x".repeat(MAX_PROFILE_SLUG_LENGTH + 1);
  assert.equal(normalizeProfileSlug(hostile), hostile);
  assert.equal(normalizeProfileSlug("Not-A-Slug"), "Not-A-Slug");
});

test("the profile query parameter is encoded once, identically, for every request", () => {
  assert.equal(profileQueryParam("v_ali"), "?profile=v_ali");
  assert.equal(profileQueryParam("odd slug"), "?profile=odd%20slug");
  assert.equal(profileQueryParam(null), "", "no identity means no parameter");
  assert.equal(profileQueryParam(undefined), "");
  assert.equal(profileQueryParam("   "), "", "blank identity means no parameter");
});

test("generation-bound requests survive while their generation is live", () => {
  const guard = createGenerationGuard();
  const first = guard.start();
  assert.ok(guard.isLive(first), "a fresh token is live");
  const second = guard.start();
  assert.equal(second, first, "tokens are stable within one generation");
  assert.ok(guard.isLive(second));
});

test("an identity switch invalidates every token issued before it", () => {
  const guard = createGenerationGuard();
  const stale = guard.start();
  guard.invalidate();
  assert.equal(guard.isLive(stale), false, "the old profile's in-flight token is stale");
  const fresh = guard.start();
  assert.notEqual(fresh, stale);
  assert.ok(guard.isLive(fresh), "only the new generation's tokens are live");
  assert.equal(guard.isLive(stale), false);
});

test("repeated invalidations keep advancing the generation monotonically", () => {
  const guard = createGenerationGuard();
  const tokens: number[] = [];
  tokens.push(guard.start());
  guard.invalidate();
  tokens.push(guard.start());
  guard.invalidate();
  tokens.push(guard.start());
  for (let index = 0; index < tokens.length - 1; index += 1) {
    assert.ok(tokens[index + 1] > tokens[index]);
    assert.equal(guard.isLive(tokens[index]), false);
  }
  assert.ok(guard.isLive(tokens[tokens.length - 1]));
});
