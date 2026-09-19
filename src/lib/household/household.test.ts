// Unit tests for the household persistence layer: pure validation, error
// classification, row mapping, and store logic against scripted runners.
// No PostgreSQL here — the real-database behavior is covered by
// household.int.test.ts on the disposable PG18 instance.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { QueryResult, QueryResultRow } from "pg";
import {
  HouseholdConflictError,
  HouseholdInputError,
  HouseholdNotFoundError,
  classifyPgError,
  describePgErrorKind
} from "./errors.ts";
import {
  WATCH_PROGRESS_IDEMPOTENCY_SCOPE,
  claimIdempotencyKey,
  fingerprintWatchProgress,
  resolveMediaRef,
  storeProblemFromPgError,
  ticksFromDb,
  transact,
  truncateSyncError,
  type SqlRunner
} from "./store.ts";
import {
  HOUSEHOLD_LIMITS,
  parseDisplayName,
  parseExternalId,
  parseJellyfinUserId,
  parseLimit,
  parseMediaSource,
  parsePreferences,
  parseProfilePatch,
  parseTicks,
  parseUuid,
  parseWatchProgress
} from "./validate.ts";

// ------------------------------------------------------------- fake runner

interface ScriptedResponse {
  rows?: QueryResultRow[];
  rowCount?: number | null;
}

class FakeRunner implements SqlRunner {
  readonly queries: { text: string; params?: unknown[] }[] = [];
  readonly released: boolean[] = [];
  private readonly script: ScriptedResponse[] = [];

  enqueue(response: ScriptedResponse): this {
    this.script.push(response);
    return this;
  }

  release(): void {
    this.released.push(true);
  }

  releasedCount(): number {
    return this.released.filter(Boolean).length;
  }

  async query<R extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
    this.queries.push({ text, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text.trim())) {
      return { rows: [], rowCount: null, command: text.split(" ")[0], oid: 0, fields: [] };
    }
    const next = this.script.shift();
    if (!next) throw new Error(`unexpected query (no scripted response): ${text.slice(0, 80)}`);
    return {
      rows: (next.rows ?? []) as R[],
      rowCount: next.rowCount ?? (next.rows ? next.rows.length : null),
      command: "",
      oid: 0,
      fields: []
    };
  }
}

// ------------------------------------------------------------- validation

test("parseUuid accepts canonical uuids and lowercases them", () => {
  const parsed = parseUuid("018F6B2E-4C7A-7CC1-B2B3-3F5D9A1C2E4B", "profile id");
  assert.ok(parsed.ok);
  if (parsed.ok) assert.equal(parsed.value, "018f6b2e-4c7a-7cc1-b2b3-3f5d9a1c2e4b");
});

test("parseUuid refuses non-uuid input without echoing it", () => {
  for (const bad of ["", "not-a-uuid", "123", null, undefined, 42]) {
    const parsed = parseUuid(bad, "profile id");
    assert.ok(!parsed.ok);
    if (!parsed.ok) {
      assert.deepEqual(parsed.errors, ["profile id must be a UUID"]);
      const echoed = String(bad);
      if (echoed.length > 0) {
        assert.ok(!JSON.stringify(parsed.errors).includes(echoed));
      }
    }
  }
});

test("parseDisplayName trims and enforces the bounded length", () => {
  const parsed = parseDisplayName("  Vali  ");
  assert.ok(parsed.ok);
  if (parsed.ok) assert.equal(parsed.value, "Vali");
  assert.ok(!parseDisplayName("   ").ok);
  assert.ok(!parseDisplayName("x".repeat(HOUSEHOLD_LIMITS.displayNameMax + 1)).ok);
  assert.ok(parseDisplayName("x".repeat(HOUSEHOLD_LIMITS.displayNameMax)).ok);
  assert.ok(!parseDisplayName(7).ok);
});

test("parseExternalId enforces the bounded length", () => {
  assert.ok(parseExternalId("  018f6b2e4c7a7cc1b2b33f5d9a1c2e4b ").ok);
  assert.ok(!parseExternalId("").ok);
  assert.ok(!parseExternalId("x".repeat(HOUSEHOLD_LIMITS.externalIdMax + 1)).ok);
});

