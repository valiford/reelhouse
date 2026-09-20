// Catalog read model (RH-0020): bounded search/filter/pagination, deterministic
// (stale-response-safe) ordering, recommendation rails, missing-art handling,
// and explicit freshness, served from the media_catalog database.
//
// Relationship to the sync (RH-0016): the sync owns writes; this module only
// reads. Readers filter retirement with `retired_at IS NULL` per
// docs/CATALOG_SYNC.md; items still only "missing" remain visible and are
// flagged instead of hidden, so a lagging full scan degrades visibly, never
// silently. Freshness comes from catalog_sync_state — stale data is served
// with an explicit `catalog.state`, never refused and never disguised.
//
// Ordering is a deterministic total order (sort key, then the unique
// external_id) walked by an opaque keyset cursor: pages stay correctly
// aligned even when rows are inserted or removed between requests — an
// offset page can silently shift under new data, a keyset page cannot.
// That is the "stale-response ordering" contract.
//
// Like sync.ts this module avoids `server-only`/aliases so tests import it
// under plain Node; routes reach it only from the server anyway.

import { Pool, type QueryResultRow } from "pg";
import { redactError } from "../db/config.ts";
import type { MediaItem } from "../types.ts";
import {
  CATALOG_URL_VAR,
  loadCatalogDatabaseConfig,
  loadCatalogFreshnessPolicy
} from "./config.ts";

// ---- Wire model ----

export type CatalogReadKind = "movie" | "series" | "season" | "episode";

export interface CatalogItemView {
  source: "jellyfin";
  externalId: string;
  kind: CatalogReadKind;
  name: string;
  sortName: string | null;
  year: number | null;
  overview: string | null;
  officialRating: string | null;
  communityRating: number | null;
  runtimeSeconds: number | null;
  genres: string[];
  /** True when the item has primary art (tag present); false = placeholder. */
  hasArt: boolean;
  imageUrl: string | null;
  /** Seen in a previous full scan but absent from the latest one. */
  missing: boolean;
  libraryId: string;
}

export type CatalogState = "fresh" | "stale" | "empty";

export interface CatalogStatusView {
  state: CatalogState;
  lastSucceededAt: string | null;
}

// The sync writes this job row; the read model only ever reads it.
const CATALOG_SYNC_JOB = "jellyfin_catalog";

// ---- Failure surface ----

// Any catalog read failure folds into this class after redaction, so a route
// can report `catalog.state = "unavailable"` (or 503) without ever leaking the
// database URL or credentials.
export class CatalogUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogUnavailableError";
  }
}

const ERROR_DETAIL_CAP = 2000;

function toUnavailableError(error: unknown, env: Record<string, string | undefined>): CatalogUnavailableError {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactError(raw, env[CATALOG_URL_VAR]);
  const bounded = redacted.length <= ERROR_DETAIL_CAP ? redacted : `${redacted.slice(0, ERROR_DETAIL_CAP)}…(truncated)`;
  return new CatalogUnavailableError(bounded);
}

// ---- Pool (resident read pool, one per process, like src/lib/db/pool.ts) ----

// Read-path bounds are fixed: this is a bounded household read model, not a
// batch job — tight statement timeout, small pool.
const READ_POOL = { max: 4, statementTimeoutMs: 10_000, connectionTimeoutMs: 5_000, idleTimeoutMs: 30_000 } as const;

const globalForCatalog = globalThis as typeof globalThis & { __reelhouseCatalogReadPool?: Pool };

export function getCatalogPool(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): Pool {
  if (globalForCatalog.__reelhouseCatalogReadPool) return globalForCatalog.__reelhouseCatalogReadPool;
  const configResult = loadCatalogDatabaseConfig(env);
  if (configResult.kind === "unconfigured") {
    throw new CatalogUnavailableError(`No media_catalog database configured: set ${CATALOG_URL_VAR}`);
  }
  if (configResult.kind === "invalid") {
    throw new CatalogUnavailableError(
      `media_catalog configuration is invalid and was rejected: ${configResult.errors.join("; ")}`
    );
  }
  const config = configResult.config;
  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl,
    max: READ_POOL.max,
    connectionTimeoutMillis: READ_POOL.connectionTimeoutMs,
    idleTimeoutMillis: READ_POOL.idleTimeoutMs,
    statement_timeout: READ_POOL.statementTimeoutMs,
    query_timeout: READ_POOL.statementTimeoutMs,
    application_name: "reelhouse-catalog-read"
  });
  pool.on("error", (error) => {
    console.error("media_catalog read pool error:", toUnavailableError(error, env).message);
  });
  globalForCatalog.__reelhouseCatalogReadPool = pool;
  return pool;
}

