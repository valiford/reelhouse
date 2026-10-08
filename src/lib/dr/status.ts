// Disaster-recovery status: how recoverable is ReelHouse right now?
//
// The read-side of RH-0037. Stale-data detection from the DR seat answers
// four questions, all derived from the databases only (no source contact):
//
// - Is the catalog stale?      (media_sync_runs freshness — the same
//                               judgment the client-facing status uses)
// - Is the household stale?    (household_sync_runs freshness)
// - Is the latest household backup fresh enough?
//   (dr_backup_runs — a household backup older than the window, or no
//   succeeded backup at all, means the durable state's RPO is drifting)
// - Has recovery been exercised? (dr_restore_runs / dr_rebuild_runs —
//   a runbook that has never been rehearsed is a theory)
//
// The verdict list is the actionable part: empty means the DR posture is
// clean; every entry names one thing an operator should do. The verdict
// rules are a pure function so they are unit-testable without a clock or a
// database; the database read is a thin, bounded gather.

import type { QueryResultRow } from "pg";
import {
  DEFAULT_CATALOG_STALE_AFTER_MS,
  DEFAULT_HOUSEHOLD_STALE_AFTER_MS
} from "../readmodels/freshness.ts";
import type { DrExecutor } from "./backup.ts";

// A household backup older than this (or absent) is flagged. The household
// changes rarely; a week is the same window the household freshness model
// uses for imports.
export const DEFAULT_BACKUP_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_LEDGER_ROWS_IN_STATUS = 1;

export type FreshnessState = "never" | "fresh" | "stale";

export interface DrFreshness {
  state: FreshnessState;
  lastAt: string | null;
  ageMs: number | null;
}

export interface DrBackupSummary extends DrFreshness {
  runId: number | null;
  artifactPath: string | null;
  artifactSha256: string | null;
  manifestSha256: string | null;
}

export interface DrRecoverySummary {
  runId: number | null;
  dryRun: boolean | null;
  status: string | null;
  finishedAt: string | null;
}

export interface DrStatus {
  now: string;
  catalog: DrFreshness;
  household: DrFreshness;
  backup: DrBackupSummary;
  lastRestore: DrRecoverySummary | null;
  lastRebuild: (DrRecoverySummary & { verified: boolean | null; syncRunId: number | null }) | null;
  // Empty = the DR posture is clean. Each entry names one operator action.
  verdicts: string[];
}

export interface DrStatusOptions {
  now?: Date;
  catalogStaleAfterMs?: number;
  householdStaleAfterMs?: number;
  backupStaleAfterMs?: number;
}

interface StampRow extends QueryResultRow {
  last_at: Date | string | null;
}

interface LastBackupRow extends QueryResultRow {
  id: string | number;
  status: string;
  finished_at: Date | string | null;
  artifact_path: string | null;
  artifact_sha256: string | null;
  manifest_sha256: string | null;
}

interface LastRestoreRow extends QueryResultRow {
  id: string | number;
  status: string;
  dry_run: boolean;
  finished_at: Date | string | null;
  checksum_verified: boolean | null;
}

interface LastRebuildRow extends QueryResultRow {
  id: string | number;
  status: string;
  finished_at: Date | string | null;
  sync_run_id: string | number | null;
  verified: boolean | null;
}

// The pure decision core: staleness verdicts from freshness states. Exported
// for hermetic tests; drStatus composes it with the database reads.
export function drVerdicts(input: {
  catalog: FreshnessState;
  household: FreshnessState;
  backup: FreshnessState;
  lastRestore: { status: string; dryRun: boolean; checksumVerified: boolean } | null;
  lastRebuild: { status: string; verified: boolean } | null;
}): string[] {
  const verdicts: string[] = [];
  if (input.catalog !== "fresh") {
    verdicts.push(input.catalog === "never" ? "catalog_never_synced" : "catalog_stale");
  }
  if (input.household !== "fresh") {
    verdicts.push(input.household === "never" ? "household_never_imported" : "household_stale");
  }
  if (input.backup === "never") verdicts.push("household_backup_missing");
  if (input.backup === "stale") verdicts.push("household_backup_stale");
  const restore = input.lastRestore;
  if (!restore || restore.status !== "succeeded") verdicts.push("restore_never_rehearsed");
  else if (restore.dryRun) verdicts.push("restore_only_dry_run");
  if (!input.lastRebuild || input.lastRebuild.status !== "succeeded") {
    verdicts.push("catalog_rebuild_never_rehearsed");
  }
  return verdicts;
}

