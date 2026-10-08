// Hermetic evidence for the RH-0036 workbench core: no database, no network.
//
// Covers the pure decision surface (payload/detail builders, repair input
// validation, filter normalization, evidence id extraction), the mechanical
// SQL placeholder↔parameter consistency invariant for every fixed query
// (the $n renumbering bug class), and the migration↔module enum drift guard
// (the reason/status/action CHECK constraints must know every value the
// module can write, or a valid repair would be rejected by the schema — or
// worse, an invalid one accepted).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  QUARANTINE_REASONS,
  QUARANTINE_STATUSES,
  WORKBENCH_LIMITS,
  duplicateFileDetail,
  duplicateFilePayload,
  evidenceItemIds,
  missingExternalIdDetail,
  missingExternalIdPayload,
  movedMediaDetail,
  movedMediaPayload,
  normalizeListParams,
  normalizeTargetLibraryId,
  parseQuarantineId,
  resolveEvidence,
  remapEvidence,
  validateRepairInput,
  WorkbenchParamError,
  // Every fixed SQL statement, imported for the placeholder invariant.
  INSERT_RUNNING_SCAN,
  COMPLETE_SCAN,
  DETECT_DUPLICATE_FILES,
  DETECT_MOVED_MEDIA,
  DETECT_MISSING_EXTERNAL_IDS,
  SELECT_ITEM_PROJECTIONS,
  FIND_OPEN_QUARANTINE,
  INSERT_SCAN_QUARANTINE,
  BUMP_SCAN_QUARANTINE,
  LIST_QUARANTINES,
  DESCRIBE_QUARANTINE,
  DESCRIBE_ITEM_HISTORY,
  DESCRIBE_REPAIRS,
  RESOLVE_QUARANTINE,
  REMAP_TARGET_LIBRARY,
  REMAP_READ_QUARANTINE,
  REMAP_READ_ITEM,
  REMAP_UPDATE_ITEM,
  INSERT_REPAIR_AUDIT
} from "./workbench.ts";

const ITEM_A = { jellyfinId: "mov-a", itemType: "movie", name: "Movie A", libraryJellyfinId: "lib-1" };
const ITEM_B = { jellyfinId: "mov-b", itemType: "movie", name: "Movie B", libraryJellyfinId: "lib-2" };

test("duplicate-file evidence is bounded and self-describing", () => {
  const many = Array.from({ length: WORKBENCH_LIMITS.payloadItemsPerConflict + 5 }, (_, index) => ({
    jellyfinId: `mov-${index}`,
    itemType: "movie",
    name: `Movie ${index}`,
    libraryJellyfinId: "lib-1"
  }));
  const payload = duplicateFilePayload("/media/x.mp4", many);
  assert.equal(payload.filePath, "/media/x.mp4");
  assert.equal(payload.itemCount, many.length, "itemCount reports the truth");
  const listed = payload.items as unknown[];
  assert.equal(
    listed.length,
    WORKBENCH_LIMITS.payloadItemsPerConflict,
    "the listed projections are capped"
  );

  const detail = duplicateFileDetail("/media/x.mp4", 3);
  assert.match(detail, /3 active catalog items/);
  assert.match(detail, /"\/media\/x\.mp4"/);
});

test("moved-media evidence separates live identities from retired ones", () => {
  const payload = movedMediaPayload(
    "/media/moved.mkv",
    [ITEM_A, ITEM_B],
    [{ jellyfinId: "mov-old", name: "Old Name", removedAt: "2026-01-01T00:00:00.000Z", firstSeenAt: "2025-01-01T00:00:00.000Z" }]
  );
  assert.equal(payload.filePath, "/media/moved.mkv");
  assert.equal(payload.activeCount, 2);
  assert.equal(payload.tombstonedCount, 1);
  assert.deepEqual(payload.active, [ITEM_A, ITEM_B]);
  assert.deepEqual(payload.tombstoned, [
    { jellyfinId: "mov-old", name: "Old Name", removedAt: "2026-01-01T00:00:00.000Z", firstSeenAt: "2025-01-01T00:00:00.000Z" }
  ]);

  const singular = movedMediaDetail("/media/moved.mkv", 1, 1);
  assert.match(singular, /1 newer identity/);
  assert.match(singular, /1 retired identity still claims it/);
  const plural = movedMediaDetail("/media/moved.mkv", 2, 3);
  assert.match(plural, /2 newer identities/);
  assert.match(plural, /3 retired identities still claim it/);
});

test("missing-external-id evidence carries the anchoring facts", () => {
  const ref = { ...ITEM_A, filePath: "/media/a.mkv" };
  assert.deepEqual(missingExternalIdPayload(ref), {
    jellyfinId: "mov-a",
    itemType: "movie",
    name: "Movie A",
    libraryJellyfinId: "lib-1",
    filePath: "/media/a.mkv"
  });
  assert.match(
    missingExternalIdDetail(ref),
    /active movie "Movie A" \(mov-a\) has no external provider IDs/
  );
});