test("parseMediaSource only accepts jellyfin today", () => {
  assert.deepEqual(parseMediaSource("jellyfin"), { ok: true, value: "jellyfin" });
  assert.ok(!parseMediaSource("plex").ok);
  assert.ok(!parseMediaSource(undefined).ok);
});

test("parseJellyfinUserId enforces the bounded length", () => {
  assert.ok(parseJellyfinUserId(" e8c2ea1f2f7d4a1f9a5b ").ok);
  assert.ok(!parseJellyfinUserId("").ok);
  assert.ok(!parseJellyfinUserId("x".repeat(HOUSEHOLD_LIMITS.jellyfinUserIdMax + 1)).ok);
});

test("parseTicks enforces integers, sign, and safe range", () => {
  assert.deepEqual(parseTicks(0, "position_ticks"), { ok: true, value: 0 });
  assert.deepEqual(parseTicks(1200, "position_ticks"), { ok: true, value: 1200 });
  assert.ok(!parseTicks(1.5, "position_ticks").ok);
  assert.ok(!parseTicks(-1, "position_ticks").ok);
  assert.ok(!parseTicks(Number.MAX_SAFE_INTEGER + 1, "position_ticks").ok);
  assert.ok(!parseTicks(0, "duration_ticks", { allowZero: false }).ok);
  assert.ok(parseTicks(1, "duration_ticks", { allowZero: false }).ok);
});

test("parsePreferences accepts objects and refuses arrays, scalars, oversize, and deep nests", () => {
  assert.deepEqual(parsePreferences({ theme: "dark" }), { ok: true, value: { theme: "dark" } });
  assert.ok(!parsePreferences([1, 2]).ok);
  assert.ok(!parsePreferences("dark").ok);
  assert.ok(!parsePreferences(null).ok);

  const big: Record<string, unknown> = {};
  for (let i = 0; i < 2000; i++) big[`k${i}`] = "y".repeat(20);
  const oversize = parsePreferences(big);
  assert.ok(!oversize.ok);
  if (!oversize.ok) assert.match(oversize.errors[0], /size or nesting depth/);

  let deep: unknown = "leaf";
  for (let i = 0; i < HOUSEHOLD_LIMITS.preferencesMaxDepth + 5; i++) deep = { nested: deep };
  assert.ok(!parsePreferences(deep).ok);
});

test("parseWatchProgress validates the full record and mirrors the database CHECK", () => {
  const good = parseWatchProgress({
    source: "jellyfin",
    externalId: "abc123",
    positionTicks: 500,
    durationTicks: 1000,
    completed: false
  });
  assert.ok(good.ok);
  if (good.ok) {
    assert.deepEqual(good.value, {
      source: "jellyfin",
      externalId: "abc123",
      positionTicks: 500,
      durationTicks: 1000,
      completed: false
    });
  }

  // Defaults: completed=false, duration optional, null duration treated as absent.
  const minimal = parseWatchProgress({ source: "jellyfin", externalId: "abc", positionTicks: 0, durationTicks: null });
  assert.ok(minimal.ok);
  if (minimal.ok) assert.equal(minimal.value.completed, false);

  const beyondDuration = parseWatchProgress({
    source: "jellyfin",
    externalId: "abc",
    positionTicks: 1001,
    durationTicks: 1000
  });
  assert.ok(!beyondDuration.ok);
  if (!beyondDuration.ok) assert.ok(beyondDuration.errors.some((e) => /position_ticks/.test(e)));

  const missingPosition = parseWatchProgress({ source: "jellyfin", externalId: "abc" });
  assert.ok(!missingPosition.ok);
  if (!missingPosition.ok) assert.ok(missingPosition.errors.some((e) => /position_ticks is required/.test(e)));

  assert.ok(!parseWatchProgress({ source: "jellyfin", externalId: "abc", positionTicks: 5, completed: "yes" }).ok);
  assert.ok(!parseWatchProgress({ source: "plex", externalId: "abc", positionTicks: 5 }).ok);
  assert.ok(!parseWatchProgress("progress").ok);
});

