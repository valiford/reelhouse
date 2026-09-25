// Incremental media_catalog refresh (RH-0039): watermark-windowed deltas
// plus a presence sweep, on top of the RH-0031 full reconciliation.
//
// One incremental run:
//  1. Requires a seeded baseline (media_sync_state.watermark) — without one
//     the run fails closed and says to run a full sync first. A delta
//     without a baseline is not incremental, it is blind.
//  2. Upserts libraries (same zero-library fail-closed guard as full).
//  3. Delta pass, per library: cursor-paginated /Items?MinDateLastSaved=
//     <watermark − 1s overlap>. Every payload goes through the same
//     normalization, duplicate policy, and change classifier as a full run:
//     adds and content changes are applied and recorded ('added'/'updated'),
//     a re-appearing tombstoned item is restored, and an item whose content
//     matches the catalog only refreshes freshness — never history.
//  4. Presence sweep, per library: identity-only cursor pages answer "which
//     ids does this library contain right now". Ids absent from the source
//     are tombstoned ('removed'), tombstoned ids still present are restored
//     ('restored') — the sweep is what makes removal and restore complete,
//     because a vanished item can never appear in a saved-at delta.
//  5. Only after every delta and sweep page succeeded does the watermark
//     advance to the newest source DateLastSaved observed this run (never
//     rewinding, never on failure — a failed run re-covers its window next
//     time, and re-covered items are idempotent no-ops).
//
// Determinism: change rows take observed_at from the source payload
// (DateLastSaved) and recorded_at from the injected clock, so replaying the
// same sequence of source states through the same run sequence reproduces an
// identical history. See incremental.int.test.ts.
//
// Mid-run failures behave exactly like the full sync: batch-sized durable
// progress, failed run recorded with a scrubbed detail, CatalogSyncError
// carrying the summary.

import type { QueryResultRow } from "pg";
import type { CatalogSource } from "./source.ts";
import { normalizeItem, type JellyfinItemPayload } from "./normalize.ts";
import {
  ADVANCE_WATERMARK,
  INSERT_INFERRED_CHANGES,
  deltaWindowStart,
  nextWatermark,
  type WatermarkRow
} from "./changes.ts";
import {
  UPSERT_LIBRARY,
  ZERO_LIBRARY_GUARD,
  CatalogSyncError,
  COMPLETE_RUN,
  applyObservedItem,
  failRun,
  freshCounters,
  quarantineDuplicateIfConflicting,
  recordFailureDetail,
  resolvePageSize,
  type CatalogSyncCounters,
  type SeenOccurrence,
  type SyncExecutor
} from "./sync.ts";

const INSERT_INCREMENTAL_RUN = `INSERT INTO media_sync_runs (source, mode, status)
  VALUES ('jellyfin', 'incremental', 'running') RETURNING id`;

const READ_WATERMARK = `SELECT watermark FROM media_sync_state WHERE source = 'jellyfin'`;

export const NO_BASELINE_ERROR =
  "no incremental baseline: media_sync_state has no watermark for 'jellyfin' — run a full catalog sync first";

export interface CatalogIncrementalOptions {
  pageSize?: number;
  clock?: () => Date;
}

