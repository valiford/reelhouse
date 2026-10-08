// Household restore: checksummed artifact → PostgreSQL household state.
//
// Contract (RH-0037):
// - A restore is a recovery path, so it is bound to evidence before it may
//   write: the artifact's manifest checksum is always verified (embedded in
//   the envelope), and a REAL restore must additionally pin the artifact to
//   a recorded expectation — a dr_backup_runs ledger row (--run-id) and/or
//   an operator-supplied file checksum (--sha256). A dry run verifies
//   everything it can without that binding, because it writes nothing.
// - The restore itself is the REAL household import (the same idempotent,
//   provenance-preserving, single-transaction loader the pipeline uses) —
//   a restore introduces no second way to land household state. A dry run
//   replays the same import inside a transaction that is rolled back
//   afterwards, so "what would this artifact do" is answered by doing it,
//   then undoing it — including the import's own run bookkeeping.
// - Fail-closed: unknown envelopes, checksum mismatches, dangling --run-id
//   bindings, and manifest contract violations all fail BEFORE the import,
//   and every failure after the run row exists is recorded on it with a
//   bounded, scrubbed detail. The database is never asked to trust bytes it
//   has not verified.

import type { QueryResultRow } from "pg";
import {
  HouseholdImportError,
  runHouseholdImport,
  type HouseholdImportCounters
} from "../household/load.ts";
import type { NormalizedManifest } from "../household/manifest.ts";
import {
  ArtifactError,
  normalizeArtifactManifest,
  parseHouseholdArtifact,
  sha256Hex,
  type HouseholdArtifact
} from "./artifact.ts";
import type { DrExecutor } from "./backup.ts";

export interface DrRestoreCounts extends Record<string, unknown> {
  profiles: number;
  profilesArchived: number;
  unresolvedLinks: number;
  conflictsSkipped: number;
}

export interface HouseholdRestoreResult {
  runId: number;
  status: "succeeded";
  dryRun: boolean;
  checksumVerified: true;
  manifestSha256: string;
  rowsImported: number;
  counts: DrRestoreCounts;
  durationMs: number;
}

export interface DrRestoreFailure {
  runId: number;
  status: "failed";
  dryRun: boolean;
  errorDetail: string;
}

export class DrRestoreError extends Error {
  readonly summary: DrRestoreFailure;

  constructor(message: string, summary: DrRestoreFailure) {
    super(message);
    this.name = "DrRestoreError";
    this.summary = summary;
  }
}

export interface HouseholdRestoreOptions {
  // The artifact bytes, exactly as stored (the file checksum is computed
  // over this string; any transport-level change is detectable).
  bytes: string;
  // Where the artifact came from — recorded on the run row for evidence.
  artifactPath?: string;
  // Verify-only mode: full verification + import replay, rolled back.
  dryRun?: boolean;
  // Operator-supplied expectation for the artifact's file checksum
  // (--sha256). The runbook's record of what was written at backup time.
  expectedSha256?: string;
  // Ledger binding (--run-id): the artifact must match this dr_backup_runs
  // row's recorded checksums.
  backupRunId?: number;
  clock?: () => Date;
}

interface BackupRunRow extends QueryResultRow {
  id: string | number;
  scope: string;
  status: string;
  artifact_sha256: string | null;
  manifest_sha256: string | null;
}

interface RunIdRow extends QueryResultRow {
  id: string | number;
}

const WRITE_COUNTER_FIELDS: readonly (keyof HouseholdImportCounters)[] = [
  "profilesUpserted",
  "profilesArchived",
  "preferencesUpserted",
  "favoritesUpserted",
  "favoritesRemoved",
  "watchlistsUpserted",
  "watchlistsArchived",
  "watchlistEntriesUpserted",
  "watchlistEntriesRemoved",
  "collectionsUpserted",
  "collectionsArchived",
  "collectionEntriesUpserted",
  "collectionEntriesRemoved",
  "homeRowsUpserted",
  "homeRowsArchived",
  "watchStateUpserted",
  "watchStateRemoved",
  "historyAppended"
];

