// Hermetic unit matrix for the Jellyfin reachability probe. A injected fetch
// implementation stands in for the network, so no Jellyfin is contacted.

import test from "node:test";
import assert from "node:assert/strict";
import { checkJellyfin } from "./jellyfin-health.ts";

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

test("blank JELLYFIN_URL is unconfigured (demo mode), never an error", async () => {
  assert.deepEqual(await checkJellyfin({}), { state: "unconfigured" });
  assert.deepEqual(await checkJellyfin({ JELLYFIN_URL: "   " }), { state: "unconfigured" });
});

test("reachable Jellyfin reports name, version, and latency", async () => {
  const calls: (RequestInfo | URL)[] = [];
  const health = await checkJellyfin({ JELLYFIN_URL: "http://nas:8096" }, async (url) => {
    calls.push(url);
    return jsonResponse(JSON.stringify({ ServerName: "Home", Version: "10.10.6" }));
  });
  assert.equal(health.state, "reachable");
  assert.equal(health.serverName, "Home");
  assert.equal(health.version, "10.10.6");
  assert.equal(typeof health.latencyMs, "number");
  assert.deepEqual(calls, ["http://nas:8096/System/Info/Public"]);
});

test("trailing slashes are normalized before probing", async () => {
  let seen = "";
  await checkJellyfin({ JELLYFIN_URL: "http://nas:8096///" }, async (url) => {
    seen = String(url);
    return jsonResponse("{}");
  });
  assert.equal(seen, "http://nas:8096/System/Info/Public");
});

test("HTTP error statuses are unreachable without body secrets", async () => {
  const health = await checkJellyfin({ JELLYFIN_URL: "http://nas:8096" }, async () => jsonResponse("nope", 502));
  assert.equal(health.state, "unreachable");
  assert.match(health.detail ?? "", /HTTP 502/);
  assert.ok(!health.detail?.includes("nope"));
});

test("network failures are unreachable and redacted", async () => {
  const raw = "http://probe:secret-token@nas:8096";
  const health = await checkJellyfin({ JELLYFIN_URL: raw }, async () => {
    throw new Error(`getaddrinfo ENOTFOUND ${raw}`);
  });
  assert.equal(health.state, "unreachable");
  assert.ok(!health.detail?.includes("secret-token"), "error leaked credentials");
  assert.ok(!health.detail?.includes(raw), "error leaked the raw URL");
  assert.match(health.detail ?? "", /ENOTFOUND/);
});

test("timeouts are bounded and reported as unreachable", async () => {
  const health = await checkJellyfin({ JELLYFIN_URL: "http://nas:8096" }, async (_url, init) => {
    const signal = init?.signal;
    assert.ok(signal, "probe must pass an abort signal");
    return new Promise<Response>((_resolve, reject) => {
      // AbortSignal.timeout timers are unref'd; hold the event loop so the
      // abort can actually fire inside this test instead of draining first.
      const keepAlive = setInterval(() => {}, 1_000);
      signal.addEventListener(
        "abort",
        () => {
          clearInterval(keepAlive);
          reject(new Error("The operation was aborted due to timeout"));
        },
        { once: true }
      );
    });
  });
  assert.equal(health.state, "unreachable");
  assert.match(health.detail ?? "", /aborted|timeout/i);
});

test("out-of-range timeout overrides fall back to the default bound", async () => {
  let observed: AbortSignal | null | undefined;
  await checkJellyfin(
    { JELLYFIN_URL: "http://nas:8096", JELLYFIN_HEALTH_TIMEOUT_MS: "99999999" },
    async (_url, init) => {
      observed = init?.signal;
      return jsonResponse("{}");
    }
  );
  assert.ok(observed, "fetch was not called");
  // Default bound is 3s; the signal must fire well before a bogus override.
  const fired = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 3_500);
    observed!.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  assert.ok(fired, "abort signal did not fire within the default 3s bound");
});

test("non-JSON 2xx bodies still count as reachable", async () => {
  const health = await checkJellyfin({ JELLYFIN_URL: "http://nas:8096" }, async () => new Response("<html>ok</html>", { status: 200 }));
  assert.equal(health.state, "reachable");
  assert.match(health.detail ?? "", /non-JSON/);
});

test("oversized or malformed fields are truncated, not echoed raw", async () => {
  // Stay under the probe's 4KB body-read bound so the JSON actually parses;
  // individual fields must still be truncated before they are reported.
  const health = await checkJellyfin({ JELLYFIN_URL: "http://nas:8096" }, async () =>
    jsonResponse(JSON.stringify({ ServerName: "x".repeat(3000), Version: "v".repeat(300) }))
  );
  assert.equal(health.state, "reachable");
  assert.equal(health.serverName?.length, 100);
  assert.equal(health.version?.length, 50);
});

test("bodies beyond the 4KB read bound still count as reachable", async () => {
  const health = await checkJellyfin({ JELLYFIN_URL: "http://nas:8096" }, async () =>
    jsonResponse(JSON.stringify({ ServerName: "y".repeat(8000) }))
  );
  assert.equal(health.state, "reachable");
  assert.match(health.detail ?? "", /non-JSON/);
});
