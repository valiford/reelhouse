/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReelHouseApp from "./ReelHouseApp";
import type { LibraryPayload, SearchPayload } from "@/lib/types";

type DeferredCall = {
  url: string;
  signal: AbortSignal;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};

function installDeferredFetch(): DeferredCall[] {
  const calls: DeferredCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        calls.push({
          url: String(input),
          signal: init?.signal as AbortSignal,
          resolve,
          reject
        });
      });
    })
  );
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function searchCalls(calls: DeferredCall[]): DeferredCall[] {
  return calls.filter((call) => call.url.includes("/api/search"));
}

function libraryCall(calls: DeferredCall[]): DeferredCall | undefined {
  return calls.find((call) => call.url.includes("/api/library"));
}

function item(index: number) {
  return { id: `result-${index}`, title: `Result ${index}`, kind: "Movie" as const };
}

const PAGE_ONE = Array.from({ length: 24 }, (_, i) => item(i));

function searchPayload(partial: Partial<SearchPayload>): SearchPayload {
  return { source: "demo", query: "q", items: [], total: 0, limit: 24, offset: 0, ...partial };
}

const LIBRARY: LibraryPayload = {
  source: "demo",
  hero: { id: "h1", title: "Hero Title", kind: "Movie" },
  sections: [{ title: "Movies", items: [{ id: "lib-1", title: "Lib Movie", kind: "Movie" }] }]
};

