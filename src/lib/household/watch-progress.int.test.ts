// Integration tests for the RH-0022 watch-state hardening and Jellyfin
// reconciliation against the disposable PostgreSQL 18 instance.
//
//   npm run test:db:up      start the disposable database (docker compose)
//   npm run test:db         run all integration suites (this one included)
//   npm run test:db:down    stop and discard the database
//
// Owns its database (reelhouse_household_watch_test) like every other
// suite, so it never fights the RH-0017/0018 suites and never touches the
// production Synology target. Jellyfin itself is a fixture client — the
// HTTP shape of the resume client is exercised by the unit suite, and no
// test ever talks to a real Jellyfin server.

import { strict as assert } from "node:assert";
import { before, after, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { HouseholdConflictError, HouseholdNotFoundError } from "./errors.ts";
import {
  createProfile,
  deleteProfile,
  getJellyfinLink,
  listContinueWatching,
  listWatchState,
  putJellyfinLink,
  recordWatchProgress,
  transact,
  type WatchProgressResult
} from "./store.ts";
import {
  JellyfinUnavailableError,
  WATCH_RECONCILE_JOB_PREFIX,
  reconcileProfileWatchState,
  type JellyfinResumeClient,
  type JellyfinResumeItem,
  type JellyfinResumePage
} from "./reconcile.ts";
import { JellyfinSyncError } from "../catalog/jellyfin-client.ts";
import { runMigrations } from "../db/migrator.ts";

const ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_test";

const WATCH_DATABASE_URL =
  process.env.HOUSEHOLD_TEST_DATABASE_URL ??
  "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_household_watch_test";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "db", "migrations");

// The disposable credential pair must never appear in any failure output.
const SECRET_PAIR = "reelhouse_test:reelhouse_test";

function assertNoSecret(error: unknown): void {
  if (error instanceof Error && error.message.includes(SECRET_PAIR)) {
    throw new Error("a store error leaked the disposable credential pair");
  }
}

async function withClient<T>(databaseUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end();
  }
}

let pool: Pool;

before(async () => {
  await withClient(ADMIN_DATABASE_URL, async (client) => {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      "reelhouse_household_watch_test"
    ]);
    if (exists.rowCount === 0) await client.query("CREATE DATABASE reelhouse_household_watch_test");
  });

  await withClient(WATCH_DATABASE_URL, async (client) => {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  });
  await runMigrations({ databaseUrl: WATCH_DATABASE_URL, migrationsDir: MIGRATIONS_DIR, log: () => {} });

  pool = new Pool({ connectionString: WATCH_DATABASE_URL, max: 2 });
});

after(async () => {
  if (pool) await pool.end();
});

async function resetTables(): Promise<void> {
  await withClient(WATCH_DATABASE_URL, async (client) => {
    await client.query("TRUNCATE household_profile, media_item_ref, sync_cursor, idempotency_record CASCADE");
  });
}

async function scalar(client: Client, text: string, params?: unknown[]): Promise<unknown> {
  const result = await client.query(text, params);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const value = Object.values(row)[0];
  return typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
}

function resumeClient(
  items: JellyfinResumeItem[],
  { skipped = 0, error }: { skipped?: number; error?: Error } = {}
): JellyfinResumeClient {
  return {
    async listResumeItems(): Promise<JellyfinResumePage> {
      if (error) throw error;
      return { items, skipped };
    }
  };
}

function item(externalId: string, overrides: Partial<JellyfinResumeItem> = {}): JellyfinResumeItem {
  return {
    externalId,
    positionTicks: 300,
    durationTicks: 6000,
    completed: false,
    playedAt: new Date("2026-09-19T10:00:00.000Z"),
    ...overrides
  };
}

const record = (profileId: string, externalId: string, positionTicks: number, playedAt?: Date) =>
  transact(pool, (tx) =>
    recordWatchProgress(tx, {
      profileId,
      source: "jellyfin",
      externalId,
      positionTicks,
      durationTicks: 6000,
      completed: false,
      playedAt
    })
  ) as Promise<WatchProgressResult>;

async function cursorRow(client: Client, job: string): Promise<Record<string, unknown> | undefined> {
  const result = await client.query("SELECT * FROM sync_cursor WHERE job = $1", [job]);
  return result.rows[0] as Record<string, unknown> | undefined;
}

