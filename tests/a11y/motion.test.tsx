/**
 * RH-0014 — reduced-motion coverage.
 *
 * Two complementary guards:
 * 1. The stylesheet contract: a `prefers-reduced-motion: reduce` block must
 *    neutralize transitions/animations and the card lift, which is where
 *    ReelHouse's motion lives today.
 * 2. A DOM scan: no component may introduce inline transitions/animations
 *    that would silently bypass the media query.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { demoItems, renderApp, searchHandler } from "./helpers";

const css = readFileSync(path.resolve(__dirname, "../../src/app/globals.css"), "utf8");

function atRuleBlock(stylesheet: string, signature: RegExp): string {
  const start = stylesheet.search(signature);
  if (start === -1) return "";
  const open = stylesheet.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (; end < stylesheet.length; end++) {
    if (stylesheet[end] === "{") depth++;
    else if (stylesheet[end] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return stylesheet.slice(open + 1, end);
}

describe("reduced-motion stylesheet contract", () => {
  const block = atRuleBlock(css, /@media \(prefers-reduced-motion: reduce\)/);

  it("defines a prefers-reduced-motion block", () => {
    expect(block).not.toBe("");
  });

  it("neutralizes transitions and animations inside that block", () => {
    expect(block).toContain("transition-duration: 0.01ms");
    expect(block).toContain("animation-duration: 0.01ms");
    expect(block).toContain("animation-iteration-count: 1");
    expect(block).toContain("scroll-behavior: auto");
  });

  it("removes the media-card lift that motion users would otherwise feel", () => {
    expect(block).toContain(".media-card:hover, .media-card:focus-visible { transform: none; }");
  });
});

describe("no JS-driven motion escapes the media query", () => {
  it("renders no inline transitions or animations in any interactive state", async () => {
    const user = userEvent.setup();
    const { container } = renderApp(searchHandler(demoItems.slice(0, 3)));
    await waitFor(() => expect(screen.getByText(/Demo library|Connected to/)).toBeInTheDocument());

    const offenders = () =>
      Array.from(container.querySelectorAll<HTMLElement>("[style]"))
        .map((el) => el.getAttribute("style") ?? "")
        .filter((style) => /transition|animation/i.test(style));

    expect(offenders()).toEqual([]);

    // search results state
    await user.click(screen.getByRole("button", { name: "Open search" }));
    await user.type(screen.getByRole("textbox"), "the");
    await waitFor(() => expect(screen.getByText("3 matches")).toBeInTheDocument(), { timeout: 2500 });
    expect(offenders()).toEqual([]);

    // details dialog state, opened from a search result
    const card = container.querySelectorAll<HTMLButtonElement>(".media-card")[0];
    await user.click(card);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(offenders()).toEqual([]);
  });
});
