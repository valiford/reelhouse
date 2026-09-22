// Full-library catalog synchronization: Jellyfin → PostgreSQL media_catalog.
//
// Contract (RH-0031):
// - The run is one reconciliation pass: libraries are upserted, items are
//   paged per library in bounded batch transactions, and anything in a
//   synced library that Jellyfin no longer reports is tombstoned
//   (removed_at), never deleted. Tombstones are scoped to libraries the run
//   actually confirmed, so a partial run never touches unconfirmed state.
// - Idempotent: re-running against an unchanged Jellyfin rewrites the same
//   values (freshness timestamps advance; content does not), appends one
//   sync-run history row, and creates no new rows.
// - Provenance-preserving: first_seen_at is set once and never rewritten,
//   facet rows are re-derived from what Jellyfin reported per item, removals
//   are tombstones, and every row carries (source, jellyfin_id) identity.
// - Fail-closed: an item without a stable identity aborts the run, and a
//   source that reports zero libraries is treated as a misconfigured or
//   degraded source (refusing to reconcile the catalog to empty), not as an
//   empty catalog.
// - A failed run leaves committed progress in place (batch-sized
//   transactions), records the failure in media_sync_runs with a scrubbed
//   error detail, and throws CatalogSyncError carrying the run summary — so
//   the next run is a clean recovery.

import type { QueryResultRow } from "pg";
import { CATALOG_SYNC_DEFAULTS, CATALOG_SYNC_LIMITS, type CatalogSource } from "./source.ts";
import {
  normalizeItem,
  type NormalizedItem,
  type JellyfinItemPayload
} from "./normalize.ts";

// The executor is deliberately minimal so the sync runs against a pg Pool,
// a pg Client, or a test double. Transactions are explicit: a pg Pool must
// not interleave BEGIN/COMMIT across its clients, so withTransaction pins
// one connection for the whole batch.
export interface SyncExecutor {
  query<R extends QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  withTransaction<R>(fn: (tx: SyncExecutor) => Promise<R>): Promise<R>;
}

export interface CatalogSyncCounters {
  librariesSeen: number;
  itemsSeen: number;
  itemsUpserted: number;
  itemsTombstoned: number;
  itemsSkipped: number;
  pagesFetched: number;
}

export interface CatalogSyncResult extends CatalogSyncCounters {
  runId: number;
  status: "succeeded";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface CatalogSyncFailure extends CatalogSyncCounters {
  runId: number;
  status: "failed";
  errorDetail: string;
}

export class CatalogSyncError extends Error {
  readonly summary: CatalogSyncFailure;

