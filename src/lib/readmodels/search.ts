// Catalog-backed bounded search (RH-0040): case-insensitive lookup over the
// active media catalog with a deterministic order and hard bounds.
//
// Contract:
// - Pattern: substring match on name / original title / series name. The
//   term is bounded and wildcard-escaped (sanitizeSearchTerm) and still
//   travels as a query parameter, so user input can never change the shape
//   of the query.
// - Order: prefix matches first, then case-folded name, then id — stable
//   across pages, so limit/offset paging is deterministic.
// - Bounded: LIMIT is clamped to 1–100 (default 40) and OFFSET to 0–10000;
//   a caller asking for more simply gets the bound.
// - Only active rows: tombstoned items never surface in search.

import {
  ITEM_PROJECTION,
  READ_MODEL_LIMITS,
  clampInt,
  publicJellyfinUrl,
  sanitizeSearchTerm,
  toMediaItem,
  type CatalogItemRow,
  type ReadExecutor
} from "./items.ts";
import type { MediaItem } from "../types";

export interface SearchOptions {
  limit?: number | string | null;
  offset?: number | string | null;
  env?: Record<string, string | undefined>;
}

export interface SearchPage {
  items: MediaItem[];
  limit: number;
  offset: number;
  // Bounded echo of the sanitized term ("" when the term was blank) so
  // callers can see what was actually searched.
  term: string;
}

export async function searchCatalog(
  executor: ReadExecutor,
  rawTerm: string | null | undefined,
  options: SearchOptions = {}
): Promise<SearchPage> {
  const term = sanitizeSearchTerm(rawTerm);
  const limit = clampInt(options.limit ?? null, READ_MODEL_LIMITS.searchLimit, READ_MODEL_LIMITS.searchLimit.default);
  const offset = clampInt(options.offset ?? null, READ_MODEL_LIMITS.searchOffset, 0);
  const publicBaseUrl = publicJellyfinUrl(options.env ?? process.env);
  if (!term) return { items: [], limit, offset, term: "" };

  const rows = (
    await executor.query<CatalogItemRow>(
      `SELECT ${ITEM_PROJECTION}
         FROM media_items m
        WHERE m.removed_at IS NULL
          AND (m.name ILIKE $1 ESCAPE '\\'
               OR m.original_title ILIKE $1 ESCAPE '\\'
               OR m.series_name ILIKE $1 ESCAPE '\\')
        ORDER BY (m.name ILIKE $2 ESCAPE '\\') DESC, lower(m.name), m.id
        LIMIT $3 OFFSET $4`,
      [`%${term}%`, `${term}%`, limit, offset]
    )
  ).rows;

  return { items: rows.map((row) => toMediaItem(row, publicBaseUrl)), limit, offset, term };
}
