// Recommendation-inputs read model (RH-0034).
//
// Deterministic, bounded candidate buckets a client (or a later ranking job)
// can turn into "recommended for you" rails. This is deliberately an inputs
// model, not a scoring engine: every bucket is one explainable SQL question
// over ReelHouse-owned state, ordered deterministically and capped, so the
// same household + catalog state always yields the same output.
//
// Buckets:
// - topGenres          the profile's taste signature: genres weighted by the
//                      profile's active favorites plus their last
//                      HISTORY_WINDOW playback events (favorites double as
//                      intent; recent history as recency). Ties break
//                      alphabetically; capped at MAX_BUCKETS_GENRES.
// - unwatchedInGenres  active movies/series in the top genres the profile
//                      has never completed (no completed, active watch-state
//                      row), best-rated first — the discovery surface.
// - nextUpEpisodes     the most recent in-progress episode per series, so a
//                      "Continue <series>" rail can offer exactly one card
//                      per show instead of burying the rail in episodes.
// - highlyRatedRecent  quality-led catalog window: active movies/series,
//                      rating then recency — works before any household
//                      state exists (a fresh profile still gets a rail).
//
// Like the other read models: active rows only (catalog tombstones and
// household tombstones both remove items from every bucket), profile-scoped
// where the bucket is about taste, deterministic order everywhere.

import type { QueryResultRow } from "pg";
import type { ReadExecutor } from "./executor.ts";
import { MAX_BUCKETS_GENRES, resolveRailLimit } from "./params.ts";
import { type RailItemRow } from "./home.ts";

// History influences taste through a bounded recent window, not the whole
// append-only log: 100 events is plenty of signal and keeps the query flat.
export const HISTORY_WINDOW = 100;

export interface GenreWeight extends QueryResultRow {
  name: string;
  weight: number;
}

export interface RecommendationInputs {
  topGenres: GenreWeight[];
  unwatchedInGenres: RailItemRow[];
  nextUpEpisodes: RailItemRow[];
  highlyRatedRecent: RailItemRow[];
}

const RAIL_CARD_COLUMNS = `m.id, m.source, m.jellyfin_id,
    l.jellyfin_id AS library_jellyfin_id, l.name AS library_name,
    m.item_type, m.name, m.sort_name, m.original_title,
    m.production_year, m.premiere_date, m.community_rating, m.official_rating,
    m.runtime_ticks, m.primary_image_tag, m.backdrop_image_tag, m.date_created,
    m.series_jellyfin_id, m.series_name, m.season_number, m.episode_number, m.synced_at`;

export async function recommendationInputs(
  executor: ReadExecutor,
  profileId: number,
  rawLimit: unknown = undefined
): Promise<RecommendationInputs> {
  const limit = resolveRailLimit(rawLimit);

  const topGenresResult = await executor.query<GenreWeight>(
    `WITH fav AS (
       SELECT mig.genre_id AS genre_id, 2::bigint AS weight
       FROM household_favorites f
       JOIN media_item_genres mig ON mig.item_id = f.item_id
       WHERE f.profile_id = $1 AND f.removed_at IS NULL AND f.item_id IS NOT NULL
     ),
     hist AS (
       SELECT mig.genre_id AS genre_id, 1::bigint AS weight
       FROM (
         SELECT jellyfin_id FROM household_playback_history
         WHERE profile_id = $1 ORDER BY played_at DESC, id DESC LIMIT ${HISTORY_WINDOW}
       ) h
       JOIN media_items mi ON mi.source = 'jellyfin' AND mi.jellyfin_id = h.jellyfin_id
       JOIN media_item_genres mig ON mig.item_id = mi.id
     )
     SELECT g.name, sum(weights.weight)::int AS weight
     FROM (
       SELECT genre_id, weight FROM fav
       UNION ALL
       SELECT genre_id, weight FROM hist
     ) weights
     JOIN media_genres g ON g.id = weights.genre_id
     GROUP BY g.name
     ORDER BY weight DESC, g.name ASC
     LIMIT ${MAX_BUCKETS_GENRES}`,
    [profileId]
  );
  const topGenres = topGenresResult.rows;

  const unwatchedResult =
    topGenres.length === 0
      ? { rows: [] as RailItemRow[] }
      : await executor.query<RailItemRow>(
          `SELECT ${RAIL_CARD_COLUMNS}
           FROM media_items m
           JOIN media_libraries l ON l.id = m.library_id
           WHERE m.removed_at IS NULL AND l.removed_at IS NULL
             AND m.item_type IN ('movie', 'series')
             AND EXISTS (
               SELECT 1 FROM media_item_genres mig
               JOIN media_genres g ON g.id = mig.genre_id
               WHERE mig.item_id = m.id AND g.name = ANY($1)
             )
             AND NOT EXISTS (
               SELECT 1 FROM household_watch_state hws
               WHERE hws.profile_id = $2
                 AND hws.source = m.source AND hws.jellyfin_id = m.jellyfin_id
                 AND hws.removed_at IS NULL AND hws.completed = true
             )
           ORDER BY m.community_rating DESC NULLS LAST,
                    COALESCE(m.date_created, m.first_seen_at) DESC, m.id DESC
           LIMIT ${limit}`,
          [topGenres.map((row) => row.name), profileId]
        );

  const nextUpResult = await executor.query<RailItemRow>(
    `SELECT DISTINCT ON (m.series_jellyfin_id)
            ${RAIL_CARD_COLUMNS}, hws.position_ticks, hws.duration_ticks, hws.last_played_at
     FROM household_watch_state hws
     JOIN media_items m ON m.source = hws.source AND m.jellyfin_id = hws.jellyfin_id AND m.removed_at IS NULL
     JOIN media_libraries l ON l.id = m.library_id
     WHERE hws.profile_id = $1
       AND hws.removed_at IS NULL AND hws.completed = false AND hws.hidden_from_continue = false
       AND m.item_type = 'episode' AND m.series_jellyfin_id IS NOT NULL
     ORDER BY m.series_jellyfin_id, hws.last_played_at DESC NULLS LAST, m.id DESC
     LIMIT ${limit}`,
    [profileId]
  );

  const highlyRatedResult = await executor.query<RailItemRow>(
    `SELECT ${RAIL_CARD_COLUMNS}
     FROM media_items m
     JOIN media_libraries l ON l.id = m.library_id
     WHERE m.removed_at IS NULL AND l.removed_at IS NULL
       AND m.item_type IN ('movie', 'series')
     ORDER BY m.community_rating DESC NULLS LAST,
              COALESCE(m.date_created, m.first_seen_at) DESC, m.id DESC
     LIMIT ${limit}`
  );

  return {
    topGenres,
    unwatchedInGenres: unwatchedResult.rows,
    nextUpEpisodes: nextUpResult.rows,
    highlyRatedRecent: highlyRatedResult.rows
  };
}
