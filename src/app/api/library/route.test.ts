// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const JELLYFIN_ENV_KEYS = ["JELLYFIN_URL", "JELLYFIN_API_KEY", "JELLYFIN_USER_ID", "NEXT_PUBLIC_JELLYFIN_URL"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of JELLYFIN_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  for (const key of JELLYFIN_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("GET /api/library", () => {
  it("serves the demo library when Jellyfin is unconfigured", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.source).toBe("demo");
    expect(body.hero.title).toBeTruthy();
    expect(body.sections.length).toBeGreaterThan(0);
    expect(body.sections[0].items.length).toBeGreaterThan(0);
  });

  it("falls back to the demo library when the engine is unreachable", async () => {
    process.env.JELLYFIN_URL = "http://127.0.0.1:9";
    process.env.JELLYFIN_API_KEY = "test-key";
    process.env.JELLYFIN_USER_ID = "test-user";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection refused"); }));

    vi.resetModules();
    const { GET: withEnv } = await import("./route");
    const response = await withEnv();
    const body = await response.json();

    expect(body.source).toBe("demo");
    expect(body.sections.length).toBeGreaterThan(0);
  });
});
