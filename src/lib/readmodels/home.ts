// Catalog-backed home payload (RH-0040): the household's home-screen rails
// served from PostgreSQL instead of live Jellyfin calls.
//
// Contract:
// - The payload is presentation-bounded: every rail is a single indexed,
//   LIMIT-clamped query over active (non-tombstoned) rows. Household rails
//   are strictly per profile — every query filters by the resolved profile,
//   so profile isolation is structural, not a post-filter.
// - Household rows carry (source, jellyfin_id) identity plus a nullable
//   catalog link (filled by the import). Display needs the catalog row, so
//   entries whose link is missing or whose catalog item is tombstoned are
//   skipped here — the household state itself is never touched by reads.
// - Configured home rows (household_home_rows) drive the rails; a profile
//   without any falls back to the built-in defaults. A reference to a
//   missing library/collection/watchlist yields an empty rail (dropped from
//   the payload), never an error: catalog and household catch up
//   independently by design.
// - An empty catalog (no active media_items) reports `empty-catalog` so the
//   route can fall back to the legacy Jellyfin/demo path — a database that
//   is configured but not yet synced must not blank the home screen.
// - Hero: the newest recently-added item that carries a backdrop, else the
//   first item of the first non-empty rail.

import type { LibraryPayload, MediaItem } from "../types";
import {
  ITEM_PROJECTION,
  READ_MODEL_LIMITS,
  publicJellyfinUrl,
  toMediaItem,
  type CatalogItemRow,
  type ReadExecutor
} from "./items.ts";

export type HomeResult =
  | { kind: "ok"; payload: LibraryPayload }
  | { kind: "empty-catalog" }
  | { kind: "profile-not-found"; detail: string };

interface ProfileRow {
  id: string | number;
  slug: string;
  display_name: string;
}

interface HomeRowConfigRow {
  slug: string;
  kind: string;
  title: string;
  config: unknown;
}

const CONFIG_KEYS: Record<string, string | null> = {
  continue_watching: null,
  recently_added: null,
  favorites: null,
  library: "library_jellyfin_id",
  collection: "collection_slug",
  watchlist: "watchlist_slug"
};

// Resolves the profile a payload is built for: the explicit slug (active
// only, fail-closed when unknown or archived), else the default active
// profile, else the lowest-id active profile.
export async function resolveProfile(
  executor: ReadExecutor,
  profileSlug: string | null
): Promise<ProfileRow | null> {
  const result = await executor.query<ProfileRow>(
    `SELECT id, slug, display_name FROM household_profiles
      WHERE archived_at IS NULL AND ($1::text IS NULL OR slug = $1)
      ORDER BY ($1::text IS NOT NULL) DESC, is_default DESC, id
      LIMIT 1`,
    [profileSlug]
  );
  return result.rows[0] ?? null;
}

// Explicit slug must match exactly; the fallback query above could quietly
// answer a different profile, so an unknown named profile is rejected here.
export async function requireProfile(
  executor: ReadExecutor,
  profileSlug: string | null
): Promise<ProfileRow | null> {
  const profile = await resolveProfile(executor, profileSlug);
  if (profileSlug !== null && (!profile || profile.slug !== profileSlug)) return null;
  return profile;
}

// A synced catalog is the switch between the catalog-backed read models and
// the legacy Jellyfin/demo path: until the first sync lands active rows,
// routes fall back rather than serve empty shells.
export async function catalogHasActiveItems(executor: ReadExecutor): Promise<boolean> {
  const result = await executor.query<{ present: number }>(
    "SELECT 1 AS present FROM media_items WHERE removed_at IS NULL LIMIT 1"
  );
  return result.rows.length > 0;
}

// One rail: rows in, MediaItems out. The projection's genre subselect is
// correlated per row; rails stay bounded by their LIMIT, so this stays a
// per-row indexed lookup.
function toItems(rows: CatalogItemRow[], publicBaseUrl: string | undefined, withProgress: boolean): MediaItem[] {
  return rows.map((row) =>
    toMediaItem(row, publicBaseUrl, withProgress ? (row.position_ticks ?? null) : undefined)
  );
}

