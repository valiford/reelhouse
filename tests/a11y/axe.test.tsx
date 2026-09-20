/**
 * RH-0014 — automated axe audits of the three ReelHouse UI states.
 *
 * jsdom cannot measure rendered contrast or layout, so color-contrast
 * findings are contract-tested separately in contrast.test.ts. Everything
 * else axe can check (names, roles, ARIA structure, landmarks, forms) must
 * pass with zero violations in every state.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import userEvent from "@testing-library/user-event";
import { demoItems, renderApp, searchHandler } from "./helpers";

describe("axe", () => {
  it("home / library view has no violations", async () => {
    const { container } = renderApp();
    await waitFor(() => expect(screen.getByText(/Demo library|Connected to/)).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("search results view has no violations", async () => {
    const user = userEvent.setup();
    const { container } = renderApp(searchHandler(demoItems.slice(0, 5)));
    await user.click(screen.getByRole("button", { name: "Open search" }));
    await user.type(screen.getByRole("textbox"), "the");
    await waitFor(() => expect(screen.getByText("5 matches")).toBeInTheDocument(), { timeout: 2500 });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("details dialog has no violations", async () => {
    const user = userEvent.setup();
    const { container } = renderApp();
    await user.click(screen.getAllByRole("button", { name: "Open The Long Weekend" })[0]);
    const dialog = screen.getByRole("dialog");
    expect(await axe(dialog)).toHaveNoViolations();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("library view with a Jellyfin-sourced play link has no violations", async () => {
    const user = userEvent.setup();
    const jelly = { ...demoItems[0], id: "jf-1234", title: "Real Item", progress: undefined };
    renderApp(searchHandler([jelly]));
    await user.click(screen.getByRole("button", { name: "Open search" }));
    await user.type(screen.getByRole("textbox"), "real");
    const card = await waitFor(() => screen.getByRole("button", { name: "Open Real Item" }), { timeout: 2500 });
    await user.click(card);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("link", { name: /Play in ReelHouse Engine/ })).toBeInTheDocument();
    expect(await axe(dialog)).toHaveNoViolations();
  });
});
