// Home-row read model (RH-0034): a profile's configured home rows resolved
// into bounded item rails for TV/browser/mobile clients.
//
// Contract:
// - Profile-scoped by construction: every rail query is parameterized by
//   profile_id (resolved from the slug), mirroring the household import's
//   structural isolation — one profile's feed can never read another's
//   favorites, watchlists, or watch state.
// - Rails reflect LIVE household state: rows read the household_* tables the
//   import maintains (favorites/watchlists/collections/home rows), so a
//   tombstoned entry or archived list drops out of the rail on the next
//   read. Curated collections are household-scoped and readable by every
//   profile; watchlists are per-profile.
// - Catalog join is by identity and activity: household entries join
//   media_items on (source, jellyfin_id) with removed_at IS NULL, so an item
//   the catalog has tombstoned (library churn) disappears from rails even
//   though the household row itself survives — Jellyfin-removed media is not
//   offered to clients.
// - Degradation is data, not an error: a home row whose config points at a
//   missing/unconfigured library, collection, or watchlist resolves to an
//   empty rail flagged `unresolved: true`. Fail-closed is reserved for
//   identity (unknown profile) and infrastructure, not editorial config.
// - Bounded: at most MAX_HOME_ROWS_PER_PROFILE rails per request and
//   RAIL_MAX_LIMIT items per rail, every order deterministic.

import type { QueryResultRow } from "pg";
import type { ReadExecutor } from "./executor.ts";
import {
  MAX_HOME_ROWS_PER_PROFILE,
  resolveIdentifier,
  resolveRailLimit,
  ReadModelParamError
} from "./params.ts";
import { type CatalogCardRow } from "./search.ts";

export class HouseholdProfileNotFoundError extends Error {
  constructor(slug: string) {
    super(`no active household profile matches slug "${slug.slice(0, 100)}"`);
    this.name = "HouseholdProfileNotFoundError";
  }
}

export class HouseholdEmptyError extends Error {
  constructor() {
    super("the household has no active profiles (nothing has been imported yet)");
    this.name = "HouseholdEmptyError";
  }
}

export interface HouseholdProfileSummary extends QueryResultRow {
  id: string | number;
  slug: string;
  display_name: string;
  initials: string | null;
  is_default: boolean;
}

export async function listProfiles(executor: ReadExecutor): Promise<HouseholdProfileSummary[]> {
  const result = await executor.query<HouseholdProfileSummary>(
    `SELECT id, slug, display_name, initials, is_default FROM household_profiles
     WHERE archived_at IS NULL
     ORDER BY is_default DESC, slug ASC`
  );
  return result.rows;
}

// Resolves the rail/feed owner: an explicit slug must match an active
// profile; no slug selects THE active default profile, falling back to the
// first active profile by slug when no default exists (a household imported
// before any default was declared is still renderable, deterministically).
export async function resolveProfile(
  executor: ReadExecutor,
  slug: string | null
): Promise<HouseholdProfileSummary> {
  if (slug !== null) {
    const named = await executor.query<HouseholdProfileSummary>(
      `SELECT id, slug, display_name, initials, is_default FROM household_profiles
       WHERE archived_at IS NULL AND slug = $1 LIMIT 1`,
      [slug]
    );
    if (!named.rows.length) throw new HouseholdProfileNotFoundError(slug);
    return named.rows[0];
  }
  const fallback = await executor.query<HouseholdProfileSummary>(
    `SELECT id, slug, display_name, initials, is_default FROM household_profiles
     WHERE archived_at IS NULL
     ORDER BY is_default DESC, slug ASC
     LIMIT 1`
  );
  if (!fallback.rows.length) throw new HouseholdEmptyError();
  return fallback.rows[0];
}