describe("progress hardening: stale and duplicate writes (RH-0022)", () => {
  it("collapses an identical unstamped retry: no rewrite, no new history event", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });

    const first = await record(profile.id, "movie-1", 300);
    assert.equal(first.applied, true);
    assert.equal(first.stale, false);
    assert.equal(first.duplicate, false);

    const retry = await record(profile.id, "movie-1", 300);
    assert.equal(retry.applied, false);
    assert.equal(retry.stale, false);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.positionTicks, 300);
    assert.equal(retry.lastPlayedAt, first.lastPlayedAt, "a retry must not bump recency");

    // Distinct progress still applies and still appends history.
    const moved = await record(profile.id, "movie-1", 900);
    assert.equal(moved.applied, true);
    assert.equal(moved.duplicate, false);

    await withClient(WATCH_DATABASE_URL, async (client) => {
      assert.equal(await scalar(client, "SELECT count(*) FROM playback_event"), 2);
      assert.equal(await scalar(client, "SELECT count(*) FROM watch_state"), 1);
    });
  });

  it("never regresses the overlay with an older timestamped event, but records the play once", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });

    const t2 = new Date("2026-09-19T12:00:00.000Z");
    const t1 = new Date("2026-09-19T10:00:00.000Z");

    await record(profile.id, "movie-1", 900, t2);
    const stale = await record(profile.id, "movie-1", 100, t1);
    assert.equal(stale.applied, false);
    assert.equal(stale.stale, true);
    assert.equal(stale.duplicate, false);
    assert.equal(stale.positionTicks, 900, "the newer position must survive");
    assert.equal(stale.lastPlayedAt, t2.toISOString());

    // The stale play happened — history is honest — but replaying the same
    // event must not append it twice.
    const replayed = await record(profile.id, "movie-1", 100, t1);
    assert.equal(replayed.stale, true);
    assert.equal(replayed.duplicate, true);

    await withClient(WATCH_DATABASE_URL, async (client) => {
      assert.equal(await scalar(client, "SELECT count(*) FROM playback_event"), 2);
      const events = await client.query(
        "SELECT position_ticks FROM playback_event ORDER BY played_at DESC"
      );
      assert.deepEqual(events.rows.map((row) => Number(row.position_ticks)), [900, 100]);
    });
  });

  it("applies a newer timestamped event with the client timestamp", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });

    const earlier = new Date("2026-09-19T10:00:00.000Z");
    const later = new Date("2026-09-19T11:30:00.000Z");
    await record(profile.id, "movie-1", 100, earlier);
    const applied = await record(profile.id, "movie-1", 500, later);

    assert.equal(applied.applied, true);
    assert.equal(applied.stale, false);
    assert.equal(applied.lastPlayedAt, later.toISOString(), "the client timestamp owns recency");
    assert.equal(applied.positionTicks, 500);
  });

  it("orders the continue-watching rail deterministically on tied timestamps", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });
    await record(profile.id, "movie-a", 100);
    await record(profile.id, "movie-b", 200);

    const tied = "2026-09-19T10:00:00+00";
    await withClient(WATCH_DATABASE_URL, async (client) => {
      await client.query(
        `UPDATE watch_state SET last_played_at = timestamptz '${tied}'
          WHERE media_ref_id IN (SELECT id FROM media_item_ref WHERE external_id IN ('movie-a', 'movie-b'))`
      );
    });

    const rail = await listContinueWatching(pool, profile.id, { limit: 20 });
    assert.deepEqual(rail.map((row) => row.externalId), ["movie-a", "movie-b"], "tie broken by media_ref_id");
    assert.deepEqual(
      (await listContinueWatching(pool, profile.id, { limit: 20 })).map((row) => row.externalId),
      rail.map((row) => row.externalId),
      "the order is stable across reads"
    );
  });
});

