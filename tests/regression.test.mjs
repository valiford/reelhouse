// RH-0008 regression suite: build-level behavior preservation after the
// Next.js security upgrade. Runs the production server (`next start`) in
// three environment scenarios and asserts the app contract from
// docs/BASELINE.md: the two API routes, the demo fallback, the degraded
// path when Jellyfin is unreachable, and the Jellyfin success path.
// Uses only node:test — no new runtime dependencies.
//
// Requires `npm run build` first (the suite starts `next start`).

import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port), reject);
    });
    probe.on("error", reject);
  });
}

async function startReelHouse(env) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [NEXT_BIN, "start", "-p", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: ROOT,
      env: { ...process.env, ...env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`next start exited early:\n${output}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/library`);
      if (res.ok) return { port, child, output: () => output };
    } catch {
      /* not accepting connections yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  child.kill();
  throw new Error(`next start did not become ready:\n${output}`);
}

async function stopReelHouse(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.child.kill("SIGKILL");
      resolve();
    }, 5_000);
    server.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const get = async (port, urlPath) => {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  return { status: res.status, text: await res.text() };
};
const getJson = async (port, urlPath) => {
  const { status, text } = await get(port, urlPath);
  return { status, body: JSON.parse(text), text };
};

// Minimal Jellyfin-compatible upstream for the success-path scenario.
// Records the last request so tests can assert the server-side contract
// (auth header stays server-side, query mapping is preserved).
function startFakeJellyfin() {
  const state = { lastUrl: null, lastAuthHeader: null, hits: 0 };
  const movies = [
    {
      Id: "jf-movie-1",
      Name: "Solar Drift",
      Type: "Movie",
      ProductionYear: 2024,
      Overview: "A freight hauler drifts into a quiet war.",
      CommunityRating: 8.1,
      Genres: ["Sci-Fi"],
      UserData: { PlaybackPositionTicks: 100, PlayedPercentage: 55 },
      ImageTags: { Primary: "tag-primary-1" },
      BackdropImageTags: ["tag-backdrop-1"]
    },
    {
      Id: "jf-series-1",
      Name: "Harbor Lights",
      Type: "Series",
      ProductionYear: 2022,
      Overview: "Two families, one lighthouse.",
      Genres: ["Drama"],
      ImageTags: {}
    }
  ];
  const server = createServer((req, res) => {
    state.hits += 1;
    state.lastUrl = new URL(req.url, "http://upstream");
    state.lastAuthHeader = req.headers["x-emby-token"] ?? null;
    res.setHeader("content-type", "application/json");
    const term = state.lastUrl.searchParams.get("SearchTerm");
    const items = term
      ? term.toLowerCase().includes("solar")
        ? [movies[0]]
        : []
      : movies;
    res.end(JSON.stringify({ Items: items, TotalRecordCount: items.length }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, state });
    });
  });
}

const DEMO_SECTIONS = [
  "Continue Watching",
  "Recently Added",
  "Movies",
  "Home Videos"
];

describe("demo mode (no Jellyfin credentials)", () => {
  let app;

  before(async () => {
    app = await startReelHouse({
      JELLYFIN_URL: "",
      JELLYFIN_API_KEY: "",
      JELLYFIN_USER_ID: "",
      NEXT_PUBLIC_JELLYFIN_URL: ""
    });
  });
  after(() => stopReelHouse(app));

  it("GET / serves the app shell", async () => {
    const { status, text } = await get(app.port, "/");
    assert.equal(status, 200);
    assert.match(text, /<title>ReelHouse<\/title>/);
    assert.match(text, /class="topbar"/);
    // Server-rendered demo hero proves the client tree hydrates from
    // the same demo payload the API serves.
    assert.match(text, /<h1>Northern Lights<\/h1>/);
    assert.match(text, /Demo library/);
  });

  it("GET /api/library returns the demo library payload", async () => {
    const { status, body } = await getJson(app.port, "/api/library");
    assert.equal(status, 200);
    assert.equal(body.source, "demo");
    assert.equal(body.hero.title, "Northern Lights");
    assert.deepEqual(
      body.sections.map((s) => s.title),
      DEMO_SECTIONS
    );
    for (const section of body.sections) {
      assert.ok(section.items.length > 0, `${section.title} has items`);
      for (const item of section.items) {
        assert.ok(item.id, "item id present");
        assert.ok(item.title, "item title present");
        assert.ok(["Movie", "Series", "Episode", "Video"].includes(item.kind));
      }
    }
  });

  it("GET /api/search?q=santorini finds the demo item", async () => {
    const { status, body } = await getJson(app.port, "/api/search?q=santorini");
    assert.equal(status, 200);
    const hit = body.items.find((item) => item.title === "Santorini");
    assert.ok(hit, "demo search finds Santorini");
    assert.equal(hit.id, "demo-3");
  });

  it("GET /api/search with blank or unmatched terms returns empty, not errors", async () => {
    const blank = await getJson(app.port, "/api/search?q=");
    assert.equal(blank.status, 200);
    assert.deepEqual(blank.body, { items: [] });

    const missing = await getJson(app.port, "/api/search");
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.body, { items: [] });

    const unmatched = await getJson(app.port, "/api/search?q=zzz-no-such-title");
    assert.equal(unmatched.status, 200);
    assert.deepEqual(unmatched.body, { items: [] });
  });
});

describe("degraded mode (configured Jellyfin unreachable)", () => {
  let app;

  before(async () => {
    // Port 9 (discard) is unassigned on loopback: connection refused.
    app = await startReelHouse({
      JELLYFIN_URL: "http://127.0.0.1:9",
      JELLYFIN_API_KEY: "test-key-unreachable",
      JELLYFIN_USER_ID: "test-user-unreachable",
      NEXT_PUBLIC_JELLYFIN_URL: "http://127.0.0.1:9"
    });
  });
  after(() => stopReelHouse(app));

  it("GET /api/library falls back to the demo library", async () => {
    const { status, body } = await getJson(app.port, "/api/library");
    assert.equal(status, 200);
    assert.equal(body.source, "demo");
    assert.equal(body.hero.title, "Northern Lights");
  });

  it("GET /api/search degrades to empty results", async () => {
    const { status, body } = await getJson(app.port, "/api/search?q=santorini");
    assert.equal(status, 200);
    assert.deepEqual(body, { items: [] });
  });
});

describe("healthy Jellyfin upstream (fake Jellyfin API)", () => {
  let app;
  let upstream;

  before(async () => {
    upstream = await startFakeJellyfin();
    app = await startReelHouse({
      JELLYFIN_URL: `http://127.0.0.1:${upstream.port}`,
      JELLYFIN_API_KEY: "test-key-123",
      JELLYFIN_USER_ID: "test-user-1",
      NEXT_PUBLIC_JELLYFIN_URL: `http://127.0.0.1:${upstream.port}`
    });
  });
  after(async () => {
    await stopReelHouse(app);
    upstream.server.close();
  });

  it("GET /api/library maps the Jellyfin payload", async () => {
    const { status, body } = await getJson(app.port, "/api/library");
    assert.equal(status, 200);
    assert.equal(body.source, "jellyfin");
    assert.equal(body.hero.title, "Solar Drift");
    assert.equal(body.hero.year, 2024);
    assert.equal(body.hero.rating, 8.1);
    assert.deepEqual(body.hero.genres, ["Sci-Fi"]);

    const continueWatching = body.sections.find(
      (s) => s.title === "Continue Watching"
    );
    assert.ok(continueWatching, "resumable item lands in Continue Watching");
    assert.equal(continueWatching.items[0].progress, 55);

    // Image URLs are built from the configured public Jellyfin URL.
    assert.match(
      body.hero.imageUrl,
      new RegExp(
        `^http://127\\.0\\.0\\.1:${upstream.port}/Items/jf-movie-1/Images/Primary\\?`
      )
    );
  });

  it("GET /api/search proxies the term upstream and maps results", async () => {
    const { status, body } = await getJson(app.port, "/api/search?q=solar");
    assert.equal(status, 200);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].id, "jf-movie-1");
    assert.equal(body.items[0].title, "Solar Drift");
    assert.equal(upstream.state.lastUrl.searchParams.get("SearchTerm"), "solar");
    assert.equal(upstream.state.lastUrl.searchParams.get("Recursive"), "true");
  });

  it("keeps the API key server-side", async () => {
    await getJson(app.port, "/api/library");
    await getJson(app.port, "/api/search?q=solar");
    assert.equal(upstream.state.lastAuthHeader, "test-key-123");
    const { text } = await get(app.port, "/api/library");
    assert.ok(!text.includes("test-key-123"), "no API key in responses");
  });
});