  constructor(message: string, summary: CatalogSyncFailure) {
    super(message);
    this.name = "CatalogSyncError";
    this.summary = summary;
  }
}

export interface CatalogSyncOptions {
  // Items fetched per Jellyfin page and committed per transaction.
  // Bounded: see CATALOG_SYNC_LIMITS.pageSize.
  pageSize?: number;
}

interface ItemIdRow extends QueryResultRow {
  id: string | number;
}

const INSERT_RUN = `INSERT INTO media_sync_runs (source, mode, status)
  VALUES ('jellyfin', 'full', 'running') RETURNING id`;

const UPSERT_LIBRARY = `INSERT INTO media_libraries (source, jellyfin_id, name, collection_type)
  VALUES ('jellyfin', $1, $2, $3)
  ON CONFLICT (source, jellyfin_id) DO UPDATE SET
    name = EXCLUDED.name,
    collection_type = EXCLUDED.collection_type,
    synced_at = now(),
    last_seen_at = now(),
    removed_at = NULL
  RETURNING id`;

// 26 positional params, columns in migration 0003 order after identity.
const UPSERT_ITEM = `INSERT INTO media_items (
    source, jellyfin_id, library_id, item_type, name, original_title, sort_name,
    overview, production_year, premiere_date, community_rating, official_rating,
    runtime_ticks, container, file_path, file_size_bytes, media_streams,
    primary_image_tag, backdrop_image_tag, etag, date_created, parent_jellyfin_id,
    series_jellyfin_id, series_name, season_jellyfin_id, season_number, episode_number
  ) VALUES (
    'jellyfin', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
    $16::jsonb, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
  )
  ON CONFLICT (source, jellyfin_id) DO UPDATE SET
    library_id = EXCLUDED.library_id,
    item_type = EXCLUDED.item_type,
    name = EXCLUDED.name,
    original_title = EXCLUDED.original_title,
    sort_name = EXCLUDED.sort_name,
    overview = EXCLUDED.overview,
    production_year = EXCLUDED.production_year,
    premiere_date = EXCLUDED.premiere_date,
    community_rating = EXCLUDED.community_rating,
    official_rating = EXCLUDED.official_rating,
    runtime_ticks = EXCLUDED.runtime_ticks,
    container = EXCLUDED.container,
    file_path = EXCLUDED.file_path,
    file_size_bytes = EXCLUDED.file_size_bytes,
    media_streams = EXCLUDED.media_streams,
    primary_image_tag = EXCLUDED.primary_image_tag,
    backdrop_image_tag = EXCLUDED.backdrop_image_tag,
    etag = EXCLUDED.etag,
    date_created = EXCLUDED.date_created,
    parent_jellyfin_id = EXCLUDED.parent_jellyfin_id,
    series_jellyfin_id = EXCLUDED.series_jellyfin_id,
    series_name = EXCLUDED.series_name,
    season_jellyfin_id = EXCLUDED.season_jellyfin_id,
    season_number = EXCLUDED.season_number,
    episode_number = EXCLUDED.episode_number,
    synced_at = now(),
    last_seen_at = now(),
    removed_at = NULL
  RETURNING id`;

const UPSERT_GENRE = `INSERT INTO media_genres (source, name) VALUES ('jellyfin', $1)
  ON CONFLICT (source, name) DO UPDATE SET name = EXCLUDED.name
  RETURNING id`;

const UPSERT_STUDIO = `INSERT INTO media_studios (source, name) VALUES ('jellyfin', $1)
  ON CONFLICT (source, name) DO UPDATE SET name = EXCLUDED.name
  RETURNING id`;

// A later payload that omits a person's Id must never erase a previously
// known one — hence COALESCE instead of blind overwrite.
const UPSERT_PERSON = `INSERT INTO media_people (source, name, jellyfin_id)
  VALUES ('jellyfin', $1, $2)
  ON CONFLICT (source, name) DO UPDATE SET
    jellyfin_id = COALESCE(EXCLUDED.jellyfin_id, media_people.jellyfin_id)
  RETURNING id`;

const RESET_ITEM_GENRES = "DELETE FROM media_item_genres WHERE item_id = $1";
const INSERT_ITEM_GENRES = `INSERT INTO media_item_genres (item_id, genre_id)
  SELECT $1, g.id FROM unnest($2::bigint[]) AS g(id)`;
const RESET_ITEM_STUDIOS = "DELETE FROM media_item_studios WHERE item_id = $1";
const INSERT_ITEM_STUDIOS = `INSERT INTO media_item_studios (item_id, studio_id)
  SELECT $1, s.id FROM unnest($2::bigint[]) AS s(id)`;
const RESET_ITEM_PEOPLE = "DELETE FROM media_item_people WHERE item_id = $1";
const INSERT_ITEM_PEOPLE = `INSERT INTO media_item_people (item_id, person_id, person_type, role_name, list_order)
  SELECT $1, p.id, f.person_type, f.role_name, f.ord
  FROM unnest($2::text[], $3::text[], $4::text[]) WITH ORDINALITY
    AS f(name, person_type, role_name, ord)
  JOIN media_people p ON p.source = 'jellyfin' AND p.name = f.name`;
const RESET_ITEM_PROVIDER_IDS = "DELETE FROM media_item_provider_ids WHERE item_id = $1";
const INSERT_ITEM_PROVIDER_IDS = `INSERT INTO media_item_provider_ids (item_id, provider_name, provider_value)
  SELECT $1, f.name, f.value FROM unnest($2::text[], $3::text[]) AS f(name, value)`;

const COMPLETE_RUN = `UPDATE media_sync_runs SET
    status = $2, finished_at = now(), libraries_seen = $3, items_seen = $4,
    items_upserted = $5, items_tombstoned = $6, items_skipped = $7,
    pages_fetched = $8, error_detail = $9
  WHERE id = $1`;

export async function runFullCatalogSync(
  source: CatalogSource,
  executor: SyncExecutor,
  options: CatalogSyncOptions = {}
): Promise<CatalogSyncResult> {
  const pageSize = options.pageSize ?? CATALOG_SYNC_DEFAULTS.pageSize;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < CATALOG_SYNC_LIMITS.pageSize.min ||
    pageSize > CATALOG_SYNC_LIMITS.pageSize.max
  ) {
    throw new Error(
      `pageSize must be between ${CATALOG_SYNC_LIMITS.pageSize.min} and ${CATALOG_SYNC_LIMITS.pageSize.max} (got ${pageSize})`
    );
  }

