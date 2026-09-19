import { describe, expect, it } from "vitest";
import { LIST_QUERY_BOUNDS, parseListQuery } from "./list-query";

describe("parseListQuery", () => {
  it("applies bounded defaults when no params are given", () => {
    const parsed = parseListQuery(new URLSearchParams());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.query).toEqual({ q: "", kinds: [], year: undefined, limit: 24, offset: 0 });
    }
  });

  it("accepts a fully bounded query", () => {
    const parsed = parseListQuery(
      new URLSearchParams({ q: "  northern  ", limit: "10", offset: "20", kind: "movie,Series", year: "2024" })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.query.q).toBe("northern");
      expect(parsed.query.kinds).toEqual(["Movie", "Series"]);
      expect(parsed.query.year).toBe(2024);
      expect(parsed.query.limit).toBe(10);
      expect(parsed.query.offset).toBe(20);
    }
  });

  it("deduplicates repeated kinds", () => {
    const parsed = parseListQuery(new URLSearchParams({ kind: "Movie,movie,MOVIE" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.query.kinds).toEqual(["Movie"]);
  });

  it("requires a non-empty q when asked", () => {
    const parsed = parseListQuery(new URLSearchParams({ q: "   " }), { requireQuery: true });
    expect(parsed).toMatchObject({ ok: false, error: { field: "q" } });
  });

  it("rejects over-long search terms", () => {
    const parsed = parseListQuery(new URLSearchParams({ q: "x".repeat(LIST_QUERY_BOUNDS.maxQueryLength + 1) }));
    expect(parsed).toMatchObject({ ok: false, error: { field: "q" } });
  });

  it("rejects unbounded or non-numeric limits", () => {
    for (const limit of ["0", String(LIST_QUERY_BOUNDS.maxLimit + 1), "-3", "abc"]) {
      const parsed = parseListQuery(new URLSearchParams({ limit }));
      expect(parsed).toMatchObject({ ok: false, error: { field: "limit" } });
    }
  });

  it("rejects out-of-range offsets", () => {
    for (const offset of ["-1", String(LIST_QUERY_BOUNDS.maxOffset + 1), "1.5"]) {
      const parsed = parseListQuery(new URLSearchParams({ offset }));
      expect(parsed).toMatchObject({ ok: false, error: { field: "offset" } });
    }
  });

  it("rejects unknown kinds", () => {
    const parsed = parseListQuery(new URLSearchParams({ kind: "Movie,Book" }));
    expect(parsed).toMatchObject({ ok: false, error: { field: "kind" } });
  });

  it("rejects years outside the deterministic range", () => {
    for (const year of ["1877", "2101", "twenty"]) {
      const parsed = parseListQuery(new URLSearchParams({ year }));
      expect(parsed).toMatchObject({ ok: false, error: { field: "year" } });
    }
  });
});
