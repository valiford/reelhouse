// Full-library catalog synchronization: Jellyfin → PostgreSQL media_catalog.
//
// Contract (RH-0031, extended by RH-0039):
// - The run is one reconciliation pass: libraries are upserted, items are
//   paged per library in bounded batch transactions, and anything in a
//   synced library that Jellyfin no longer reports is tombstoned
//   (removed_at), never deleted. Tombstones are scoped to libraries the run
//   actually confirmed, so a partial run never touches unconfirmed state.
// - Idempotent: re-running against an unchanged Jellyfin rewrites the same
//   values (freshness timestamps advance; content does not), appends one
//   sync-run history row, and creates no new rows — including no new
//   change-history rows: media_item_changes records only genuine state
//   transitions (added/updated/removed/restored), detected by the shared
//   classifier in changes.ts.
// - Provenance-preserving: first_seen_at is set once and never rewritten,
//   facet rows are re-derived from what Jellyfin reported per item, removals
//   are tombstones, and every row carries (source, jellyfin_id) identity.
//   Change rows carry the source revision (Etag / DateLastSaved) and the
//   source-provided observation time.
// - Fail-closed: an item without a stable identity aborts the run, and a
//   source that reports zero libraries is treated as a misconfigured or
//   degraded source (refusing to reconcile the catalog to empty), not as an
//   empty catalog.
// - Duplicates are non-destructive: the same Jellyfin id reported twice in
//   one run is benign when identical (skipped) and quarantined otherwise —
//   the first occurrence wins deterministically, the conflict is recorded in
//   media_item_quarantine for the repair workbench (RH-0036).
// - A failed run leaves committed progress in place (batch-sized
//   transactions), records the failure in media_sync_runs with a scrubbed
//   error detail, and throws CatalogSyncError carrying the run summary — so
//   the next run is a clean recovery. The incremental watermark advances
//   only on success (a failed run re-covers its window next time).

import type { QueryResultRow } from "pg";
import { CATALOG_SYNC_DEFAULTS, CATALOG_SYNC_LIMITS, type CatalogSource } from "./source.ts";
import {
  normalizeItem,
  type NormalizedItem,
  type JellyfinItemPayload
} from "./normalize.ts";
import {
  INSERT_ITEM_CHANGE,
  INSERT_INFERRED_CHANGES,
  QUARANTINE_DUPLICATE,
  ADVANCE_WATERMARK,
  SELECT_ITEM_PROJECTION,
  classifyDuplicateOccurrence,
  nextWatermark,
  planItemChange,
  quarantinePayloadOf,
  sourceRevisionOf,
  type ExistingItemRow
} from "./changes.ts";

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
  itemsRestored: number;
  itemsQuarantined: number;
  pagesFetched: number;
}

export interface CatalogSyncResult extends CatalogSyncCounters {
  runId: number;
  status: "succeeded";
  mode: "full";
  // Effective incremental watermark after this run's advance (full runs see
  // every item, so they re-seed coverage too).
  watermark: string;
  // Change-history rows this run appended (added+updated+removed+restored).
  changesRecorded: number;
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
  // Deterministic clock for change-history timestamps (observed_at fallback
  // and recorded_at). Defaults to the wall clock; tests inject a fixed one
  // so a source sequence replays to a byte-identical history.
  clock?: () => Date;
}

// Shared with the incremental pipeline.
export function resolvePageSize(pageSize: number | undefined): number {
  const resolved = pageSize ?? CATALOG_SYNC_DEFAULTS.pageSize;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < CATALOG_SYNC_LIMITS.pageSize.min ||
    resolved > CATALOG_SYNC_LIMITS.pageSize.max
  ) {
    throw new Error(
      `pageSize must be between ${CATALOG_SYNC_LIMITS.pageSize.min} and ${CATALOG_SYNC_LIMITS.pageSize.max} (got ${resolved})`
    );
  }
  return resolved;
}

export function freshCounters(): CatalogSyncCounters {
  return {
    librariesSeen: 0,
    itemsSeen: 0,
    itemsUpserted: 0,
    itemsTombstoned: 0,
    itemsSkipped: 0,
    itemsRestored: 0,
    itemsQuarantined: 0,
    pagesFetched: 0
  };
}

interface ItemIdRow extends QueryResultRow {
  id: string | number;
}

// Deduplication state shared by both pipelines: the first occurrence of a
// Jellyfin id in a run wins; later conflicting occurrences are quarantined.
export interface SeenOccurrence {
  libraryJellyfinId: string;
  name: string;
  itemType: string;
  etag: string | null;
}

export const INSERT_FULL_RUN = `INSERT INTO media_sync_runs (source, mode, status)
  VALUES ('jellyfin', 'full', 'running') RETURNING id`;