function freshnessOf(lastAt: Date | string | null, now: Date, staleAfterMs: number): DrFreshness {
  if (lastAt === null) return { state: "never", lastAt: null, ageMs: null };
  const stamp = lastAt instanceof Date ? lastAt : new Date(lastAt);
  const ageMs = Math.max(0, now.getTime() - stamp.getTime());
  return {
    state: ageMs > staleAfterMs ? "stale" : "fresh",
    lastAt: stamp.toISOString(),
    ageMs
  };
}

function isoOf(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function num(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === "number" ? value : Number(value);
}

export async function drStatus(
  executor: DrExecutor,
  options: DrStatusOptions = {}
): Promise<DrStatus> {
  const now = options.now ?? new Date();
  const catalogStaleAfterMs = options.catalogStaleAfterMs ?? DEFAULT_CATALOG_STALE_AFTER_MS;
  const householdStaleAfterMs = options.householdStaleAfterMs ?? DEFAULT_HOUSEHOLD_STALE_AFTER_MS;
  const backupStaleAfterMs = options.backupStaleAfterMs ?? DEFAULT_BACKUP_STALE_AFTER_MS;

  const [catalogRun, householdRun, backupRow, restoreRow, rebuildRow] = await Promise.all([
    executor.query<StampRow>(
      `SELECT finished_at AS last_at FROM media_sync_runs
       WHERE status = 'succeeded' ORDER BY id DESC LIMIT 1`
    ),
    executor.query<StampRow>(
      `SELECT finished_at AS last_at FROM household_sync_runs
       WHERE status = 'succeeded' ORDER BY id DESC LIMIT 1`
    ),
    executor.query<LastBackupRow>(
      `SELECT id, status, finished_at, artifact_path, artifact_sha256, manifest_sha256
       FROM dr_backup_runs ORDER BY id DESC LIMIT ${MAX_LEDGER_ROWS_IN_STATUS}`
    ),
    executor.query<LastRestoreRow>(
      `SELECT id, status, dry_run, finished_at, checksum_verified
       FROM dr_restore_runs ORDER BY id DESC LIMIT ${MAX_LEDGER_ROWS_IN_STATUS}`
    ),
    executor.query<LastRebuildRow>(
      `SELECT id, status, finished_at, sync_run_id, verified
       FROM dr_rebuild_runs ORDER BY id DESC LIMIT ${MAX_LEDGER_ROWS_IN_STATUS}`
    )
  ]);

  const catalog = freshnessOf(catalogRun.rows[0]?.last_at ?? null, now, catalogStaleAfterMs);
  const household = freshnessOf(householdRun.rows[0]?.last_at ?? null, now, householdStaleAfterMs);

  const backupRowValue = backupRow.rows[0] ?? null;
  // Staleness is judged on the newest SUCCEEDED backup; a failed attempt is
  // not a backup.
  let backup: DrBackupSummary;
  if (backupRowValue && backupRowValue.status === "succeeded") {
    const freshness = freshnessOf(backupRowValue.finished_at, now, backupStaleAfterMs);
    backup = {
      ...freshness,
      runId: num(backupRowValue.id),
      artifactPath: backupRowValue.artifact_path,
      artifactSha256: backupRowValue.artifact_sha256,
      manifestSha256: backupRowValue.manifest_sha256
    };
  } else {
    backup = {
      state: "never",
      lastAt: null,
      ageMs: null,
      runId: null,
      artifactPath: null,
      artifactSha256: null,
      manifestSha256: null
    };
  }

  const restoreValue = restoreRow.rows[0] ?? null;
  const lastRestore: DrRecoverySummary | null = restoreValue
    ? {
        runId: num(restoreValue.id),
        dryRun: restoreValue.dry_run,
        status: restoreValue.status,
        finishedAt: isoOf(restoreValue.finished_at)
      }
    : null;

  const rebuildValue = rebuildRow.rows[0] ?? null;
  const lastRebuild = rebuildValue
    ? {
        runId: num(rebuildValue.id),
        dryRun: null,
        status: rebuildValue.status,
        finishedAt: isoOf(rebuildValue.finished_at),
        syncRunId: num(rebuildValue.sync_run_id),
        verified: rebuildValue.verified
      }
    : null;

  const verdicts = drVerdicts({
    catalog: catalog.state,
    household: household.state,
    backup: backup.state,
    lastRestore:
      restoreValue && restoreValue.status === "succeeded"
        ? {
            status: restoreValue.status,
            dryRun: restoreValue.dry_run,
            checksumVerified: restoreValue.checksum_verified === true
          }
        : null,
    lastRebuild:
      rebuildValue && rebuildValue.status === "succeeded"
        ? { status: rebuildValue.status, verified: rebuildValue.verified === true }
        : null
  });

  return {
    now: now.toISOString(),
    catalog,
    household,
    backup,
    lastRestore,
    lastRebuild,
    verdicts
  };
}
