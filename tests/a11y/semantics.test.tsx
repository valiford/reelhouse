/**
 * RH-0014 — semantic coverage for ReelHouse UI surfaces.
 *
 * Guards landmarks, heading structure, accessible names, dialog semantics,
 * menu semantics, and progress disclosure. These are the contracts the
 * keyboard and screen-reader behavior in keyboard.test.tsx relies on.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { demoItems, renderApp, searchHandler } from "./helpers";

describe("landmarks and structure", () => {
  it("exposes a main landmark, named primary nav, and one h1", () => {
    renderApp();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Northern Lights" })).toBeInTheDocument();
    for (const title of ["Continue Watching", "Recently Added", "Movies", "Home Videos"]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeInTheDocument();
    }
  });

  it("provides a skip link ahead of all other content", () => {
    renderApp();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveAttribute("href", "#reelhouse-main");
    expect(screen.getByRole("main").firstElementChild).toBe(skip);
  });

  it("marks the active nav destination with aria-current", () => {
    renderApp();
    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");
  });

  it("announces search result counts as a polite live region", async () => {
    const user = userEvent.setup();
    renderApp(searchHandler(demoItems.slice(0, 3)));
    await user.click(screen.getByRole("button", { name: "Open search" }));
    const box = screen.getByRole("search", { name: "Library search" });
    const input = within(box).getByRole("textbox");
    await user.type(input, "the");
    const status = await waitFor(() => screen.getByText(/matches/i), { timeout: 2500 });
    expect(status).toHaveAttribute("aria-live", "polite");
  });
});

describe("cards and progress", () => {
  it("gives every media card an accessible name containing its visible title", () => {
    const { container } = renderApp();
    const cards = Array.from(container.querySelectorAll<HTMLButtonElement>(".media-card"));
    expect(cards.length).toBeGreaterThanOrEqual(20);
    for (const card of cards) {
      const label = card.getAttribute("aria-label") ?? "";
      expect(label).toMatch(/^Open /);
      const title = label.replace(/^Open /, "");
      expect(card.textContent).toContain(title);
      expect(card).toHaveAttribute("aria-haspopup", "dialog");
    }
  });

  it("exposes resume progress through progressbar semantics, not color alone", () => {
    renderApp();
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(4);
    for (const bar of bars) {
      expect(bar).toHaveAccessibleName(/Progress through/);
      const now = Number(bar.getAttribute("aria-valuenow"));
      expect(now).toBeGreaterThan(0);
      expect(now).toBeLessThanOrEqual(100);
      expect(bar.getAttribute("aria-valuemax")).toBe("100");
    }
  });
});

describe("details dialog semantics", () => {
  it("labels and describes the dialog from its own content", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getAllByRole("button", { name: "Open Northern Lights" })[0]);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "reelhouse-details-title");
    expect(dialog).toHaveAttribute("aria-describedby", "reelhouse-details-overview");
    const title = within(dialog).getByRole("heading", { level: 2 });
    expect(title).toHaveAttribute("id", "reelhouse-details-title");
    expect(dialog).toHaveAccessibleName("Northern Lights");
    expect(within(dialog).getByRole("button", { name: "Close details" })).toBeInTheDocument();
  });

  it("fails closed on identity: demo items expose a disabled play affordance only", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getAllByRole("button", { name: "Open Northern Lights" })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("link", { name: /Play in ReelHouse Engine/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Demo item" })).toBeDisabled();
  });
});

describe("search and profile controls", () => {
  it("wires the search toggle, search landmark, and input together", async () => {
    const user = userEvent.setup();
    renderApp();
    const toggle = screen.getByRole("button", { name: "Open search" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "reelhouse-search-panel");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Close search");
    const panel = screen.getByRole("search", { name: "Library search" });
    expect(panel).toHaveAttribute("id", "reelhouse-search-panel");
    expect(within(panel).getByRole("textbox")).toHaveAccessibleName("Search movies, shows, home videos");
  });

  it("presents the profile switcher as a menu of checked radio items", async () => {
    const user = userEvent.setup();
    renderApp();
    const pill = screen.getByRole("button", { name: /V’Ali/ });
    expect(pill).toHaveAttribute("aria-haspopup", "menu");
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(pill).toHaveAttribute("aria-controls", "reelhouse-profile-menu");
    await user.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Switch household profile" });
    const choices = within(menu).getAllByRole("menuitemradio");
    expect(choices).toHaveLength(2);
    expect(choices[0]).toHaveAccessibleName("V’Ali");
    expect(choices[0]).toHaveAttribute("aria-checked", "true");
    expect(choices[1]).toHaveAccessibleName("Nicole");
    expect(choices[1]).toHaveAttribute("aria-checked", "false");
  });
});
