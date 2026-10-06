// Pure, bounded parameter contract for the read models.
//
// Every client-facing knob passes through here before any SQL sees it: page
// sizes clamp into a fixed window, enum values fail closed on anything
// unknown, free text is trimmed and length-bounded, and filter lists are
// deduplicated and capped. The result is deterministic — the same request
// normalizes identically on every server — and hostile input degrades to a
// typed rejection (ReadModelParamError) instead of reaching the database as
// text. No I/O, no imports: fully unit-testable under `node --test`.

import type { CatalogItemType } from "../catalog/normalize.ts";

export class ReadModelParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadModelParamError";
  }
}

// Bounded-result contract: a page is at most PAGE_MAX_LIMIT rows, defaulting
// to PAGE_DEFAULT_LIMIT so a bare request stays a bounded response.
export const PAGE_DEFAULT_LIMIT = 24;
export const PAGE_MAX_LIMIT = 100;
export const MAX_QUERY_LENGTH = 200;
export const MAX_FILTER_VALUE_LENGTH = 200;
export const MAX_FILTER_VALUES = 25;

// Rails and recommendation buckets carry their own (smaller) window: a home
// screen never needs a full library page.
export const RAIL_DEFAULT_LIMIT = 20;
export const RAIL_MAX_LIMIT = 50;
export const MAX_HOME_ROWS_PER_PROFILE = 12;
export const MAX_BUCKETS_GENRES = 10;

export const ITEM_TYPES: readonly CatalogItemType[] = ["movie", "series", "season", "episode"];

export const CATALOG_SORTS = ["title", "recent", "rating", "year"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export type SortDirection = "asc" | "desc";

export function resolvePage(input: { limit?: unknown; offset?: unknown }): {
  limit: number;
  offset: number;
} {
  return {
    limit: resolveBoundedInteger(input.limit, {
      what: "limit",
      fallback: PAGE_DEFAULT_LIMIT,
      minimum: 1,
      maximum: PAGE_MAX_LIMIT,
      clamp: true
    }),
    offset: resolveBoundedInteger(input.offset, {
      what: "offset",
      fallback: 0,
      minimum: 0,
      maximum: 1_000_000,
      clamp: true
    })
  };
}

export function resolveRailLimit(input: unknown): number {
  return resolveBoundedInteger(input, {
    what: "limit",
    fallback: RAIL_DEFAULT_LIMIT,
    minimum: 1,
    maximum: RAIL_MAX_LIMIT,
    clamp: true
  });
}

interface BoundedOptions {
  what: string;
  fallback: number;
  minimum: number;
  maximum: number;
  clamp: boolean;
}

// Shared numeric knob parser: numbers or purely numeric strings, NaN-safe.
// Out-of-range values clamp (a client asking for 5000 rows gets the bounded
// maximum, not an error) while non-numeric values fail closed.
function resolveBoundedInteger(value: unknown, options: BoundedOptions): number {
  if (value === undefined || value === null || value === "") return options.fallback;
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new ReadModelParamError(`${options.what} must be an integer (got ${JSON.stringify(value)?.slice(0, 50)})`);
  }
  if (parsed < options.minimum) {
    if (options.clamp) return options.minimum;
    throw new ReadModelParamError(`${options.what} must be >= ${options.minimum}`);
  }
  if (parsed > options.maximum) return options.maximum;
  return parsed;
}

export interface SearchFiltersInput {
  q?: unknown;
  types?: unknown;
  libraries?: unknown;
  genres?: unknown;
  yearMin?: unknown;
  yearMax?: unknown;
  minRating?: unknown;
  sort?: unknown;
  dir?: unknown;
}

export interface ResolvedSearchFilters {
  q: string | null;
  types: CatalogItemType[];
  libraries: string[];
  genres: string[];
  yearMin: number | null;
  yearMax: number | null;
  minRating: number | null;
  sort: CatalogSort;
  dir: SortDirection;
}

// Sort directions default per sort key: title sorts A→Z, every recency- or
// quality-led sort defaults to "best first". Explicit ?dir= always wins.
const DEFAULT_DIRECTION: Record<CatalogSort, SortDirection> = {
  title: "asc",
  recent: "desc",
  rating: "desc",
  year: "desc"
};

const MIN_YEAR = 1850;
const MAX_YEAR = 2100;
const MAX_RATING = 10;