test("repair input validation is fail-closed on operator and note", () => {
  assert.throws(() => validateRepairInput({ operator: undefined, note: null }), WorkbenchParamError);
  assert.throws(() => validateRepairInput({ operator: "   ", note: null }), WorkbenchParamError);
  assert.throws(
    () => validateRepairInput({ operator: "o".repeat(WORKBENCH_LIMITS.operatorMaxLength + 1), note: null }),
    WorkbenchParamError
  );
  assert.throws(() => validateRepairInput({ operator: "op", note: "   " }), WorkbenchParamError);
  assert.throws(
    () => validateRepairInput({ operator: "op", note: "n".repeat(WORKBENCH_LIMITS.noteMaxLength + 1) }),
    WorkbenchParamError
  );

  const clean = validateRepairInput({ operator: "  op-1 ", note: "  verified in Jellyfin  " });
  assert.deepEqual(clean, { operator: "op-1", note: "verified in Jellyfin" });
  assert.deepEqual(validateRepairInput({ operator: "op-1", note: null }), { operator: "op-1", note: null });
});

test("quarantine id and target-library parsing fail closed", () => {
  assert.throws(() => parseQuarantineId("0"), WorkbenchParamError);
  assert.throws(() => parseQuarantineId("-1"), WorkbenchParamError);
  assert.throws(() => parseQuarantineId("abc"), WorkbenchParamError);
  assert.throws(() => parseQuarantineId("1.5"), WorkbenchParamError);
  assert.equal(parseQuarantineId("42"), 42);

  assert.throws(() => normalizeTargetLibraryId("   "), WorkbenchParamError);
  assert.throws(() => normalizeTargetLibraryId("l".repeat(WORKBENCH_LIMITS.operatorMaxLength + 1)), WorkbenchParamError);
  assert.equal(normalizeTargetLibraryId("  lib-movies "), "lib-movies");
});

test("list filter normalization accepts only the closed enums", () => {
  assert.deepEqual(normalizeListParams({}), {
    status: "all",
    reason: "all",
    limit: WORKBENCH_LIMITS.listDefaultLimit
  });
  assert.deepEqual(normalizeListParams({ status: "quarantined", reason: "duplicate_file", limit: 5 }), {
    status: "quarantined",
    reason: "duplicate_file",
    limit: 5
  });

  assert.throws(() => normalizeListParams({ status: "open" }), WorkbenchParamError);
  assert.throws(() => normalizeListParams({ reason: "duplicate" }), WorkbenchParamError);
  assert.throws(() => normalizeListParams({ limit: 0 }), WorkbenchParamError);
  assert.throws(() => normalizeListParams({ limit: WORKBENCH_LIMITS.listMaxLimit + 1 }), WorkbenchParamError);
  assert.throws(() => normalizeListParams({ limit: 1.5 }), WorkbenchParamError);
});

test("evidence id extraction deduplicates, bounds, and skips file-path identities", () => {
  const filePathPayload = duplicateFilePayload("/media/x.mp4", [ITEM_A, ITEM_B]);
  assert.deepEqual(
    evidenceItemIds("/media/x.mp4", "duplicate_file", filePathPayload),
    ["mov-a", "mov-b"],
    "a file-path identity itself is not an item id"
  );

  const moved = movedMediaPayload("/media/m.mkv", [ITEM_A], [
    { jellyfinId: "mov-old", name: "Old", removedAt: "2026-01-01T00:00:00.000Z", firstSeenAt: "2025-01-01T00:00:00.000Z" }
  ]);
  assert.deepEqual(evidenceItemIds("/media/m.mkv", "moved_media", moved), ["mov-a", "mov-old"]);

  assert.deepEqual(evidenceItemIds("mov-solo", "missing_external_id", missingExternalIdPayload({ ...ITEM_A, filePath: null })), ["mov-solo"]);
  assert.deepEqual(evidenceItemIds("mov-solo", "duplicate_identity", {}), ["mov-solo"]);
  assert.deepEqual(evidenceItemIds("x", "duplicate_identity", null), ["x"]);

  const flood = duplicateFilePayload(
    "/media/y.mp4",
    Array.from({ length: WORKBENCH_LIMITS.describeItemsPerQuarantine + 3 }, (_, index) => ({
      jellyfinId: `mov-${index}`,
      itemType: "movie",
      name: `M${index}`,
      libraryJellyfinId: "lib-1"
    }))
  );
  assert.equal(
    evidenceItemIds("/media/y.mp4", "duplicate_file", flood).length,
    WORKBENCH_LIMITS.payloadItemsPerConflict,
    "the payload itself caps how many ids an inspection join can see"
  );
});

