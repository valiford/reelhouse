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
  return new NextRequest(`http://localhost:3000/api/library${query}`);
}

describe("GET /api/library — demo mode (no Jellyfin credentials)", () => {
  it("returns the full demo payload by default", async () => {
    const GET = await loadGetWithEnv({});
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.source).toBe("demo");
    expect(body.degraded).toBeUndefined();
    expect(body.hero.id).toBeTruthy();
    expect(body.sections.map((section: { title: string }) => section.title)).toEqual(
      expect.arrayContaining(["Continue Watching", "Recently Added", "Movies", "Home Videos"])
    );
  });

  it("filters to known sections case-insensitively", async () => {
    const GET = await loadGetWithEnv({});
    const body = await (await GET(getRequest("?sections=movies,Home%20Videos"))).json();
    expect(body.sections.map((section: { title: string }) => section.title)).toEqual(["Movies", "Home Videos"]);
  });

  it("bounds each section with the limit parameter", async () => {
    const GET = await loadGetWithEnv({});
    const body = await (await GET(getRequest("?sections=Movies&limit=2"))).json();
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0].items.length).toBeLessThanOrEqual(2);
  });

  it("rejects unknown sections with an explicit 400", async () => {
    const GET = await loadGetWithEnv({});
    const response = await GET(getRequest("?sections=Movies,Playlists"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatchObject({ code: "invalid_query", field: "sections" });
  });

  it("rejects invalid limits with an explicit 400", async () => {
    const GET = await loadGetWithEnv({});
    const response = await GET(getRequest("?limit=0"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.field).toBe("limit");
  });
});

describe("GET /api/library — Jellyfin mode", () => {
  const JELLYFIN_ENV = {
    JELLYFIN_URL: "http://jellyfin:8096",
    JELLYFIN_API_KEY: "test-key",
    JELLYFIN_USER_ID: "user-1"
  };

  function stubUpstream(movies: Array<{ Id: string; Name: string }>) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const isMovieQuery = url.includes("IncludeItemTypes=Movie&");
      return new Response(
        JSON.stringify({ Items: isMovieQuery ? movies : [], TotalRecordCount: isMovieQuery ? movies.length : 0 }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("maps upstream sections with a bounded limit", async () => {
    stubUpstream([{ Id: "m1", Name: "One" }, { Id: "m2", Name: "Two" }, { Id: "m3", Name: "Three" }]);
    const GET = await loadGetWithEnv(JELLYFIN_ENV);

    const response = await GET(getRequest("?sections=Movies&limit=2"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.source).toBe("jellyfin");
    expect(body.sections.map((section: { title: string }) => section.title)).toEqual(["Movies"]);
    expect(body.sections[0].items.map((item: { id: string }) => item.id)).toEqual(["m1", "m2"]);
    expect(body.hero.id).toBe("m1");
  });

  it("falls back to demo data and flags the payload degraded when upstream fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("upstream down")));
    const GET = await loadGetWithEnv(JELLYFIN_ENV);

    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.source).toBe("demo");
    expect(body.degraded).toBe(true);
  });

  it("surfaces cancellation as 408 without flagging degraded demo data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })));
    const GET = await loadGetWithEnv(JELLYFIN_ENV);

    const response = await GET(getRequest());
    expect(response.status).toBe(408);
  });
});
