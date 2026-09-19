import type { LibraryPayload, MediaItem, SearchPayload } from "./types";
import type { ListQuery } from "./list-query";
import { demoLibrary } from "./demo";

const serverUrl = process.env.JELLYFIN_URL?.replace(/\/$/, "");
const apiKey = process.env.JELLYFIN_API_KEY;
const userId = process.env.JELLYFIN_USER_ID;
const publicUrl = process.env.NEXT_PUBLIC_JELLYFIN_URL?.replace(/\/$/, "") || serverUrl;

export const LIBRARY_SECTIONS = ["Continue Watching", "Recently Added", "Movies", "Shows", "Home Videos"] as const;

type JellyfinItem = {
  Id: string;
  Name: string;
  Type: "Movie" | "Series" | "Episode" | "Video";
  ProductionYear?: number;
  Overview?: string;
  CommunityRating?: number;
  Genres?: string[];
  UserData?: { PlaybackPositionTicks?: number; PlayedPercentage?: number };
  ImageTags?: { Primary?: string };
  BackdropImageTags?: string[];
};

type JellyfinResponse = { Items?: JellyfinItem[]; TotalRecordCount?: number };

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Drop duplicate ids so paged result identity stays deterministic. */
function dedupeById(items: MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function image(id: string, type: "Primary" | "Backdrop", tag?: string) {
  if (!publicUrl || !tag) return undefined;
  const width = type === "Primary" ? 600 : 1600;
  return `${publicUrl}/Items/${id}/Images/${type}?maxWidth=${width}&quality=90&tag=${encodeURIComponent(tag)}`;
}

function mapItem(row: JellyfinItem): MediaItem {
  return {
    id: row.Id,
    title: row.Name,
    year: row.ProductionYear,
    overview: row.Overview,
    kind: row.Type,
    rating: row.CommunityRating,
    genres: row.Genres,
    progress: row.UserData?.PlayedPercentage,
    imageUrl: image(row.Id, "Primary", row.ImageTags?.Primary),
    backdropUrl: image(row.Id, "Backdrop", row.BackdropImageTags?.[0])
  };
}

async function queryItems(params: Record<string, string>, signal?: AbortSignal): Promise<{ items: MediaItem[]; total: number }> {
  if (!serverUrl || !apiKey || !userId) return { items: [], total: 0 };
  const qs = new URLSearchParams({
    Recursive: "true",
    UserId: userId,
    Fields: "Overview,Genres,ProductionYear,CommunityRating,PrimaryImageAspectRatio,UserData",
    ImageTypeLimit: "1",
    EnableImageTypes: "Primary,Backdrop",
    EnableTotalRecordCount: "true",
    ...params
  });
  const response = await fetch(`${serverUrl}/Users/${userId}/Items?${qs}`, {
    headers: { "X-Emby-Token": apiKey },
    cache: "no-store",
    signal
  });
  if (!response.ok) throw new Error(`Jellyfin ${response.status}`);
  const body = (await response.json()) as JellyfinResponse;
  const items = (body.Items || []).map(mapItem);
  return { items, total: typeof body.TotalRecordCount === "number" ? body.TotalRecordCount : items.length };
}

function demoSearchPayload(query: ListQuery): SearchPayload {
  const pool = dedupeById(demoLibrary.sections.flatMap((s) => s.items));
  const filtered = pool.filter((item) => {
    if (query.kinds.length && !query.kinds.includes(item.kind)) return false;
    if (query.year !== undefined && item.year !== query.year) return false;
    return `${item.title} ${item.overview || ""} ${(item.genres || []).join(" ")}`
      .toLowerCase()
      .includes(query.q.toLowerCase());
  });
  return {
    source: "demo",
    query: query.q,
    items: filtered.slice(query.offset, query.offset + query.limit),
    total: filtered.length,
    limit: query.limit,
    offset: query.offset
  };
}

/** Apply the route's section filter and bounded limit to demo data too, so demo and live modes honor the same contract. */
function shapeDemoPayload(options: { sections?: string[]; limit?: number }, degraded = false): LibraryPayload {
  const sections = demoLibrary.sections
    .filter((section) => !options.sections || options.sections.includes(section.title))
    .map((section) => ({ ...section, items: options.limit ? section.items.slice(0, options.limit) : section.items }));
  return { ...demoLibrary, sections, ...(degraded ? { degraded: true } : {}) };
}

export async function getLibrary(options: {
  sections?: string[];
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<LibraryPayload> {
  if (!serverUrl || !apiKey || !userId) return shapeDemoPayload(options);

  try {
    const sectionLimit = options.limit;
    const [recent, movies, series, resume] = await Promise.all([
      queryItems({ IncludeItemTypes: "Movie,Series,Video", SortBy: "DateCreated", SortOrder: "Descending", Limit: "18" }, options.signal),
      queryItems({ IncludeItemTypes: "Movie", SortBy: "SortName", SortOrder: "Ascending", Limit: "24" }, options.signal),
      queryItems({ IncludeItemTypes: "Series", SortBy: "SortName", SortOrder: "Ascending", Limit: "24" }, options.signal),
      queryItems({ IncludeItemTypes: "Movie,Episode,Video", IsResumable: "true", SortBy: "DatePlayed", SortOrder: "Descending", Limit: "12" }, options.signal)
    ]);

    const hero = recent.items.find((x) => x.backdropUrl) || recent.items[0] || movies.items[0] || demoLibrary.hero;
    const payload: LibraryPayload = {
      source: "jellyfin",
      hero,
      sections: [
        { title: "Continue Watching", items: resume.items },
        { title: "Recently Added", items: recent.items },
        { title: "Movies", items: movies.items },
        { title: "Shows", items: series.items }
      ]
        .filter((section) => section.items.length)
        .filter((section) => !options.sections || options.sections.includes(section.title))
        .map((section) => ({
          ...section,
          items: sectionLimit ? section.items.slice(0, sectionLimit) : section.items
        }))
    };
    return payload;
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.error("Falling back to demo library:", error);
    return shapeDemoPayload(options, true);
  }
}

/**
 * Bounded, filtered search. Deterministic ordering (SortName ascending at
 * the upstream, stable demo order locally) and id-deduplicated results so
 * the same query + filters + page always resolve to identical items.
 * Upstream failures throw — the route maps them to an explicit error.
 */
export async function searchLibrary(term: string, query: ListQuery, signal?: AbortSignal): Promise<SearchPayload> {
  if (!term.trim()) return { source: serverUrl && apiKey && userId ? "jellyfin" : "demo", query: term, items: [], total: 0, limit: query.limit, offset: query.offset };
  if (!serverUrl || !apiKey || !userId) return demoSearchPayload({ ...query, q: term });

  const { items, total } = await queryItems(
    {
      IncludeItemTypes: query.kinds.length ? query.kinds.join(",") : "Movie,Series,Episode,Video",
      SearchTerm: term,
      SortBy: "SortName",
      SortOrder: "Ascending",
      StartIndex: String(query.offset),
      Limit: String(query.limit),
      ...(query.year !== undefined ? { Years: String(query.year) } : {})
    },
    signal
  );
  const deduped = dedupeById(items);
  return {
    source: "jellyfin",
    query: term,
    items: deduped,
    total,
    limit: query.limit,
    offset: query.offset
  };
}