async function railQuery(
  executor: ReadExecutor,
  sql: string,
  params: unknown[]
): Promise<CatalogItemRow[]> {
  return (await executor.query<CatalogItemRow>(sql, params)).rows;
}

async function continueWatchingRail(
  executor: ReadExecutor,
  profileId: number,
  publicBaseUrl: string | undefined
): Promise<MediaItem[]> {
  const rows = await railQuery(
    executor,
    `SELECT ${ITEM_PROJECTION}, w.position_ticks, w.duration_ticks
       FROM household_watch_state w
       JOIN media_items m ON m.id = w.item_id AND m.removed_at IS NULL
      WHERE w.profile_id = $1
        AND w.removed_at IS NULL AND w.hidden_from_continue = false
        AND w.completed = false AND w.position_ticks IS NOT NULL AND w.position_ticks > 0
      ORDER BY w.last_played_at DESC NULLS LAST, w.jellyfin_id
      LIMIT $2`,
    [profileId, READ_MODEL_LIMITS.continueItems]
  );
  return toItems(rows, publicBaseUrl, true);
}

async function recentlyAddedRail(
  executor: ReadExecutor,
  publicBaseUrl: string | undefined
): Promise<MediaItem[]> {
  const rows = await railQuery(
    executor,
    `SELECT ${ITEM_PROJECTION}
       FROM media_items m
      WHERE m.removed_at IS NULL AND m.item_type IN ('movie', 'series')
      ORDER BY m.date_created DESC NULLS LAST, m.id
      LIMIT $1`,
    [READ_MODEL_LIMITS.railItems]
  );
  return toItems(rows, publicBaseUrl, false);
}

async function favoritesRail(
  executor: ReadExecutor,
  profileId: number,
  publicBaseUrl: string | undefined
): Promise<MediaItem[]> {
  const rows = await railQuery(
    executor,
    `SELECT ${ITEM_PROJECTION}
       FROM household_favorites f
       JOIN media_items m ON m.id = f.item_id AND m.removed_at IS NULL
      WHERE f.profile_id = $1 AND f.removed_at IS NULL
      ORDER BY f.position, f.first_added_at, f.jellyfin_id
      LIMIT $2`,
    [profileId, READ_MODEL_LIMITS.railItems]
  );
  return toItems(rows, publicBaseUrl, false);
}

async function libraryRail(
  executor: ReadExecutor,
  libraryJellyfinId: string,
  publicBaseUrl: string | undefined
): Promise<MediaItem[]> {
  const rows = await railQuery(
    executor,
    `SELECT ${ITEM_PROJECTION}
       FROM media_items m
       JOIN media_libraries l ON l.id = m.library_id AND l.removed_at IS NULL
      WHERE l.jellyfin_id = $1 AND m.removed_at IS NULL AND m.item_type IN ('movie', 'series')
      ORDER BY lower(m.name), m.id
      LIMIT $2`,
    [libraryJellyfinId, READ_MODEL_LIMITS.railItems]
  );
  return toItems(rows, publicBaseUrl, false);
}

async function collectionRail(
  executor: ReadExecutor,
  collectionSlug: string,
  publicBaseUrl: string | undefined
): Promise<MediaItem[]> {
  const rows = await railQuery(
    executor,
    `SELECT ${ITEM_PROJECTION}
       FROM household_collections c
       JOIN household_collection_entries e ON e.collection_id = c.id AND e.removed_at IS NULL
       JOIN media_items m ON m.id = e.item_id AND m.removed_at IS NULL
      WHERE c.slug = $1 AND c.archived_at IS NULL
      ORDER BY e.position, e.first_added_at, e.jellyfin_id
      LIMIT $2`,
    [collectionSlug, READ_MODEL_LIMITS.railItems]
  );
  return toItems(rows, publicBaseUrl, false);
}

