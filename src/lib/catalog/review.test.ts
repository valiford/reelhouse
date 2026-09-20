// Unit tests for the quarantine review workflow's pure half: reason
// ownership, input normalization, resolution states, and the duplicate-path
// / renamed-identity detector planning. Database behavior is covered by the
// integration suite.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DETECTOR_QUARANTINE_REASONS,
  LIST_LIMIT_MAX,
  QUARANTINE_REASONS,
  RESOLUTION_ACTIONS,
  RESOLVE_ACTIONS,
  SYNC_QUARANTINE_REASONS,
  describeResolutionState,
  normalizeLibraryPin,
  normalizeListLimit,
  normalizeProviderClaim,
  normalizeQuarantineId,
  normalizeResolution,
  planDuplicatePathFindings,
  planRenamedIdentityFindings,
  type CatalogPathRow
} from "./review.ts";

// ---- Reason ownership ----

test("sync reasons and detector reasons are disjoint and cover the whole vocabulary", () => {
  const sync = new Set<string>(SYNC_QUARANTINE_REASONS);
  const detector = new Set<string>(DETECTOR_QUARANTINE_REASONS);
  for (const reason of detector) assert.ok(!sync.has(reason), `reason ${reason} must belong to exactly one owner`);
  assert.equal(QUARANTINE_REASONS.length, sync.size + detector.size);
  assert.deepEqual([...sync].sort(), [
    "duplicate_external_id",
    "duplicate_provider_id",
    "invalid_item",
    "library_conflict",
    "orphan_parent"
  ]);
  assert.deepEqual([...detector].sort(), ["duplicate_path", "renamed_identity"]);
});

test("resolve actions exclude the remapped action, which only remap flows may set", () => {
  assert.ok(!(RESOLVE_ACTIONS as readonly string[]).includes("remapped"));
  assert.ok((RESOLUTION_ACTIONS as readonly string[]).includes("remapped"));
});

// ---- Resolution states ----

test("resolution state distinguishes open, operator actions, and automatic closes", () => {
  assert.equal(describeResolutionState("duplicate_path", null, null), "open");
  assert.equal(describeResolutionState("duplicate_provider_id", null, null), "open");
  assert.equal(describeResolutionState("duplicate_path", "2026-09-20T12:00:00Z", "dismissed"), "dismissed");
  assert.equal(describeResolutionState("library_conflict", "2026-09-20T12:00:00Z", "remapped"), "remapped");
  assert.equal(describeResolutionState("duplicate_provider_id", "2026-09-20T12:00:00Z", null), "auto_sync");
  assert.equal(describeResolutionState("renamed_identity", "2026-09-20T12:00:00Z", null), "auto_detect");
});

// ---- normalizeResolution ----

test("normalizeResolution accepts a bounded operator decision", () => {
  const result = normalizeResolution({ action: "dismissed", note: "  known dupe  ", by: "  alex  " });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") {
    assert.deepEqual(result.value, { action: "dismissed", note: "known dupe", by: "alex" });
  }
});

test("normalizeResolution turns an empty note into null", () => {
  const result = normalizeResolution({ action: "source_fixed", note: "   ", by: "alex" });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") assert.equal(result.value.note, null);
});

test("normalizeResolution rejects unknown actions and the remapped action", () => {
  for (const action of ["", "remapped", "deleted", "DISMISSED"]) {
    const result = normalizeResolution({ action, note: "", by: "alex" });
    assert.equal(result.kind, "invalid", `action "${action}" must be rejected`);
    if (result.kind === "invalid") assert.ok(result.errors[0].includes("action must be one of"));
  }
});

test("normalizeResolution rejects a missing operator and an oversized note", () => {
  const missing = normalizeResolution({ action: "dismissed", note: "", by: "   " });
  assert.equal(missing.kind, "invalid");
  const oversized = normalizeResolution({ action: "dismissed", note: "n".repeat(1001), by: "alex" });
  assert.equal(oversized.kind, "invalid");
  if (oversized.kind === "invalid") assert.match(oversized.errors[0], /at most 1000/);
});

// ---- normalizeProviderClaim ----

test("normalizeProviderClaim lowercases the provider and trims identifiers", () => {
  const result = normalizeProviderClaim({ provider: "  IMDB ", value: " tt111 ", to: " m-1 ", note: "dup", by: "alex" });
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") {
    assert.deepEqual(
      [result.value.provider, result.value.value, result.value.canonicalExternalId, result.value.note],
      ["imdb", "tt111", "m-1", "dup"]
    );
  }
});

test("normalizeProviderClaim rejects missing pieces", () => {
  for (const raw of [{}, { provider: "imdb" }, { provider: "imdb", value: "tt111" }, { provider: "", value: "tt111", to: "m-1", by: "alex" }]) {
    assert.equal(normalizeProviderClaim(raw).kind, "invalid");
  }
});

// ---- normalizeLibraryPin ----

test("normalizeLibraryPin accepts an item-to-library decision and rejects a self-pin", () => {
  const good = normalizeLibraryPin({ externalId: "m-1", to: "lib-movies", note: "moved", by: "alex" });
  assert.equal(good.kind, "valid");
  if (good.kind === "valid") assert.deepEqual([good.value.externalId, good.value.libraryExternalId], ["m-1", "lib-movies"]);
  const self = normalizeLibraryPin({ externalId: "m-1", to: "m-1", by: "alex" });
  assert.equal(self.kind, "invalid");
  if (self.kind === "invalid") assert.match(self.errors[0], /cannot be pinned to itself/);
});