  const startedMs = Date.now();
  const startedAt = new Date().toISOString();
  const counters: CatalogSyncCounters = {
    librariesSeen: 0,
    itemsSeen: 0,
    itemsUpserted: 0,
    itemsTombstoned: 0,
    itemsSkipped: 0,
    pagesFetched: 0
  };

  const runRow = await executor.query<ItemIdRow>(INSERT_RUN);
  const runId = Number(runRow.rows[0].id);

  try {
    const libraries = await source.listLibraries();
    if (libraries.length === 0) {
      // Reconciling against an empty library list would tombstone the whole
      // catalog. That outcome is far more likely a permission or URL
      // misconfiguration than a genuinely emptied server: fail closed.
      throw new Error(
        "Jellyfin reported no libraries; refusing to reconcile the catalog to empty (check JELLYFIN_URL / API key scope)"
      );
    }
    counters.librariesSeen = libraries.length;

    const libraryIds = new Map<string, number>();
    for (const library of libraries) {
      const row = await executor.query<ItemIdRow>(UPSERT_LIBRARY, [
        library.jellyfinId,
        library.name,
        library.collectionType
      ]);
      libraryIds.set(library.jellyfinId, Number(row.rows[0].id));
    }

    // Seen pairs drive tombstoning, aligned per item: (library row id,
    // item jellyfin id) with one entry per item actually seen.
    const seenItemLibraryIds: number[] = [];
    const seenItemIds: string[] = [];

    for (const library of libraries) {
      const libraryId = libraryIds.get(library.jellyfinId);
      if (libraryId === undefined) throw new Error(`internal: library ${library.jellyfinId} was not upserted`);

      let startIndex = 0;
      for (;;) {
        const page = await source.fetchItemsPage(library.jellyfinId, startIndex, pageSize);
        counters.pagesFetched += 1;
        if (page.items.length === 0) break;

        // One bounded transaction per page: progress is durable in
        // batch-sized units, and a mid-run failure leaves earlier pages
        // committed for the recovery run. Counters and the seen list merge
        // only after the batch commits, so a rollback never over-reports.
        const batch = await executor.withTransaction(async (tx) => {
          const seen: string[] = [];
          let upserted = 0;
          let skipped = 0;
          for (const raw of page.items) {
            const normalized = normalizeItem(raw as JellyfinItemPayload, library.jellyfinId);
            if (!normalized) {
              skipped += 1;
              continue;
            }
            await upsertItemWithFacets(tx, libraryId, normalized);
            seen.push(normalized.jellyfinId);
            upserted += 1;
          }
          return { seen, upserted, skipped };
        });
        counters.itemsSeen += page.items.length;
        counters.itemsUpserted += batch.upserted;
        counters.itemsSkipped += batch.skipped;
        seenItemIds.push(...batch.seen);
        seenItemLibraryIds.push(...batch.seen.map(() => libraryId));

        startIndex += page.items.length;
        if (page.items.length < pageSize) break;
        if (page.totalRecordCount !== null && startIndex >= page.totalRecordCount) break;
      }
    }

    const tombstoned = await reconcileRemovals(
      executor,
      seenItemLibraryIds,
      seenItemIds,
      libraries.map((l) => l.jellyfinId)
    );
    counters.itemsTombstoned = tombstoned;

    const finishedAt = new Date().toISOString();
    await executor.query(COMPLETE_RUN, [
      runId,
      "succeeded",
      counters.librariesSeen,
      counters.itemsSeen,
      counters.itemsUpserted,
      counters.itemsTombstoned,
      counters.itemsSkipped,
      counters.pagesFetched,
      null
    ]);
    return {
      runId,
      status: "succeeded",
      ...counters,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs
    };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    // The run record must reflect the failure, but the original error wins
    // if even the bookkeeping write fails.
    try {
      await executor.query(COMPLETE_RUN, [
        runId,
        "failed",
        counters.librariesSeen,
        counters.itemsSeen,
        counters.itemsUpserted,
        counters.itemsTombstoned,
        counters.itemsSkipped,
        counters.pagesFetched,
        detail
      ]);
    } catch {
      /* original failure is reported instead */
    }
    throw new CatalogSyncError(`Catalog sync failed: ${detail}`, {
      runId,
      status: "failed",
      ...counters,
      errorDetail: detail
    });
  }
}

