/**
 * RH-0014 — responsive interaction coverage.
 *
 * jsdom has no layout engine, so viewport behavior is guarded as a
 * stylesheet contract: the exact rules that produce ReelHouse's responsive
 * behavior (breakpoints, reflow, bounded scrolling, visible keyboard focus)
 * must stay present. If a rule moves or is renamed, this file is the place
 * to update deliberately alongside it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

describe("compact-viewport breakpoint (max-width: 850px)", () => {
  const block = atRuleBlock(css, /@media \(max-width: 850px\)/);

  it("exists", () => {
    expect(block).not.toBe("");
  });

  it("collapses the primary nav and condenses the topbar", () => {
    expect(block).toContain(".nav-links { display: none; }");
    expect(block).toContain(".topbar { height: 64px; }");
  });

  it("enlarges rail cards for touch/ten-foot interaction", () => {
    expect(block).toMatch(/\.media-row \{ grid-auto-columns: clamp\(/);
  });

  it("keeps the hero readable with truncated overview", () => {
    expect(block).toContain(".hero { min-height: 72vh; }");
    expect(block).toMatch(/-webkit-line-clamp: 3/);
  });
});

describe("wide-viewport breakpoint (min-width: 1200px)", () => {
  const block = atRuleBlock(css, /@media \(min-width: 1200px\)/);

  it("keeps the poster focus/hover affordance at ten-foot distances", () => {
    expect(block).toContain(".media-card:focus-visible .poster");
  });
});

describe("fluid layout contracts", () => {
  it("gutters scale with the viewport via clamp()", () => {
    expect(css).toMatch(/\.page-gutter \{ padding-left: clamp\([^;]+\); padding-right: clamp\([^;]+\); \}/);
  });

  it("poster grid wraps instead of overflowing horizontally", () => {
    expect(css).toMatch(/\.poster-grid \{[^}]*repeat\(auto-fill, minmax\(160px, 1fr\)\)/);
  });

  it("media rails scroll within their own box", () => {
    expect(css).toMatch(/\.media-row \{[^}]*overflow-x: auto/);
    expect(css).toMatch(/\.media-row \{[^}]*overscroll-behavior-inline: contain/);
  });

  it("hero and headings use fluid type", () => {
    expect(css).toMatch(/h1 \{ font-size: clamp\(/);
    expect(css).toMatch(/\.section-heading h2 \{[^}]*font-size: clamp\(/);
  });
});

describe("keyboard focus visibility contract", () => {
  it("keeps a global :focus-visible ring and a skip link in the stylesheet", () => {
    expect(css).toMatch(/:focus-visible \{ outline: 2px solid var\(--gold-bright\); outline-offset: 2px; \}/);
    expect(css).toMatch(/\.skip-link:focus-visible \{ top: 12px; \}/);
    expect(css).not.toMatch(/outline:\s*(none|0)\b/);
  });

  it("keeps the profile menu driven by component state, not hover-only", () => {
    expect(css).toContain(".profile-switcher[data-open] .profile-menu { display: grid; }");
    expect(css).not.toContain(".profile-switcher:hover .profile-menu");
  });
});