// Unknown query-string keys are ignored (cache busters, future clients);
// every KNOWN key is validated strictly. Array values (repeated query
// params) and comma-separated values are accepted interchangeably.
export function resolveSearchFilters(input: SearchFiltersInput): ResolvedSearchFilters {
  const qRaw = textOrNull(input.q);
  const q = qRaw === null ? null : qRaw.slice(0, MAX_QUERY_LENGTH);

  const sortRaw = textOrNull(input.sort);
  let sort: CatalogSort = "title";
  if (sortRaw !== null) {
    if (!(CATALOG_SORTS as readonly string[]).includes(sortRaw)) {
      throw new ReadModelParamError(
        `sort must be one of ${CATALOG_SORTS.join(", ")} (got "${sortRaw.slice(0, 50)}")`
      );
    }
    sort = sortRaw as CatalogSort;
  }

  const dirRaw = textOrNull(input.dir);
  let dir = DEFAULT_DIRECTION[sort];
  if (dirRaw !== null) {
    if (dirRaw !== "asc" && dirRaw !== "desc") {
      throw new ReadModelParamError(`dir must be "asc" or "desc" (got "${dirRaw.slice(0, 50)}")`);
    }
    dir = dirRaw;
  }

  const types = resolveEnumList(input.types, ITEM_TYPES, "type");
  const libraries = resolveStringList(input.libraries, "libraries");
  const genres = resolveStringList(input.genres, "genres");

  const yearMin = resolveYear(input.yearMin, "yearMin");
  const yearMax = resolveYear(input.yearMax, "yearMax");
  if (yearMin !== null && yearMax !== null && yearMin > yearMax) {
    throw new ReadModelParamError(`yearMin (${yearMin}) must be <= yearMax (${yearMax})`);
  }

  const minRatingParsed = numericOrNull(input.minRating, "minRating");
  let minRating: number | null = null;
  if (minRatingParsed !== null) {
    if (minRatingParsed < 0 || minRatingParsed > MAX_RATING) {
      throw new ReadModelParamError(`minRating must be a number between 0 and ${MAX_RATING}`);
    }
    minRating = minRatingParsed;
  }

  return { q, types, libraries, genres, yearMin, yearMax, minRating, sort, dir };
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function resolveEnumList<T extends string>(value: unknown, allowed: readonly T[], what: string): T[] {
  const entries = listEntries(value);
  const out: T[] = [];
  for (const entry of entries) {
    if (!(allowed as readonly string[]).includes(entry)) {
      throw new ReadModelParamError(
        `${what} "${entry.slice(0, 50)}" is not one of ${allowed.join(", ")}`
      );
    }
    const typed = entry as T;
    if (!out.includes(typed)) out.push(typed);
  }
  return out;
}

function resolveStringList(value: unknown, what: string): string[] {
  const entries = listEntries(value);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.length > MAX_FILTER_VALUE_LENGTH) {
      throw new ReadModelParamError(`${what} entry exceeds ${MAX_FILTER_VALUE_LENGTH} characters`);
    }
    if (!out.includes(entry)) out.push(entry);
  }
  if (out.length > MAX_FILTER_VALUES) {
    throw new ReadModelParamError(`${what} accepts at most ${MAX_FILTER_VALUES} values (got ${out.length})`);
  }
  return out;
}

function listEntries(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value) && typeof value !== "string") {
    throw new ReadModelParamError("filter values must be strings or arrays of strings");
  }
  const raw = Array.isArray(value) ? value : value.split(",");
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new ReadModelParamError("filter values must be strings");
    }
    const trimmed = entry.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}

// Shared numeric knob coercion: numbers pass through, purely numeric strings
// parse, anything else fails closed. null/undefined/empty → null (absent).
function numericOrNull(value: unknown, what: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) {
    throw new ReadModelParamError(`${what} must be a number (got ${JSON.stringify(value)?.slice(0, 50)})`);
  }
  return parsed;
}

function resolveYear(value: unknown, what: string): number | null {
  const parsed = numericOrNull(value, what);
  if (parsed === null) return null;
  if (!Number.isSafeInteger(parsed) || parsed < MIN_YEAR || parsed > MAX_YEAR) {
    throw new ReadModelParamError(`${what} must be an integer between ${MIN_YEAR} and ${MAX_YEAR}`);
  }
  return parsed;
}

// Escapes the LIKE/ILIKE metacharacters so a query containing % or _ matches
// itself, not an arbitrary pattern; the caller wraps the result with the
// surrounding wildcards. Deterministic: identical input, identical output.
export function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}

// Slug-shaped identifiers (profile slug, watchlist slug, collection slug,
// Jellyfin ids) are validated at one choke point: bounded, non-empty. The
// shape is intentionally permissive beyond that — Jellyfin ids are opaque.
export function resolveIdentifier(value: unknown, what: string): string {
  const raw = textOrNull(value);
  if (raw === null) {
    throw new ReadModelParamError(`${what} is required`);
  }
  if (raw.length > MAX_FILTER_VALUE_LENGTH) {
    throw new ReadModelParamError(`${what} exceeds ${MAX_FILTER_VALUE_LENGTH} characters`);
  }
  return raw;
}
