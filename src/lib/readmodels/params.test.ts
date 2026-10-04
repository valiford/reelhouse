// Hermetic unit tests for the read-model parameter contract (RH-0034).
//
// The bounds here ARE the bounded-result contract: what a client can ask for
// and what normalization does with it. Everything is pure — no database, no
// I/O — so these run in the hermetic `npm test` pass.

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FILTER_VALUES,
  PAGE_DEFAULT_LIMIT,
  PAGE_MAX_LIMIT,
  likePattern,
  resolveIdentifier,
  resolvePage,
  resolveRailLimit,
  resolveSearchFilters,
  ReadModelParamError
} from "./params.ts";

test("page resolution applies the bounded-result window", () => {
  assert.deepEqual(resolvePage({}), { limit: PAGE_DEFAULT_LIMIT, offset: 0 });
  assert.deepEqual(resolvePage({ limit: 10, offset: 40 }), { limit: 10, offset: 40 });
  // Numeric strings are accepted (they arrive as query params).
  assert.deepEqual(resolvePage({ limit: "10", offset: "0" }), { limit: 10, offset: 0 });
  // Out-of-range clamps, never errors: a client asking for too much gets the
  // bounded maximum.
  assert.deepEqual(resolvePage({ limit: PAGE_MAX_LIMIT + 5000 }), { limit: PAGE_MAX_LIMIT, offset: 0 });
  assert.deepEqual(resolvePage({ limit: 0 }), { limit: 1, offset: 0 });
  assert.deepEqual(resolvePage({ offset: -5 }), { limit: PAGE_DEFAULT_LIMIT, offset: 0 });
});

test("page resolution fails closed on non-numeric values", () => {
  for (const bad of ["abc", "1.5", "  ", true, {}, []]) {
    assert.throws(() => resolvePage({ limit: bad }), ReadModelParamError, `limit=${JSON.stringify(bad)}`);
  }
  assert.throws(() => resolvePage({ offset: "much" }), ReadModelParamError);
});

test("rail limit shares the clamp policy with a tighter ceiling", () => {
  assert.equal(resolveRailLimit(undefined), 20);
  assert.equal(resolveRailLimit("500"), 50);
  assert.equal(resolveRailLimit(1), 1);
  assert.throws(() => resolveRailLimit("lots"), ReadModelParamError);
});

test("search filters normalize deterministically and fail closed on unknown enums", () => {
  const filters = resolveSearchFilters({
    q: "  Arrival  ",
    types: "movie,series,movie",
    libraries: ["lib-a", "lib-a", "lib-b"],
    genres: "Sci-Fi, Drama",
    yearMin: "1970",
    yearMax: 2026,
    minRating: "7.5",
    sort: "rating",
    dir: undefined
  });
  assert.equal(filters.q, "Arrival");
  assert.deepEqual(filters.types, ["movie", "series"], "types dedupe, CSV accepted");
  assert.deepEqual(filters.libraries, ["lib-a", "lib-b"]);
  assert.deepEqual(filters.genres, ["Sci-Fi", "Drama"]);
  assert.equal(filters.yearMin, 1970);
  assert.equal(filters.yearMax, 2026);
  assert.equal(filters.minRating, 7.5);
  assert.equal(filters.sort, "rating");
  assert.equal(filters.dir, "desc", "rating defaults to best-first");
});

test("sort direction defaults follow the sort key", () => {
  assert.equal(resolveSearchFilters({}).dir, "asc", "title is A→Z by default");
  assert.equal(resolveSearchFilters({ sort: "recent" }).dir, "desc");
  assert.equal(resolveSearchFilters({ sort: "year", dir: "asc" }).dir, "asc", "explicit dir wins");
});

test("invalid enum / range / shape inputs are rejected with typed errors", () => {
  assert.throws(() => resolveSearchFilters({ sort: "vibes" }), /sort must be one of/);
  assert.throws(() => resolveSearchFilters({ dir: "up" }), /dir must be/);
  assert.throws(() => resolveSearchFilters({ types: "documentary" }), /type "documentary" is not one of/);
  assert.throws(() => resolveSearchFilters({ yearMin: 1800 }), /yearMin must be an integer between/);
  assert.throws(() => resolveSearchFilters({ yearMax: "3000" }), /yearMax must be an integer between/);
  assert.throws(() => resolveSearchFilters({ yearMin: 2020, yearMax: 1990 }), /yearMin .* must be <= yearMax/);
  assert.throws(() => resolveSearchFilters({ minRating: "11" }), /minRating must be a number between 0 and 10/);
  assert.throws(() => resolveSearchFilters({ minRating: "-1" }), /minRating/);
  assert.throws(() => resolveSearchFilters({ genres: 42 }), /filter values must be strings/);
  assert.throws(
    () => resolveSearchFilters({ libraries: "x".repeat(500) }),
    /libraries entry exceeds 200 characters/
  );
  const tooMany = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => `g${i}`).join(",");
  assert.throws(() => resolveSearchFilters({ genres: tooMany }), /genres accepts at most/);
});

test("empty and whitespace filters collapse to defaults, unknown keys are ignored", () => {
  const filters = resolveSearchFilters({ q: "   ", types: "", cacheBuster: "x" } as Record<string, unknown>);
  assert.equal(filters.q, null);
  assert.deepEqual(filters.types, []);
  assert.equal(filters.sort, "title");
});

test("likePattern escapes ILIKE metacharacters and wraps with wildcards", () => {
  assert.equal(likePattern("Arrival"), "%Arrival%");
  assert.equal(likePattern("100%"), "%100\\%%");
  assert.equal(likePattern("under_score"), "%under\\_score%");
  assert.equal(likePattern("back\\slash"), "%back\\\\slash%");
});

test("identifier resolution is bounded and required", () => {
  assert.equal(resolveIdentifier(" v_ali ", "profile"), "v_ali");
  assert.throws(() => resolveIdentifier("", "profile"), /profile is required/);
  assert.throws(() => resolveIdentifier("   ", "profile"), /profile is required/);
  assert.throws(() => resolveIdentifier("x".repeat(300), "profile"), /exceeds 200 characters/);
});
