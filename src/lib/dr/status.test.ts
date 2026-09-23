// Hermetic unit evidence for the DR staleness verdicts (RH-0037).
//
// drVerdicts is the pure decision core of dr status: given freshness
// states and the last recovery attempts, name the operator actions that
// are outstanding. Pinned here without a database or a clock; the database
// composition is covered by the integration suite.

import test from "node:test";
import assert from "node:assert/strict";
import { drVerdicts } from "./status.ts";

function input(overrides: Partial<Parameters<typeof drVerdicts>[0]> = {}): Parameters<typeof drVerdicts>[0] {
  return {
    catalog: "fresh",
    household: "fresh",
    backup: "fresh",
    lastRestore: { status: "succeeded", dryRun: false, checksumVerified: true },
    lastRebuild: { status: "succeeded", verified: true },
    ...overrides
  };
}

test("a fully fresh, fully rehearsed posture is clean", () => {
  assert.deepEqual(drVerdicts(input()), []);
});

test("catalog and household staleness are named", () => {
  assert.deepEqual(drVerdicts(input({ catalog: "stale" })), ["catalog_stale"]);
  assert.deepEqual(drVerdicts(input({ catalog: "never" })), ["catalog_never_synced"]);
  assert.deepEqual(drVerdicts(input({ household: "stale" })), ["household_stale"]);
  assert.deepEqual(drVerdicts(input({ household: "never" })), ["household_never_imported"]);
});

test("backup staleness distinguishes missing from old", () => {
  assert.deepEqual(drVerdicts(input({ backup: "never" })), ["household_backup_missing"]);
  assert.deepEqual(drVerdicts(input({ backup: "stale" })), ["household_backup_stale"]);
});

test("recovery rehearsal gaps are flagged", () => {
  assert.deepEqual(drVerdicts(input({ lastRestore: null })), ["restore_never_rehearsed"]);
  assert.deepEqual(
    drVerdicts(input({ lastRestore: { status: "failed", dryRun: false, checksumVerified: false } })),
    ["restore_never_rehearsed"]
  );
  // A dry run is a verification, not a rehearsal: restoring for real has
  // never happened.
  assert.deepEqual(
    drVerdicts(input({ lastRestore: { status: "succeeded", dryRun: true, checksumVerified: true } })),
    ["restore_only_dry_run"]
  );
  assert.deepEqual(drVerdicts(input({ lastRebuild: null })), ["catalog_rebuild_never_rehearsed"]);
});

test("a fresh-from-nothing database names every outstanding action", () => {
  const verdicts = drVerdicts({
    catalog: "never",
    household: "never",
    backup: "never",
    lastRestore: null,
    lastRebuild: null
  });
  assert.deepEqual(verdicts, [
    "catalog_never_synced",
    "household_never_imported",
    "household_backup_missing",
    "restore_never_rehearsed",
    "catalog_rebuild_never_rehearsed"
  ]);
});