test("parseProfilePatch requires at least one field and validates types", () => {
  const rename = parseProfilePatch({ displayName: " Nicole " });
  assert.ok(rename.ok);
  if (rename.ok) assert.deepEqual(rename.value, { displayName: "Nicole" });

  const deactivate = parseProfilePatch({ isActive: false });
  assert.ok(deactivate.ok);

  assert.ok(!parseProfilePatch({}).ok);
  assert.ok(!parseProfilePatch({ displayName: "" }).ok);
  assert.ok(!parseProfilePatch({ isActive: "no" }).ok);
  assert.ok(!parseProfilePatch([]).ok);
});

test("parseLimit refuses out-of-contract values instead of clamping", () => {
  assert.deepEqual(parseLimit(null, 20, 50), { ok: true, value: 20 });
  assert.deepEqual(parseLimit("", 20, 50), { ok: true, value: 20 });
  assert.deepEqual(parseLimit("10", 20, 50), { ok: true, value: 10 });
  assert.ok(!parseLimit("0", 20, 50).ok);
  assert.ok(!parseLimit("51", 20, 50).ok);
  assert.ok(!parseLimit("-3", 20, 50).ok);
  assert.ok(!parseLimit("10; drop table", 20, 50).ok);
});

// ---------------------------------------------------- error classification

test("classifyPgError maps SQLSTATE classes to response categories", () => {
  assert.deepEqual(classifyPgError({ code: "23505", constraint: "household_profile_display_name_key" }), {
    kind: "conflict",
    code: "23505",
    constraint: "household_profile_display_name_key"
  });
  assert.equal(classifyPgError({ code: "23503" })?.kind, "missing-reference");
  assert.equal(classifyPgError({ code: "23514" })?.kind, "input");
  assert.equal(classifyPgError({ code: "23502" })?.kind, "input");
  assert.equal(classifyPgError({ code: "22P02" })?.kind, "input");
  assert.equal(classifyPgError({ code: "08006" })?.kind, "storage");
  assert.equal(classifyPgError(new Error("plain error")), undefined);
  assert.equal(classifyPgError("string"), undefined);
});

test("describePgErrorKind produces value-free category text", () => {
  const text = describePgErrorKind({ kind: "conflict", code: "23505" });
  assert.match(text, /conflicts with existing state/);
  assert.ok(!text.includes("vali"));
});

test("storeProblemFromPgError converts classified violations to typed store errors", () => {
  assert.ok(storeProblemFromPgError({ code: "23505" }) instanceof HouseholdConflictError);
  assert.ok(storeProblemFromPgError({ code: "23503" }) instanceof HouseholdNotFoundError);
  assert.ok(storeProblemFromPgError({ code: "23514" }) instanceof HouseholdInputError);
  const passthrough = new Error("connection refused");
  assert.equal(storeProblemFromPgError(passthrough), passthrough);
});

// ------------------------------------------------------------ row mapping

test("ticksFromDb accepts both pg bigint shapes and null", () => {
  assert.equal(ticksFromDb("1200"), 1200);
  assert.equal(ticksFromDb(1200), 1200);
  assert.equal(ticksFromDb(null), null);
});

// ---------------------------------------------------------- transact

test("transact commits and releases on success", async () => {
  const client = new FakeRunner().enqueue({ rows: [{ ok: 1 }] });
  const pool = { connect: async () => client };
  const result = await transact(pool, async (tx) => {
    await tx.query("SELECT 1");
    return "done";
  });
  assert.equal(result, "done");
  assert.ok(client.queries.some((q) => q.text === "BEGIN"));
  assert.ok(client.queries.some((q) => q.text === "COMMIT"));
  assert.ok(!client.queries.some((q) => q.text === "ROLLBACK"));
  assert.equal(client.releasedCount(), 1);
});