export async function closeCatalogPool(): Promise<void> {
  const pool = globalForCatalog.__reelhouseCatalogReadPool;
  globalForCatalog.__reelhouseCatalogReadPool = undefined;
  if (pool) await pool.end();
}

// Wraps one read so any pg failure leaves as CatalogUnavailableError with a
// redacted, bounded message; successful results pass through untouched.
async function readQuery<T extends QueryResultRow>(
  pool: Pool,
  env: Record<string, string | undefined>,
  text: string,
  params?: unknown[]
): Promise<T[]> {
  try {
    const result = await pool.query<T>(text, params);
    return result.rows;
  } catch (error) {
    throw toUnavailableError(error, env);
  }
}

// ---- Freshness ----

export async function catalogStatus(
  pool: Pool,
  env: Record<string, string | undefined>,
  options: { now: Date }
): Promise<CatalogStatusView> {
  const policy = loadCatalogFreshnessPolicy(env);
  if (policy.kind === "invalid") {
    throw new CatalogUnavailableError(`Catalog freshness policy is invalid and was rejected: ${policy.errors.join("; ")}`);
  }
  const rows = await readQuery<{ last_succeeded_at: Date | null }>(
    pool,
    env,
    "SELECT last_succeeded_at FROM catalog_sync_state WHERE job = $1",
    [CATALOG_SYNC_JOB]
  );
  const lastSucceededAt = rows[0]?.last_succeeded_at ?? null;
  if (lastSucceededAt === null) return { state: "empty", lastSucceededAt: null };
  const stale = options.now.getTime() - lastSucceededAt.getTime() > policy.policy.staleAfterMs;
  return { state: stale ? "stale" : "fresh", lastSucceededAt: lastSucceededAt.toISOString() };
}

// ---- Search: parsing (pure) ----

export const SEARCH_LIMITS = {
  qMax: 200,
  genreMax: 100,
  limitDefault: 24,
  limitMax: 100,
  yearMin: 1000,
  yearMax: 2999
} as const;

export type CatalogSort = "name" | "rating" | "recent" | "year";

export interface CatalogSearchQuery {
  q: string;
  kinds: CatalogReadKind[];
  genre: string | null;
  year: number | null;
  sort: CatalogSort;
  limit: number;
  cursor: CatalogCursor | null;
}

export type ParsedSearchQuery = { ok: true; value: CatalogSearchQuery } | { ok: false; errors: string[] };

const KINDS: readonly CatalogReadKind[] = ["movie", "series", "season", "episode"];
const SORTS: readonly CatalogSort[] = ["name", "rating", "recent", "year"];

// Comma-separated kinds must be a non-empty subset of the known domain;
// anything else is refused (never clamped) so clients see their mistake.
function parseKinds(raw: string | null): CatalogReadKind[] | { error: string } {
  if (raw === null || raw.trim() === "") return ["movie", "series"];
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return ["movie", "series"];
  for (const part of parts) {
    if (!KINDS.includes(part as CatalogReadKind)) {
      return { error: `kind must be a comma-separated list drawn from: ${KINDS.join(", ")}` };
    }
  }
  return [...new Set(parts)] as CatalogReadKind[];
}