// ---- normalizeQuarantineId ----

test("quarantine and override ids must be uuids", () => {
  assert.equal(normalizeQuarantineId("018f4d3e-7c1a-7cc2-9d3e-2f5a6b7c8d9e").kind, "valid");
  const upper = normalizeQuarantineId("018F4D3E-7C1A-7CC2-9D3E-2F5A6B7C8D9E");
  assert.equal(upper.kind, "valid");
  if (upper.kind === "valid") assert.equal(upper.value, "018f4d3e-7c1a-7cc2-9d3e-2f5a6b7c8d9e");
  for (const bad of ["", "m-1", "not a uuid", "018f4d3e7c1a7cc29d3e2f5a6b7c8d9e"]) {
    assert.equal(normalizeQuarantineId(bad).kind, "invalid", `"${bad}" must be rejected`);
  }
});

// ---- normalizeListLimit ----

test("listing bounds clamp into 1..max and default is applied by the caller", () => {
  assert.equal(normalizeListLimit(undefined), 100);
  assert.equal(normalizeListLimit(0), 1);
  assert.equal(normalizeListLimit(-5), 1);
  assert.equal(normalizeListLimit(1_000_000), LIST_LIMIT_MAX);
  assert.equal(normalizeListLimit(7), 7);
});

// ---- Detector planning ----

function pathRow(externalId: string, path: string, observedAt: string, overrides: Partial<CatalogPathRow> = {}): CatalogPathRow {
  return { externalId, path, observedAt, missingSince: null, retiredAt: null, ...overrides };
}

test("duplicate-path findings report every live claimant after the earliest observation", () => {
  const plan = planDuplicatePathFindings(
    [
      pathRow("b-2", "/media/a.mkv", "2026-09-02T00:00:00Z"),
      pathRow("a-1", "/media/a.mkv", "2026-09-01T00:00:00Z"),
      pathRow("c-3", "/media/a.mkv", "2026-09-03T00:00:00Z"),
      pathRow("solo", "/media/unique.mkv", "2026-09-01T00:00:00Z")
    ],
    500
  );
  assert.equal(plan.truncated, false);
  assert.deepEqual(
    plan.findings.map((finding) => [finding.externalId, finding.reason, finding.detail.incumbentExternalId]),
    [
      ["b-2", "duplicate_path", "a-1"],
      ["c-3", "duplicate_path", "a-1"]
    ]
  );
  const first = plan.findings[0];
  assert.ok(first !== undefined);
  assert.equal((first.detail.path as string), "/media/a.mkv");
  assert.equal(first.detail.incumbentObservedAt, "2026-09-01T00:00:00Z");
});

test("duplicate-path planning ignores missing and retired rows and is deterministic", () => {
  const plan = planDuplicatePathFindings(
    [
      pathRow("gone", "/media/a.mkv", "2026-09-01T00:00:00Z", { missingSince: "2026-09-05T00:00:00Z" }),
      pathRow("live", "/media/a.mkv", "2026-09-02T00:00:00Z"),
      pathRow("retired", "/media/b.mkv", "2026-09-01T00:00:00Z", { retiredAt: "2026-09-06T00:00:00Z" })
    ],
    500
  );
  assert.deepEqual(plan.findings, [], "a missing item sharing a path with a live one is a rename candidate, not a duplicate");
});

test("duplicate-path planning truncates deterministically and reports it", () => {
  const rows = [
    pathRow("b", "/p", "2026-09-01T00:00:00Z"),
    pathRow("a", "/p", "2026-09-02T00:00:00Z")
  ];
  const plan = planDuplicatePathFindings(rows, 0);
  assert.equal(plan.truncated, true);
  assert.equal(plan.findings.length, 0);
});

test("renamed-identity findings pair a gone item with the earliest live successor", () => {
  const plan = planRenamedIdentityFindings(
    [
      pathRow("new-1", "/media/moved.mkv", "2026-09-03T00:00:00Z"),
      pathRow("new-2", "/media/moved.mkv", "2026-09-02T00:00:00Z"),
      pathRow("old", "/media/moved.mkv", "2026-09-01T00:00:00Z", { missingSince: "2026-09-05T00:00:00Z" }),
      pathRow("retired-old", "/media/retired.mkv", "2026-09-01T00:00:00Z", { retiredAt: "2026-09-07T00:00:00Z" }),
      pathRow("live-only", "/media/retired.mkv", "2026-09-02T00:00:00Z")
    ],
    500
  );
  assert.equal(plan.truncated, false);
  assert.deepEqual(
    plan.findings.map((finding) => [finding.externalId, finding.detail.successorExternalId, finding.detail.path]),
    [
      ["old", "new-2", "/media/moved.mkv"],
      ["retired-old", "live-only", "/media/retired.mkv"]
    ]
  );
  const renamed = plan.findings[0];
  assert.ok(renamed !== undefined);
  assert.equal(renamed.reason, "renamed_identity");
  assert.equal(renamed.detail.missingSince, "2026-09-05T00:00:00Z");
  assert.equal(renamed.detail.retiredAt, null);
});

test("renamed-identity planning never pairs an item with itself and ignores unrelated paths", () => {
  const plan = planRenamedIdentityFindings(
    [
      pathRow("only", "/media/one.mkv", "2026-09-01T00:00:00Z", { missingSince: "2026-09-05T00:00:00Z" }),
      pathRow("other", "/media/two.mkv", "2026-09-01T00:00:00Z")
    ],
    500
  );
  assert.deepEqual(plan.findings, []);
});
