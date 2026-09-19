// Unit tests for the HTTP Jellyfin catalog client: parameter building, auth
// header placement, and key-free bounded errors. Uses a stubbed fetch so no
// network is involved.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHttpJellyfinClient, JellyfinSyncError } from "./jellyfin-client.ts";
import type { JellyfinSyncConfig } from "./config.ts";

const CONFIG: JellyfinSyncConfig = {
  baseUrl: "http://jf.lan:8096",
  apiKey: "sekrit-key",
  requestTimeoutMs: 30_000
};

function stubFetch(respond: (url: URL, headers: Record<string, string>) => unknown | Promise<unknown>) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const impl = (async (input: string | URL, init?: { headers?: Record<string, string> }) => {
    const url = new URL(String(input));
    const headers = init?.headers ?? {};
    calls.push({ url, headers });
    const body = await respond(url, headers);
    return { ok: true, status: 200, statusText: "OK", json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("listLibraries hits /Library/MediaFolders with the key in the header, never the URL", async () => {
  const { impl, calls } = stubFetch(() => ({ Items: [{ Id: "lib-1", Name: "Movies" }] }));
  const client = createHttpJellyfinClient(CONFIG, impl);
  const libraries = await client.listLibraries();
  assert.deepEqual(libraries, [{ Id: "lib-1", Name: "Movies" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["X-Emby-Token"], "sekrit-key");
  assert.equal(calls[0].url.pathname, "/Library/MediaFolders");
  assert.ok(!calls[0].url.toString().includes("sekrit-key"));
});

test("listItemPage passes pagination, kind filter, and the incremental cursor", async () => {
  const { impl, calls } = stubFetch(() => ({ Items: [{ Id: "i-1", Type: "Movie" }], TotalRecordCount: 1 }));
  const client = createHttpJellyfinClient(CONFIG, impl);
  const page = await client.listItemPage("lib-1", {
    startIndex: 500,
    limit: 500,
    includeTypes: ["Series", "Movie"],
    updatedSince: "2026-09-19T12:00:00.000Z"
  });
  assert.equal(page.items.length, 1);
  assert.equal(page.totalRecorded, 1);
  const params = calls[0].url.searchParams;
  assert.equal(params.get("ParentId"), "lib-1");
  assert.equal(params.get("Recursive"), "true");
  assert.equal(params.get("IncludeItemTypes"), "Series,Movie");
  assert.equal(params.get("StartIndex"), "500");
  assert.equal(params.get("Limit"), "500");
  assert.equal(params.get("MinDateLastSaved"), "2026-09-19T12:00:00.000Z");
  assert.ok(params.get("Fields")!.includes("ProviderIds"));
  assert.equal(params.get("SortBy"), "SortName");
  assert.ok(!calls[0].url.toString().includes("sekrit-key"));
});

test("HTTP error statuses raise key-free, path-bearing errors", async () => {
  const failing = (async () =>
    ({ ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
  const client = createHttpJellyfinClient(CONFIG, failing);
  await assert.rejects(client.listLibraries(), (error: unknown) => {
    assert.ok(error instanceof JellyfinSyncError);
    assert.match(error.message, /503 Service Unavailable/);
    assert.match(error.message, /\/Library\/MediaFolders/);
    assert.ok(!error.message.includes("sekrit-key"));
    assert.equal(error.status, 503);
    return true;
  });
});

test("network failures raise key-free errors that name the endpoint", async () => {
  const rejecting = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:1");
  }) as unknown as typeof fetch;
  const client = createHttpJellyfinClient(CONFIG, rejecting);
  await assert.rejects(client.listItemPage("lib-1", { startIndex: 0, limit: 10, includeTypes: ["Movie"] }), (error: unknown) => {
    assert.ok(error instanceof JellyfinSyncError);
    assert.match(error.message, /ECONNREFUSED/);
    assert.match(error.message, /\/Items/);
    assert.ok(!error.message.includes("sekrit-key"));
    return true;
  });
});
