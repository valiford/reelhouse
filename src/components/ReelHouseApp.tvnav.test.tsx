import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReelHouseApp from "./ReelHouseApp";
import { demoLibrary } from "@/lib/demo";
import type { MediaItem, SearchPayload } from "@/lib/types";

function rect(el: Element, x: number, y: number, w = 200, h = 300) {
  el.setAttribute("data-rect", `${x},${y},${w},${h}`);
}

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

function isApi(input: RequestInfo | URL, path: string) {
  const [route] = String(input).split("?");
  return route === path;
}

function queryParams(input: RequestInfo | URL) {
  const parts = String(input).split("?");
  return new URLSearchParams(parts[1] || "");
}

function searchPayload(items: MediaItem[], total = items.length): SearchPayload {
  return { source: "demo", query: "q", items, total, limit: 24, offset: 0 };
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  if (isApi(input, "/api/search")) {
    const q = (queryParams(input).get("q") || "").toLowerCase();
    const items = demoLibrary.sections
      .flatMap((s) => s.items)
      .filter((item, i, all) => all.findIndex((y) => y.id === item.id) === i)
      .filter((item) => item.title.toLowerCase().includes(q));
    return jsonResponse(searchPayload(items));
  }
  return jsonResponse(demoLibrary);
});

/** Stamps a deterministic TV-sized layout onto the rendered surfaces. */
function layoutHome() {
  const nav = screen.getByRole("navigation", { name: "Primary" });
  const navButtons = nav.querySelectorAll("button");
  navButtons.forEach((b, i) => rect(b, 200 + i * 130, 12, 120, 46));
  rect(screen.getByRole("button", { name: "Search" }), 950, 12, 42, 42);
  rect(screen.getAllByRole("button", { name: /V’Ali/ })[0], 1000, 12, 130, 42);
  rect(screen.getByRole("button", { name: "Play" }), 100, 520, 160, 46);
  rect(screen.getByRole("button", { name: /More info/i }), 270, 520, 160, 46);
  screen.getAllByRole("button", { name: /^Open / }).forEach((card, i) => {
    rect(card, 100 + (i % 4) * 220, 700 + Math.floor(i / 4) * 350);
  });
}

function press(key: string, keyCode = 0) {
  fireEvent.keyDown(document, { key, keyCode });
}

function openSearch() {
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  const input = screen.getByRole("textbox");
  rect(input, 400, 80, 800, 50);
  return input;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-kbd-nav");
  vi.restoreAllMocks();
});

