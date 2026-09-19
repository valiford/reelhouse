import type { MediaKind } from "./types";

export const MEDIA_KINDS: readonly MediaKind[] = ["Movie", "Series", "Episode", "Video"];

export const LIST_QUERY_BOUNDS = {
  defaultLimit: 24,
  maxLimit: 50,
  maxOffset: 10_000,
  maxQueryLength: 200,
  minYear: 1878,
  maxYear: 2100
} as const;

export type ListQueryError = { field: string; message: string };

export type ListQuery = {
  q: string;
  kinds: MediaKind[];
  year?: number;
  limit: number;
  offset: number;
};

export type ParsedListQuery =
  | { ok: true; query: ListQuery }
  | { ok: false; error: ListQueryError };

export type ListQueryOptions = {
  defaultLimit?: number;
  requireQuery?: boolean;
};

function parseInteger(raw: string): number | null {
  return /^-?\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

function canonicalKind(raw: string): MediaKind | null {
  const match = MEDIA_KINDS.find((kind) => kind.toLowerCase() === raw.trim().toLowerCase());
  return match ?? null;
}

/**
 * Parse and validate the shared bounded listing contract used by
 * /api/search and /api/library. Every bound is enforced here so no
 * route handler can emit an unbounded upstream or downstream query.
 */
export function parseListQuery(
  params: URLSearchParams,
  options: ListQueryOptions = {}
): ParsedListQuery {
  const defaultLimit = options.defaultLimit ?? LIST_QUERY_BOUNDS.defaultLimit;

  const q = (params.get("q") ?? "").trim();
  if (q.length > LIST_QUERY_BOUNDS.maxQueryLength) {
    return {
      ok: false,
      error: {
        field: "q",
        message: `Search term must be at most ${LIST_QUERY_BOUNDS.maxQueryLength} characters.`
      }
    };
  }
  if (options.requireQuery && !q) {
    return {
      ok: false,
      error: { field: "q", message: "A non-empty q parameter is required." }
    };
  }

  const kinds: MediaKind[] = [];
  const rawKinds = params.get("kind");
  if (rawKinds) {
    for (const part of rawKinds.split(",")) {
      if (!part.trim()) continue;
      const kind = canonicalKind(part);
      if (!kind) {
        return {
          ok: false,
          error: {
            field: "kind",
            message: `Unknown kind "${part.trim()}". Allowed kinds: ${MEDIA_KINDS.join(", ")}.`
          }
        };
      }
      if (!kinds.includes(kind)) kinds.push(kind);
    }
  }

  let year: number | undefined;
  const rawYear = params.get("year");
  if (rawYear) {
    const parsed = parseInteger(rawYear);
    if (parsed === null || parsed < LIST_QUERY_BOUNDS.minYear || parsed > LIST_QUERY_BOUNDS.maxYear) {
      return {
        ok: false,
        error: {
          field: "year",
          message: `year must be an integer between ${LIST_QUERY_BOUNDS.minYear} and ${LIST_QUERY_BOUNDS.maxYear}.`
        }
      };
    }
    year = parsed;
  }

  let limit = defaultLimit;
  const rawLimit = params.get("limit");
  if (rawLimit) {
    const parsed = parseInteger(rawLimit);
    if (parsed === null || parsed < 1 || parsed > LIST_QUERY_BOUNDS.maxLimit) {
      return {
        ok: false,
        error: {
          field: "limit",
          message: `limit must be an integer between 1 and ${LIST_QUERY_BOUNDS.maxLimit}.`
        }
      };
    }
    limit = parsed;
  }

  let offset = 0;
  const rawOffset = params.get("offset");
  if (rawOffset) {
    const parsed = parseInteger(rawOffset);
    if (parsed === null || parsed < 0 || parsed > LIST_QUERY_BOUNDS.maxOffset) {
      return {
        ok: false,
        error: {
          field: "offset",
          message: `offset must be an integer between 0 and ${LIST_QUERY_BOUNDS.maxOffset}.`
        }
      };
    }
    offset = parsed;
  }

  return { ok: true, query: { q, kinds, year, limit, offset } };
}