export interface CatalogIncrementalResult extends CatalogSyncCounters {
  runId: number;
  status: "succeeded";
  mode: "incremental";
  // The window this run covered and the watermark it advanced to (ISO).
  windowStart: string;
  watermark: string;
  changesRecorded: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

interface ItemIdRow extends QueryResultRow {
  id: string | number;
}

export async function runIncrementalCatalogSync(
  source: CatalogSource,
  executor: SyncExecutor,
  options: CatalogIncrementalOptions = {}
): Promise<CatalogIncrementalResult> {
  const pageSize = resolvePageSize(options.pageSize);
  const clock = options.clock ?? (() => new Date());

  const startedMs = Date.now();
  const startedAt = new Date().toISOString();
  const counters = freshCounters();
  let changesRecorded = 0;

  const runRow = await executor.query<ItemIdRow>(INSERT_INCREMENTAL_RUN);
  const runId = Number(runRow.rows[0].id);

  try {
    const baseline = await executor.query<WatermarkRow>(READ_WATERMARK);
    if (baseline.rows.length === 0) {
      throw new Error(NO_BASELINE_ERROR);
    }
    const watermark = baseline.rows[0].watermark;
    const windowStart = deltaWindowStart(watermark);

    const libraries = await source.listLibraries();
    if (libraries.length === 0) {
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

    const seenIndex = new Map<string, SeenOccurrence>();
    const observedDates: (Date | null)[] = [];

    for (const library of libraries) {
      const libraryId = libraryIds.get(library.jellyfinId);
      if (libraryId === undefined) throw new Error(`internal: library ${library.jellyfinId} was not upserted`);

      // Delta pass — adds, updates, delta-driven restores.
      let startIndex = 0;
      for (;;) {
        const page = await source.fetchChangedItemsPage(library.jellyfinId, windowStart, startIndex, pageSize);
        counters.pagesFetched += 1;
        if (page.items.length === 0) break;

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

      // Presence sweep — identity-only pages, then one reconciliation
      // transaction per library: source-absent ids are retired (tombstoned),
      // still-present tombstones are restored. Content is deliberately not
      // touched here; the delta pass owns content.
      const sweepIds = new Set<string>();
      startIndex = 0;
      for (;;) {
        const page = await source.fetchLibraryItemIdsPage(library.jellyfinId, startIndex, pageSize);
        counters.pagesFetched += 1;
        if (page.items.length === 0) break;
        for (const raw of page.items) {
          const id = raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).Id === "string"
            ? ((raw as Record<string, unknown>).Id as string).trim()
            : "";
          if (id) sweepIds.add(id);
        }
        startIndex += page.items.length;
        if (page.items.length < pageSize) break;
        if (page.totalRecordCount !== null && startIndex >= page.totalRecordCount) break;
      }

      const sweep = await reconcilePresence(executor, runId, libraryId, [...sweepIds], clock);
      counters.itemsTombstoned += sweep.removed;
      counters.itemsRestored += sweep.restored;
      changesRecorded += sweep.removed + sweep.restored;
    }

    // Watermark advances only after every page of every phase succeeded.
    const effective = nextWatermark(watermark, observedDates);
    await executor.query(ADVANCE_WATERMARK, [effective, runId]);

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
      effective
    ]);
    return {
      runId,
      status: "succeeded",
      mode: "incremental",
      ...counters,
      windowStart,
      watermark: effective.toISOString(),
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

// One transaction per library keeps the sweep atomic: the catalog never
// shows a half-applied removal/restore reconciliation for a library.
async function reconcilePresence(
  executor: SyncExecutor,
  runId: number,
  libraryId: number,
  sweepIds: string[],
  clock: () => Date
): Promise<{ removed: number; restored: number }> {
  return executor.withTransaction(async (tx) => {
    const inferredAt = clock();

    const removed = await tx.query<{ id: string | number; jellyfin_id: string; library_id: string | number }>(
      `UPDATE media_items m SET removed_at = now()
       WHERE m.source = 'jellyfin'
         AND m.library_id = $1
         AND m.removed_at IS NULL
         AND NOT (m.jellyfin_id = ANY($2::text[]))
       RETURNING m.id, m.jellyfin_id, m.library_id`,
      [libraryId, sweepIds]
    );
    // Restores advance freshness too: the sweep confirmed presence.
    const restored = await tx.query<{ id: string | number; jellyfin_id: string; library_id: string | number }>(
      `UPDATE media_items m SET removed_at = NULL, synced_at = now(), last_seen_at = now()
       WHERE m.source = 'jellyfin'
         AND m.library_id = $1
         AND m.removed_at IS NOT NULL
         AND m.jellyfin_id = ANY($2::text[])
       RETURNING m.id, m.jellyfin_id, m.library_id`,
      [libraryId, sweepIds]
    );

    for (const [kind, rows] of [
      ["removed", removed.rows],
      ["restored", restored.rows]
    ] as const) {
      if (rows.length) {
        await tx.query(INSERT_INFERRED_CHANGES, [
          runId,
          kind,
          inferredAt,
          rows.map((row) => Number(row.id)),
          rows.map((row) => row.jellyfin_id),
          rows.map((row) => Number(row.library_id))
        ]);
      }
    }

    return { removed: removed.rows.length, restored: restored.rows.length };
  });
}
