import { describe, expect, it } from "vitest";
import {
  BACKDROP_WIDTHS,
  POSTER_SIZES,
  POSTER_WIDTHS,
  resizedImageUrl,
  responsiveImage
} from "./poster-image";

const JELLYFIN_POSTER = "https://jf.example/Items/abc123/Images/Primary?maxWidth=600&quality=90&tag=tm%20v2";
const JELLYFIN_BACKDROP = "https://jf.example/Items/abc123/Images/Backdrop?maxWidth=1600&quality=90&tag=tm%20v2";

function srcSetWidths(srcSet: string): number[] {
  return srcSet.split(", ").map((entry) => {
    const [url, descriptor] = entry.split(" ");
    expect(descriptor).toMatch(/^\d+w$/);
    expect(url).toContain(`maxWidth=${descriptor?.replace("w", "")}`);
    return Number(descriptor?.replace("w", ""));
  });
}

describe("resizedImageUrl", () => {
  it("rewrites maxWidth while preserving the other parameters", () => {
    expect(resizedImageUrl(JELLYFIN_POSTER, 480)).toBe(
      "https://jf.example/Items/abc123/Images/Primary?maxWidth=480&quality=90&tag=tm%20v2"
    );
  });

  it("rejects URLs outside the Jellyfin image API", () => {
    expect(resizedImageUrl("https://picsum.photos/seed/x/600/900", 240)).toBeNull();
    expect(resizedImageUrl("https://jf.example/Items/abc123?maxWidth=600", 240)).toBeNull();
  });

  it("rejects Jellyfin image URLs without a maxWidth parameter", () => {
    expect(resizedImageUrl("https://jf.example/Items/abc123/Images/Primary?tag=abc", 240)).toBeNull();
  });

  it("rejects widths that cannot describe a resize", () => {
    expect(resizedImageUrl(JELLYFIN_POSTER, 0)).toBeNull();
    expect(resizedImageUrl(JELLYFIN_POSTER, -240)).toBeNull();
    expect(resizedImageUrl(JELLYFIN_POSTER, 2.5)).toBeNull();
  });

  it("rejects malformed URLs instead of throwing", () => {
    expect(resizedImageUrl("not a url", 240)).toBeNull();
  });
});

describe("responsiveImage", () => {
  it("builds an ascending srcSet and keeps the original URL as src", () => {
    const art = responsiveImage(JELLYFIN_POSTER, POSTER_WIDTHS);
    expect(art.srcSet).not.toBeNull();
    expect(art.src).toBe(JELLYFIN_POSTER);
    const widths = srcSetWidths(art.srcSet!);
    expect(widths).toEqual([240, 360, 480, 720, 960]);
  });

  it("rewrites every candidate onto the same image identity and quality", () => {
    const art = responsiveImage(JELLYFIN_BACKDROP, BACKDROP_WIDTHS);
    for (const entry of art.srcSet!.split(", ")) {
      expect(entry.split(" ")[0]).toContain("/Items/abc123/Images/Backdrop?");
      expect(entry.split(" ")[0]).toContain("quality=90");
    }
  });

  it("falls back to src-only art when no candidate can be built", () => {
    const art = responsiveImage("https://picsum.photos/seed/x/600/900", POSTER_WIDTHS);
    expect(art.srcSet).toBeNull();
    expect(art.src).toBe("https://picsum.photos/seed/x/600/900");
  });

  it("drops duplicated or unsorted widths instead of emitting a broken descriptor", () => {
    const art = responsiveImage(JELLYFIN_POSTER, [240, 240, 120, 360]);
    expect(srcSetWidths(art.srcSet!)).toEqual([240, 360]);
  });

  it("exports an ascending, positive width ladder and a poster sizes hint", () => {
    for (const widths of [POSTER_WIDTHS, BACKDROP_WIDTHS]) {
      for (let index = 1; index < widths.length; index += 1) {
        expect(widths[index]).toBeGreaterThan(widths[index - 1]!);
      }
    }
    expect(POSTER_SIZES).toMatch(/px/);
  });
});
