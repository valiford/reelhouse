// Catalog rebuild: repopulate media_catalog from the Jellyfin API.
//
// Contract (RH-0037):
// - media_catalog is REBUILDABLE by design: it mirrors what Jellyfin
//   reports, so its recovery path is a full reconciliation resync — never a
//   backup file, and never a write into Jellyfin. Media is never deleted:
//   the rebuild only reads from the source API (the catalog source surface
//   is read-only by construction) and rewrites ReelHouse-owned mirror rows.
// - The rebuild IS the real full sync (runFullCatalogSync) — no second
//   catalog-writing path exists. This module adds the recovery evidence:
//   exactly one dr_rebuild_runs row per attempt, bound to the
//   media_sync_runs row the resync produced, with post-rebuild counts and a
//   verification verdict.
// - Verification is honest and bounded: after a successful sync, the active
//   library count must equal the number of libraries the source reported
//   (a full reconciliation tombstones every library it did not confirm, so
//   anything else means the rebuild did not converge). Item counts are
//   recorded for the runbook; item-level convergence is the sync's own
//   contract (identity-keyed upserts, tombstone-only removal).
// - Failure: the sync's own run row records the failure with its scrubbed
//   detail; the rebuild row mirrors it so a failed recovery attempt is
//   visible as such. A retry after the source recovers is a clean new run.

import type { QueryResultRow } from "pg";
import type { CatalogSource } from "../catalog/source.ts";
import { CatalogSyncError, runFullCatalogSync } from "../catalog/sync.ts";
import type { DrExecutor } from "./backup.ts";

export interface CatalogRebuildResult {
  runId: number;
  status: "succeeded";
  syncRunId: number;
  librariesCount: number;
  itemsCount: number;
  verified: true;
  changesRecorded: number;
  durationMs: number;
}

export interface DrRebuildFailure {
  runId: number;
  status: "failed";
  syncRunId?: number;
  errorDetail: string;
}

export class DrRebuildError extends Error {
  readonly summary: DrRebuildFailure;

  constructor(message: string, summary: DrRebuildFailure) {
    super(message);
    this.name = "DrRebuildError";
    this.summary = summary;
  }
}

export interface CatalogRebuildOptions {
  pageSize?: number;
  clock?: () => Date;
}

interface CountRow extends QueryResultRow {
  count: string | number;
}

interface RunIdRow extends QueryResultRow {
  id: string | number;
}

export async function runCatalogRebuild(
  source: CatalogSource,
  executor: DrExecutor,
  options: CatalogRebuildOptions = {}
): Promise<CatalogRebuildResult> {
  const startedMs = Date.now();
  const runRow = await executor.query<RunIdRow>(
    "INSERT INTO dr_rebuild_runs (mode) VALUES ('full_resync') RETURNING id"
  );
  const runId = Number(runRow.rows[0].id);

  // Records the failure on the run row and hands back the error to throw.
  // Call sites throw it explicitly so control flow stays honest to TypeScript.
  const recordFailure = async (detail: string, syncRunId?: number): Promise<DrRebuildError> => {
    const bounded = detail.slice(0, 500);
    try {
      if (syncRunId === undefined) {
        await executor.query(
          `UPDATE dr_rebuild_runs SET status = 'failed', finished_at = now(), error_detail = $2
           WHERE id = $1`,
          [runId, bounded]
        );
      } else {
        await executor.query(
          `UPDATE dr_rebuild_runs SET status = 'failed', finished_at = now(), error_detail = $2, sync_run_id = $3
           WHERE id = $1`,
          [runId, bounded, syncRunId]
        );
      }
    } catch {
      // The original failure propagates; bookkeeping must not mask it.
    }
    return new DrRebuildError(`catalog rebuild failed and was recorded (run #${runId}): ${bounded}`, {
      runId,
      status: "failed",
      syncRunId,
      errorDetail: bounded
    });
  };

  try {
    const sync = await runFullCatalogSync(source, executor, {
      pageSize: options.pageSize,
      clock: options.clock
    });

    // Post-rebuild verification: every library the source reported is
    // present and active. A full reconciliation is defined to tombstone
    // unreported libraries, so a mismatch means the rebuild did not
    // converge — record that and fail rather than claim recovery.
    const libraryCount = n(
      (
        await executor.query<CountRow>(
          "SELECT count(*) AS count FROM media_libraries WHERE removed_at IS NULL"
        )
      ).rows[0].count
    );
    const itemCount = n(
      (
        await executor.query<CountRow>(
          "SELECT count(*) AS count FROM media_items WHERE removed_at IS NULL"
        )
      ).rows[0].count
    );
    if (libraryCount !== sync.librariesSeen) {
      throw await recordFailure(
        `rebuild did not converge: source reported ${sync.librariesSeen} libraries, catalog holds ${libraryCount} active after the sync (sync run #${sync.runId})`,
        sync.runId
      );
    }

    await executor.query(
      `UPDATE dr_rebuild_runs SET status = 'succeeded', finished_at = now(),
         sync_run_id = $2, libraries_count = $3, items_count = $4, verified = TRUE
       WHERE id = $1`,
      [runId, sync.runId, libraryCount, itemCount]
    );

    return {
      runId,
      status: "succeeded",
      syncRunId: sync.runId,
      librariesCount: libraryCount,
      itemsCount: itemCount,
      verified: true,
      changesRecorded: sync.changesRecorded,
      durationMs: Date.now() - startedMs
    };
  } catch (error) {
    if (error instanceof DrRebuildError) throw error;
    if (error instanceof CatalogSyncError) {
      throw await recordFailure(`catalog sync failed: ${error.summary.errorDetail}`, error.summary.runId);
    }
    throw await recordFailure(error instanceof Error ? error.message : String(error));
  }
}

function n(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}