export function parseSearchQuery(params: {
  q: string | null;
  kind: string | null;
  genre: string | null;
  year: string | null;
  sort: string | null;
  limit: string | null;
  cursor: string | null;
}): ParsedSearchQuery {
  const errors: string[] = [];

  const rawQ = params.q?.trim() ?? "";
  if (rawQ.length > SEARCH_LIMITS.qMax) {
    errors.push(`q must be at most ${SEARCH_LIMITS.qMax} characters`);
  }

  const kindsResult = parseKinds(params.kind);
  if (!Array.isArray(kindsResult)) errors.push(kindsResult.error);

  const rawGenre = params.genre?.trim() ?? "";
  if (rawGenre.length > SEARCH_LIMITS.genreMax) {
    errors.push(`genre must be at most ${SEARCH_LIMITS.genreMax} characters`);
  }

  let year: number | null = null;
  if (params.year !== null && params.year.trim() !== "") {
    if (!/^\d+$/.test(params.year.trim())) {
      errors.push("year must be a four-digit year");
    } else {
      const value = Number(params.year.trim());
      if (value < SEARCH_LIMITS.yearMin || value > SEARCH_LIMITS.yearMax) {
        errors.push(`year must be between ${SEARCH_LIMITS.yearMin} and ${SEARCH_LIMITS.yearMax}`);
      } else {
        year = value;
      }
    }
  }

  let sort: CatalogSort = "name";
  if (params.sort !== null && params.sort.trim() !== "") {
    const candidate = params.sort.trim();
    if (!SORTS.includes(candidate as CatalogSort)) {
      errors.push(`sort must be one of: ${SORTS.join(", ")}`);
    } else {
      sort = candidate as CatalogSort;
    }
  }

  let limit: number = SEARCH_LIMITS.limitDefault;
  if (params.limit !== null && params.limit.trim() !== "") {
    if (!/^\d+$/.test(params.limit.trim())) {
      errors.push("limit must be a positive integer");
    } else {
      const value = Number(params.limit.trim());
      if (value < 1 || value > SEARCH_LIMITS.limitMax) {
        errors.push(`limit must be between 1 and ${SEARCH_LIMITS.limitMax}`);
      } else {
        limit = value;
      }
    }
  }

  let cursor: CatalogCursor | null = null;
  if (params.cursor !== null && params.cursor.trim() !== "") {
    const decoded = decodeCursor(params.cursor.trim());
    if (decoded.ok === false) {
      errors.push(decoded.error);
    } else if (decoded.value.sort !== sort) {
      errors.push("cursor does not match the requested sort");
    } else {
      cursor = decoded.value;
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      q: rawQ,
      kinds: (Array.isArray(kindsResult) ? kindsResult : ["movie", "series"]) as CatalogReadKind[],
      genre: rawGenre === "" ? null : rawGenre.toLowerCase(),
      year,
      sort,
      limit,
      cursor
    }
  };
}

// ---- Cursor codec (pure) ----

export interface CatalogCursor {
  sort: CatalogSort;
  /** Sort value of the last row on the previous page (null = NULLS LAST zone). */
  sortValue: string | number | null;
  externalId: string;
}

// base64url of a small JSON envelope; validated on decode so a forged cursor
// is a 400, never SQL with attacker-shaped structure.
export function encodeCursor(cursor: CatalogCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, k: cursor.sort, s: cursor.sortValue, e: cursor.externalId }), "utf8").toString("base64url");
}

export type DecodedCursor = { ok: true; value: CatalogCursor } | { ok: false; error: string };

export function decodeCursor(raw: string): DecodedCursor {
  let parsed: unknown;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "cursor is not a valid page cursor" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, error: "cursor is not a valid page cursor" };
  const envelope = parsed as { v?: unknown; k?: unknown; s?: unknown; e?: unknown };
  if (envelope.v !== 1) return { ok: false, error: "cursor is not a valid page cursor" };
  if (typeof envelope.k !== "string" || !SORTS.includes(envelope.k as CatalogSort)) {
    return { ok: false, error: "cursor is not a valid page cursor" };
  }
  if (typeof envelope.e !== "string" || envelope.e.trim() === "" || envelope.e.length > 512) {
    return { ok: false, error: "cursor is not a valid page cursor" };
  }
  const sort = envelope.k as CatalogSort;
  const candidate = envelope.s;
  let sortValue: string | number | null;
  // Only the NULLS LAST sorts can legitimately carry a null sort value.
  const nullableSort = sort === "rating" || sort === "recent" || sort === "year";
  if (candidate === null) {
    if (!nullableSort) return { ok: false, error: "cursor is not a valid page cursor" };
    sortValue = null;
  } else if (sort === "name") {
    if (typeof candidate !== "string") return { ok: false, error: "cursor is not a valid page cursor" };
    sortValue = candidate;
  } else if (sort === "rating") {
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) return { ok: false, error: "cursor is not a valid page cursor" };
    sortValue = candidate;
  } else if (sort === "year") {
    if (typeof candidate !== "number" || !Number.isInteger(candidate)) return { ok: false, error: "cursor is not a valid page cursor" };
    sortValue = candidate;
  } else {
    if (typeof candidate !== "string" || Number.isNaN(Date.parse(candidate))) return { ok: false, error: "cursor is not a valid page cursor" };
    sortValue = candidate;
  }
  return { ok: true, value: { sort, sortValue, externalId: envelope.e } };
}

