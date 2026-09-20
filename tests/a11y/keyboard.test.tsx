/**
 * RH-0014 — keyboard and focus coverage for ReelHouse UI surfaces.
 *
 * Guards tab order, keyboard operability of search/profile/dialog surfaces,
 * the details-modal focus trap, and focus restoration on close.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { demoItems, renderApp, searchHandler } from "./helpers";

type UserEvent = ReturnType<typeof userEvent.setup>;

async function focusPath(user: UserEvent, steps: number) {
  const visited: (HTMLElement | null)[] = [];
  for (let i = 0; i < steps; i++) {
    await user.tab();
    visited.push(document.activeElement as HTMLElement | null);
  }
  return visited;
}

describe("tab order", () => {
  it("offers the skip link first, then topbar controls in DOM order", async () => {
    const user = userEvent.setup();
    renderApp();
    const path = await focusPath(user, 7);
    const names = path.map((el) => (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim());
    expect(names[0]).toBe("Skip to content");
    expect(names.slice(1, 5)).toEqual(["Home", "Movies", "Shows", "Home Videos"]);
    expect(names[5]).toBe("Open search");
    expect(names[6]).toContain("V’Ali");
  });

  it("keeps every focusable element visibly focusable via a global focus-visible ring", () => {
    renderApp();
    // The ring itself is CSS; the regression hooks are in motion/responsive
    // style contracts. Here we assert no component opts out of the outline.
    const styled = document.querySelectorAll<HTMLElement>("[style]");
    for (const el of styled) {
      expect(el.getAttribute("style")?.toLowerCase()).not.toContain("outline");
    }
  });
});

describe("search surface", () => {
  it("opens with focus in the input, Escape clears then closes, focus returns to the toggle", async () => {
    const user = userEvent.setup();
    renderApp(searchHandler(demoItems.slice(0, 3)));
    const toggle = screen.getByRole("button", { name: "Open search" });
    await user.click(toggle);
    const input = screen.getByRole("textbox", { name: "Search movies, shows, home videos" });
    expect(input).toHaveFocus();

    await user.type(input, "the");
    await waitFor(() => expect(screen.getByText("3 matches")).toBeInTheDocument(), { timeout: 2500 });

    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("returns from the search view to the library view when the query is emptied", async () => {
    const user = userEvent.setup();
    renderApp(searchHandler(demoItems.slice(0, 3)));
    await user.click(screen.getByRole("button", { name: "Open search" }));
    const input = screen.getByRole("textbox");
    await user.type(input, "the");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Search results" })).toBeInTheDocument(), { timeout: 2500 });
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Northern Lights" })).toBeInTheDocument());
    expect(input).toHaveFocus();
  });
});

describe("profile menu", () => {
  it("switches profiles entirely from the keyboard and restores focus to the pill", async () => {
    const user = userEvent.setup();
    renderApp();
    const pill = screen.getByRole("button", { name: /V’Ali/ });
    pill.focus();
    await user.keyboard("{Enter}");
    expect(pill).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Tab}{Tab}"); // first item is the current profile
    await user.keyboard("{Enter}");
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(pill).toHaveAccessibleName(/Nicole/);
    expect(pill).toHaveFocus();
    expect(screen.getByRole("menuitemradio", { name: "Nicole" })).toHaveAttribute("aria-checked", "true");
  });

  it("closes the menu with Escape without changing the profile", async () => {
    const user = userEvent.setup();
    renderApp();
    const pill = screen.getByRole("button", { name: /V’Ali/ });
    await user.click(pill);
    await user.keyboard("{Escape}");
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(pill).toHaveFocus();
    expect(screen.getByRole("menuitemradio", { name: "V’Ali" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("details dialog focus management", () => {
  it("moves focus into the dialog on open, traps Tab, and restores focus on close", async () => {
    const user = userEvent.setup();
    renderApp();
    const card = screen.getAllByRole("button", { name: "Open The Long Weekend" })[0];
    await user.click(card);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveFocus();

    const close = within(dialog).getByRole("button", { name: "Close details" });
    await user.keyboard("{Tab}");
    expect(close).toHaveFocus();

    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(within(dialog).getByRole("button", { name: /Watchlist/ })).toHaveFocus();

    await user.keyboard("{Tab}");
    expect(close).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(card).toHaveFocus();
  });

  it("restores focus to the opener even when closed by backdrop activation", async () => {
    const user = userEvent.setup();
    renderApp();
    const card = screen.getAllByRole("button", { name: "Open Northern Lights" })[0];
    await user.click(card);
    const dialog = screen.getByRole("dialog");
    await user.pointer({ keys: "[MouseLeft]", target: dialog }); // mousedown on the shell itself
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(card).toHaveFocus();
  });
});