async function upsertItemWithFacets(
  tx: SyncExecutor,
  libraryId: number,
  item: NormalizedItem
): Promise<void> {
  const itemRow = await tx.query<ItemIdRow>(UPSERT_ITEM, [
    item.jellyfinId,
    libraryId,
    item.itemType,
    item.name,
    item.originalTitle,
    item.sortName,
    item.overview,
    item.productionYear,
    item.premiereDate,
    item.communityRating,
    item.officialRating,
    item.runtimeTicks,
    item.container,
    item.filePath,
    item.fileSizeBytes,
    JSON.stringify(item.mediaStreams),
    item.primaryImageTag,
    item.backdropImageTag,
    item.etag,
    item.dateCreated,
    item.parentJellyfinId,
    item.seriesJellyfinId,
    item.seriesName,
    item.seasonJellyfinId,
    item.seasonNumber,
    item.episodeNumber
  ]);
  const itemId = Number(itemRow.rows[0].id);

  const genreIds: number[] = [];
  for (const genre of item.genres) {
    const row = await tx.query<ItemIdRow>(UPSERT_GENRE, [genre]);
    genreIds.push(Number(row.rows[0].id));
  }
  const studioIds: number[] = [];
  for (const studio of item.studios) {
    const row = await tx.query<ItemIdRow>(UPSERT_STUDIO, [studio]);
    studioIds.push(Number(row.rows[0].id));
  }
  const personIds: number[] = [];
  for (const person of item.people) {
    const row = await tx.query<ItemIdRow>(UPSERT_PERSON, [person.name, person.jellyfinId]);
    personIds.push(Number(row.rows[0].id));
  }

  // Facet joins always mirror exactly what this item's payload said.
  await tx.query(RESET_ITEM_GENRES, [itemId]);
  if (genreIds.length) {
    await tx.query(INSERT_ITEM_GENRES, [itemId, genreIds]);
  }
  await tx.query(RESET_ITEM_STUDIOS, [itemId]);
  if (studioIds.length) {
    await tx.query(INSERT_ITEM_STUDIOS, [itemId, studioIds]);
  }
  await tx.query(RESET_ITEM_PEOPLE, [itemId]);
  if (item.people.length) {
    await tx.query(INSERT_ITEM_PEOPLE, [
      itemId,
      item.people.map((p) => p.name),
      item.people.map((p) => p.personType),
      item.people.map((p) => p.roleName)
    ]);
  }
  await tx.query(RESET_ITEM_PROVIDER_IDS, [itemId]);
  if (item.providerIds.length) {
    await tx.query(INSERT_ITEM_PROVIDER_IDS, [
      itemId,
      item.providerIds.map((p) => p.name),
      item.providerIds.map((p) => p.value)
    ]);
  }
}

// Tombstones everything in the confirmed libraries that this run did not see,
// and libraries that no longer exist. Runs in one transaction so the catalog
// never shows a half-applied reconciliation.
async function reconcileRemovals(
  executor: SyncExecutor,
  seenItemLibraryIds: number[],
  seenItemIds: string[],
  seenLibraryJellyfinIds: string[]
): Promise<number> {
  return executor.withTransaction(async (tx) => {
    // A previous rolled-back transaction in this session can leave the temp
    // table behind (ON COMMIT DROP only fires on commit); drop defensively.
    await tx.query("DROP TABLE IF EXISTS sync_seen_items");
    await tx.query(
      `CREATE TEMP TABLE sync_seen_items (
         library_id bigint NOT NULL,
         item_jellyfin_id text NOT NULL,
         PRIMARY KEY (library_id, item_jellyfin_id)
       ) ON COMMIT DROP`
    );
    await tx.query(
      `INSERT INTO sync_seen_items (library_id, item_jellyfin_id)
       SELECT * FROM unnest($1::bigint[], $2::text[]) AS t(library_id, item_jellyfin_id)
       ON CONFLICT (library_id, item_jellyfin_id) DO NOTHING`,
      [seenItemLibraryIds, seenItemIds]
    );

    const removed = await tx.query<ItemIdRow>(
      `UPDATE media_items m SET removed_at = now()
       WHERE m.source = 'jellyfin'
         AND m.removed_at IS NULL
         AND m.library_id IN (SELECT library_id FROM sync_seen_items)
         AND NOT EXISTS (
           SELECT 1 FROM sync_seen_items s
           WHERE s.library_id = m.library_id AND s.item_jellyfin_id = m.jellyfin_id
         )
       RETURNING m.id`
    );

    await tx.query(
      `UPDATE media_libraries SET removed_at = now()
       WHERE source = 'jellyfin' AND removed_at IS NULL
         AND jellyfin_id <> ALL($1::text[])`,
      [seenLibraryJellyfinIds]
    );

    return removed.rows.length;
  });
}