async function watchlistRail(
  executor: ReadExecutor,
  profileId: number,
  watchlistSlug: string,
  publicBaseUrl: string | undefined
): Promise<MediaItem[]> {
  const rows = await railQuery(
    executor,
    `SELECT ${ITEM_PROJECTION}
       FROM household_watchlists w
       JOIN household_watchlist_entries e ON e.watchlist_id = w.id AND e.removed_at IS NULL
       JOIN media_items m ON m.id = e.item_id AND m.removed_at IS NULL
      WHERE w.profile_id = $1 AND w.slug = $2 AND w.archived_at IS NULL
      ORDER BY e.position, e.first_added_at, e.jellyfin_id
      LIMIT $3`,
    [profileId, watchlistSlug, READ_MODEL_LIMITS.railItems]
  );
  return toItems(rows, publicBaseUrl, false);
}

// Extracts the one config key a reference kind may carry; anything else
// (missing, non-string, extra) makes the rail skippable rather than fatal.
function configValue(config: unknown, key: string | null): string | null {
  if (!key || !config || typeof config !== "object" || Array.isArray(config)) return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}

interface Section {
  kind: string;
  title: string;
  items: MediaItem[];
}

async function buildSection(
  executor: ReadExecutor,
  profile: ProfileRow,
  row: HomeRowConfigRow,
  publicBaseUrl: string | undefined
): Promise<Section | null> {
  const profileId = Number(profile.id);
  switch (row.kind) {
    case "continue_watching":
      return { kind: row.kind, title: row.title, items: await continueWatchingRail(executor, profileId, publicBaseUrl) };
    case "recently_added":
      return { kind: row.kind, title: row.title, items: await recentlyAddedRail(executor, publicBaseUrl) };
    case "favorites":
      return { kind: row.kind, title: row.title, items: await favoritesRail(executor, profileId, publicBaseUrl) };
    case "library": {
      const libraryId = configValue(row.config, CONFIG_KEYS.library);
      if (!libraryId) return null;
      return { kind: row.kind, title: row.title, items: await libraryRail(executor, libraryId, publicBaseUrl) };
    }
    case "collection": {
      const collectionSlug = configValue(row.config, CONFIG_KEYS.collection);
      if (!collectionSlug) return null;
      return { kind: row.kind, title: row.title, items: await collectionRail(executor, collectionSlug, publicBaseUrl) };
    }
    case "watchlist": {
      const watchlistSlug = configValue(row.config, CONFIG_KEYS.watchlist);
      if (!watchlistSlug) return null;
      return {
        kind: row.kind,
        title: row.title,
        items: await watchlistRail(executor, profileId, watchlistSlug, publicBaseUrl)
      };
    }
    default:
      // The loader's closed kind set plus migration drift: skip, don't fail.
      return null;
  }
}

// Built-in rails for a profile with no configured home rows, mirroring the
// legacy rails. Empty sections are dropped by the same filter as configured
// ones.
function defaultHomeRowConfigs(): HomeRowConfigRow[] {
  return [
    { slug: "default_continue_watching", kind: "continue_watching", title: "Continue Watching", config: {} },
    { slug: "default_recently_added", kind: "recently_added", title: "Recently Added", config: {} },
    { slug: "default_movies", kind: "library", title: "Movies", config: null },
    { slug: "default_series", kind: "library", title: "Shows", config: null }
  ];
}

