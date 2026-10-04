// Hermetic unit tests for read-model SQL construction (RH-0034).
//
// The write paths in this codebase build parameter arrays from field lists
// precisely so $n placeholders can never drift from their values; the read
// models hold the same line by producing text and values together through
// SqlBuilder. These tests assert that invariant mechanically — for every
// filter combination, every $n in the text has a value, no value is orphaned,
// the sort cannot be shaped from outside, and pagination bounds are
// parameterized. All pure; runs in the hermetic `npm test` pass.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalogCountQuery,
  buildCatalogSearchQuery
} from "./search.ts";
import { resolvePage, resolveSearchFilters } from "./params.ts";

function assertPlaceholderConsistency(query: { text: string; values: unknown[] }): void {
  const indices = [...query.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  const max = Math.max(0, ...indices);
  assert.equal(
    max,
    query.values.length,
    `every placeholder has a value: text uses $1..$${max}, array holds ${query.values.length}`
  );
  assert.deepEqual(
    [...new Set(indices)].sort((a, b) => a - b),
    Array.from({ length: query.values.length }, (_, i) => i + 1),
    "no gaps and no orphaned values in the placeholder numbering"
  );
}

const FILTER_MATRIX: Record<string, Record<string, unknown>> = {
  bare: {},
  queryOnly: { q: "arrival" },
  types: { types: "movie,series" },
  libraries: { libraries: "lib-movies,lib-tv" },
  genres: { genres: "Sci-Fi" },
  years: { yearMin: "1990", yearMax: "2020" },
  rating: { minRating: "7" },
  everything: {
    q: "the%",
    types: "movie",
    libraries: "lib-movies",
    genres: "Drama,Sci-Fi",
    yearMin: "1970",
    yearMax: "2026",
    minRating: "6.5",
    sort: "recent",
    dir: "asc"
  },
  wildcardQuery: { q: "100% _great\\", sort: "rating" },
  allSortsAsc: { sort: "title", dir: "asc" },
  recentDesc: { sort: "recent", dir: "desc" },
  yearAsc: { sort: "year", dir: "asc" },
  ratingDesc: { sort: "rating", dir: "desc" }
};

for (const [name, raw] of Object.entries(FILTER_MATRIX)) {
  test(`search query is placeholder-consistent: ${name}`, () => {
    const filters = resolveSearchFilters(raw);
    const page = resolvePage({ limit: 10, offset: 20 });
    assertPlaceholderConsistency(buildCatalogSearchQuery(filters, page));
    assertPlaceholderConsistency(buildCatalogCountQuery(filters));
  });
}

test("pagination bounds are parameterized, never interpolated from input", () => {
  const filters = resolveSearchFilters({});
  const text = buildCatalogSearchQuery(filters, resolvePage({ limit: 5, offset: 500 })).text;
  assert.match(text, /LIMIT \$\d+ OFFSET \$\d+$/, "limit/offset arrive as parameters");
  assert.doesNotMatch(text, /LIMIT 5/, "no literal page numbers in the SQL text");
});

test("ORDER BY is drawn from a fixed per-sort expression with a unique tiebreaker", () => {
  const cases: Array<[string, RegExp]> = [
    ["title", /ORDER BY lower\(COALESCE\(m\.sort_name, m\.name\)\) ASC, m\.id ASC/],
    ["recent", /ORDER BY COALESCE\(m\.date_created, m\.first_seen_at\) DESC, m\.id DESC/],
    ["rating", /ORDER BY m\.community_rating DESC NULLS LAST, m\.id DESC/],
    ["year", /ORDER BY m\.production_year DESC NULLS LAST, m\.id DESC/]
  ];
  for (const [sort, pattern] of cases) {
    const text = buildCatalogSearchQuery(resolveSearchFilters({ sort }), resolvePage({})).text;
    assert.match(text, pattern, `sort=${sort} orders deterministically`);
  }
});

test("the active-only predicate is always present, whatever the filters", () => {
  for (const raw of Object.values(FILTER_MATRIX)) {
    const filters = resolveSearchFilters(raw);
    const count = buildCatalogCountQuery(filters).text;
    assert.match(count, /m\.removed_at IS NULL/);
    assert.match(count, /l\.removed_at IS NULL/);
  }
});

test("search and count share the identical filter clause", () => {
  const filters = resolveSearchFilters(FILTER_MATRIX.everything);
  const search = buildCatalogSearchQuery(filters, resolvePage({}));
  const count = buildCatalogCountQuery(filters);
  const whereOf = (text: string): string => text.slice(text.indexOf("WHERE") + 5, text.indexOf("ORDER BY") === -1 ? undefined : text.indexOf("ORDER BY"));
  assert.equal(whereOf(search.text).trim(), whereOf(count.text).trim(), "page and count filter identically");
});

test("query text interpolates no client-controlled strings", () => {
  const filters = resolveSearchFilters({ q: "'; DROP TABLE media_items; --", genres: "Sci'Fi" });
  const text = buildCatalogSearchQuery(filters, resolvePage({})).text;
  assert.doesNotMatch(text, /DROP TABLE/);
  assert.doesNotMatch(text, /Sci'Fi/);
});