describe("ReelHouseApp TV navigation", () => {
  it("starts with deterministic focus on the Home nav button", () => {
    render(<ReelHouseApp />);
    expect(document.activeElement).toBe(screen.getByRole("navigation", { name: "Primary" }).querySelector("button"));
  });

  it("moves focus spatially: down from Home, right from Play, and holds at row edges", () => {
    render(<ReelHouseApp />);
    layoutHome();

    press("ArrowDown");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Play" }));

    press("ArrowRight");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /More info/i }));

    const firstCard = screen.getAllByRole("button", { name: /^Open / })[0];
    firstCard.focus();
    press("ArrowLeft");
    expect(document.activeElement).toBe(firstCard);
  });

  it("steps down into the aligned column of the next rail", () => {
    render(<ReelHouseApp />);
    layoutHome();
    const cards = screen.getAllByRole("button", { name: /^Open / });
    cards[1].focus(); // second column of the first rail
    press("ArrowDown");
    expect(document.activeElement).toBe(cards[5]); // second column of the second rail
  });

  it("flags keyboard navigation on the document and clears it on pointer use", () => {
    render(<ReelHouseApp />);
    layoutHome();
    press("ArrowDown");
    expect(document.documentElement.getAttribute("data-kbd-nav")).toBe("true");
    fireEvent.pointerDown(document);
    expect(document.documentElement.hasAttribute("data-kbd-nav")).toBe(false);
  });

  it("opens the details modal with focus on the primary action and restores focus on Escape", () => {
    render(<ReelHouseApp />);
    layoutHome();
    const card = screen.getAllByRole("button", { name: /^Open / })[0];
    card.focus();
    fireEvent.click(card);

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-focus-scope")).not.toBeNull();
    expect(dialog.getAttribute("aria-labelledby")).toBe("details-title");
    const watchlist = screen.getByRole("button", { name: /Watchlist/ });
    expect(document.activeElement).toBe(watchlist); // demo item: Play is disabled

    press("Tab");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close details" }));
    press("Tab");
    expect(document.activeElement).toBe(watchlist); // wraps inside the modal

    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it("closes the modal via the remote Back key (webOS 461 / Tizen GoBack)", () => {
    render(<ReelHouseApp />);
    layoutHome();
    const card = screen.getAllByRole("button", { name: /^Open / })[0];
    card.focus();
    fireEvent.click(card);
    expect(screen.getByRole("dialog")).toBeTruthy();

    press("GoBack", 461);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it("navigates from the search field into results, and Back restores the search toggle", async () => {
    render(<ReelHouseApp />);
    layoutHome();
    openSearch();

    const results = await screen.findAllByRole("button", { name: "Open Northern Lights" });
    // Grid starts at the input's left edge, so the first card is the
    // horizontally aligned target below the field.
    results.forEach((card, i) => rect(card, 400 + i * 220, 200));
    const firstResult = results[0];

    press("ArrowDown");
    expect(document.activeElement).toBe(firstResult);

    press("Escape");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy(); // home surfaces return
  });

  it("commits the search with Enter: focus steps into the first result", async () => {
    render(<ReelHouseApp />);
    layoutHome();
    const input = openSearch();

    fireEvent.change(input, { target: { value: "northern" } });
    const results = await screen.findAllByRole("button", { name: "Open Northern Lights" });
    results.forEach((card, i) => rect(card, 400 + i * 220, 200));
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.activeElement).toBe(results[0]);
  });

  it("closes the profile menu on Back and returns focus to the profile pill", () => {
    render(<ReelHouseApp />);
    layoutHome();
    const pill = screen.getAllByRole("button", { name: /V’Ali/ })[0];
    fireEvent.click(pill);
    expect(pill.getAttribute("aria-expanded")).toBe("true");

    press("Escape");
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(pill);
  });
});

describe("ReelHouseApp search results resilience", () => {
  it("announces the live match count and busy state", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/search")) return pending.promise;
      return jsonResponse(demoLibrary);
    }));

    vi.useFakeTimers();
    render(<ReelHouseApp />);
    const input = openSearch();

    act(() => { fireEvent.change(input, { target: { value: "northern" } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(220); });
    expect(screen.getByText("Searching…")).toBeTruthy();

    pending.resolve(jsonResponse(searchPayload([demoLibrary.sections[0].items[1]])));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("1 matches")).toBeTruthy();
  });

  it("ignores stale responses from an abandoned query", async () => {
    const stale = deferred<Response>();
    const fresh = deferred<Response>();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (isApi(input, "/api/search")) {
        const q = queryParams(input).get("q") || "";
        calls.push(q);
        return q === "a" ? stale.promise : fresh.promise;
      }
      return jsonResponse(demoLibrary);
    }));

    vi.useFakeTimers();
    render(<ReelHouseApp />);
    const input = openSearch();

    act(() => { fireEvent.change(input, { target: { value: "a" } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(220); });
    act(() => { fireEvent.change(input, { target: { value: "ab" } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(220); });
    expect(calls).toEqual(["a", "ab"]);

    // The newer query answers first; the older, abandoned one lands last
    // and must not overwrite the results.
    fresh.resolve(jsonResponse(searchPayload([{ id: "fresh-1", title: "Fresh Result", kind: "Movie" }])));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    stale.resolve(jsonResponse(searchPayload([{ id: "stale-1", title: "Stale Result", kind: "Movie" }])));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(screen.getByRole("button", { name: "Open Fresh Result" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Stale Result" })).toBeNull();
    expect(screen.getByText("1 matches")).toBeTruthy();
  });

  it("dedupes duplicate results from the source", async () => {
    const dupe: MediaItem = { id: "dupe-1", title: "Duplicated", kind: "Movie" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (isApi(input, "/api/search")) {
        return jsonResponse(searchPayload([dupe, { ...dupe }, dupe], 1));
      }
      return jsonResponse(demoLibrary);
    }));

    render(<ReelHouseApp />);
    const input = openSearch();
    fireEvent.change(input, { target: { value: "anything" } });

    const cards = await screen.findAllByRole("button", { name: "Open Duplicated" });
    expect(cards).toHaveLength(1);
    expect(screen.getByText("1 matches")).toBeTruthy();
  });

  it("survives search failure with a bounded redacted warning and recovers on the next query", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let failing = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (isApi(input, "/api/search")) {
        if (failing) return { ok: false, status: 503, json: async () => null } as unknown as Response;
        return jsonResponse(searchPayload([{ id: "ok-1", title: "Recovered", kind: "Movie" }]));
      }
      return jsonResponse(demoLibrary);
    }));

    render(<ReelHouseApp />);
    const input = openSearch();

    fireEvent.change(input, { target: { value: "secret-query" } });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Search unavailable")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Search failed (HTTP 503).");
    // The only variable content is the status we generated ourselves —
    // the household query and URL never enter the diagnostic.
    expect(warn).toHaveBeenCalledWith("[reelhouse] search failed:", "Search failed (HTTP 503).");

    failing = false;
    fireEvent.change(input, { target: { value: "recovered" } });
    expect(await screen.findByRole("button", { name: "Open Recovered" })).toBeTruthy();
    expect(screen.getByText("1 matches")).toBeTruthy();
  });

  it("keeps the demo library when the library request fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (isApi(input, "/api/library")) return { ok: false, status: 500 } as Response;
      return jsonResponse(demoLibrary);
    }));

    render(<ReelHouseApp />);
    expect(await screen.findByText(/Demo library/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(warn).toHaveBeenCalledWith("[reelhouse] library unavailable, showing demo:", "Library failed (HTTP 500).");
  });
});
