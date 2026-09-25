// Pure mapping and bounding helpers for the catalog read models (RH-0040).
//
// Deliberately free of any I/O and of `server-only` imports (the same
// discipline as db/config.ts) so the hermetic unit suite can exercise every
// rule without a database. The database-facing modules (home.ts, search.ts,
// diagnostics.ts) accept a read executor; the Next.js routes wire the real
// application pool into them, so PostgreSQL credentials never leave
// server-side code.

import type { QueryResultRow } from "pg";
import type { MediaItem, MediaKind } from "../types";

// Read models never write, so a single query surface is enough. Reads run on
// separate statements at read-committed isolation: each rail is bounded and
// self-consistent; cross-rail snapshot consistency is not a goal for a
// presentation payload. The Next.js routes wire the application pool into
// this surface through readmodels/pg (server-only); tests drive doubles.
export interface ReadExecutor {
  query<R extends QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

// Hard bounds for every read-model surface. A rail or search page may return
// fewer rows, never more, no matter what a caller asks for.
export const READ_MODEL_LIMITS = {
  searchLimit: { min: 1, max: 100, default: 40 },
  searchOffset: { min: 0, max: 10_000 },
  railItems: 24,
  continueItems: 12,
  termLength: 100
} as const;

// numeric(3,1) and bigint columns arrive as wire strings; counts likewise.
export function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function clampInt(
  raw: number | string | null | undefined,
  limits: { min: number; max: number },
  fallback: number
): number {
  // Absent means "use the default" — never coerce to 0 (Number(null) is 0,
  // Number("") is 0, and both would silently clamp to the minimum).
  if (raw === null || raw === undefined || raw === "") return fallback;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, parsed));
}

// Search terms are bounded and LIKE-wildcard-escaped so a user-typed '%' or
// '_' matches literally; the value itself still goes through a query
// parameter — the escaping only keeps the pattern meaning deterministic.
export function sanitizeSearchTerm(raw: string | null | undefined): string | null {
  const term = (raw ?? "").trim().slice(0, READ_MODEL_LIMITS.termLength);
  if (!term) return null;
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// ReelHouse serves watch progress as the 0–100 percentage the UI renders.
// A missing or zero duration yields no bar (never a division blow-up), and
// the value is clamped so a bad tick pair cannot overflow the UI.
export function computeProgress(
  positionTicks: string | number | null,
  durationTicks: string | number | null
): number | undefined {
  const position = toNumber(positionTicks);
  const duration = toNumber(durationTicks);
  if (position === null || duration === null || duration <= 0) return undefined;
  return Math.min(100, Math.max(0, Math.round((position / duration) * 100)));
}

// Catalog item types are the sync's closed set. Jellyfin's Video items are
// synced as movies (normalize.ts), so "Video" reappears only for the
// legacy/demo paths; household and catalog rows never produce it here.
export function kindOf(itemType: string): MediaKind {
  switch (itemType) {
    case "movie":
      return "Movie";
    case "series":
      return "Series";
    case "episode":
      return "Episode";
    default:
      return "Video";
  }
}

// Poster/backdrop URLs follow the same browser-facing shape the Jellyfin
// integration builds (jellyfin.ts): the public URL only — the API key is
// never part of an image URL, and image requests go straight from the
// browser to Jellyfin, which remains the playback/library authority.
export function imageUrl(
  publicBaseUrl: string | undefined,
  jellyfinId: string,
  type: "Primary" | "Backdrop",
  tag: string | null
): string | undefined {
  if (!publicBaseUrl || !tag) return undefined;
  const width = type === "Primary" ? 600 : 1600;
  return `${publicBaseUrl}/Items/${encodeURIComponent(jellyfinId)}/Images/${type}?maxWidth=${width}&quality=90&tag=${encodeURIComponent(tag)}`;
}

// The browser-facing Jellyfin base URL: NEXT_PUBLIC_JELLYFIN_URL (the URL
// clients are meant to reach) wins, else the server URL. Trailing slashes
// are stripped; absent env leaves images undefined and the UI falls back to
// its letter tiles.
export function publicJellyfinUrl(env: Record<string, string | undefined>): string | undefined {
  const candidate = (env.NEXT_PUBLIC_JELLYFIN_URL ?? env.JELLYFIN_URL ?? "").trim().replace(/\/$/, "");
  return candidate || undefined;
}

// One catalog row joined with its genres (and, for the continue rail, its
// watch position). All columns the payload projection selects.
export interface CatalogItemRow extends QueryResultRow {
  jellyfin_id: string;
  item_type: string;
  name: string;
  series_name: string | null;
  production_year: number | null;
  overview: string | null;
  community_rating: string | null;
  primary_image_tag: string | null;
  backdrop_image_tag: string | null;
  genres: string[] | null;
  position_ticks?: string | null;
  duration_ticks?: string | null;
}

export function toMediaItem(
  row: CatalogItemRow,
  publicBaseUrl: string | undefined,
  progress?: string | number | null
): MediaItem {
  return {
    id: row.jellyfin_id,
    title: row.name,
    subtitle: row.series_name ?? undefined,
    year: row.production_year ?? undefined,
    overview: row.overview ?? undefined,
    kind: kindOf(row.item_type),
    rating: toNumber(row.community_rating) ?? undefined,
    progress: progress !== undefined ? computeProgress(progress, row.duration_ticks ?? null) : undefined,
    imageUrl: imageUrl(publicBaseUrl, row.jellyfin_id, "Primary", row.primary_image_tag),
    backdropUrl: imageUrl(publicBaseUrl, row.jellyfin_id, "Backdrop", row.backdrop_image_tag),
    genres: row.genres ?? undefined
  };
}

// Shared projection for catalog-backed reads: the display fields plus the
// genre aggregation. Always against active rows only — tombstones are
// history, not presentation.
export const ITEM_PROJECTION = `m.jellyfin_id, m.item_type, m.name, m.series_name,
    m.production_year, m.overview, m.community_rating, m.primary_image_tag,
    m.backdrop_image_tag,
    (SELECT array_agg(g.name ORDER BY g.name)
       FROM media_item_genres ig JOIN media_genres g ON g.id = ig.genre_id
      WHERE ig.item_id = m.id) AS genres`;
