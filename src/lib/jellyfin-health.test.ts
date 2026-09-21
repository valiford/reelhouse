import test from "node:test";
import assert from "node:assert/strict";
import { checkJellyfin } from "./jellyfin-health.ts";

const BASE = { JELLYFIN_URL: "http://jellyfin.lan:8096" } as const;

function okFetch(body: unknown = { ServerName: "Home", Version: "10.10.1" }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

test("blank JELLYFIN_URL is unconfigured (demo mode), never an error", async () => {
  assert.deepEqual(await checkJellyfin({}, okFetch()), { state: "unconfigured" });
  assert.deepEqual(await checkJellyfin({ JELLYFIN_URL: "   " }, okFetch()), { state: "unconfigured" });
});

test("reachable Jellyfin reports name, version, and latency", async () => {
  const health = await checkJellyfin(BASE, okFetch());
  assert.equal(health.state, "reachable");
  assert.equal(health.serverName, "Home");
  assert.equal(health.version, "10.10.1");
  assert.equal(typeof health.latencyMs, "number");
});

test("trailing slashes are normalized before probing", async () => {
  let seen: string | undefined;
  const fetchImpl = (async (input: string | URL | Request) => {
    seen = String(input);
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  await checkJellyfin({ JELLYFIN_URL: "http://jf.lan:8096///" }, fetchImpl);
  assert.equal(seen, "http://jf.lan:8096/System/Info/Public");
});

test("HTTP error statuses are unreachable without body secrets", async () => {
  const fetchImpl = (async () => new Response("denied", { status: 401 })) as typeof fetch;
  const health = await checkJellyfin(BASE, fetchImpl);
  assert.equal(health.state, "unreachable");
  assert.match(health.detail || "", /HTTP 401/);
  assert.ok(!health.detail?.includes("denied"));
});

test("network failures are unreachable and redacted", async () => {
  const fetchImpl = (async () => {
    throw new Error("connect ECONNREFUSED http://jellyfin.lan:8096/System/Info/Public");
  }) as typeof fetch;
  const health = await checkJellyfin(BASE, fetchImpl);
  assert.equal(health.state, "unreachable");
  assert.match(health.detail || "", /ECONNREFUSED/);
});

test("timeouts are bounded and reported as unreachable", async () => {
  // AbortSignal.timeout timers are unref'd; without an active handle the
  // event loop would drain before the abort fires and cancel this test.
  const keepAlive = setTimeout(() => {}, 30_000);
  try {
    let sawSignal: AbortSignal | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      sawSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        sawSignal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      });
    }) as typeof fetch;
    const started = Date.now();
    const health = await checkJellyfin({ JELLYFIN_URL: "http://blackhole.lan", JELLYFIN_HEALTH_TIMEOUT_MS: "250" }, fetchImpl);
    assert.equal(health.state, "unreachable");
    assert.ok(Date.now() - started < 5_000, `probe took ${Date.now() - started}ms, expected the ~250ms bound`);
    assert.equal(sawSignal?.aborted, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("out-of-range timeout overrides fall back to the default bound", async () => {
  const keepAlive = setTimeout(() => {}, 30_000);
  try {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      });
    }) as typeof fetch;
    const started = Date.now();
    const health = await checkJellyfin({ JELLYFIN_URL: "http://blackhole.lan", JELLYFIN_HEALTH_TIMEOUT_MS: "99999999" }, fetchImpl);
    assert.equal(health.state, "unreachable");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2_500, `probe aborted after ${elapsed}ms — override was not clamped to the default`);
    assert.ok(elapsed < 8_000, `probe took ${elapsed}ms — expected the 3s default bound`);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("non-JSON 2xx bodies still count as reachable", async () => {
  const fetchImpl = (async () => new Response("<html>ok</html>", { status: 200 })) as typeof fetch;
  const health = await checkJellyfin(BASE, fetchImpl);
  assert.equal(health.state, "reachable");
  assert.match(health.detail || "", /non-JSON/);
});

test("oversized or malformed fields are truncated, not echoed raw", async () => {
  const long = "x".repeat(500);
  const health = await checkJellyfin(BASE, okFetch({ ServerName: long, Version: "1" }));
  assert.equal(health.state, "reachable");
  assert.equal(health.serverName?.length, 100);
});