// ---- Search: SQL assembly ----

// ILIKE pattern with %, _ and the escape character itself escaped, so a query
// of "100%" finds a literal percent and cannot widen the scan by wildcard.
export function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (match) => `\\${match}`);
  return `%${escaped}%`;
}

interface SortPlan {
  orderBy: string;
  // Builds the cursor predicate with the final parameter indices (value
  // first, external id second) — substituted as numbers, never by string
  // replacement, so indices cannot collide. Predicates keep the NULLS LAST
  // zone strictly after every valued row.
  cursorPredicate: (valueIndex: number, idIndex: number) => string;
}

const SORT_PLANS: Record<CatalogSort, SortPlan> = {
  name: {
    // The sort key is inlined (a SELECT alias is not visible to WHERE);
    // the JS cursor still reads it back through the `sort_key` alias.
    orderBy: "lower(coalesce(sort_name, name)) ASC, external_id ASC",
    cursorPredicate: (v, i) => `(lower(coalesce(sort_name, name)), external_id) > ($${v}::text, $${i}::text)`
  },
  rating: {
    orderBy: "community_rating DESC NULLS LAST, external_id ASC",
    cursorPredicate: (v, i) =>
      `($${v}::numeric IS NOT NULL AND (community_rating < $${v}::numeric OR (community_rating = $${v}::numeric AND external_id > $${i}::text) OR community_rating IS NULL)) ` +
      `OR ($${v}::numeric IS NULL AND community_rating IS NULL AND external_id > $${i}::text)`
  },
  recent: {
    orderBy: "date_created DESC NULLS LAST, external_id ASC",
    cursorPredicate: (v, i) =>
      `($${v}::timestamptz IS NOT NULL AND (date_created < $${v}::timestamptz OR (date_created = $${v}::timestamptz AND external_id > $${i}::text) OR date_created IS NULL)) ` +
      `OR ($${v}::timestamptz IS NULL AND date_created IS NULL AND external_id > $${i}::text)`
  },
  year: {
    orderBy: "production_year DESC NULLS LAST, external_id ASC",
    cursorPredicate: (v, i) =>
      `($${v}::integer IS NOT NULL AND (production_year < $${v}::integer OR (production_year = $${v}::integer AND external_id > $${i}::text) OR production_year IS NULL)) ` +
      `OR ($${v}::integer IS NULL AND production_year IS NULL AND external_id > $${i}::text)`
  }
};

interface CatalogItemRow extends QueryResultRow {
  id: string;
  library_id: string;
  source: string;
  external_id: string;
  kind: string;
  name: string;
  sort_name: string | null;
  production_year: number | null;
  overview: string | null;
  official_rating: string | null;
  community_rating_text: string | null;
  runtime_seconds: number | null;
  date_created: Date | null;
  primary_image_tag: string | null;
  missing_since: Date | null;
  sort_key?: string;
}

const ITEM_COLUMNS = `id, library_id, source, external_id, kind, name, sort_name, production_year,
  overview, official_rating, community_rating::text AS community_rating_text, runtime_seconds,
  date_created, primary_image_tag, missing_since`;

function cursorSortValue(
  sort: CatalogSort,
  row: Pick<CatalogItemRow, "sort_key" | "community_rating_text" | "date_created" | "production_year">
): string | number | null {
  switch (sort) {
    case "name":
      return row.sort_key ?? "";
    case "rating":
      return row.community_rating_text === null ? null : Number(row.community_rating_text);
    case "recent":
      return row.date_created ? row.date_created.toISOString() : null;
    case "year":
      return row.production_year ?? null;
  }
}