export async function runHouseholdRestore(
  executor: DrExecutor,
  options: HouseholdRestoreOptions
): Promise<HouseholdRestoreResult> {
  const dryRun = options.dryRun ?? false;
  const startedMs = Date.now();

  const runRow = await executor.query<RunIdRow>(
    "INSERT INTO dr_restore_runs (scope, dry_run) VALUES ('household', $1) RETURNING id",
    [dryRun]
  );
  const runId = Number(runRow.rows[0].id);

  // Records the failure on the run row and hands back the error to throw.
  // Call sites throw it explicitly so control flow stays honest to TypeScript.
  const recordFailure = async (detail: string): Promise<DrRestoreError> => {
    const bounded = detail.slice(0, 500);
    try {
      await executor.query(
        `UPDATE dr_restore_runs SET status = 'failed', finished_at = now(), error_detail = $2
         WHERE id = $1`,
        [runId, bounded]
      );
    } catch {
      // The original failure propagates; bookkeeping must not mask it.
    }
    return new DrRestoreError(
      `household restore ${dryRun ? "(dry run) " : ""}failed and was recorded (run #${runId}): ${bounded}`,
      { runId, status: "failed", dryRun, errorDetail: bounded }
    );
  };

  try {
    // 1. External file-checksum expectation (optional for a dry run,
    //    mandatory for a real restore — enforced below).
    const expected = normalizeSha256(options.expectedSha256);
    let fileSha256: string | null = null;
    if (expected !== null) {
      fileSha256 = sha256Hex(options.bytes);
      if (fileSha256 !== expected) {
        throw await recordFailure(
          `artifact bytes do not match the expected checksum: operator recorded ${expected.slice(0, 12)}, file hashes to ${fileSha256.slice(0, 12)} — refusing to import`
        );
      }
    }

    // 2. Envelope + embedded manifest checksum.
    let artifact: HouseholdArtifact;
    try {
      artifact = parseHouseholdArtifact(options.bytes);
    } catch (error) {
      if (error instanceof ArtifactError) {
        throw await recordFailure(`artifact rejected: ${error.message}`);
      }
      throw error;
    }

    // 3. Ledger binding.
    let backupRun: BackupRunRow | null = null;
    if (options.backupRunId !== undefined) {
      const rows = (
        await executor.query<BackupRunRow>(
          `SELECT id, scope, status, artifact_sha256, manifest_sha256
           FROM dr_backup_runs WHERE id = $1`,
          [options.backupRunId]
        )
      ).rows;
      const row = rows[0];
      if (!row) {
        throw await recordFailure(`no dr_backup_runs row #${options.backupRunId} exists — the binding points nowhere`);
      }
      if (row.scope !== "household" || row.status !== "succeeded") {
        throw await recordFailure(
          `dr_backup_runs row #${options.backupRunId} is ${row.scope}/${row.status}; only a succeeded household backup can be bound`
        );
      }
      if (fileSha256 === null) fileSha256 = sha256Hex(options.bytes);
      if (row.artifact_sha256 !== fileSha256) {
        throw await recordFailure(
          `artifact does not match backup run #${options.backupRunId}: ledger recorded ${String(row.artifact_sha256).slice(0, 12)}, file hashes to ${fileSha256.slice(0, 12)}`
        );
      }
      if (row.manifest_sha256 !== artifact.manifest_sha256) {
        throw await recordFailure(
          `manifest checksum disagrees with backup run #${options.backupRunId}: ledger ${String(row.manifest_sha256).slice(0, 12)}, artifact ${artifact.manifest_sha256.slice(0, 12)}`
        );
      }
      backupRun = row;
    }

    // 4. A real restore must be pinned to evidence.
    if (!dryRun && expected === null && backupRun === null) {
      throw await recordFailure(
        "refusing to import an unbound artifact: a restore requires --run-id (ledger row) or --sha256 (recorded checksum); use --dry-run to verify without writing"
      );
    }

    // 5. Full manifest contract validation before any write, producing the
    //    normalized form the loader consumes.
    let manifest: NormalizedManifest;
    try {
      manifest = normalizeArtifactManifest(artifact);
    } catch (error) {
      if (error instanceof ArtifactError) {
        throw await recordFailure(`artifact rejected: ${error.message}`);
      }
      throw error;
    }

    // 6. Import — the real loader, or the same loader replayed inside a
    //    rolled-back transaction for a dry run.
    let counters: HouseholdImportCounters;
    if (dryRun) {
      counters = await runDryRunImport(executor, manifest, options.clock);
    } else {
      counters = await runHouseholdImport(manifest, executor, { clock: options.clock });
    }

    const rowsImported = WRITE_COUNTER_FIELDS.reduce((sum, field) => sum + counters[field], 0);
    const counts: DrRestoreCounts = {
      profiles: counters.profilesSeen,
      profilesArchived: counters.profilesArchived,
      unresolvedLinks: counters.unresolvedLinks,
      conflictsSkipped: counters.conflictsSkipped
    };

    await executor.query(
      `UPDATE dr_restore_runs SET status = 'succeeded', finished_at = now(),
         artifact_path = $2, manifest_sha256 = $3, expected_sha256 = $4,
         backup_run_id = $5, checksum_verified = TRUE, rows_imported = $6, counts = $7::jsonb
       WHERE id = $1`,
      [
        runId,
        options.artifactPath ?? null,
        artifact.manifest_sha256,
        expected,
        backupRun === null ? null : Number(backupRun.id),
        rowsImported,
        JSON.stringify(counts)
      ]
    );

    return {
      runId,
      status: "succeeded",
      dryRun,
      checksumVerified: true,
      manifestSha256: artifact.manifest_sha256,
      rowsImported,
      counts,
      durationMs: Date.now() - startedMs
    };
  } catch (error) {
    if (error instanceof DrRestoreError) throw error;
    if (error instanceof HouseholdImportError) {
      throw await recordFailure(`household import failed: ${error.summary.errorDetail}`);
    }
    throw await recordFailure(error instanceof Error ? error.message : String(error));
  }
}

