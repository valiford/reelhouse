/**
 * Responsive poster/backdrop sizing, resolved client-side against the
 * household Jellyfin host's own resize API. Posters keep loading straight
 * from Jellyfin (never through the Next image optimizer): Jellyfin already
 * resizes and caches per `maxWidth`, and proxying art bytes through the
 * app server would spend NAS CPU on a second resizer while blurring the
 * media-authority boundary (browsers fetch media from Jellyfin directly).
 */

/** Poster candidates, px. Covers the largest layout slot (380 CSS px) at DPR 2. */
export const POSTER_WIDTHS = [240, 360, 480, 720, 960] as const;

/** Backdrop candidates, px. Hero is full-bleed, so the ladder runs to 1920. */
export const BACKDROP_WIDTHS = [640, 960, 1280, 1600, 1920] as const;

/**
 * Slot width a poster is laid out into, for the `sizes` attribute. Mirrors
 * the widest poster slot per breakpoint (media-row / poster-grid clamps);
 * narrower slots only make the browser pick a smaller candidate.
 */
export const POSTER_SIZES = "(min-width: 1800px) 400px, (min-width: 1400px) 320px, (min-width: 900px) 260px, 48vw";

/**
 * Rewrites the `maxWidth` parameter of a Jellyfin image URL to `width`.
 * Byte-preserving — only the maxWidth value is swapped, so every other
 * parameter keeps its exact original encoding (a full URL round-trip would
 * re-encode e.g. %20 as +). Returns null for URLs outside the Jellyfin
 * image API, without a numeric maxWidth, or with a non-positive/non-integer
 * target, so callers fall back to the original src.
 */
export function resizedImageUrl(url: string, width: number): string | null {
  if (!/\/Items\/[^/?]+\/Images\//.test(url)) return null;
  if (!Number.isInteger(width) || width <= 0) return null;
  if (!/(?:[?&])maxWidth=\d+/.test(url)) return null;
  return url.replace(/([?&])maxWidth=\d+/, `$1maxWidth=${width}`);
}

/**
 * Builds `srcSet`/`sizes` for an image URL across `widths`. The URL itself
 * stays the smallest-candidate `src` — the fallback browsers use when they
 * don't support srcSet. Widths must be strictly ascending; noise (duplicates,
 * non-positive entries) yields no candidates rather than a broken attribute.
 */
export function responsiveImage(
  url: string,
  widths: readonly number[]
): { srcSet: string; src: string } | { srcSet: null; src: string } {
  const candidates = widths
    .filter((width, index) => width > 0 && (index === 0 || width > widths[index - 1]))
    .map((width) => ({ width, url: resizedImageUrl(url, width) }))
    .filter((candidate): candidate is { width: number; url: string } => candidate.url !== null);
  if (!candidates.length) return { srcSet: null, src: url };
  return {
    srcSet: candidates.map((candidate) => `${candidate.url} ${candidate.width}w`).join(", "),
    src: url
  };
}
