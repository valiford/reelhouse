// Catalog search/filter/pagination read model (RH-0034).
//
// One bounded, deterministic read path over the ACTIVE catalog for
// TV/browser/mobile clients. Design contract:
// - Bounded: every query carries a LIMIT resolved through the params module
//   (max 100), the count query is filtered but never paginated, and the
//   detail facet lists are individually capped. Nothing can return an
//   unbounded result set.
// - Deterministic: every ORDER BY ends in a unique column (id) in the same
//   direction, so pagination never duplicates or skips a row across pages.
// - Indexed: filters/orders are shaped to the partial indexes of migration
//   0008 (active title / added / rating / year). Substring search remains a
//   bounded ILIKE scan by design — no superuser-only extensions required.
// - Active-only: removed catalog rows never surface; a tombstoned item
//   leaves search and rails on the next read (catalog churn is authoritative
//   for what is discoverable).
//
// Query construction is pure (buildCatalogSearchQuery / buildCatalogCountQuery):
// the SQL text and the parameter array are produced together through
// SqlBuilder, so placeholder numbering can never drift from the values, and
// both are unit-asserted without a database.

import type { QueryResultRow } from "pg";
import type { CatalogItemType } from "../catalog/normalize.ts";
import { SqlBuilder, type ReadExecutor } from "./executor.ts";
import { likePattern, type ResolvedSearchFilters } from "./params.ts";

export interface CatalogCardRow extends QueryResultRow {
  id: string | number;
  source: string;
  jellyfin_id: string;
  library_jellyfin_id: string;
  library_name: string;
  item_type: CatalogItemType;
  name: string;
  sort_name: string | null;
  original_title: string | null;
  production_year: number | null;
  premiere_date: Date | string | null;
  community_rating: string | null;
  official_rating: string | null;
  runtime_ticks: string | null;
  primary_image_tag: string | null;
  backdrop_image_tag: string | null;
  date_created: Date | string | null;
  series_jellyfin_id: string | null;
  series_name: string | null;
  season_number: number | null;
  episode_number: number | null;
  synced_at: Date | string;
}

const CARD_COLUMNS = `m.id, m.source, m.jellyfin_id,
       l.jellyfin_id AS library_jellyfin_id, l.name AS library_name,
       m.item_type, m.name, m.sort_name, m.original_title,
       m.production_year, m.premiere_date, m.community_rating, m.official_rating,
       m.runtime_ticks, m.primary_image_tag, m.backdrop_image_tag, m.date_created,
       m.series_jellyfin_id, m.series_name, m.season_number, m.episode_number, m.synced_at`;

// The WHERE clause is shared verbatim by the page query and the count query.
// The caller owns ONE SqlBuilder per query and passes it in, so filter
// values and LIMIT/OFFSET share a single $n sequence — two builders here
// would both start numbering at $1 and silently collide.
function buildFilterClause(filters: ResolvedSearchFilters, builder: SqlBuilder): string {
  const clauses: string[] = [
    "m.removed_at IS NULL",
    "l.removed_at IS NULL"
  ];

  if (filters.types.length) {
    clauses.push(`m.item_type = ANY(${builder.param(filters.types)})`);
  }
  if (filters.libraries.length) {
    clauses.push(`l.jellyfin_id = ANY(${builder.param(filters.libraries)})`);
  }
  if (filters.q !== null) {
    const pattern = likePattern(filters.q);
    clauses.push(
      `(m.name ILIKE ${builder.param(pattern)} OR COALESCE(m.original_title, '') ILIKE ${builder.param(
        pattern
      )} OR COALESCE(m.sort_name, '') ILIKE ${builder.param(pattern)})`
    );
  }
  if (filters.genres.length) {
    clauses.push(`EXISTS (
      SELECT 1 FROM media_item_genres mig
      JOIN media_genres g ON g.id = mig.genre_id
      WHERE mig.item_id = m.id AND g.name = ANY(${builder.param(filters.genres)})
    )`);
  }
  if (filters.yearMin !== null) {
    clauses.push(`m.production_year >= ${builder.param(filters.yearMin)}`);
  }
  if (filters.yearMax !== null) {
    clauses.push(`m.production_year <= ${builder.param(filters.yearMax)}`);
  }
  if (filters.minRating !== null) {
    clauses.push(`m.community_rating >= ${builder.param(filters.minRating)}`);
  }

  return clauses.join(" AND ");
}

interface OrderSpec {
  expression: string;
  // PostgreSQL's DESC default is NULLS FIRST, which would lead a rating- or
  // year-sorted rail with unrated/undated items; quality-led sorts push
  // NULLs to the tail explicitly.
  nulls?: "NULLS LAST";
}

// Order expressions are static per sort key — filter values never enter the
// ORDER BY, so the sort cannot be shaped from the outside. `recent` matches
// the migration 0008 added-index expression exactly; ties break on id.
function orderFor(sort: ResolvedSearchFilters["sort"]): OrderSpec {
  switch (sort) {
    case "recent":
      return { expression: "COALESCE(m.date_created, m.first_seen_at)" };
    case "rating":
      return { expression: "m.community_rating", nulls: "NULLS LAST" };
    case "year":
      return { expression: "m.production_year", nulls: "NULLS LAST" };
    case "title":
    default:
      return { expression: "lower(COALESCE(m.sort_name, m.name))" };
  }
}