// Dry-run plumbing: the household import writes its run bookkeeping OUTSIDE
// its mutation transaction, so a truthful "verify without writing" has to
// wrap the whole import — bookkeeping included — in one transaction and
// force it to roll back. The import therefore runs exactly as it would in a
// real restore, against the real database, and every byte it wrote is
// undone. Returns the import's write counters; any import failure propagates
// (after the rollback).
const ROLLBACK_SENTINEL = Symbol("reelhouse-dr-dry-run-rollback");

async function runDryRunImport(
  executor: DrExecutor,
  manifest: NormalizedManifest,
  clock: (() => Date) | undefined
): Promise<HouseholdImportCounters> {
  let outcome: { counters?: HouseholdImportCounters; error?: unknown } = {};
  try {
    await executor.withTransaction(async (tx) => {
      // Everything the import can reach goes through the one live
      // transaction: its top-level bookkeeping queries and its own
      // withTransaction (flattened — the loader never needs real nesting).
      const dry: DrExecutor = {
        query: (text, params) => tx.query(text, params),
        withTransaction: (fn) => fn(dry)
      };
      try {
        const result = await runHouseholdImport(manifest, dry, { clock });
        outcome = { counters: result };
      } catch (error) {
        outcome = { error };
      }
      throw ROLLBACK_SENTINEL;
    });
  } catch (error) {
    if (error !== ROLLBACK_SENTINEL) throw error;
  }
  if (outcome.error !== undefined) throw outcome.error;
  if (!outcome.counters) throw new Error("internal: dry-run import returned no counters");
  return outcome.counters;
}

function normalizeSha256(raw: string | undefined): string | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`expected checksum must be 64 hex characters (got "${value.slice(0, 20)}…")`);
  }
  return value;
}
