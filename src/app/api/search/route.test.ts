import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type GetHandler = (request: NextRequest) => Promise<Response>;

const ORIGINAL_ENV = { ...process.env };
const JELLYFIN_KEYS = ["JELLYFIN_URL", "JELLYFIN_API_KEY", "JELLYFIN_USER_ID", "NEXT_PUBLIC_JELLYFIN_URL"] as const;

async function loadGetWithEnv(env: Partial<Record<(typeof JELLYFIN_KEYS)[number], string>>): Promise<GetHandler> {
  vi.resetModules();
  for (const key of JELLYFIN_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const mod = await import("./route");
  return mod.GET as GetHandler;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

function getRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/search${query}`);
}

function jellyfinItemsBody(ids: string[], total?: number): string {
  return JSON.stringify({
    Items: ids.map((id) => ({ Id: id, Name: `Item ${id}`, Type: "Movie" })),
    ...(total === undefined ? {} : { TotalRecordCount: total })
  });
}

describe("GET /api/search — demo mode (no Jellyfin credentials)", () => {
  it.each([
    ["non-numeric limit", "?q=northern&limit=abc"],
    ["over-large limit", "?q=northern&limit=51"],
    ["negative offset", "?q=northern&offset=-1"],
    ["unknown kind", "?q=northern&kind=Book"],
    ["impossible year", "?q=northern&year=1877"],
    ["over-long term", `?q=${"x".repeat(201)}`]
  ])("rejects invalid input with an explicit 400 (%s)", async (_label, query) => {
    const GET = await loadGetWithEnv({});
    const response = await GET(getRequest(query));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_query");
    expect(typeof body.error.field).toBe("string");
    expect(typeof body.error.message).toBe("string");
  });

  it("requires a non-empty q", async () => {
    const GET = await loadGetWithEnv({});
    const response = await GET(getRequest("?q=%20%20"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.field).toBe("q");
  });

  it("returns a bounded page and identical bytes for identical requests", async () => {
    const GET = await loadGetWithEnv({});
    const first = await GET(getRequest("?q=the&limit=5"));
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.source).toBe("demo");
    expect(body.items.length).toBeLessThanOrEqual(5);
    expect(body.limit).toBe(5);
    expect(body.offset).toBe(0);
    expect(body.total).toBeGreaterThanOrEqual(body.items.length);
    const second = await GET(getRequest("?q=the&limit=5"));
    expect(await second.json()).toEqual(body);
  });

  it("pages with disjoint, deterministic windows", async () => {
    const GET = await loadGetWithEnv({});
    const pageOne = await (await GET(getRequest("?q=the&limit=5&offset=0"))).json();
    const pageTwo = await (await GET(getRequest("?q=the&limit=5&offset=5"))).json();
    expect(pageTwo.total).toBe(pageOne.total);
    const seen = new Set(pageOne.items.map((item: { id: string }) => item.id));
    for (const item of pageTwo.items) expect(seen.has(item.id)).toBe(false);
    const beyond = await (await GET(getRequest(`?q=the&limit=5&offset=${pageOne.total + 50}`))).json();
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(pageOne.total);
  });

  it("applies kind and year filters", async () => {
    const GET = await loadGetWithEnv({});
    const series = await (await GET(getRequest("?q=e&kind=Series"))).json();
    expect(series.total).toBe(0);
    expect(series.items).toEqual([]);
    const homeVideos = await (await GET(getRequest("?q=e&kind=Video&year=2026"))).json();
    for (const item of homeVideos.items) {
      expect(item.kind).toBe("Video");
      expect(item.year).toBe(2026);
    }
  });
});

describe("GET /api/search — Jellyfin mode", () => {
  const JELLYFIN_ENV = {
    JELLYFIN_URL: "http://jellyfin:8096",
    JELLYFIN_API_KEY: "test-key",
    JELLYFIN_USER_ID: "user-1"
  };

  it("returns a deduplicated bounded payload and queries the upstream deterministically", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(jellyfinItemsBody(["a", "a", "b"], 42), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const GET = await loadGetWithEnv(JELLYFIN_ENV);

    const response = await GET(getRequest("?q=al&limit=10&offset=20&kind=Movie&year=2024"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.source).toBe("jellyfin");
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(["a", "b"]);
    expect(body.total).toBe(42);
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(20);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("SearchTerm=al");
    expect(url).toContain("SortBy=SortName");
    expect(url).toContain("SortOrder=Ascending");
    expect(url).toContain("StartIndex=20");
    expect(url).toContain("Limit=10");
    expect(url).toContain("IncludeItemTypes=Movie");
    expect(url).toContain("Years=2024");
    expect((init.headers as Record<string, string>)["X-Emby-Token"]).toBe("test-key");
  });

  it("maps upstream failure to an explicit 502 instead of fake empty results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("upstream down")));
    const GET = await loadGetWithEnv(JELLYFIN_ENV);

    const response = await GET(getRequest("?q=al"));
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("upstream_unavailable");
  });

  it("reports cancellation as 408, not as an upstream failure", async () => {
    const abortError = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));
    const GET = await loadGetWithEnv(JELLYFIN_ENV);

    const abortedUpstream = await GET(getRequest("?q=al"));
    expect(abortedUpstream.status).toBe(408);

    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("upstream down")));
    const abortedRequest = await GET(new NextRequest("http://localhost:3000/api/search?q=al", { signal: controller.signal }));
    expect(abortedRequest.status).toBe(408);
  });
});
