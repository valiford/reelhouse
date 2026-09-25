// Hermetic unit evidence for the Jellyfin catalog source adapter (RH-0031).
//
// Uses an injected fetch (same pattern as jellyfin-health.test.ts) so the
// wire contract — URL/query shape, header-only API key, pagination bounds,
// redacted failure paths — is verified without any network access.

import test from "node:test";
import assert from "node:assert/strict";
import {
  JellyfinCatalogSource,
  readCatalogSyncEnv,
  CATALOG_SYNC_DEFAULTS
} from "./source.ts";

const KEY = "secret-jf-key-123";

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  responder: (url: string, init: RequestInit) => Response | Promise<Response> | never
): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const record = { url: String(url), init: init ?? {} };
    requests.push(record);
    return responder(record.url, record.init);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("listLibraries requests MediaFolders with the key only in headers", async () => {
  const { fetchImpl, requests } = fakeFetch(() =>
    jsonResponse({
      Items: [
        { Id: "lib-1", Name: "Movies", CollectionType: "movies" },
        { Id: "lib-2", Name: "Shows", CollectionType: "tvshows" }
      ]
    })
  );
  const source = new JellyfinCatalogSource("http://jf.local:8096/", KEY, fetchImpl);

  const libraries = await source.listLibraries();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://jf.local:8096/Library/MediaFolders");
  const headers = requests[0].init.headers as Record<string, string>;
  assert.equal(headers["X-Emby-Token"], KEY);
  assert.ok(!requests[0].url.includes(KEY), "API key must never appear in the URL");
  assert.deepEqual(libraries, [
    { jellyfinId: "lib-1", name: "Movies", collectionType: "movies" },
    { jellyfinId: "lib-2", name: "Shows", collectionType: "tvshows" }
  ]);
});

test("listLibraries tolerates a missing Items array as an empty list", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse({}));
  const source = new JellyfinCatalogSource("http://jf.local:8096", KEY, fetchImpl);
  assert.deepEqual(await source.listLibraries(), []);
});

test("a library entry without stable identity fails closed", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse({ Items: [{ Name: "Broken" }] }));
  const source = new JellyfinCatalogSource("http://jf.local:8096", KEY, fetchImpl);
  await assert.rejects(source.listLibraries(), /without a stable Id\/Name/);
});

test("fetchItemsPage sends the full bounded query contract", async () => {
  const { fetchImpl, requests } = fakeFetch(() =>
    jsonResponse({ Items: [], TotalRecordCount: 0 })
  );
  const source = new JellyfinCatalogSource("http://jf.local:8096", KEY, fetchImpl);

  const page = await source.fetchItemsPage("lib-9", 500, 250);

  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.origin, "http://jf.local:8096");
  assert.equal(url.pathname, "/Items");
  const params = url.searchParams;
  assert.equal(params.get("ParentId"), "lib-9");
  assert.equal(params.get("Recursive"), "true");
  assert.equal(params.get("IncludeItemTypes"), "Movie,Series,Season,Episode,Video");
  const fields = (params.get("Fields") ?? "").split(",");
  for (const required of ["Path", "Genres", "Studios", "People", "ProviderIds", "MediaSources"]) {
    assert.ok(fields.includes(required), `Fields must include ${required}`);
  }
  assert.equal(params.get("StartIndex"), "500");
  assert.equal(params.get("Limit"), "250");
  assert.equal(params.get("SortBy"), "SortName");
  assert.ok(!requests[0].url.includes(KEY));
  assert.deepEqual(page, { items: [], totalRecordCount: 0 });
});

test("fetchChangedItemsPage sends the per-library delta window contract", async () => {
  const { fetchImpl, requests } = fakeFetch(() =>
    jsonResponse({ Items: [{ Id: "mov-1", Name: "X", Type: "Movie", DateLastSaved: "2025-06-01T12:00:00.000Z" }], TotalRecordCount: 1 })
  );
  const source = new JellyfinCatalogSource("http://jf.local:8096", KEY, fetchImpl);

  const page = await source.fetchChangedItemsPage("lib-9", "2025-06-01T11:59:59.000Z", 100, 250);

  assert.equal(requests.length, 1);
  const params = new URL(requests[0].url).searchParams;
  assert.equal(params.get("ParentId"), "lib-9", "the delta is scoped per library");
  assert.equal(params.get("MinDateLastSaved"), "2025-06-01T11:59:59.000Z");
  assert.equal(params.get("Recursive"), "true");
  assert.equal(params.get("IncludeItemTypes"), "Movie,Series,Season,Episode,Video");
  assert.equal(params.get("SortBy"), "SortName");
  assert.equal(params.get("StartIndex"), "100");
  assert.equal(params.get("Limit"), "250");
  assert.ok(!requests[0].url.includes(KEY));
  const fields = (params.get("Fields") ?? "").split(",");
  assert.ok(fields.includes("DateLastSaved"), "delta payloads must carry the save time");
  assert.equal(page.items.length, 1);
  assert.equal(page.totalRecordCount, 1);
});