export interface HomeRowRecord extends QueryResultRow {
  id: string | number;
  slug: string;
  kind: string;
  title: string;
  position: number;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface HomeRail {
  slug: string;
  kind: string;
  title: string;
  position: number;
  enabled: boolean;
  resolved: boolean;
  items: RailItemRow[];
}

// A rail item is a catalog card plus whatever household context the rail is
// about (watch progress, list position). Fields are optional because only
// the continue-watching rail carries progress.
export type RailItemRow = CatalogCardRow & {
  position_ticks?: string | null;
  duration_ticks?: string | null;
  last_played_at?: Date | string | null;
  rail_position?: string | number;
};

const RAIL_CARD_COLUMNS = `m.id, m.source, m.jellyfin_id,
    l.jellyfin_id AS library_jellyfin_id, l.name AS library_name,
    m.item_type, m.name, m.sort_name, m.original_title,
    m.production_year, m.premiere_date, m.community_rating, m.official_rating,
    m.runtime_ticks, m.primary_image_tag, m.backdrop_image_tag, m.date_created,
    m.series_jellyfin_id, m.series_name, m.season_number, m.episode_number, m.synced_at`;

const RAIL_FROM = `FROM %TABLE% r
  JOIN media_items m ON m.source = r.source AND m.jellyfin_id = r.jellyfin_id AND m.removed_at IS NULL
  JOIN media_libraries l ON l.id = m.library_id`;

export async function listHomeRows(
  executor: ReadExecutor,
  profileId: number
): Promise<HomeRowRecord[]> {
  const result = await executor.query<HomeRowRecord>(
    `SELECT id, slug, kind, title, position, enabled, config FROM household_home_rows
     WHERE profile_id = $1 AND archived_at IS NULL
     ORDER BY position, id
     LIMIT ${MAX_HOME_ROWS_PER_PROFILE}`,
    [profileId]
  );
  return result.rows;
}

async function continueWatchingRail(
  executor: ReadExecutor,
  profileId: number,
  limit: number
): Promise<RailItemRow[]> {
  const result = await executor.query<RailItemRow>(
    `SELECT ${RAIL_CARD_COLUMNS}, hws.position_ticks, hws.duration_ticks, hws.last_played_at
     FROM household_watch_state hws
     JOIN media_items m ON m.source = hws.source AND m.jellyfin_id = hws.jellyfin_id AND m.removed_at IS NULL
     JOIN media_libraries l ON l.id = m.library_id
     WHERE hws.profile_id = $1
       AND hws.removed_at IS NULL
       AND hws.completed = false
       AND hws.hidden_from_continue = false
     ORDER BY hws.last_played_at DESC NULLS LAST, m.id DESC
     LIMIT ${limit}`,
    [profileId]
  );
  return result.rows;
}

async function recentlyAddedRail(
  executor: ReadExecutor,
  libraryJellyfinId: string | null,
  limit: number
): Promise<RailItemRow[]> {
  const builder = [`m.removed_at IS NULL`, `l.removed_at IS NULL`];
  const params: unknown[] = [];
  if (libraryJellyfinId !== null) {
    params.push(libraryJellyfinId);
    builder.push(`l.jellyfin_id = $${params.length}`);
  }
  const result = await executor.query<RailItemRow>(
    `SELECT ${RAIL_CARD_COLUMNS}
     FROM media_items m
     JOIN media_libraries l ON l.id = m.library_id
     WHERE ${builder.join(" AND ")}
     ORDER BY COALESCE(m.date_created, m.first_seen_at) DESC, m.id DESC
     LIMIT ${limit}`,
    params
  );
  return result.rows;
}

async function favoritesRail(
  executor: ReadExecutor,
  profileId: number,
  limit: number
): Promise<RailItemRow[]> {
  const result = await executor.query<RailItemRow>(
    `SELECT ${RAIL_CARD_COLUMNS}, r.position AS rail_position
     ${RAIL_FROM.replace("%TABLE%", "household_favorites")}
     WHERE r.profile_id = $1 AND r.removed_at IS NULL
     ORDER BY r.position, r.jellyfin_id
     LIMIT ${limit}`,
    [profileId]
  );
  return result.rows;
}

async function libraryRail(
  executor: ReadExecutor,
  libraryJellyfinId: string,
  limit: number
): Promise<RailItemRow[]> {
  const result = await executor.query<RailItemRow>(
    `SELECT ${RAIL_CARD_COLUMNS}
     FROM media_items m
     JOIN media_libraries l ON l.id = m.library_id
     WHERE l.jellyfin_id = $1 AND m.removed_at IS NULL AND l.removed_at IS NULL
     ORDER BY lower(COALESCE(m.sort_name, m.name)), m.id
     LIMIT ${limit}`,
    [libraryJellyfinId]
  );
  return result.rows;
}

async function collectionRail(
  executor: ReadExecutor,
  collectionSlug: string,
  limit: number
): Promise<RailItemRow[]> {
  const result = await executor.query<RailItemRow>(
    `SELECT ${RAIL_CARD_COLUMNS}, r.position AS rail_position
     FROM household_collections c
     JOIN household_collection_entries r ON r.collection_id = c.id AND r.removed_at IS NULL
     JOIN media_items m ON m.source = r.source AND m.jellyfin_id = r.jellyfin_id AND m.removed_at IS NULL
     JOIN media_libraries l ON l.id = m.library_id
     WHERE c.slug = $1 AND c.archived_at IS NULL
     ORDER BY r.position, r.jellyfin_id
     LIMIT ${limit}`,
    [collectionSlug]
  );
  return result.rows;
}

async function watchlistRail(
  executor: ReadExecutor,
  profileId: number,
  watchlistSlug: string,
  limit: number
): Promise<RailItemRow[]> {
  const result = await executor.query<RailItemRow>(
    `SELECT ${RAIL_CARD_COLUMNS}, r.position AS rail_position
     FROM household_watchlists w
     JOIN household_watchlist_entries r ON r.watchlist_id = w.id AND r.removed_at IS NULL
     JOIN media_items m ON m.source = r.source AND m.jellyfin_id = r.jellyfin_id AND m.removed_at IS NULL
     JOIN media_libraries l ON l.id = m.library_id
     WHERE w.profile_id = $1 AND w.slug = $2 AND w.archived_at IS NULL
     ORDER BY r.position, r.jellyfin_id
     LIMIT ${limit}`,
    [profileId, watchlistSlug]
  );
  return result.rows;
}

// The config keys the household import validates for each reference kind.
function configString(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// Target-existence probes: a rail whose config names a library/collection/
// watchlist that no longer exists (or never did) is UNRESOLVED — distinct
// from a live target that merely has no items yet. One bounded probe per
// reference rail keeps the distinction cheap and explicit.
async function libraryExists(executor: ReadExecutor, libraryJellyfinId: string): Promise<boolean> {
  const result = await executor.query(
    "SELECT 1 FROM media_libraries WHERE jellyfin_id = $1 AND removed_at IS NULL LIMIT 1",
    [libraryJellyfinId]
  );
  return result.rows.length > 0;
}

async function collectionExists(executor: ReadExecutor, collectionSlug: string): Promise<boolean> {
  const result = await executor.query(
    "SELECT 1 FROM household_collections WHERE slug = $1 AND archived_at IS NULL LIMIT 1",
    [collectionSlug]
  );
  return result.rows.length > 0;
}

async function watchlistExists(
  executor: ReadExecutor,
  profileId: number,
  watchlistSlug: string
): Promise<boolean> {
  const result = await executor.query(
    "SELECT 1 FROM household_watchlists WHERE profile_id = $1 AND slug = $2 AND archived_at IS NULL LIMIT 1",
    [profileId, watchlistSlug]
  );
  return result.rows.length > 0;
}

export async function resolveHomeRail(
  executor: ReadExecutor,
  profileId: number,
  row: HomeRowRecord,
  rawLimit: unknown = undefined
): Promise<HomeRail> {
  const limit = resolveRailLimit(rawLimit);
  const empty: HomeRail = {
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    position: Number(row.position),
    enabled: row.enabled,
    resolved: false,
    items: []
  };
  if (!row.enabled) return { ...empty, resolved: true };

  switch (row.kind) {
    case "continue_watching": {
      return { ...empty, resolved: true, items: await continueWatchingRail(executor, profileId, limit) };
    }
    case "recently_added": {
      const library = configString(row.config, "library_jellyfin_id");
      if (library !== null && !(await libraryExists(executor, library))) return empty;
      return {
        ...empty,
        resolved: true,
        items: await recentlyAddedRail(executor, library, limit)
      };
    }
    case "favorites": {
      return { ...empty, resolved: true, items: await favoritesRail(executor, profileId, limit) };
    }
    case "library": {
      const library = configString(row.config, "library_jellyfin_id");
      if (library === null) return empty;
      if (!(await libraryExists(executor, library))) return empty;
      return {
        ...empty,
        resolved: true,
        items: await libraryRail(executor, library, limit)
      };
    }
    case "collection": {
      const collection = configString(row.config, "collection_slug");
      if (collection === null) return empty;
      if (!(await collectionExists(executor, collection))) return empty;
      return {
        ...empty,
        resolved: true,
        items: await collectionRail(executor, collection, limit)
      };
    }
    case "watchlist": {
      const watchlist = configString(row.config, "watchlist_slug");
      if (watchlist === null) return empty;
      if (!(await watchlistExists(executor, profileId, watchlist))) return empty;
      return {
        ...empty,
        resolved: true,
        items: await watchlistRail(executor, profileId, watchlist, limit)
      };
    }
    default:
      // The schema constrains kind to the closed set; an unknown kind here
      // would mean the constraint was altered underneath us — fail closed.
      throw new ReadModelParamError(`home row "${row.slug}" has unknown kind "${String(row.kind).slice(0, 50)}"`);
  }
}

export interface HomeFeed {
  profile: HouseholdProfileSummary;
  rows: HomeRail[];
  perRailLimit: number;
}

export async function homeFeed(
  executor: ReadExecutor,
  options: { profileSlug?: unknown; limit?: unknown } = {}
): Promise<HomeFeed> {
  const slug = options.profileSlug === undefined ? null : resolveIdentifier(options.profileSlug, "profile");
  const limit = resolveRailLimit(options.limit);
  const profile = await resolveProfile(executor, slug);
  const rows = await listHomeRows(executor, Number(profile.id));
  const rails: HomeRail[] = [];
  for (const row of rows) {
    rails.push(await resolveHomeRail(executor, Number(profile.id), row, limit));
  }
  return { profile, rows: rails, perRailLimit: limit };
}
