/**
 * RH-0014 — WCAG 2.x color-contrast coverage for the ReelHouse palette.
 *
 * jsdom cannot measure rendered pixels, so the audit reads the actual
 * stylesheet, resolves every audited color (including alpha compositing of
 * translucent surfaces over their real backdrops), and asserts WCAG ratios:
 * 4.5:1 for body-size text, 3:1 for large text and non-text UI.
 *
 * Every fg/surface/over literal must also still exist verbatim in
 * globals.css — a palette change that forgets to update this table fails
 * here instead of silently shipping an unaudited combination.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath = path.resolve(__dirname, "../../src/app/globals.css");
const css = readFileSync(cssPath, "utf8");

type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(raw: string): Rgba {
  const value = raw.trim();
  const hex = value.startsWith("#") ? value.slice(1) : null;
  if (hex) {
    const expand = (s: string) => parseInt(s.length === 1 ? s + s : s, 16);
    if (hex.length === 3) return { r: expand(hex[0]), g: expand(hex[1]), b: expand(hex[2]), a: 1 };
    if (hex.length === 6) return { r: expand(hex.slice(0, 2)), g: expand(hex.slice(2, 4)), b: expand(hex.slice(4, 6)), a: 1 };
    if (hex.length === 8) return { r: expand(hex.slice(0, 2)), g: expand(hex.slice(2, 4)), b: expand(hex.slice(4, 6)), a: expand(hex.slice(6, 8)) / 255 };
  }
  const fn = value.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const parts = fn[1].split(",").map((p) => parseFloat(p.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  throw new Error(`Unsupported color literal: ${raw}`);
}

/** Alpha-composite `fg` over an opaque `bg`. */
function composite(fg: Rgba, bg: Rgba): Rgba {
  const outA = fg.a + bg.a * (1 - fg.a);
  const mix = (f: number, b: number) => Math.round((f * fg.a + b * bg.a * (1 - fg.a)) / outA);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(color: Rgba): number {
  return 0.2126 * channelLuminance(color.r) + 0.7152 * channelLuminance(color.g) + 0.0722 * channelLuminance(color.b);
}

function contrastRatio(fg: Rgba, bg: Rgba): number {
  const l1 = luminance(fg.a >= 1 ? fg : composite(fg, bg));
  const l2 = luminance(bg);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

const toHex = (n: number) => n.toString(16).padStart(2, "0");
const asCssHex = (c: Rgba) => `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`;

/** The background color actually rendered behind the text, after compositing. */
function effectiveBackground(audit: Audit): string {
  const surface = parseColor(audit.surface);
  if (surface.a >= 1) return audit.surface;
  return asCssHex(composite(surface, parseColor(audit.over ?? "#000000")));
}

const AA_TEXT = 4.5;
const AA_LARGE_OR_UI = 3;

/** page background */
const BG = "#0b0b0c";
/** lightest hero/panel gradient stop behind text — worst-case dark backdrop */
const HERO_WORST = "#171719";
/** details panel surface */
const PANEL = "#151517";
/** lightest poster gradient stop behind card copy */
const POSTER_WORST = "#34343a";
/** card copy sits under this translucent gradient scrim */
const CARD_SCRIM = "#050505dd";

type Audit = { name: string; fg: string; surface: string; over?: string; min: number };

const audits: Audit[] = [
  { name: "body text on page background", fg: "#f7f7f8", surface: BG, min: AA_TEXT },
  { name: "muted metadata token on page background", fg: "#aaaab1", surface: BG, min: AA_TEXT },
  { name: "nav links on translucent topbar", fg: "#b9b9bf", surface: "#0b0b0cf2", over: BG, min: AA_TEXT },
  { name: "source chip text on translucent chip", fg: "#bdbdc3", surface: "#18181bcc", over: BG, min: AA_TEXT },
  { name: "section heading links (See all) on background", fg: "#99999f", surface: BG, min: AA_TEXT },
  { name: "search panel gold button text on translucent panel", fg: "#ffc247", surface: "#17171bf5", over: BG, min: AA_TEXT },
  { name: "eyebrow label on hero", fg: "#ffc247", surface: HERO_WORST, min: AA_TEXT },
  { name: "hero meta line on hero", fg: "#d5d5d8", surface: HERO_WORST, min: AA_TEXT },
  { name: "hero overview on hero", fg: "#d3d3d6", surface: HERO_WORST, min: AA_TEXT },
  { name: "card copy small on scrimmed poster", fg: "#c0c0c4", surface: CARD_SCRIM, over: POSTER_WORST, min: AA_TEXT },
  { name: "card copy title on scrimmed poster", fg: "#f7f7f8", surface: CARD_SCRIM, over: POSTER_WORST, min: AA_TEXT },
  { name: "primary button label on brightest gold stop", fg: "#15100a", surface: "#ffc247", min: AA_TEXT },
  { name: "secondary button label on translucent fill", fg: "#ffffff", surface: "#ffffff18", over: BG, min: AA_TEXT },
  { name: "details copy on details panel", fg: "#ccccd0", surface: PANEL, min: AA_TEXT },
  { name: "metadata chips on details panel", fg: "#d0d0d4", surface: "#ffffff0b", over: PANEL, min: AA_TEXT },
  { name: "close button glyph on translucent disc", fg: "#f7f7f8", surface: "#0d0d0ebf", over: PANEL, min: AA_TEXT },
  { name: "focus ring gold on page background (non-text UI)", fg: "#ffc247", surface: BG, min: AA_LARGE_OR_UI },
  { name: "progress fill gold on page background (non-text UI)", fg: "#e8a317", surface: BG, min: AA_LARGE_OR_UI }
];

describe("palette contrast", () => {
  it.each(audits)("$name meets WCAG 2.x AA", (audit) => {
    const ratio = contrastRatio(parseColor(audit.fg), parseColor(effectiveBackground(audit)));
    expect(ratio, `${audit.name}: expected ≥ ${audit.min}:1, got ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(audit.min);
  });

  it("does not lose audited color literals from the stylesheet", () => {
    for (const audit of audits) {
      expect(css, `missing fg ${audit.fg}`).toContain(audit.fg);
      expect(css, `missing surface ${audit.surface}`).toContain(audit.surface);
      if (audit.over) expect(css, `missing over ${audit.over}`).toContain(audit.over);
    }
  });
});
