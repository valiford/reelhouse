// Catalog freshness and degraded-state read model (RH-0034).
//
// Clients need to know how trustworthy the catalog they are rendering is,
// especially when Jellyfin is degraded (unreachable, mid-sync, long-stale).
// This module derives that state from the databases only — it never contacts
// Jellyfin (the reachability probe lives in jellyfin-health.ts and the two
// signals compose at the API layer):
//
// - `never_synced`   no successful catalog run has ever completed.
// - `fresh`          the newest successful run finished within the window.
// - `stale`          the newest successful run finished outside the window;
//                    the catalog is still served, but clients should banner
//                    it as possibly outdated.
//
// The judgment is deliberately simple and deterministic: one wall-clock
// comparison against the newest SUCCEEDED media_sync_runs row (the watermark
// alone is not enough — it only advances on incremental coverage). `now` is
// injectable so the state machine is unit-testable without a clock. The
// household sync gets the same treatment. Every list in the payload is
// bounded and ordered; nothing here throws on a half-populated database.

import type { QueryResultRow } from "pg";
import type { ReadExecutor } from "./executor.ts";

// A catalog older than this is served but flagged stale.
export const DEFAULT_CATALOG_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
// The household changes rarely; a week-old import is still considered fresh.
export const DEFAULT_HOUSEHOLD_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_LIBRARIES_IN_STATUS = 50;
export const MAX_RECENT_RUNS = 5;

export type FreshnessState = "never_synced" | "fresh" | "stale";

export interface SyncRunSummary extends QueryResultRow {
  id: string | number;
  mode: string;
  status: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  error_detail: string | null;
}

export interface LibrarySummary extends QueryResultRow {
  jellyfin_id: string;
  name: string;
  collection_type: string | null;
  item_count: number;
  last_synced_at: Date | string;
}

export interface CatalogStatus {
  state: FreshnessState;
  staleAfterMs: number;
  now: string;
  lastSucceededAt: string | null;
  ageMs: number | null;
  watermark: string | null;
  itemCounts: { total: number; byType: Record<string, number> };
  libraryCount: number;
  libraries: LibrarySummary[];
  recentRuns: SyncRunSummary[];
  openQuarantines: number;
  household: {
    state: FreshnessState;
    lastRun: SyncRunSummary | null;
    lastSucceededAt: string | null;
  };
}

function freshnessOf(
  lastSucceededAt: Date | string | null,
  now: Date,
  staleAfterMs: number
): { state: FreshnessState; ageMs: number | null } {
  if (!lastSucceededAt) return { state: "never_synced", ageMs: null };
  const stamp = lastSucceededAt instanceof Date ? lastSucceededAt : new Date(lastSucceededAt);
  const ageMs = Math.max(0, now.getTime() - stamp.getTime());
  return { state: ageMs > staleAfterMs ? "stale" : "fresh", ageMs };
}

export async function catalogStatus(
  executor: ReadExecutor,
  options: { now?: Date; catalogStaleAfterMs?: number; householdStaleAfterMs?: number } = {}
): Promise<CatalogStatus> {
  const now = options.now ?? new Date();
  const catalogStaleAfterMs = options.catalogStaleAfterMs ?? DEFAULT_CATALOG_STALE_AFTER_MS;
  const householdStaleAfterMs = options.householdStaleAfterMs ?? DEFAULT_HOUSEHOLD_STALE_AFTER_MS;

  const [lastSucceeded, watermarkRow, typeCounts, libraryRows, runRows, quarantineRow, lastHouseholdRun] =
    await Promise.all([
      executor.query<{ finished_at: Date | string }>(
        `SELECT finished_at FROM media_sync_runs
         WHERE status = 'succeeded' ORDER BY id DESC LIMIT 1`
      ),
      executor.query<{ watermark: Date | string }>(
        "SELECT watermark FROM media_sync_state WHERE source = 'jellyfin' LIMIT 1"
      ),
      executor.query<{ item_type: string; count: number }>(
        `SELECT item_type, count(*)::int AS count FROM media_items
         WHERE removed_at IS NULL GROUP BY item_type ORDER BY item_type`
      ),
      executor.query<LibrarySummary>(
        `SELECT l.jellyfin_id, l.name, l.collection_type, l.synced_at AS last_synced_at,
                count(m.id)::int AS item_count
         FROM media_libraries l
         LEFT JOIN media_items m ON m.library_id = l.id AND m.removed_at IS NULL
         WHERE l.removed_at IS NULL
         GROUP BY l.id, l.jellyfin_id, l.name, l.collection_type, l.synced_at
         ORDER BY lower(l.name), l.id
         LIMIT ${MAX_LIBRARIES_IN_STATUS}`
      ),
      executor.query<SyncRunSummary>(
        `SELECT id, mode, status, started_at, finished_at, error_detail
         FROM media_sync_runs ORDER BY id DESC LIMIT ${MAX_RECENT_RUNS}`
      ),
      executor.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM media_item_quarantine WHERE status = 'quarantined'`
      ),
      executor.query<SyncRunSummary>(
        `SELECT id, status, started_at, finished_at, error_detail
         FROM household_sync_runs ORDER BY id DESC LIMIT 1`
      )
    ]);

  const lastSucceededAt = lastSucceeded.rows[0]?.finished_at ?? null;
  const catalogFreshness = freshnessOf(lastSucceededAt, now, catalogStaleAfterMs);

  const byType: Record<string, number> = {};
  let total = 0;
  for (const row of typeCounts.rows) {
    byType[row.item_type] = Number(row.count);
    total += Number(row.count);
  }

  const householdRun = lastHouseholdRun.rows[0] ?? null;
  const householdFreshness = freshnessOf(
    householdRun && householdRun.status === "succeeded" ? householdRun.finished_at : null,
    now,
    householdStaleAfterMs
  );

  return {
    state: catalogFreshness.state,
    staleAfterMs: catalogStaleAfterMs,
    now: now.toISOString(),
    lastSucceededAt: lastSucceededAt ? new Date(lastSucceededAt).toISOString() : null,
    ageMs: catalogFreshness.ageMs,
    watermark: watermarkRow.rows[0]?.watermark
      ? new Date(watermarkRow.rows[0].watermark).toISOString()
      : null,
    itemCounts: { total, byType },
    libraryCount: libraryRows.rows.length,
    libraries: libraryRows.rows,
    recentRuns: runRows.rows,
    openQuarantines: Number(quarantineRow.rows[0]?.count ?? 0),
    household: {
      state: householdFreshness.state,
      lastRun: householdRun,
      lastSucceededAt:
        householdRun && householdRun.status === "succeeded" && householdRun.finished_at
          ? new Date(householdRun.finished_at).toISOString()
          : null
    }
  };
}
