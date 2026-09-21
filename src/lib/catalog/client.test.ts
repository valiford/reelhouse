// Hermetic unit tests for the HTTP Jellyfin catalog client (fake fetch — no
// network, and the API key must never appear in a URL).

import test from "node:test";
import assert from "node:assert/strict";
import { createHttpJellyfinClient, JellyfinSyncError } from "./jellyfin-client.ts";
import type { JellyfinSyncConfig } from "./config.ts";

function config(overrides: Partial<JellyfinSyncConfig> = {}): JellyfinSyncConfig {
  return { baseUrl: "http://jellyfin.lan:8096", apiKey: "secret-key", requestTimeoutMs: 5_000, ...overrides };
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("listLibraries hits the media folders endpoint with the key in a header only", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const client = createHttpJellyfinClient(config(), async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
    return okJson({ Items: [{ Id: "lib1", Name: "Movies" }] });
  });
  const libraries = await client.listLibraries();
  assert.equal(libraries.length, 1);
  assert.equal(libraries[0].Id, "lib1");
  assert.ok(capturedUrl.startsWith("http://jellyfin.lan:8096/Library/MediaFolders"));
  assert.equal(capturedHeaders["x-emby-token"], "secret-key");
  assert.ok(!capturedUrl.includes("secret-key"), "API key leaked into the URL");
});

test("listItemPage bounds the page and passes incremental cursors", async () => {
  const calls: Array<Record<string, string>> = [];
  const client = createHttpJellyfinClient(config(), async (url) => {
    const parsed = new URL(String(url));
    const params: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    calls.push(params);
    return okJson({ Items: [], TotalRecordCount: 0 });
  });

  await client.listItemPage("lib9", {
    startIndex: 500,
    limit: 100,
    includeTypes: ["Series", "Movie"],
    updatedSince: "2026-09-21T00:00:00Z"
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ParentId, "lib9");
  assert.equal(calls[0].Recursive, "true");
  assert.equal(calls[0].IncludeItemTypes, "Series,Movie");
  assert.equal(calls[0].StartIndex, "500");
  assert.equal(calls[0].Limit, "100");
  assert.equal(calls[0].MinDateLastSaved, "2026-09-21T00:00:00Z");
  assert.ok(calls[0].Fields.includes("ProviderIds"));
  assert.ok(!String(calls[0]).includes("secret-key"));

  await client.listItemPage("lib9", { startIndex: 0, limit: 100, includeTypes: ["Movie"] });
  assert.equal(calls[1].MinDateLastSaved, undefined);
});

test("http errors surface as JellyfinSyncError with the status and no key", async () => {
  const client = createHttpJellyfinClient(config(), async () => new Response("nope", { status: 503 }));
  await assert.rejects(client.listLibraries(), (error: unknown) => {
    assert.ok(error instanceof JellyfinSyncError);
    assert.equal(error.status, 503);
    assert.match(error.message, /503/);
    assert.ok(!error.message.includes("secret-key"));
    return true;
  });
});

test("timeouts abort the request and are reported in ReelHouse terms", async () => {
  const client = createHttpJellyfinClient(config({ requestTimeoutMs: 20 }), async (_url, init) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("This operation was aborted", "AbortError"))
      );
    });
  });
  await assert.rejects(client.listLibraries(), (error: unknown) => {
    assert.ok(error instanceof JellyfinSyncError);
    assert.match(error.message, /timed out after 20 ms/);
    return true;
  });
});

test("network failures carry the path but never the key", async () => {
  const client = createHttpJellyfinClient(config(), async () => {
    throw new Error("connect ECONNREFUSED");
  });
  await assert.rejects(client.listLibraries(), (error: unknown) => {
    assert.ok(error instanceof JellyfinSyncError);
    assert.match(error.message, /ECONNREFUSED/);
    assert.match(error.message, /\/Library\/MediaFolders/);
    assert.ok(!error.message.includes("secret-key"));
    return true;
  });
});
