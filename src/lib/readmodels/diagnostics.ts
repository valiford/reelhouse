// Catalog and household freshness diagnostics for /api/health (RH-0040).
//
// One bounded query answers the operator questions the DR runbook cares
// about: how much catalog state exists, when it was last confirmed against
// Jellyfin, where the incremental watermark stands, how many identity
// conflicts sit in quarantine, and when household state was last imported.
// Like the migration summary, this block is diagnostic: it never flips the
// health status, and any failure degrades to `unknown` with a bounded
// detail — a broken diagnostic must not break readiness.

import type { QueryResultRow } from "pg";
import type { ReadExecutor } from "./items.ts";

export interface CatalogDiagnostics {
  state: "ok" | "unknown";
  activeItems?: number;
  activeLibraries?: number;
  quarantined?: number;
  lastSuccessfulSyncAt?: string;
  lastSyncMode?: string;
  watermark?: string;
  activeProfiles?: number;
  lastSuccessfulImportAt?: string;
  detail?: string;
}

interface DiagnosticsRow extends QueryResultRow {
  active_items: string;
  active_libraries: string;
  quarantined: string;
  last_sync_finished: Date | null;
  last_sync_mode: string | null;
  watermark: Date | null;
  active_profiles: string;
  last_import_finished: Date | null;
}

function iso(value: Date | null): string | undefined {
  return value ? value.toISOString() : undefined;
}

export async function catalogDiagnostics(executor: ReadExecutor): Promise<CatalogDiagnostics> {
  try {
    const result = await executor.query<DiagnosticsRow>(
      `SELECT
        (SELECT count(*) FROM media_items WHERE removed_at IS NULL) AS active_items,
        (SELECT count(*) FROM media_libraries WHERE removed_at IS NULL) AS active_libraries,
        (SELECT count(*) FROM media_item_quarantine WHERE status = 'quarantined') AS quarantined,
        (SELECT max(finished_at) FROM media_sync_runs WHERE status = 'succeeded') AS last_sync_finished,
        (SELECT mode FROM media_sync_runs WHERE status = 'succeeded'
          ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1) AS last_sync_mode,
        (SELECT watermark FROM media_sync_state WHERE source = 'jellyfin') AS watermark,
        (SELECT count(*) FROM household_profiles WHERE archived_at IS NULL) AS active_profiles,
        (SELECT max(finished_at) FROM household_sync_runs WHERE status = 'succeeded') AS last_import_finished`
    );
    const row = result.rows[0];
    if (!row) return { state: "unknown", detail: "diagnostics query returned no row" };
    const diagnostics: CatalogDiagnostics = {
      state: "ok",
      activeItems: Number(row.active_items),
      activeLibraries: Number(row.active_libraries),
      quarantined: Number(row.quarantined),
      activeProfiles: Number(row.active_profiles)
    };
    const lastSync = iso(row.last_sync_finished);
    if (lastSync) diagnostics.lastSuccessfulSyncAt = lastSync;
    if (row.last_sync_mode) diagnostics.lastSyncMode = row.last_sync_mode;
    const watermark = iso(row.watermark);
    if (watermark) diagnostics.watermark = watermark;
    const lastImport = iso(row.last_import_finished);
    if (lastImport) diagnostics.lastSuccessfulImportAt = lastImport;
    return diagnostics;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 42P01 (undefined_table) is the pre-migration state: say so plainly.
    if ((error as { code?: string }).code === "42P01") {
      return { state: "unknown", detail: "catalog tables not present (migrations not applied)" };
    }
    return { state: "unknown", detail: message.slice(0, 300) };
  }
}