export function buildCatalogSearchQuery(
  filters: ResolvedSearchFilters,
  page: { limit: number; offset: number }
): { text: string; values: unknown[] } {
  const builder = new SqlBuilder();
  const where = buildFilterClause(filters, builder);
  const order = orderFor(filters.sort);
  const primary = `${order.expression} ${filters.dir.toUpperCase()}${order.nulls ? ` ${order.nulls}` : ""}`;
  const text = `SELECT ${CARD_COLUMNS}
    FROM media_items m
    JOIN media_libraries l ON l.id = m.library_id
    WHERE ${where}
    ORDER BY ${primary}, m.id ${filters.dir.toUpperCase()}
    LIMIT ${builder.param(page.limit)} OFFSET ${builder.param(page.offset)}`;
  return { text, values: builder.values };
}

export function buildCatalogCountQuery(filters: ResolvedSearchFilters): {
  text: string;
  values: unknown[];
} {
  const builder = new SqlBuilder();
  const where = buildFilterClause(filters, builder);
  return {
    text: `SELECT count(*)::int AS total
      FROM media_items m
      JOIN media_libraries l ON l.id = m.library_id
      WHERE ${where}`,
    values: builder.values
  };
}

export interface CatalogSearchPage {
  items: CatalogCardRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export async function searchCatalogItems(
  executor: ReadExecutor,
  filters: ResolvedSearchFilters,
  page: { limit: number; offset: number }
): Promise<CatalogSearchPage> {
  const pageQuery = buildCatalogSearchQuery(filters, page);
  const countQuery = buildCatalogCountQuery(filters);
  const [pageResult, countResult] = await Promise.all([
    executor.query<CatalogCardRow>(pageQuery.text, pageQuery.values),
    executor.query<{ total: number }>(countQuery.text, countQuery.values)
  ]);
  const total = Number(countResult.rows[0]?.total ?? 0);
  return {
    items: pageResult.rows,
    total,
    limit: page.limit,
    offset: page.offset,
    hasMore: page.offset + pageResult.rows.length < total
  };
}

export class CatalogItemNotFoundError extends Error {
  constructor(jellyfinId: string) {
    super(`no active catalog item matches jellyfin id "${jellyfinId.slice(0, 100)}"`);
    this.name = "CatalogItemNotFoundError";
  }
}

// Facet caps: a detail view never needs every cast member of a 500-episode
// series; each facet list is bounded independently and ordered deterministically.
export const DETAIL_MAX_GENRES = 30;
export const DETAIL_MAX_STUDIOS = 30;
export const DETAIL_MAX_PEOPLE = 30;
export const DETAIL_MAX_PROVIDERS = 20;

export interface CatalogItemDetail {
  item: CatalogCardRow;
  overview: string | null;
  container: string | null;
  filePath: string | null;
  fileSizeBytes: string | null;
  etag: string | null;
  firstSeenAt: Date | string;
  genres: string[];
  studios: string[];
  people: { name: string; personType: string; roleName: string | null }[];
  providerIds: { name: string; value: string }[];
}

export async function getCatalogItem(
  executor: ReadExecutor,
  jellyfinId: string
): Promise<CatalogItemDetail> {
  const itemResult = await executor.query<CatalogCardRow>(
    `SELECT ${CARD_COLUMNS}
     FROM media_items m
     JOIN media_libraries l ON l.id = m.library_id
     WHERE m.source = 'jellyfin' AND m.jellyfin_id = $1 AND m.removed_at IS NULL AND l.removed_at IS NULL
     LIMIT 1`,
    [jellyfinId]
  );
  const item = itemResult.rows[0];
  if (!item) throw new CatalogItemNotFoundError(jellyfinId);
  const itemId = Number(item.id);

  const [fileRow, genreRows, studioRows, peopleRows, providerRows] = await Promise.all([
    executor.query<{
      overview: string | null;
      container: string | null;
      file_path: string | null;
      file_size_bytes: string | null;
      etag: string | null;
      first_seen_at: Date | string;
    }>(
      "SELECT overview, container, file_path, file_size_bytes, etag, first_seen_at FROM media_items WHERE id = $1",
      [itemId]
    ),
    executor.query<{ name: string }>(
      `SELECT g.name FROM media_item_genres mig
       JOIN media_genres g ON g.id = mig.genre_id
       WHERE mig.item_id = $1 ORDER BY g.name LIMIT ${DETAIL_MAX_GENRES}`,
      [itemId]
    ),
    executor.query<{ name: string }>(
      `SELECT s.name FROM media_item_studios mis
       JOIN media_studios s ON s.id = mis.studio_id
       WHERE mis.item_id = $1 ORDER BY s.name LIMIT ${DETAIL_MAX_STUDIOS}`,
      [itemId]
    ),
    executor.query<{ name: string; person_type: string; role_name: string | null }>(
      `SELECT p.name, mip.person_type, mip.role_name FROM media_item_people mip
       JOIN media_people p ON p.id = mip.person_id
       WHERE mip.item_id = $1 ORDER BY mip.list_order, p.name LIMIT ${DETAIL_MAX_PEOPLE}`,
      [itemId]
    ),
    executor.query<{ provider_name: string; provider_value: string }>(
      `SELECT provider_name, provider_value FROM media_item_provider_ids
       WHERE item_id = $1 ORDER BY provider_name LIMIT ${DETAIL_MAX_PROVIDERS}`,
      [itemId]
    )
  ]);

  const file = fileRow.rows[0];
  return {
    item,
    overview: file?.overview ?? null,
    container: file?.container ?? null,
    filePath: file?.file_path ?? null,
    fileSizeBytes: file?.file_size_bytes ?? null,
    etag: file?.etag ?? null,
    firstSeenAt: file?.first_seen_at ?? item.synced_at,
    genres: genreRows.rows.map((row) => row.name),
    studios: studioRows.rows.map((row) => row.name),
    people: peopleRows.rows.map((row) => ({ name: row.name, personType: row.person_type, roleName: row.role_name })),
    providerIds: providerRows.rows.map((row) => ({ name: row.provider_name, value: row.provider_value }))
  };
}
