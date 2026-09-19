/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  const abortError = () => new DOMException("The operation was aborted.", "AbortError");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        const call: DeferredCall = {
          url: String(input),
          signal: signal as AbortSignal,
          resolve,
          reject
        };
        calls.push(call);
        // Match real fetch: an aborted signal rejects the pending request.
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        signal?.addEventListener("abort", () => reject(abortError()), { once: true });
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
  await user.click(screen.getByRole("button", { name: "Search" }));
  await user.type(screen.getByPlaceholderText(/Search movies, shows/i), term);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

describe("ReelHouseApp engine connection lifecycle", () => {
  function libraryCalls(calls: DeferredCall[]): DeferredCall[] {
    return calls.filter((call) => call.url.includes("/api/library"));
  }

  it("degrades to an explicit unavailable state, auto-reconnects, and acknowledges recovery", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    libraryCall(calls)!.reject(new Error("connect ECONNREFUSED"));
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Couldn’t reach the ReelHouse API");
    expect(banner.textContent).toContain("connect ECONNREFUSED");
    expect(await screen.findByText(/ReelHouse Engine unreachable — demo titles shown/)).toBeTruthy();
    expect(screen.getByText(/reconnecting \(attempt 1\)/)).toBeTruthy();

    // First automatic retry fires at the bottom of the backoff ladder.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(libraryCalls(calls)).toHaveLength(2);
    libraryCalls(calls)[1].resolve(jsonResponse({ ...LIBRARY, source: "jellyfin" }));
    expect(await screen.findByText("Reconnected to ReelHouse Engine")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    // The recovery acknowledgment is transient.
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(screen.getByText("● Connected to ReelHouse Engine")).toBeTruthy();
  });

  it("keeps the last engine data as stale when a health refresh fails, then recovers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    libraryCall(calls)!.resolve(jsonResponse({ ...LIBRARY, source: "jellyfin" }));
    expect(await screen.findByText("● Connected to ReelHouse Engine")).toBeTruthy();

    // Quiet health refresh (60s while healthy) fails while engine data is
    // on screen: the data stays, explicitly marked stale.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(libraryCalls(calls)).toHaveLength(2);
    libraryCalls(calls)[1].reject(new Error("connect ECONNREFUSED"));
    expect(await screen.findByText(/Connection lost — showing last synced titles/)).toBeTruthy();
    expect(screen.getByText(/reconnecting \(attempt 1\)/)).toBeTruthy();
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("Lost connection to the ReelHouse API");
    expect(banner.className).toContain("stale");
    expect(screen.getByText("Lib Movie")).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    libraryCalls(calls)[2].resolve(jsonResponse({ ...LIBRARY, source: "jellyfin" }));
    expect(await screen.findByText("Reconnected to ReelHouse Engine")).toBeTruthy();
  });

  it("treats a degraded engine payload as unavailable and surfaces the server reason", async () => {
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    libraryCall(calls)!.resolve(jsonResponse({
      ...LIBRARY,
      source: "demo",
      degraded: true,
      degradedReason: "Jellyfin 503",
      sections: []
    }));
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Couldn’t reach the ReelHouse API");
    expect(banner.textContent).toContain("(Jellyfin 503)");
    expect(await screen.findByText(/ReelHouse Engine unreachable — demo titles shown/)).toBeTruthy();
  });

  it("degrades a slow engine into an explicit timeout with a reconnect attempt", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(libraryCall(calls)!.signal.aborted).toBe(true);
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Media engine timed out after 12s.");
    expect(screen.getByText(/reconnecting \(attempt 1\)/)).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    libraryCalls(calls)[1].resolve(jsonResponse({ ...LIBRARY, source: "jellyfin" }));
    expect(await screen.findByText("Reconnected to ReelHouse Engine")).toBeTruthy();
  });

  it("surfaces malformed library payloads explicitly", async () => {
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    libraryCall(calls)!.resolve(jsonResponse({ unexpected: true }));
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Library returned malformed data.");
  });

  it("surfaces malformed search payloads explicitly", async () => {
    const user = userEvent.setup();
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    await openSearchAndType(user, "northern");
    await waitFor(() => expect(searchCalls(calls)).toHaveLength(1));
    searchCalls(calls)[0].resolve(jsonResponse({ unexpected: true }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Search returned malformed data.");
  });

  it("times out a slow search with an explicit message", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    // Settle the library first so its own timeout cannot join the alert set.
    libraryCall(calls)!.resolve(jsonResponse(LIBRARY));
    expect(await screen.findByText("Lib Movie")).toBeTruthy();

    await openSearchAndType(user, "northern");
    await act(async () => { await vi.advanceTimersByTimeAsync(220); });
    await waitFor(() => expect(searchCalls(calls)).toHaveLength(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(searchCalls(calls)[0].signal.aborted).toBe(true);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Search timed out after 12s");
  });
});

describe("ReelHouseApp presentation fallbacks", () => {
  it("shows a connecting state until the library fetch settles", async () => {
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    expect(await screen.findByText(/Connecting to ReelHouse Engine/)).toBeTruthy();

    libraryCall(calls)!.resolve(jsonResponse({ ...LIBRARY, source: "jellyfin" }));
    expect(await screen.findByText("● Connected to ReelHouse Engine")).toBeTruthy();
  });

  it("falls back to the title initial when poster art fails to load", async () => {
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    libraryCall(calls)!.resolve(jsonResponse({
      ...LIBRARY,
      sections: [{ title: "Movies", items: [{ id: "art-1", title: "Broken Art", kind: "Movie", imageUrl: "https://images.example/broken.jpg" }] }]
    }));
    const card = await screen.findByRole("button", { name: "Open Broken Art" });
    const img = card.querySelector("img.poster-img");
    expect(img).toBeTruthy();
    expect(img!.getAttribute("loading")).toBe("lazy");

    fireEvent.error(img!);
    expect(within(card).getByText("B")).toBeTruthy();
    expect(card.querySelector("img.poster-img")).toBeNull();
  });

  it("explains an empty connected library instead of a blank rail", async () => {
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    libraryCall(calls)!.resolve(jsonResponse({ ...LIBRARY, source: "jellyfin", sections: [] }));
    expect(await screen.findByText(/nothing is indexed yet/)).toBeTruthy();
  });

  it("renders a crossfading hero backdrop once the engine supplies one", async () => {
    const calls = installDeferredFetch();
    render(<ReelHouseApp />);

    libraryCall(calls)!.resolve(jsonResponse({
      ...LIBRARY,
      hero: { id: "h1", title: "Hero Title", kind: "Movie", backdropUrl: "https://images.example/hero.jpg" }
    }));
    await screen.findByText("Hero Title");
    expect(document.querySelector(".hero-bg")).toBeTruthy();
  });
});