export const UPSERT_LIBRARY = `INSERT INTO media_libraries (source, jellyfin_id, name, collection_type)
  VALUES ('jellyfin', $1, $2, $3)
  ON CONFLICT (source, jellyfin_id) DO UPDATE SET
    name = EXCLUDED.name,
    collection_type = EXCLUDED.collection_type,
    synced_at = now(),
    last_seen_at = now(),
    removed_at = NULL
  RETURNING id`;

// 27 positional params, columns in migration 0003 order after identity
// (source_observed_at is the RH-0039 addition; a payload that omits it never
// erases a previously known observation time).
export const UPSERT_ITEM = `INSERT INTO media_items (
    source, jellyfin_id, library_id, item_type, name, original_title, sort_name,
    overview, production_year, premiere_date, community_rating, official_rating,
    runtime_ticks, container, file_path, file_size_bytes, media_streams,
    primary_image_tag, backdrop_image_tag, etag, date_created, parent_jellyfin_id,
    series_jellyfin_id, series_name, season_jellyfin_id, season_number, episode_number,
    source_observed_at
  ) VALUES (
    'jellyfin', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
    $16::jsonb, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
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
    source_observed_at = COALESCE(EXCLUDED.source_observed_at, media_items.source_observed_at),
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

export const COMPLETE_RUN = `UPDATE media_sync_runs SET
    status = $2, finished_at = now(), libraries_seen = $3, items_seen = $4,
    items_upserted = $5, items_tombstoned = $6, items_skipped = $7,
    pages_fetched = $8, error_detail = $9,
    items_restored = $10, items_quarantined = $11, watermark = $12
  WHERE id = $1`;

export const ZERO_LIBRARY_GUARD =
  "Jellyfin reported no libraries; refusing to reconcile the catalog to empty (check JELLYFIN_URL / API key scope)";

export function recordFailureDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

export async function failRun(
  executor: SyncExecutor,
  runId: number,
  counters: CatalogSyncCounters,
  detail: string
): Promise<void> {
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
      detail,
      counters.itemsRestored,
      counters.itemsQuarantined,
      null
    ]);
  } catch {
    /* original failure is reported instead */
  }
}

// Writes the change-history row for one classified item transition. Called
// inside the same transaction as the item mutation so history and state can
// never disagree.
export async function recordItemChange(
  tx: SyncExecutor,
  params: {
    runId: number;
    itemId: number;
    item: NormalizedItem;
    libraryId: number;
    kind: "added" | "updated" | "restored";
    changedFields: string[];
    observedAt: Date;
  }
): Promise<void> {
  await tx.query(INSERT_ITEM_CHANGE, [
    params.runId,
    params.itemId,
    params.item.jellyfinId,
    params.libraryId,
    params.kind,
    sourceRevisionOf(params.item),
    params.observedAt,
    params.observedAt,
    JSON.stringify(params.changedFields)
  ]);
}

// Classification + write path shared by both pipelines: reads the stored
// projection, plans the transition, upserts the item with facets, and
// appends exactly one change row for a genuine transition (none for an
// unchanged item). Returns the plan so callers can count.
export async function applyObservedItem(
  tx: SyncExecutor,
  params: {
    runId: number;
    libraryId: number;
    item: NormalizedItem;
    observedAt: Date;
  }
): Promise<{ kind: "added" | "updated" | "restored" | "unchanged"; changedFields: string[] }> {
  const existing = await tx.query<ExistingItemRow>(SELECT_ITEM_PROJECTION, [params.item.jellyfinId]);
  const existingRow = existing.rows.length ? existing.rows[0] : null;
  const plan = planItemChange(existingRow, params.item, params.libraryId);

  const itemRow = await tx.query<ItemIdRow>(UPSERT_ITEM, [
    params.item.jellyfinId,
    params.libraryId,
    params.item.itemType,
    params.item.name,
    params.item.originalTitle,
    params.item.sortName,
    params.item.overview,
    params.item.productionYear,
    params.item.premiereDate,
    params.item.communityRating,
    params.item.officialRating,
    params.item.runtimeTicks,
    params.item.container,
    params.item.filePath,
    params.item.fileSizeBytes,
    JSON.stringify(params.item.mediaStreams),
    params.item.primaryImageTag,
    params.item.backdropImageTag,
    params.item.etag,
    params.item.dateCreated,
    params.item.parentJellyfinId,
    params.item.seriesJellyfinId,
    params.item.seriesName,
    params.item.seasonJellyfinId,
    params.item.seasonNumber,
    params.item.episodeNumber,
    params.item.dateLastSaved
  ]);
  const itemId = Number(itemRow.rows[0].id);

  if (plan.kind !== "unchanged") {
    await recordItemChange(tx, {
      runId: params.runId,
      itemId,
      item: params.item,
      libraryId: params.libraryId,
      kind: plan.kind,
      changedFields: plan.changedFields,
      observedAt: params.item.dateLastSaved ? new Date(params.item.dateLastSaved) : params.observedAt
    });
  }

  const genreIds: number[] = [];
  for (const genre of params.item.genres) {
    const row = await tx.query<ItemIdRow>(UPSERT_GENRE, [genre]);
    genreIds.push(Number(row.rows[0].id));
  }
  const studioIds: number[] = [];
  for (const studio of params.item.studios) {
    const row = await tx.query<ItemIdRow>(UPSERT_STUDIO, [studio]);
    studioIds.push(Number(row.rows[0].id));
  }
  for (const person of params.item.people) {
    await tx.query<ItemIdRow>(UPSERT_PERSON, [person.name, person.jellyfinId]);
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
  if (params.item.people.length) {
    await tx.query(INSERT_ITEM_PEOPLE, [
      itemId,
      params.item.people.map((p) => p.name),
      params.item.people.map((p) => p.personType),
      params.item.people.map((p) => p.roleName)
    ]);
  }
  await tx.query(RESET_ITEM_PROVIDER_IDS, [itemId]);
  if (params.item.providerIds.length) {
    await tx.query(INSERT_ITEM_PROVIDER_IDS, [
      itemId,
      params.item.providerIds.map((p) => p.name),
      params.item.providerIds.map((p) => p.value)
    ]);
  }

  return plan;
}

// Non-destructive duplicate policy shared by both pipelines. Returns true
// when the occurrence was recorded as a conflict (caller counts it as
// quarantined and skips the item); benign overlaps return false and are
// simply skipped by the caller.
export async function quarantineDuplicateIfConflicting(
  tx: SyncExecutor,
  params: {
    runId: number;
    first: SeenOccurrence;
    second: SeenOccurrence;
    jellyfinId: string;
    item: NormalizedItem;
    libraryJellyfinId: string;
    seenAt: Date;
  }
): Promise<boolean> {
  if (classifyDuplicateOccurrence(params.first, params.second) === "benign") {
    return false;
  }
  await tx.query(QUARANTINE_DUPLICATE, [
    params.jellyfinId,
    params.runId,
    JSON.stringify(quarantinePayloadOf(params.item, params.libraryJellyfinId)),
    `duplicate Jellyfin id "${params.jellyfinId}" reported again with differing placement/content ` +
      `(first: library ${params.first.libraryJellyfinId} "${params.first.name}", ` +
      `again: library ${params.second.libraryJellyfinId} "${params.second.name}") — first occurrence kept`,
    params.seenAt
  ]);
  return true;
}

export async function runFullCatalogSync(
  source: CatalogSource,
  executor: SyncExecutor,
  options: CatalogSyncOptions = {}
): Promise<CatalogSyncResult> {
  const pageSize = resolvePageSize(options.pageSize);
  const clock = options.clock ?? (() => new Date());

  const startedMs = Date.now();
  const startedAt = new Date().toISOString();
  const counters = freshCounters();
  let changesRecorded = 0;

  const runRow = await executor.query<ItemIdRow>(INSERT_FULL_RUN);
  const runId = Number(runRow.rows[0].id);

  try {
    const libraries = await source.listLibraries();
    if (libraries.length === 0) {
      // Reconciling against an empty library list would tombstone the whole
      // catalog. That outcome is far more likely a permission or URL
      // misconfiguration than a genuinely emptied server: fail closed.
      throw new Error(ZERO_LIBRARY_GUARD);
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

    // First-occurrence-wins duplicate index across the whole run.
    const seenIndex = new Map<string, SeenOccurrence>();
    const observedDates: (Date | null)[] = [];

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
          const now = clock();
          let upserted = 0;
          let skipped = 0;
          let restored = 0;
          let quarantined = 0;
          let changes = 0;
          for (const raw of page.items) {
            const normalized = normalizeItem(raw as JellyfinItemPayload, library.jellyfinId);
            if (!normalized) {
              skipped += 1;
              continue;
            }
            const prior = seenIndex.get(normalized.jellyfinId);
            if (prior) {
              const quarantinedNow = await quarantineDuplicateIfConflicting(tx, {
                runId,
                first: prior,
                second: {
                  libraryJellyfinId: library.jellyfinId,
                  name: normalized.name,
                  itemType: normalized.itemType,
                  etag: normalized.etag
                },
                jellyfinId: normalized.jellyfinId,
                item: normalized,
                libraryJellyfinId: library.jellyfinId,
                seenAt: now
              });
              if (quarantinedNow) {
                quarantined += 1;
              } else {
                skipped += 1;
              }
              continue;
            }
            const plan = await applyObservedItem(tx, {
              runId,
              libraryId,
              item: normalized,
              observedAt: now
            });
            seenIndex.set(normalized.jellyfinId, {
              libraryJellyfinId: library.jellyfinId,
              name: normalized.name,
              itemType: normalized.itemType,
              etag: normalized.etag
            });
            observedDates.push(normalized.dateLastSaved ? new Date(normalized.dateLastSaved) : null);
            upserted += 1;
            if (plan.kind === "restored") restored += 1;
            if (plan.kind !== "unchanged") changes += 1;
          }
          return { upserted, skipped, restored, quarantined, changes };
        });
        counters.itemsSeen += page.items.length;
        counters.itemsUpserted += batch.upserted;
        counters.itemsSkipped += batch.skipped;
        counters.itemsRestored += batch.restored;
        counters.itemsQuarantined += batch.quarantined;
        changesRecorded += batch.changes;

        startIndex += page.items.length;
        if (page.items.length < pageSize) break;
        if (page.totalRecordCount !== null && startIndex >= page.totalRecordCount) break;
      }
    }

    const tombstoned = await reconcileRemovals(executor, runId, seenIndex, libraries.map((l) => l.jellyfinId), clock);
    counters.itemsTombstoned = tombstoned.removed;
    changesRecorded += tombstoned.removed;

    // A full pass observes every in-scope item, so it also re-seeds the
    // incremental coverage window (advance-only).
    const effectiveWatermark = nextWatermark(null, observedDates);
    await executor.query(ADVANCE_WATERMARK, [effectiveWatermark, runId]);

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
      null,
      counters.itemsRestored,
      counters.itemsQuarantined,
      effectiveWatermark
    ]);
    return {
      runId,
      status: "succeeded",
      mode: "full",
      ...counters,
      watermark: effectiveWatermark.toISOString(),
      changesRecorded,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs
    };
  } catch (error) {
    const detail = recordFailureDetail(error);
    await failRun(executor, runId, counters, detail);
    throw new CatalogSyncError(`Catalog sync failed: ${detail}`, {
      runId,
      status: "failed",
      ...counters,
      errorDetail: detail
    });
  }
}

// Tombstones everything in the confirmed libraries that this run did not see,
// and libraries that no longer exist. Runs in one transaction so the catalog
// never shows a half-applied reconciliation; every tombstone appends a
// 'removed' change row (inferred, not source-observed).
async function reconcileRemovals(
  executor: SyncExecutor,
  runId: number,
  seenIndex: Map<string, SeenOccurrence>,
  seenLibraryJellyfinIds: string[],
  clock: () => Date
): Promise<{ removed: number }> {
  return executor.withTransaction(async (tx) => {
    // A previous rolled-back transaction in this session can leave the temp
    // table behind (ON COMMIT DROP only fires on commit); drop defensively.
    await tx.query("DROP TABLE IF EXISTS sync_seen_items");
    await tx.query(
      `CREATE TEMP TABLE sync_seen_items (
         item_jellyfin_id text NOT NULL,
         PRIMARY KEY (item_jellyfin_id)
       ) ON COMMIT DROP`
    );
    await tx.query(
      `INSERT INTO sync_seen_items (item_jellyfin_id)
       SELECT unnest($1::text[])
       ON CONFLICT (item_jellyfin_id) DO NOTHING`,
      [[...seenIndex.keys()]]
    );

    const inferredAt = clock();
    const removed = await tx.query<{ id: string | number; jellyfin_id: string; library_id: string | number }>(
      `UPDATE media_items m SET removed_at = now()
       WHERE m.source = 'jellyfin'
         AND m.removed_at IS NULL
         AND m.library_id IN (SELECT l.id FROM media_libraries l WHERE l.jellyfin_id = ANY($1::text[]))
         AND NOT EXISTS (SELECT 1 FROM sync_seen_items s WHERE s.item_jellyfin_id = m.jellyfin_id)
       RETURNING m.id, m.jellyfin_id, m.library_id`,
      [seenLibraryJellyfinIds]
    );

    if (removed.rows.length) {
      await tx.query(INSERT_INFERRED_CHANGES, [
        runId,
        "removed",
        inferredAt,
        removed.rows.map((row) => Number(row.id)),
        removed.rows.map((row) => row.jellyfin_id),
        removed.rows.map((row) => Number(row.library_id))
      ]);
    }

    await tx.query(
      `UPDATE media_libraries SET removed_at = now()
       WHERE source = 'jellyfin' AND removed_at IS NULL
         AND jellyfin_id <> ALL($1::text[])`,
      [seenLibraryJellyfinIds]
    );

    return { removed: removed.rows.length };
  });
}
