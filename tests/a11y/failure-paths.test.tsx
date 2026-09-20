/**
 * RH-0014 — failure-path coverage for ReelHouse UI surfaces.
 *
 * The UI must degrade gracefully when the ReelHouse API is unreachable or
 * returns garbage: demo content stays up, search reports zero matches, and
 * nothing crashes. Identity failure (no Jellyfin link for an item) must
 * fail closed to a disabled control.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultHandler, demoItems, jsonInvalid, networkFail, renderApp, searchHandler } from "./helpers";

describe("library fetch failure", () => {
  it("keeps the demo library up when /api/library is unreachable", async () => {
    renderApp((url) => (url.includes("/api/library") ? networkFail() : defaultHandler(url)));
    expect(screen.getByRole("heading", { level: 1, name: "Northern Lights" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Demo library/)).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: /^Open / }).length).toBeGreaterThanOrEqual(20);
  });

  it("keeps the demo library up when /api/library returns non-JSON", async () => {
    renderApp((url) => (url.includes("/api/library") ? jsonInvalid() : defaultHandler(url)));
    await waitFor(() => expect(screen.getByText(/Demo library/)).toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 1, name: "Northern Lights" })).toBeInTheDocument();
  });

  it("surfaces a Jellyfin payload that omits sections without crashing", async () => {
    renderApp((url) =>
      url.includes("/api/library")
        ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ source: "jellyfin", hero: demoItems[1], sections: [] }) })
        : defaultHandler(url)
    );
    await waitFor(() => expect(screen.getByText(/Connected to ReelHouse Engine/)).toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 1, name: "Northern Lights" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Movies" })).not.toBeInTheDocument();
  });
});

describe("search fetch failure", () => {
  it("reports zero matches when /api/search is unreachable", async () => {
    const user = userEvent.setup();
    renderApp((url) => (url.includes("/api/search") ? networkFail() : defaultHandler(url)));
    await user.click(screen.getByRole("button", { name: "Open search" }));
    await user.type(screen.getByRole("textbox"), "the");
    await waitFor(() => expect(screen.getByText("0 matches")).toBeInTheDocument(), { timeout: 2500 });
    expect(screen.getByRole("heading", { name: "Search results" })).toBeInTheDocument();
  });

  it("treats a null items array as zero matches", async () => {
    const user = userEvent.setup();
    renderApp((url) => (url.includes("/api/search") ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: null }) }) : defaultHandler(url)));
    await user.click(screen.getByRole("button", { name: "Open search" }));
    await user.type(screen.getByRole("textbox"), "the");
    await waitFor(() => expect(screen.getByText("0 matches")).toBeInTheDocument(), { timeout: 2500 });
  });

  it("renders returned cards that still open a working dialog", async () => {
    const user = userEvent.setup();
    const { container } = renderApp(searchHandler(demoItems.slice(0, 2)));
    await user.click(screen.getByRole("button", { name: "Open search" }));
    await user.type(screen.getByRole("textbox"), "the");
    await waitFor(() => expect(container.querySelectorAll(".media-card").length).toBe(2), { timeout: 2500 });
    await user.click(container.querySelector<HTMLButtonElement>(".media-card")!);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });
});
