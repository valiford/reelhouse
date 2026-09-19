// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

function requestFor(q: string): NextRequest {
  const url = new URL("http://localhost:3210/api/search");
  if (q) url.searchParams.set("q", q);
  return new NextRequest(url);
}

describe("GET /api/search", () => {
  it("matches demo items by title when Jellyfin is unconfigured", async () => {
    const response = await GET(requestFor("northern"));
    const body = await response.json();

    expect(response.status).toBe(200);
    // The demo generator recycles its 10 seed titles across 22 items,
    // so one term can legitimately match distinct items with equal titles.
    expect(body.items).toHaveLength(2);
    for (const item of body.items) expect(item.title).toBe("Northern Lights");
  });

  it("returns no items for a blank query", async () => {
    const response = await GET(requestFor(""));
    const body = await response.json();

    expect(body.items).toEqual([]);
  });

  it("returns no items when nothing matches", async () => {
    const response = await GET(requestFor("zzzz-no-such-title"));
    const body = await response.json();

    expect(body.items).toEqual([]);
  });
});