// ---- Search: execution ----

export interface CatalogSearchPage {
  items: CatalogItemView[];
  total: number;
  nextCursor: string | null;
}

export async function searchCatalogItems(
  pool: Pool,
  env: Record<string, string | undefined>,
  query: CatalogSearchQuery
): Promise<CatalogSearchPage> {
  const plan = SORT_PLANS[query.sort];
  const params: unknown[] = [];
  const filters: string[] = ["retired_at IS NULL", "kind = ANY($1::text[])"];
  params.push(query.kinds);

  if (query.q !== "") {
    params.push(likePattern(query.q));
    filters.push(
      `(name ILIKE $${params.length} ESCAPE '\\' OR coalesce(sort_name, '') ILIKE $${params.length} ESCAPE '\\' OR coalesce(original_title, '') ILIKE $${params.length} ESCAPE '\\')`
    );
  }
  if (query.genre !== null) {
    params.push(query.genre);
    filters.push(
      // `catalog_item.id` is qualified: unqualified `id` would resolve to
      // catalog_genre's column inside this EXISTS.
      `EXISTS (SELECT 1 FROM catalog_item_genre ig JOIN catalog_genre g ON g.id = ig.genre_id WHERE ig.item_id = catalog_item.id AND g.name_key = $${params.length})`
    );
  }
  if (query.year !== null) {
    params.push(query.year);
    filters.push(`production_year = $${params.length}`);
  }

  const whereFiltered = filters.join(" AND ");
  const countRows = await readQuery<{ n: string }>(
    pool,
    env,
    `SELECT count(*)::text AS n FROM catalog_item WHERE ${whereFiltered}`,
    params
  );
  const total = Number(countRows[0]?.n ?? "0");

  const pageParams = [...params];
  if (query.cursor !== null) {
    pageParams.push(query.cursor.sortValue, query.cursor.externalId);
    const valueIndex = pageParams.length - 1;
    const idIndex = pageParams.length;
    filters.push(plan.cursorPredicate(valueIndex, idIndex));
  }
  pageParams.push(query.limit);
  const limitIndex = pageParams.length;
  const pageRows = await readQuery<CatalogItemRow>(
    pool,
    env,
    `SELECT ${ITEM_COLUMNS}, lower(coalesce(sort_name, name)) AS sort_key
       FROM catalog_item
      WHERE ${filters.join(" AND ")}
      ORDER BY ${plan.orderBy}
      LIMIT $${limitIndex}`,
    pageParams
  );

  const imageBase = jellyfinImageBase(env);
  const genresByItem = await loadGenres(pool, env, pageRows.map((row) => row.id));
  const items = pageRows.map((row) => toCatalogItemView(row, genresByItem.get(row.id) ?? [], imageBase));

  let nextCursor: string | null = null;
  if (items.length === query.limit && pageRows.length > 0) {
    const lastRow = pageRows[pageRows.length - 1];
    nextCursor = encodeCursor({
      sort: query.sort,
      sortValue: cursorSortValue(query.sort, lastRow),
      externalId: lastRow.external_id
    });
  }
  return { items, total, nextCursor };
}

async function loadGenres(
  pool: Pool,
  env: Record<string, string | undefined>,
  itemIds: string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (itemIds.length === 0) return out;
  const rows = await readQuery<{ item_id: string; name: string }>(
    pool,
    env,
    `SELECT ig.item_id, g.name
       FROM catalog_item_genre ig
       JOIN catalog_genre g ON g.id = ig.genre_id
      WHERE ig.item_id = ANY($1::uuid[])
      ORDER BY ig.item_id, ig.list_order`,
    [itemIds]
  );
  for (const row of rows) {
    const list = out.get(row.item_id);
    if (list) list.push(row.name);
    else out.set(row.item_id, [row.name]);
  }
  return out;
}

// Presentation base for composing image URLs server-side (same resolution as
// src/lib/jellyfin.ts): the public URL when set, else the server URL. Absent
// either, items are served with hasArt facts only and no fabricated URL.
export function jellyfinImageBase(env: Record<string, string | undefined>): string | null {
  const publicUrl = env["NEXT_PUBLIC_JELLYFIN_URL"]?.replace(/\/$/, "");
  const serverUrl = env["JELLYFIN_URL"]?.replace(/\/$/, "");
  return publicUrl || serverUrl || null;
}

