import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReelHouseApp from "./ReelHouseApp";
import { demoLibrary } from "@/lib/demo";

function rect(el: Element, x: number, y: number, w = 200, h = 300) {
  el.setAttribute("data-rect", `${x},${y},${w},${h}`);
}

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/search")) {
    const q = decodeURIComponent(url.split("q=")[1] || "").toLowerCase();
    const items = demoLibrary.sections
      .flatMap((s) => s.items)
      .filter((item, i, all) => all.findIndex((y) => y.id === item.id) === i)
      .filter((item) => item.title.toLowerCase().includes(q));
    return jsonResponse({ items });
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

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-kbd-nav");
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
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    const input = screen.getByRole("textbox");
    expect(document.activeElement).toBe(input);
    rect(input, 400, 80, 800, 50);

    fireEvent.change(input, { target: { value: "northern" } });
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