// The Movies/Shows defaults are type-based, not library-based: they show the
// catalog's movies and series regardless of which virtual folder holds them.
async function buildDefaultSection(
  executor: ReadExecutor,
  profile: ProfileRow,
  row: HomeRowConfigRow,
  publicBaseUrl: string | undefined
): Promise<Section | null> {
  if (row.kind === "library" && row.slug === "default_movies") {
    const rows = await railQuery(
      executor,
      `SELECT ${ITEM_PROJECTION}
         FROM media_items m
        WHERE m.removed_at IS NULL AND m.item_type = 'movie'
        ORDER BY lower(m.name), m.id
        LIMIT $1`,
      [READ_MODEL_LIMITS.railItems]
    );
    return { kind: row.kind, title: row.title, items: toItems(rows, publicBaseUrl, false) };
  }
  if (row.kind === "library" && row.slug === "default_series") {
    const rows = await railQuery(
      executor,
      `SELECT ${ITEM_PROJECTION}
         FROM media_items m
        WHERE m.removed_at IS NULL AND m.item_type = 'series'
        ORDER BY lower(m.name), m.id
        LIMIT $1`,
      [READ_MODEL_LIMITS.railItems]
    );
    return { kind: row.kind, title: row.title, items: toItems(rows, publicBaseUrl, false) };
  }
  return buildSection(executor, profile, row, publicBaseUrl);
}

export interface HomeOptions {
  profileSlug?: string | null;
  env?: Record<string, string | undefined>;
}

// Builds the household home payload from the catalog. The three non-ok
// outcomes are data, not errors: `empty-catalog` asks the route to fall back
// to the legacy Jellyfin/demo path; `profile-not-found` is a 404.
export async function getHomePayload(executor: ReadExecutor, options: HomeOptions = {}): Promise<HomeResult> {
  const profileSlug = options.profileSlug?.trim() || null;
  const publicBaseUrl = publicJellyfinUrl(options.env ?? process.env);

  // The synced-catalog check comes first: a database that is configured but
  // not yet synced (no catalog, maybe no household import either) must fall
  // back to the legacy path, never 404 for a missing default profile.
  if (!(await catalogHasActiveItems(executor))) return { kind: "empty-catalog" };

  const profile = await requireProfile(executor, profileSlug);
  if (!profile) {
    return { kind: "profile-not-found", detail: `no active household profile "${profileSlug ?? "(default)"}"` };
  }

  const configuredRows = (
    await executor.query<HomeRowConfigRow>(
      `SELECT slug, kind, title, config FROM household_home_rows
        WHERE profile_id = $1 AND archived_at IS NULL AND enabled
        ORDER BY position, slug`,
      [profile.id]
    )
  ).rows;
  const homeRows = configuredRows.length ? configuredRows : defaultHomeRowConfigs();

  const builder = configuredRows.length ? buildSection : buildDefaultSection;
  const sections: Section[] = [];
  for (const row of homeRows) {
    const section = await builder(executor, profile, row, publicBaseUrl);
    if (section && section.items.length > 0) sections.push(section);
  }

  // Hero preference: the recently-added rail (the "what's new" surface) —
  // newest item with a backdrop first — else the first rail that can paint
  // one, else simply the first item of the first rail.
  const recent = sections.find((section) => section.kind === "recently_added");
  const hero =
    recent?.items.find((item) => item.backdropUrl) ??
    recent?.items[0] ??
    sections.find((section) => section.items.some((item) => item.backdropUrl))?.items.find((item) => item.backdropUrl) ??
    sections[0]?.items[0];
  if (!hero) {
    // Catalog rows exist but nothing any rail shows (e.g. only episodes
    // synced): fall back rather than render an empty shell.
    const fallback = await railQuery(
      executor,
      `SELECT ${ITEM_PROJECTION}
         FROM media_items m
        WHERE m.removed_at IS NULL
        ORDER BY m.date_created DESC NULLS LAST, m.id
        LIMIT 1`,
      []
    );
    if (!fallback.length) return { kind: "empty-catalog" };
    const [item] = toItems(fallback, publicBaseUrl, false);
    return { kind: "ok", payload: { source: "catalog", hero: item, sections: [] } };
  }

  return {
    kind: "ok",
    payload: { source: "catalog", hero, sections: sections.map(({ title, items }) => ({ title, items })) }
  };
}