async function openSearchAndType(user: ReturnType<typeof userEvent.setup>, term: string) {
  await user.click(screen.getByRole("button", { name: "Toggle search" }));
  await user.type(screen.getByPlaceholderText(/Search movies, shows/i), term);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReelHouseApp search interactions", () => {
  it("renders bounded search results and total counts", async () => {
    const user = userEvent.setup();
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    await openSearchAndType(user, "northern");
    await waitFor(() => expect(searchCalls(calls)).toHaveLength(1));
    expect(searchCalls(calls)[0].url).toContain("limit=24");
    expect(searchCalls(calls)[0].url).toContain("offset=0");
    expect(searchCalls(calls)[0].url).toContain("q=northern");
    expect(screen.getByText(/Searching for/)).toBeTruthy();

    searchCalls(calls)[0].resolve(jsonResponse(searchPayload({ query: "northern", items: PAGE_ONE.slice(0, 3), total: 30 })));
    expect(await screen.findByText("Result 0")).toBeTruthy();
    expect(screen.getByText("3 of 30 matches")).toBeTruthy();
  });

  it("shows an explicit empty state instead of a blank grid", async () => {
    const user = userEvent.setup();
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    await openSearchAndType(user, "zzzz");
    await waitFor(() => expect(searchCalls(calls)).toHaveLength(1));
    searchCalls(calls)[0].resolve(jsonResponse(searchPayload({ query: "zzzz" })));
    expect(await screen.findByText(/No matches for “zzzz”/)).toBeTruthy();
  });

  it("shows an explicit error state with a working retry", async () => {
    const user = userEvent.setup();
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    await openSearchAndType(user, "northern");
    await waitFor(() => expect(searchCalls(calls)).toHaveLength(1));
    searchCalls(calls)[0].resolve(
      jsonResponse({ error: { code: "upstream_unavailable", message: "Search is temporarily unavailable." } }, 502)
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Search is temporarily unavailable.");

    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(searchCalls(calls)).toHaveLength(2));
    searchCalls(calls)[1].resolve(jsonResponse(searchPayload({ items: PAGE_ONE.slice(0, 2), total: 2 })));
    expect(await screen.findByText("Result 0")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("aborts a superseded request and ignores its stale response", async () => {
    const user = userEvent.setup();
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    await openSearchAndType(user, "a");
    await waitFor(() => expect(searchCalls(calls)).toHaveLength(1));
    await user.type(screen.getByPlaceholderText(/Search movies, shows/i), "b");
    await waitFor(() => expect(searchCalls(calls)).toHaveLength(2));

    const stale = searchCalls(calls)[0];
    const fresh = searchCalls(calls)[1];
    expect(stale.url).toContain("q=a");
    expect(fresh.url).toContain("q=ab");
    expect(stale.signal.aborted).toBe(true);

    fresh.resolve(jsonResponse(searchPayload({ query: "a b", items: [item(1)], total: 1 })));
    stale.resolve(jsonResponse(searchPayload({ query: "a", items: [item(99)], total: 1 })));
    expect(await screen.findByText("Result 1")).toBeTruthy();
    expect(screen.queryByText("Result 99")).toBeNull();
  });

  it("aborts the in-flight search when the component unmounts", async () => {
    const user = userEvent.setup();
    const calls = installDeferredFetch();
    const view = render(<ReelHouseApp />);

    await openSearchAndType(user, "northern");
    await waitFor(() => expect(searchCalls(calls)).toHaveLength(1));
    view.unmount();
    expect(searchCalls(calls)[0].signal.aborted).toBe(true);
  });

  it("loads more pages and deduplicates overlapping ids", async () => {
    const user = userEvent.setup();
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    await openSearchAndType(user, "northern");
    await waitFor(() => expect(searchCalls(calls)).toHaveLength(1));
    searchCalls(calls)[0].resolve(jsonResponse(searchPayload({ items: PAGE_ONE, total: 30 })));
    expect(await screen.findByText("Result 0")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Load more/ }));
    await waitFor(() => expect(searchCalls(calls)).toHaveLength(2));
    const second = searchCalls(calls)[1];
    expect(second.url).toContain("offset=24");
    // Overlapping window: ids 20..29, so 20..23 must dedupe against page one.
    second.resolve(
      jsonResponse(searchPayload({ items: Array.from({ length: 10 }, (_, i) => item(20 + i)), total: 30, offset: 24 }))
    );
    expect(await screen.findByText("Result 29")).toBeTruthy();
    expect(screen.getAllByText("Result 20")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull());
  });

  it("re-queries with the selected kind filter", async () => {
    const user = userEvent.setup();
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    await openSearchAndType(user, "north");
    await waitFor(() => expect(searchCalls(calls)).toHaveLength(1));
    searchCalls(calls)[0].resolve(jsonResponse(searchPayload({ items: [item(1)], total: 1 })));
    expect(await screen.findByText("Result 1")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Series" }));
    await waitFor(() => expect(searchCalls(calls)).toHaveLength(2));
    expect(searchCalls(calls)[1].url).toContain("kind=Series");
    searchCalls(calls)[1].resolve(jsonResponse(searchPayload({ query: "north" })));
    expect(await screen.findByText(/No matches for “north” in Series/)).toBeTruthy();
  });
});

describe("ReelHouseApp library surface", () => {
  it("surfaces library fetch failures with an explicit retry", async () => {
    const user = userEvent.setup();
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    libraryCall(calls)!.reject(new Error("api down"));
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Couldn’t reach the ReelHouse API");

    await user.click(within(banner).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/api/library"))).toHaveLength(2));
    calls.filter((c) => c.url.includes("/api/library"))[1].resolve(jsonResponse(LIBRARY));
    expect(await screen.findByText("Lib Movie")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("marks degraded engine fallbacks explicitly", async () => {
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    libraryCall(calls)!.resolve(jsonResponse({ ...LIBRARY, source: "demo", degraded: true, sections: [] }));
    expect(await screen.findByText(/ReelHouse Engine unreachable — demo titles shown/)).toBeTruthy();
  });

  it("renders the healthy engine chip when Jellyfin serves the library", async () => {
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    libraryCall(calls)!.resolve(jsonResponse({ ...LIBRARY, source: "jellyfin" }));
    expect(await screen.findByText("● Connected to ReelHouse Engine")).toBeTruthy();
  });
});