test("fetchLibraryItemIdsPage requests identity-only sweep pages", async () => {
  const { fetchImpl, requests } = fakeFetch(() =>
    jsonResponse({ Items: [{ Id: "mov-1" }, { Id: "mov-2" }], TotalRecordCount: 2 })
  );
  const source = new JellyfinCatalogSource("http://jf.local:8096", KEY, fetchImpl);

  const page = await source.fetchLibraryItemIdsPage("lib-9", 0, 500);

  assert.equal(requests.length, 1);
  const params = new URL(requests[0].url).searchParams;
  assert.equal(params.get("ParentId"), "lib-9");
  assert.equal(params.get("Fields"), "Id", "the sweep must not pull full payloads");
  assert.equal(params.get("StartIndex"), "0");
  assert.equal(params.get("Limit"), "500");
  assert.deepEqual(page.items, [{ Id: "mov-1" }, { Id: "mov-2" }]);
});

test("non-OK API responses raise status errors that never echo the key", async () => {
  for (const status of [401, 403, 500]) {
    const { fetchImpl } = fakeFetch(
      () => new Response(JSON.stringify({}), { status })
    );
    const source = new JellyfinCatalogSource("http://jf.local:8096", KEY, fetchImpl);
    await assert.rejects(
      async () => {
        await source.listLibraries();
      },
      (error: Error) => {
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.ok(!error.message.includes(KEY));
        assert.ok(!error.message.includes("jf.local"), "URL must not be echoed");
        return true;
      }
    );
  }
});

test("transport failures are scrubbed of the server URL and key", async () => {
  const { fetchImpl } = fakeFetch(() => {
    throw new Error("fetch failed http://jf.local:8096/Library/MediaFolders with key " + KEY);
  });
  const source = new JellyfinCatalogSource("http://jf.local:8096", KEY, fetchImpl);
  await assert.rejects(
    async () => {
      await source.listLibraries();
    },
    (error: Error) => {
      assert.ok(!error.message.includes(KEY));
      assert.ok(!error.message.includes("jf.local"));
      assert.match(error.message, /Jellyfin API request failed/);
      return true;
    }
  );
});

test("a non-JSON success body is an unreadable-body error, not a crash", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("<html>hello</html>", { status: 200 }));
  const source = new JellyfinCatalogSource("http://jf.local:8096", KEY, fetchImpl);
  await assert.rejects(source.listLibraries(), /unreadable body/);
});

test("readCatalogSyncEnv validates tuning fail-closed", () => {
  // Defaults when unset.
  assert.deepEqual(readCatalogSyncEnv({}), {
    timeoutMs: CATALOG_SYNC_DEFAULTS.timeoutMs,
    pageSize: CATALOG_SYNC_DEFAULTS.pageSize
  });

  // Bounds are honored.
  assert.deepEqual(readCatalogSyncEnv({ CATALOG_SYNC_HTTP_TIMEOUT_MS: "1000", CATALOG_SYNC_BATCH_SIZE: "50" }), {
    timeoutMs: 1000,
    pageSize: 50
  });

  // Out-of-range and non-numeric values fail closed with a named variable.
  assert.throws(() => readCatalogSyncEnv({ CATALOG_SYNC_HTTP_TIMEOUT_MS: "999" }), /CATALOG_SYNC_HTTP_TIMEOUT_MS/);
  assert.throws(() => readCatalogSyncEnv({ CATALOG_SYNC_BATCH_SIZE: "1001" }), /CATALOG_SYNC_BATCH_SIZE/);
  assert.throws(() => readCatalogSyncEnv({ CATALOG_SYNC_BATCH_SIZE: "soon" }), /CATALOG_SYNC_BATCH_SIZE/);
});