test("resolution and remap evidence are bounded plain-data projections", () => {
  const evidence = resolveEvidence({
    action: "released",
    reason: "duplicate_file",
    identity: "/media/x.mp4",
    occurrences: 2,
    firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-02-01T00:00:00.000Z"),
    detail: "detail sentence",
    payload: { filePath: "/media/x.mp4" },
    note: null
  });
  assert.equal(evidence.action, "released");
  const quarantine = evidence.quarantine as Record<string, unknown>;
  assert.equal(quarantine.reason, "duplicate_file");
  assert.equal(quarantine.occurrences, 2);
  assert.equal(quarantine.firstSeenAt, "2026-01-01T00:00:00.000Z");
  assert.equal(evidence.note, null);

  const remap = remapEvidence({
    reason: "duplicate_identity",
    identity: "mov-twin",
    itemName: "Twin",
    fromLibraryJellyfinId: "lib-movies",
    toLibraryJellyfinId: "lib-tv",
    note: "tv placement confirmed"
  });
  assert.equal(remap.action, "remapped");
  assert.deepEqual(remap.placement, {
    from: { libraryJellyfinId: "lib-movies" },
    to: { libraryJellyfinId: "lib-tv" }
  });
});

// Mechanical placeholder invariant: for every fixed statement the highest $n
// must equal the parameter count of its one and only call site, and every
// $1..$n must appear (no gaps, no stale renumbering).
const SQL_PARAM_CONTRACT: [name: string, sql: string, paramCount: number][] = [
  ["INSERT_RUNNING_SCAN", INSERT_RUNNING_SCAN, 0],
  ["COMPLETE_SCAN", COMPLETE_SCAN, 9],
  ["DETECT_DUPLICATE_FILES", DETECT_DUPLICATE_FILES, 1],
  ["DETECT_MOVED_MEDIA", DETECT_MOVED_MEDIA, 1],
  ["DETECT_MISSING_EXTERNAL_IDS", DETECT_MISSING_EXTERNAL_IDS, 1],
  ["SELECT_ITEM_PROJECTIONS", SELECT_ITEM_PROJECTIONS, 2],
  ["FIND_OPEN_QUARANTINE", FIND_OPEN_QUARANTINE, 2],
  ["INSERT_SCAN_QUARANTINE", INSERT_SCAN_QUARANTINE, 6],
  ["BUMP_SCAN_QUARANTINE", BUMP_SCAN_QUARANTINE, 5],
  ["LIST_QUARANTINES", LIST_QUARANTINES, 3],
  ["DESCRIBE_QUARANTINE", DESCRIBE_QUARANTINE, 1],
  ["DESCRIBE_ITEM_HISTORY", DESCRIBE_ITEM_HISTORY, 2],
  ["DESCRIBE_REPAIRS", DESCRIBE_REPAIRS, 1],
  ["RESOLVE_QUARANTINE", RESOLVE_QUARANTINE, 3],
  ["REMAP_TARGET_LIBRARY", REMAP_TARGET_LIBRARY, 1],
  ["REMAP_READ_QUARANTINE", REMAP_READ_QUARANTINE, 1],
  ["REMAP_READ_ITEM", REMAP_READ_ITEM, 1],
  ["REMAP_UPDATE_ITEM", REMAP_UPDATE_ITEM, 2],
  ["INSERT_REPAIR_AUDIT", INSERT_REPAIR_AUDIT, 6]
];

for (const [name, sql, paramCount] of SQL_PARAM_CONTRACT) {
  test(`placeholder invariant: ${name} uses exactly $1..$${paramCount}`, () => {
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    const highest = Math.max(0, ...placeholders);
    assert.equal(highest, paramCount, `${name} highest placeholder $${highest} must equal param count ${paramCount}`);
    const seen = new Set(placeholders);
    for (let index = 1; index <= paramCount; index += 1) {
      assert.ok(seen.has(index), `${name} is missing placeholder $${index}`);
    }
  });
}

test("migration 0009 knows every reason, status, action, and origin rule the module writes", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../../../db/migrations/0009_media_identity_workbench.sql", import.meta.url)),
    "utf8"
  );
  // The reason CHECK (rewritten by 0009) must cover the sync's
  // duplicate_identity plus every scan reason, or a scan would fail at
  // insert time against its own schema.
  for (const reason of QUARANTINE_REASONS) {
    assert.match(sql, new RegExp(`'${reason}'`), `migration 0009 must allow reason "${reason}"`);
  }
  assert.match(sql, /media_item_quarantine_reason_check/);

  // The origin rule: exactly one of run_id / scan_id.
  assert.match(sql, /media_item_quarantine_origin_check/);
  assert.match(sql, /ALTER COLUMN run_id DROP NOT NULL/);
  assert.match(sql, /ADD COLUMN scan_id/);

  // The audit trail: every resolution action the module can write.
  for (const action of ["released", "discarded", "remapped"]) {
    assert.match(sql, new RegExp(`'${action}'`), `migration 0009 must allow repair action "${action}"`);
  }
  assert.match(sql, /media_identity_scans/);
  assert.match(sql, /media_identity_repairs/);
});

test("module enums align with the quarantine statuses the schema allows", () => {
  assert.deepEqual([...QUARANTINE_STATUSES], ["quarantined", "released", "discarded"]);
  assert.deepEqual([...QUARANTINE_REASONS], [
    "duplicate_identity",
    "duplicate_file",
    "moved_media",
    "missing_external_id"
  ]);
});