export function composeImageUrl(base: string, externalId: string, tag: string): string {
  return `${base}/Items/${encodeURIComponent(externalId)}/Images/Primary?maxWidth=600&quality=90&tag=${encodeURIComponent(tag)}`;
}

function toCatalogItemView(row: CatalogItemRow, genres: string[], imageBase: string | null): CatalogItemView {
  const hasArt = row.primary_image_tag !== null && row.primary_image_tag !== "";
  return {
    source: "jellyfin",
    externalId: row.external_id,
    kind: row.kind as CatalogReadKind,
    name: row.name,
    sortName: row.sort_name,
    year: row.production_year,
    overview: row.overview,
    officialRating: row.official_rating,
    communityRating: row.community_rating_text === null ? null : Number(row.community_rating_text),
    runtimeSeconds: row.runtime_seconds,
    genres,
    hasArt,
    imageUrl:
      hasArt && imageBase !== null ? composeImageUrl(imageBase, row.external_id, row.primary_image_tag as string) : null,
    missing: row.missing_since !== null,
    libraryId: row.library_id
  };
}

// ---- UI-facing mapping ----

// The household UI contract is MediaItem (id/title/kind); catalog-backed
// endpoints serve the same shape — the external id IS the Jellyfin item id,
// so household links (media_item_ref) keep working — with the read model's
// presentation facts carried as additive fields.
export interface CatalogMediaItem extends MediaItem {
  hasArt: boolean;
  missing: boolean;
}

const MEDIA_KIND_BY_CATALOG_KIND: Record<CatalogReadKind, NonNullable<MediaItem["kind"]>> = {
  movie: "Movie",
  series: "Series",
  season: "Season",
  episode: "Episode"
};

export function catalogViewToMediaItem(view: CatalogItemView): CatalogMediaItem {
  return {
    id: view.externalId,
    title: view.name,
    year: view.year ?? undefined,
    overview: view.overview ?? undefined,
    kind: MEDIA_KIND_BY_CATALOG_KIND[view.kind],
    rating: view.communityRating ?? undefined,
    imageUrl: view.imageUrl ?? undefined,
    genres: view.genres.length > 0 ? view.genres : undefined,
    hasArt: view.hasArt,
    missing: view.missing
  };
}

// ---- Recommendation rails ----

export interface CatalogRail {
  key: "top_rated" | "recently_added" | "genre";
  title: string;
  genre: string | null;
  items: CatalogItemView[];
}

export const RAIL_LIMITS = { default: 12, max: 50, genreMax: 100 } as const;

export type ParsedRailQuery =
  | { ok: true; value: { genre: string | null; limit: number } }
  | { ok: false; errors: string[] };