test("transact rolls back and re-raises the original error", async () => {
  const client = new FakeRunner();
  const pool = { connect: async () => client };
  const failure = new Error("constraint blew up");
  await assert.rejects(
    transact(pool, async () => {
      throw failure;
    }),
    (error: unknown) => error === failure
  );
  assert.ok(client.queries.some((q) => q.text === "ROLLBACK"));
  assert.ok(!client.queries.some((q) => q.text === "COMMIT"));
  assert.equal(client.releasedCount(), 1);
});

// ---------------------------------------------------------- media refs

test("resolveMediaRef returns the existing id without inserting", async () => {
  const runner = new FakeRunner().enqueue({ rows: [{ id: "ref-1" }] });
  const id = await resolveMediaRef(runner, "jellyfin", "abc");
  assert.equal(id, "ref-1");
  assert.equal(runner.queries.length, 1);
  assert.deepEqual(runner.queries[0]?.params, ["jellyfin", "abc"]);
});

test("resolveMediaRef inserts when absent and re-reads the winner on a race", async () => {
  const inserted = new FakeRunner().enqueue({ rows: [] }).enqueue({ rows: [{ id: "ref-2" }] });
  assert.equal(await resolveMediaRef(inserted, "jellyfin", "abc"), "ref-2");
  assert.equal(inserted.queries.length, 2);

  const raced = new FakeRunner()
    .enqueue({ rows: [] })
    .enqueue({ rows: [], rowCount: 0 })
    .enqueue({ rows: [{ id: "ref-3" }] });
  assert.equal(await resolveMediaRef(raced, "jellyfin", "abc"), "ref-3");
  assert.equal(raced.queries.length, 3);
});

// ------------------------------------------------------- sync metadata

test("truncateSyncError bounds failure messages at 2000 characters", () => {
  const long = "e".repeat(5000);
  const truncated = truncateSyncError(long);
  assert.ok(truncated.length <= 2001);
  assert.ok(truncated.startsWith("eeee"));

  const short = "boom";
  assert.equal(truncateSyncError(short), "boom");
});

// ------------------------------------------------------- idempotency

test("claimIdempotencyKey claims a fresh key", async () => {
  const runner = new FakeRunner().enqueue({ rows: [{ id: "k1" }], rowCount: 1 });
  const claim = await claimIdempotencyKey(runner, WATCH_PROGRESS_IDEMPOTENCY_SCOPE, "key-1", "fp-1");
  assert.equal(claim, "claimed");
  assert.deepEqual(runner.queries[0]?.params, [WATCH_PROGRESS_IDEMPOTENCY_SCOPE, "key-1", "fp-1"]);
});

test("claimIdempotencyKey detects a same-fingerprint replay", async () => {
  const runner = new FakeRunner().enqueue({ rows: [], rowCount: 0 }).enqueue({ rows: [{ fingerprint: "fp-1" }] });
  const claim = await claimIdempotencyKey(runner, WATCH_PROGRESS_IDEMPOTENCY_SCOPE, "key-1", "fp-1");
  assert.deepEqual(claim, { replay: true });
});

test("claimIdempotencyKey conflicts on a same-key different-payload replay", async () => {
  const runner = new FakeRunner().enqueue({ rows: [], rowCount: 0 }).enqueue({ rows: [{ fingerprint: "fp-other" }] });
  await assert.rejects(
    claimIdempotencyKey(runner, WATCH_PROGRESS_IDEMPOTENCY_SCOPE, "key-1", "fp-new"),
    HouseholdConflictError
  );
});

test("fingerprintWatchProgress is stable for identical semantic input only", () => {
  const base = {
    profileId: "p1",
    source: "jellyfin" as const,
    externalId: "abc",
    positionTicks: 500,
    durationTicks: 1000,
    completed: false
  };
  assert.equal(fingerprintWatchProgress(base), fingerprintWatchProgress({ ...base }));

  const noDuration = fingerprintWatchProgress({ ...base, durationTicks: undefined });
  assert.notEqual(fingerprintWatchProgress(base), noDuration);
  assert.notEqual(
    fingerprintWatchProgress(base),
    fingerprintWatchProgress({ ...base, positionTicks: 501 })
  );
  assert.match(fingerprintWatchProgress(base), /^[0-9a-f]{64}$/);
});