describe("Jellyfin watch-state reconciliation (RH-0022)", () => {
  it("seeds an empty overlay from the linked Jellyfin account and answers the rail", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });
    await putJellyfinLink(pool, profile.id, "jf-user-1");

    const outcome = await reconcileProfileWatchState({
      source: pool,
      profileId: profile.id,
      client: resumeClient([
        item("ep-1", { positionTicks: 1200 }),
        item("movie-done", { positionTicks: 0, completed: true })
      ]),
      now: new Date("2026-09-19T12:00:00.000Z")
    });

    assert.equal(outcome.applied, 2);
    assert.equal(outcome.stale, 0);
    assert.equal(outcome.duplicate, 0);
    assert.equal(outcome.jellyfinUserId, "jf-user-1");
    assert.equal(outcome.cursor.lastError, null);

    const rail = await listContinueWatching(pool, profile.id, { limit: 20 });
    assert.deepEqual(rail.map((row) => row.externalId), ["ep-1"], "only the in-progress import rides the rail");
    assert.equal(rail[0]?.lastPlayedAt, "2026-09-19T10:00:00.000Z", "Jellyfin's timestamp owns recency");

    await withClient(WATCH_DATABASE_URL, async (client) => {
      const events = await client.query("SELECT recorded_by, count(*) FROM playback_event GROUP BY recorded_by");
      assert.equal(events.rows.length, 1);
      assert.equal(events.rows[0].recorded_by, "jellyfin_import");
      assert.equal(Number(events.rows[0].count), 2);
    });
  });

  it("re-running reconciliation is a no-op: duplicate history never accumulates", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });
    await putJellyfinLink(pool, profile.id, "jf-user-1");
    const client = resumeClient([item("ep-1")]);

    const first = await reconcileProfileWatchState({ source: pool, profileId: profile.id, client,
      now: new Date("2026-09-19T12:00:00.000Z")
    });
    assert.equal(first.applied, 1);

    const second = await reconcileProfileWatchState({ source: pool, profileId: profile.id, client,
      now: new Date("2026-09-19T12:05:00.000Z")
    });
    assert.equal(second.applied, 0);
    assert.equal(second.duplicate, 1, "identical state with no new event time is already applied");

    await withClient(WATCH_DATABASE_URL, async (client) => {
      assert.equal(await scalar(client, "SELECT count(*) FROM playback_event"), 1);
      assert.equal(await scalar(client, "SELECT count(*) FROM watch_state"), 1);
    });
  });

  it("lets newer Jellyfin state win and older Jellyfin state lose", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });
    await putJellyfinLink(pool, profile.id, "jf-user-1");

    // Local write is newer than Jellyfin's: local survives.
    await record(profile.id, "ep-1", 500, new Date("2026-09-19T11:00:00.000Z"));
    const older = await reconcileProfileWatchState({
      source: pool,
      profileId: profile.id,
      client: resumeClient([item("ep-1", { positionTicks: 200, playedAt: new Date("2026-09-19T09:00:00.000Z") })])
    });
    assert.equal(older.applied, 0);
    assert.equal(older.stale, 1);
    const state = await listWatchState(pool, profile.id, { limit: 10 });
    assert.equal(state[0]?.positionTicks, 500);

    // Jellyfin newer than local: Jellyfin wins.
    const newer = await reconcileProfileWatchState({
      source: pool,
      profileId: profile.id,
      client: resumeClient([item("ep-1", { positionTicks: 2000, playedAt: new Date("2026-09-19T13:00:00.000Z") })])
    });
    assert.equal(newer.applied, 1);
    const after = await listWatchState(pool, profile.id, { limit: 10 });
    assert.equal(after[0]?.positionTicks, 2000);
    assert.equal(after[0]?.lastPlayedAt, "2026-09-19T13:00:00.000Z");
  });

  it("imports an untimed Jellyfin item only into an empty overlay, never over local state", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });
    await putJellyfinLink(pool, profile.id, "jf-user-1");
    const untimed = [item("ep-1", { playedAt: null })];

    const seeded = await reconcileProfileWatchState({
      source: pool,
      profileId: profile.id,
      client: resumeClient(untimed),
      now: new Date("2026-09-19T12:00:00.000Z")
    });
    assert.equal(seeded.applied, 1);

    // Different local state now exists; the untimed item must not overwrite it.
    await record(profile.id, "ep-1", 800, new Date("2026-09-19T12:30:00.000Z"));
    const guarded = await reconcileProfileWatchState({
      source: pool,
      profileId: profile.id,
      client: resumeClient(untimed),
      now: new Date("2026-09-19T12:40:00.000Z")
    });
    assert.equal(guarded.applied, 0);
    assert.equal(guarded.stale, 1);
    const state = await listWatchState(pool, profile.id, { limit: 10 });
    assert.equal(state[0]?.positionTicks, 800);
  });

  it("counts skipped malformed items without applying them", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });
    await putJellyfinLink(pool, profile.id, "jf-user-1");

    const outcome = await reconcileProfileWatchState({
      source: pool,
      profileId: profile.id,
      client: resumeClient([item("ep-1")], { skipped: 3 })
    });
    assert.equal(outcome.applied, 1);
    assert.equal(outcome.skipped, 3);
    assert.equal(outcome.cursor.cursor.skipped, 3, "the cursor carries the bounded diagnostic");
  });

  it("writes only the linked profile's rows: profile isolation", async () => {
    await resetTables();
    const vali = await createProfile(pool, { displayName: "Vali" });
    const nicole = await createProfile(pool, { displayName: "Nicole" });
    await putJellyfinLink(pool, vali.id, "jf-user-1");

    const outcome = await reconcileProfileWatchState({
      source: pool,
      profileId: vali.id,
      client: resumeClient([item("ep-1"), item("ep-2")])
    });
    assert.equal(outcome.applied, 2);

    assert.equal((await listWatchState(pool, nicole.id, { limit: 10 })).length, 0);
    assert.equal(await getJellyfinLink(pool, nicole.id), null);
    // The shared Jellyfin identity cannot be claimed by a second profile.
    await assert.rejects(
      putJellyfinLink(pool, nicole.id, "jf-user-1"),
      HouseholdConflictError
    );
    // Deleting the owning profile cascades the imported state; the shared
    // media refs are the identity bridge, not profile-owned, and survive.
    await deleteProfile(pool, vali.id);
    await withClient(WATCH_DATABASE_URL, async (client) => {
      assert.equal(await scalar(client, "SELECT count(*) FROM watch_state"), 0);
      assert.equal(await scalar(client, "SELECT count(*) FROM playback_event"), 0);
      assert.equal(await scalar(client, "SELECT count(*) FROM media_item_ref"), 2);
    });
  });

  it("fails closed: unknown profile, unlinked profile, and unreachable Jellyfin", async () => {
    await resetTables();
    await assert.rejects(
      reconcileProfileWatchState({ source: pool, profileId: "00000000-0000-0000-0000-000000000009", client: resumeClient([]) }),
      HouseholdNotFoundError
    );

    const profile = await createProfile(pool, { displayName: "Vali" });
    await assert.rejects(
      reconcileProfileWatchState({ source: pool, profileId: profile.id, client: resumeClient([item("ep-1")]) }),
      (error: unknown) => {
        assertNoSecret(error);
        return error instanceof HouseholdConflictError;
      },
      "no link means no identity to reconcile from"
    );
    await withClient(WATCH_DATABASE_URL, async (client) => {
      assert.equal(await scalar(client, "SELECT count(*) FROM playback_event"), 0);
      assert.equal(await scalar(client, "SELECT count(*) FROM watch_state"), 0);
    });

    await putJellyfinLink(pool, profile.id, "jf-user-1");
    await assert.rejects(
      reconcileProfileWatchState({
        source: pool,
        profileId: profile.id,
        client: resumeClient([], { error: new JellyfinSyncError("Jellyfin API returned 503 Service Unavailable (/Users/jf-user-1/Items)", 503) })
      }),
      JellyfinUnavailableError
    );
  });

  it("tracks the reconciliation lifecycle in the per-profile sync cursor", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });
    await putJellyfinLink(pool, profile.id, "jf-user-1");
    const job = `${WATCH_RECONCILE_JOB_PREFIX}:${profile.id}`;

    // A failing run records a bounded error and no success stamp.
    await assert.rejects(
      reconcileProfileWatchState({
        source: pool,
        profileId: profile.id,
        client: resumeClient([], { error: new JellyfinSyncError("Jellyfin request failed: connect ECONNREFUSED (/Users/jf-user-1/Items)") })
      }),
      JellyfinUnavailableError
    );
    await withClient(WATCH_DATABASE_URL, async (client) => {
      const row = await cursorRow(client, job);
      assert.ok(row);
      assert.equal(row.last_error, "Jellyfin request failed: connect ECONNREFUSED (/Users/jf-user-1/Items)");
      assert.equal(row.last_succeeded_at, null);
      assert.ok(row.last_started_at, "the attempt itself is stamped");
    });

    // The next good run clears the error and stamps the counters.
    const outcome = await reconcileProfileWatchState({
      source: pool,
      profileId: profile.id,
      client: resumeClient([item("ep-1")]),
      now: new Date("2026-09-19T12:00:00.000Z")
    });
    assert.equal(outcome.applied, 1);
    await withClient(WATCH_DATABASE_URL, async (client) => {
      const row = await cursorRow(client, job);
      assert.ok(row);
      assert.equal(row.last_error, null);
      assert.deepEqual(row.cursor, {
        scanned: 1,
        applied: 1,
        stale: 0,
        duplicate: 0,
        skipped: 0,
        limit: 50
      });
    });
  });
});