export function parseRailQuery(params: { genre: string | null; limit: string | null }): ParsedRailQuery {
  const errors: string[] = [];
  const rawGenre = params.genre?.trim() ?? "";
  if (rawGenre.length > RAIL_LIMITS.genreMax) errors.push(`genre must be at most ${RAIL_LIMITS.genreMax} characters`);

  let limit: number = RAIL_LIMITS.default;
  if (params.limit !== null && params.limit.trim() !== "") {
    if (!/^\d+$/.test(params.limit.trim())) {
      errors.push("limit must be a positive integer");
    } else {
      const value = Number(params.limit.trim());
      if (value < 1 || value > RAIL_LIMITS.max) {
        errors.push(`limit must be between 1 and ${RAIL_LIMITS.max}`);
      } else {
        limit = value;
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { genre: rawGenre === "" ? null : rawGenre.toLowerCase(), limit } };
}

// Rails prefer artful items first (missing-art items still appear, flagged, so
// the rail stays honest and complete), then the rail's own key, then the
// unique external id for a deterministic total order.
async function railRows(
  pool: Pool,
  env: Record<string, string | undefined>,
  sql: string,
  params: unknown[]
): Promise<CatalogItemRow[]> {
  return readQuery<CatalogItemRow>(pool, env, sql, params);
}

export async function catalogRails(
  pool: Pool,
  env: Record<string, string | undefined>,
  options: { genre: string | null; limit: number }
): Promise<CatalogRail[]> {
  const kinds = ["movie", "series"];
  const topRatedRows = await railRows(
    pool,
    env,
    `SELECT ${ITEM_COLUMNS}
       FROM catalog_item
      WHERE retired_at IS NULL AND kind = ANY($1::text[])
      ORDER BY (primary_image_tag IS NULL) ASC, community_rating DESC NULLS LAST, external_id ASC
      LIMIT $2`,
    [kinds, options.limit]
  );
  const recentRows = await railRows(
    pool,
    env,
    `SELECT ${ITEM_COLUMNS}
       FROM catalog_item
      WHERE retired_at IS NULL AND kind = ANY($1::text[])
      ORDER BY (primary_image_tag IS NULL) ASC, date_created DESC NULLS LAST, external_id ASC
      LIMIT $2`,
    [kinds, options.limit]
  );
  const genreRows =
    options.genre !== null
      ? await railRows(
          pool,
          env,
          `SELECT ${ITEM_COLUMNS}
             FROM catalog_item ci
            WHERE ci.retired_at IS NULL AND ci.kind = ANY($1::text[])
              AND EXISTS (
                SELECT 1 FROM catalog_item_genre ig JOIN catalog_genre g ON g.id = ig.genre_id
                 WHERE ig.item_id = ci.id AND g.name_key = $2
              )
            ORDER BY (ci.primary_image_tag IS NULL) ASC, ci.community_rating DESC NULLS LAST, ci.external_id ASC
            LIMIT $3`,
          [kinds, options.genre, options.limit]
        )
      : [];

  const imageBase = jellyfinImageBase(env);
  const allIds = [...topRatedRows, ...recentRows, ...genreRows].map((row) => row.id);
  const genresByItem = await loadGenres(pool, env, allIds);
  const view = (row: CatalogItemRow): CatalogItemView => toCatalogItemView(row, genresByItem.get(row.id) ?? [], imageBase);

  const rails: CatalogRail[] = [
    { key: "top_rated", title: "Top Rated", genre: null, items: topRatedRows.map(view) },
    { key: "recently_added", title: "Recently Added", genre: null, items: recentRows.map(view) }
  ];
  if (options.genre !== null) {
    rails.push({ key: "genre", title: `Best of ${options.genre}`, genre: options.genre, items: genreRows.map(view) });
  }
  return rails;
}

// ---- Library browse ----

export interface CatalogLibraryBrowse {
  hero: CatalogItemView | null;
  sections: Array<{ title: string; items: CatalogItemView[] }>;
}

export async function catalogLibraryBrowse(
  pool: Pool,
  env: Record<string, string | undefined>,
  options: { limit: number }
): Promise<CatalogLibraryBrowse> {
  const rails = await catalogRails(pool, env, { genre: null, limit: options.limit });
  const byKey = new Map(rails.map((rail) => [rail.key, rail.items]));
  const recent = byKey.get("recently_added") ?? [];
  const topRated = byKey.get("top_rated") ?? [];

  const imageBase = jellyfinImageBase(env);
  const byName = async (kind: "movie" | "series"): Promise<CatalogItemView[]> => {
    const rows = await railRows(
      pool,
      env,
      `SELECT ${ITEM_COLUMNS}
         FROM catalog_item
        WHERE retired_at IS NULL AND kind = ANY($1::text[])
        ORDER BY lower(coalesce(sort_name, name)) ASC, external_id ASC
        LIMIT $2`,
      [[kind], options.limit]
    );
    const genresByItem = await loadGenres(pool, env, rows.map((row) => row.id));
    return rows.map((row) => toCatalogItemView(row, genresByItem.get(row.id) ?? [], imageBase));
  };
  const movies = await byName("movie");
  const series = await byName("series");

  const hero = recent.find((item) => item.hasArt) ?? recent[0] ?? topRated[0] ?? null;
  return {
    hero,
    sections: [
      { title: "Recently Added", items: recent },
      { title: "Top Rated", items: topRated },
      { title: "Movies", items: movies },
      { title: "Shows", items: series }
    ].filter((section) => section.items.length > 0)
  };
}
