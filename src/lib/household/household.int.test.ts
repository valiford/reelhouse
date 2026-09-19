// Integration tests for ReelHouse-owned household state persistence
// (RH-0017) against the disposable PostgreSQL 18 instance.
//
//   npm run test:db:up      start the disposable database (docker compose)
//   npm run test:db         run all integration suites (this one included)
//   npm run test:db:down    stop and discard the database
//
// Like the smoke and catalog suites, this suite drives its own database
// (reelhouse_household_test) inside the shared disposable container, created
// on demand with the reelhouse migrations applied fresh, so it never fights
// the other suites and never touches the production Synology target.

import { strict as assert } from "node:assert";
import { before, after, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import {
  HouseholdConflictError,
  HouseholdInputError,
  HouseholdNotFoundError
} from "./errors.ts";
import {
  WATCH_PROGRESS_IDEMPOTENCY_SCOPE,
  claimIdempotencyKey,
  createProfile,
  deleteJellyfinLink,
  deleteProfile,
  fingerprintWatchProgress,
  getJellyfinLink,
  getProfile,
  getWatchState,
  listContinueWatching,
  listProfiles,
  listWatchState,
  markSyncFailed,
  markSyncStarted,
  markSyncSucceeded,
  putJellyfinLink,
  recordWatchProgress,
  replacePreferences,
  resolveMediaRef,
  transact,
  updateProfile
} from "./store.ts";
import { runMigrations } from "../db/migrator.ts";

const ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_test";

const HOUSEHOLD_DATABASE_URL =
  process.env.HOUSEHOLD_TEST_DATABASE_URL ??
  "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_household_test";

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
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", ["reelhouse_household_test"]);
    if (exists.rowCount === 0) await client.query("CREATE DATABASE reelhouse_household_test");
  });

  await withClient(HOUSEHOLD_DATABASE_URL, async (client) => {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  });
  await runMigrations({ databaseUrl: HOUSEHOLD_DATABASE_URL, migrationsDir: MIGRATIONS_DIR, log: () => {} });

  pool = new Pool({ connectionString: HOUSEHOLD_DATABASE_URL, max: 2 });
});

after(async () => {
  if (pool) await pool.end();
});

async function resetTables(): Promise<void> {
  await withClient(HOUSEHOLD_DATABASE_URL, async (client) => {
    await client.query(
      "TRUNCATE household_profile, media_item_ref, sync_cursor, idempotency_record CASCADE"
    );
  });
}

async function scalar(client: Client, text: string, params?: unknown[]): Promise<unknown> {
  const result = await client.query(text, params);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const value = Object.values(row)[0];
  // bigint counts arrive as strings; coerce numeric strings for strict equals.
  return typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
}

describe("household profiles", () => {
  it("creates a profile with empty preferences and lists it", async () => {
    await resetTables();
    const created = await createProfile(pool, { displayName: "Vali" });
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.displayName, "Vali");
    assert.equal(created.isActive, true);
    assert.deepEqual(created.preferences, {});

    const listed = await listProfiles(pool, { limit: 100 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, created.id);

    const withInactive = await listProfiles(pool, { includeInactive: true, limit: 100 });
    assert.equal(withInactive.length, 1);
  });

  it("refuses duplicate names case-insensitively with a conflict", async () => {
    await resetTables();
    await createProfile(pool, { displayName: "Vali" });
    await assert.rejects(
      createProfile(pool, { displayName: "vali" }),
      (error: unknown) => {
        assertNoSecret(error);
        return error instanceof HouseholdConflictError;
      }
    );
    const listed = await listProfiles(pool, { limit: 100 });
    assert.equal(listed.length, 1);
  });

  it("creates a profile with initial preferences atomically", async () => {
    await resetTables();
    const created = await createProfile(pool, {
      displayName: "Nicole",
      preferences: { theme: "dark", autoplay: true }
    });
    assert.deepEqual(created.preferences, { theme: "dark", autoplay: true });

    const fetched = await getProfile(pool, created.id);
    assert.ok(fetched);
    assert.deepEqual(fetched?.preferences, { theme: "dark", autoplay: true });
  });

  it("renames, deactivates, hides from the default list, and is found with includeInactive", async () => {
    await resetTables();
    const created = await createProfile(pool, { displayName: "Temporary" });

    const renamed = await updateProfile(pool, created.id, { displayName: "Renamed", isActive: false });
    assert.ok(renamed);
    assert.equal(renamed?.displayName, "Renamed");
    assert.equal(renamed?.isActive, false);

    const visible = await listProfiles(pool, { limit: 100 });
    assert.equal(visible.length, 0);
    const all = await listProfiles(pool, { includeInactive: true, limit: 100 });
    assert.equal(all.length, 1);
  });

  it("conflicts when renaming onto an existing name and returns null for unknown updates", async () => {
    await resetTables();
    const first = await createProfile(pool, { displayName: "Vali" });
    await createProfile(pool, { displayName: "Nicole" });

    await assert.rejects(
      updateProfile(pool, first.id, { displayName: "nicole" }),
      HouseholdConflictError
    );
    const missing = await updateProfile(pool, "00000000-0000-0000-0000-000000000001", { isActive: false });
    assert.equal(missing, null);
  });

  it("deletes a profile and cascades every owned row", async () => {
    await resetTables();
    const created = await createProfile(pool, { displayName: "Doomed" });
    await putJellyfinLink(pool, created.id, "jf-user-1");
    await transact(pool, (tx) =>
      recordWatchProgress(tx, {
        profileId: created.id,
        source: "jellyfin",
        externalId: "movie-1",
        positionTicks: 300,
        completed: false
      })
    );

    const deleted = await deleteProfile(pool, created.id);
    assert.equal(deleted, true);
    assert.equal(await getProfile(pool, created.id), null);

    await withClient(HOUSEHOLD_DATABASE_URL, async (client) => {
      assert.equal(await scalar(client, "SELECT count(*) FROM profile_preferences"), 0);
      assert.equal(await scalar(client, "SELECT count(*) FROM jellyfin_account_link"), 0);
      assert.equal(await scalar(client, "SELECT count(*) FROM watch_state"), 0);
      assert.equal(await scalar(client, "SELECT count(*) FROM playback_event"), 0);
    });

    assert.equal(await deleteProfile(pool, created.id), false);
  });
});

describe("profile preferences", () => {
  it("replaces the whole object and reports missing profiles", async () => {
    await resetTables();
    const created = await createProfile(pool, { displayName: "Vali", preferences: { a: 1 } });

    const replaced = await replacePreferences(pool, created.id, { b: { c: [1, 2] }, keep: false });
    assert.ok(replaced);
    assert.deepEqual(replaced?.preferences, { b: { c: [1, 2] }, keep: false });

    const again = await replacePreferences(pool, created.id, {});
    assert.ok(again);
    assert.deepEqual(again?.preferences, {});

    // A missing profile surfaces as not-found (the FK is the authority).
    await assert.rejects(
      replacePreferences(pool, "00000000-0000-0000-0000-000000000002", {}),
      HouseholdNotFoundError
    );
  });

  it("rejects non-object preferences at the database even if a caller bypasses validation", async () => {
    await resetTables();
    const created = await createProfile(pool, { displayName: "Vali" });
    await assert.rejects(
      withClient(HOUSEHOLD_DATABASE_URL, async (client) =>
        client.query("UPDATE profile_preferences SET preferences = $1::jsonb WHERE profile_id = $2", [
          JSON.stringify([1, 2]),
          created.id
        ])
      ),
      (error: unknown) => {
        assertNoSecret(error);
        return typeof error === "object" && error !== null && (error as { code?: string }).code === "23514";
      }
    );
  });
});

describe("media item refs and the jellyfin account link", () => {
  it("resolves (source, external_id) to one stable id across repeat calls", async () => {
    await resetTables();
    const first = await resolveMediaRef(pool, "jellyfin", "episode-42");
    const second = await resolveMediaRef(pool, "jellyfin", "episode-42");
    assert.equal(first, second);
    const other = await resolveMediaRef(pool, "jellyfin", "episode-43");
    assert.notEqual(first, other);
  });

  it("round-trips the 1:1 link, preserves created_at across re-link, and conflicts on a stolen user id", async () => {
    await resetTables();
    const vali = await createProfile(pool, { displayName: "Vali" });
    const nicole = await createProfile(pool, { displayName: "Nicole" });

    const linked = await putJellyfinLink(pool, vali.id, "jf-user-a");
    assert.equal(linked.jellyfinUserId, "jf-user-a");
    const fetched = await getJellyfinLink(pool, vali.id);
    assert.equal(fetched?.jellyfinUserId, "jf-user-a");

    const relinked = await putJellyfinLink(pool, vali.id, "jf-user-b");
    assert.equal(relinked.jellyfinUserId, "jf-user-b");
    assert.equal(relinked.createdAt, linked.createdAt, "re-link must keep the original creation stamp");
    assert.notEqual(relinked.updatedAt, linked.updatedAt);

    await assert.rejects(
      putJellyfinLink(pool, nicole.id, "jf-user-b"),
      HouseholdConflictError,
      "a jellyfin user id already claimed by another profile must conflict"
    );

    assert.equal(await deleteJellyfinLink(pool, vali.id), true);
    assert.equal(await getJellyfinLink(pool, vali.id), null);
    assert.equal(await deleteJellyfinLink(pool, vali.id), false);
  });

  it("refuses a link for a missing profile", async () => {
    await resetTables();
    await assert.rejects(
      putJellyfinLink(pool, "00000000-0000-0000-0000-000000000003", "jf-user-x"),
      HouseholdNotFoundError
    );
  });
});

describe("watch state and the continue-watching overlay", () => {
  it("records progress atomically: one overlay row, one history event per write", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });

    const first = await transact(pool, (tx) =>
      recordWatchProgress(tx, {
        profileId: profile.id,
        source: "jellyfin",
        externalId: "movie-1",
        positionTicks: 300,
        durationTicks: 6000,
        completed: false
      })
    );
    assert.equal(first.positionTicks, 300);
    assert.equal(first.durationTicks, 6000);
    assert.equal(first.completed, false);
    assert.equal(first.source, "jellyfin");
    assert.equal(first.externalId, "movie-1");

    const second = await transact(pool, (tx) =>
      recordWatchProgress(tx, {
        profileId: profile.id,
        source: "jellyfin",
        externalId: "movie-1",
        positionTicks: 900,
        durationTicks: 6000,
        completed: false
      })
    );
    assert.equal(second.positionTicks, 900);

    await withClient(HOUSEHOLD_DATABASE_URL, async (client) => {
      assert.equal(await scalar(client, "SELECT count(*) FROM watch_state"), 1);
      assert.equal(await scalar(client, "SELECT count(*) FROM playback_event"), 2);
      assert.equal(await scalar(client, "SELECT count(*) FROM media_item_ref"), 1);
    });

    const fetched = await getWatchState(pool, profile.id, "jellyfin", "movie-1");
    assert.equal(fetched?.positionTicks, 900);
    assert.equal(await getWatchState(pool, profile.id, "jellyfin", "movie-missing"), null);
  });

  it("rolls back the whole progress write (media ref included) when the transaction fails", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });

    const boom = new Error("simulated crash after the ref resolves");
    await assert.rejects(
      transact(pool, async (tx) => {
        const state = await recordWatchProgress(tx, {
          profileId: profile.id,
          source: "jellyfin",
          externalId: "movie-rollback",
          positionTicks: 10,
          completed: false
        });
        assert.ok(state);
        throw boom;
      }),
      (error: unknown) => error === boom
    );

    await withClient(HOUSEHOLD_DATABASE_URL, async (client) => {
      assert.equal(await scalar(client, "SELECT count(*) FROM watch_state"), 0);
      assert.equal(await scalar(client, "SELECT count(*) FROM playback_event"), 0);
      assert.equal(await scalar(client, "SELECT count(*) FROM media_item_ref"), 0, "the ref must not survive a rolled-back write");
    });
  });

  it("maps a write for a missing profile to not-found and leaves no orphan ref", async () => {
    await resetTables();
    await assert.rejects(
      transact(pool, (tx) =>
        recordWatchProgress(tx, {
          profileId: "00000000-0000-0000-0000-000000000004",
          source: "jellyfin",
          externalId: "movie-orphan",
          positionTicks: 5,
          completed: false
        })
      ),
      (error: unknown) => {
        assertNoSecret(error);
        return error instanceof HouseholdNotFoundError;
      }
    );
    await withClient(HOUSEHOLD_DATABASE_URL, async (client) => {
      assert.equal(await scalar(client, "SELECT count(*) FROM media_item_ref"), 0);
    });
  });

  it("refuses position beyond duration at the database and classifies it as input", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });
    // Bypass the request-layer validation on purpose: prove the database
    // CHECK is the backstop and the store maps it to HouseholdInputError.
    await assert.rejects(
      transact(pool, (tx) =>
        recordWatchProgress(tx, {
          profileId: profile.id,
          source: "jellyfin",
          externalId: "movie-overrun",
          positionTicks: 999,
          durationTicks: 10,
          completed: false
        })
      ),
      HouseholdInputError
    );
  });

  it("answers the continue-watching query: excludes unstarted and completed, orders by recency, bounds the limit", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });
    const record = (externalId: string, positionTicks: number, completed: boolean) =>
      transact(pool, (tx) =>
        recordWatchProgress(tx, {
          profileId: profile.id,
          source: "jellyfin",
          externalId,
          positionTicks,
          completed
        })
      );

    await record("unstarted", 0, false);
    await record("in-progress-a", 100, false);
    await record("in-progress-b", 200, false);
    await record("finished", 5000, true);

    // Deterministic recency: stamp explicit last_played_at values instead of
    // racing the server clock.
    await withClient(HOUSEHOLD_DATABASE_URL, async (client) => {
      await client.query(
        `UPDATE watch_state SET last_played_at = timestamptz '2026-09-19 10:00:00+00' WHERE media_ref_id = (SELECT id FROM media_item_ref WHERE external_id = 'in-progress-a')`,
        []
      );
      await client.query(
        `UPDATE watch_state SET last_played_at = timestamptz '2026-09-19 11:00:00+00' WHERE media_ref_id = (SELECT id FROM media_item_ref WHERE external_id = 'in-progress-b')`,
        []
      );
      await client.query(
        `UPDATE watch_state SET last_played_at = timestamptz '2026-09-19 12:00:00+00' WHERE media_ref_id = (SELECT id FROM media_item_ref WHERE external_id = 'finished')`,
        []
      );
    });

    const continueWatching = await listContinueWatching(pool, profile.id, { limit: 20 });
    assert.deepEqual(
      continueWatching.map((item) => item.externalId),
      ["in-progress-b", "in-progress-a"],
      "newest activity first, completed and unstarted excluded"
    );

    const bounded = await listContinueWatching(pool, profile.id, { limit: 1 });
    assert.equal(bounded.length, 1);
    assert.equal(bounded[0]?.externalId, "in-progress-b");

    const everything = await listWatchState(pool, profile.id, { limit: 50 });
    assert.equal(everything.length, 4);

    // Recovery: finishing then resuming returns the item to the rail.
    await record("in-progress-b", 6000, true);
    assert.equal((await listContinueWatching(pool, profile.id, { limit: 20 })).length, 1);
    await record("in-progress-b", 6100, false);
    const resumed = await listContinueWatching(pool, profile.id, { limit: 20 });
    assert.equal(resumed.length, 2);
    assert.equal(resumed[0]?.externalId, "in-progress-b");
  });

  it("scopes every read and write to the owning profile", async () => {
    await resetTables();
    const vali = await createProfile(pool, { displayName: "Vali" });
    const nicole = await createProfile(pool, { displayName: "Nicole" });
    await transact(pool, (tx) =>
      recordWatchProgress(tx, {
        profileId: vali.id,
        source: "jellyfin",
        externalId: "shared-movie",
        positionTicks: 100,
        completed: false
      })
    );
    const nicoleItems = await listWatchState(pool, nicole.id, { limit: 50 });
    assert.equal(nicoleItems.length, 0);
    const valiItems = await listWatchState(pool, vali.id, { limit: 50 });
    assert.equal(valiItems.length, 1);
    // The same external id records independently per profile.
    await transact(pool, (tx) =>
      recordWatchProgress(tx, {
        profileId: nicole.id,
        source: "jellyfin",
        externalId: "shared-movie",
        positionTicks: 200,
        completed: false
      })
    );
    assert.equal((await listWatchState(pool, nicole.id, { limit: 50 }))[0]?.positionTicks, 200);
    assert.equal((await listWatchState(pool, vali.id, { limit: 50 }))[0]?.positionTicks, 100);
  });
});

describe("sync metadata", () => {
  it("tracks the started/succeeded lifecycle and preserves the cursor across a cursor-less restart", async () => {
    await resetTables();
    const startedAt = new Date("2026-09-19T10:00:00Z");
    const started = await markSyncStarted(pool, { job: "household_probe", cursor: { page: 3 } }, startedAt);
    assert.deepEqual(started.cursor, { page: 3 });
    assert.equal(started.lastStartedAt, startedAt.toISOString());

    const restarted = await markSyncStarted(pool, { job: "household_probe" }, new Date("2026-09-19T10:05:00Z"));
    assert.deepEqual(restarted.cursor, { page: 3 }, "an absent cursor must preserve the stored one");

    const succeeded = await markSyncSucceeded(
      pool,
      "household_probe",
      new Date("2026-09-19T10:06:00Z"),
      { page: 7 }
    );
    assert.ok(succeeded);
    assert.equal(new Date(succeeded?.lastSucceededAt ?? 0).getTime(), Date.parse("2026-09-19T10:06:00Z"));
    assert.equal(succeeded?.lastError, null);
    assert.deepEqual(succeeded?.cursor, { page: 7 });
  });

  it("carries a bounded error through failure and keeps the last good run visible, then recovers", async () => {
    await resetTables();
    await markSyncStarted(pool, { job: "household_probe", cursor: { page: 2 } }, new Date("2026-09-19T10:00:00Z"));
    await markSyncSucceeded(pool, "household_probe", new Date("2026-09-19T10:01:00Z"));

    const huge = "x".repeat(10_000);
    const failed = await markSyncFailed(pool, "household_probe", huge);
    assert.ok(failed);
    assert.ok((failed?.lastError?.length ?? 0) <= 2001, "failure text must be bounded");
    assert.equal(
      new Date(failed?.lastSucceededAt ?? 0).getTime(),
      Date.parse("2026-09-19T10:01:00Z"),
      "failure must not erase the last good run"
    );
    assert.deepEqual(failed?.cursor, { page: 2 });

    const recovered = await markSyncSucceeded(pool, "household_probe", new Date("2026-09-19T10:10:00Z"));
    assert.ok(recovered);
    assert.equal(recovered?.lastError, null);
    assert.equal(new Date(recovered?.lastSucceededAt ?? 0).getTime(), Date.parse("2026-09-19T10:10:00Z"));
  });

  it("returns null for lifecycle writes on unknown jobs", async () => {
    await resetTables();
    assert.equal(await markSyncFailed(pool, "never-started", "boom"), null);
    assert.equal(await markSyncSucceeded(pool, "never-started", new Date()), null);
  });
});

describe("idempotent progress recording", () => {
  it("claims once, replays without duplicating history, and conflicts on payload changes", async () => {
    await resetTables();
    const profile = await createProfile(pool, { displayName: "Vali" });
    const input = {
      profileId: profile.id,
      source: "jellyfin" as const,
      externalId: "movie-idem",
      positionTicks: 400,
      durationTicks: 8000,
      completed: false
    };
    const fingerprint = fingerprintWatchProgress(input);
    const key = "client-request-1";

    const recordOnce = async (runner: Pool) => {
      return transact(runner, async (tx) => {
        const claim = await claimIdempotencyKey(tx, WATCH_PROGRESS_IDEMPOTENCY_SCOPE, key, fingerprint);
        if (claim !== "claimed") {
          const existing = await getWatchState(tx, input.profileId, input.source, input.externalId);
          if (existing) return { replay: true as const, state: existing };
        }
        return { replay: false as const, state: await recordWatchProgress(tx, input) };
      });
    };

    const first = await recordOnce(pool);
    assert.equal(first.replay, false);

    const replay = await recordOnce(pool);
    assert.equal(replay.replay, true);
    assert.equal(replay.state.positionTicks, 400);

    await withClient(HOUSEHOLD_DATABASE_URL, async (client) => {
      assert.equal(await scalar(client, "SELECT count(*) FROM playback_event"), 1, "replay must not append history");
      assert.equal(await scalar(client, "SELECT count(*) FROM idempotency_record"), 1);
    });

    await assert.rejects(
      transact(pool, (tx) =>
        claimIdempotencyKey(
          tx,
          WATCH_PROGRESS_IDEMPOTENCY_SCOPE,
          key,
          fingerprintWatchProgress({ ...input, positionTicks: 999 })
        )
      ),
      HouseholdConflictError,
      "same key with a different payload must conflict"
    );
  });

  it("scopes keys so different scopes never collide", async () => {
    await resetTables();
    const first = await claimIdempotencyKey(pool, WATCH_PROGRESS_IDEMPOTENCY_SCOPE, "shared-key", "fp-a");
    assert.equal(first, "claimed");
    const otherScope = await claimIdempotencyKey(pool, "other_scope", "shared-key", "fp-b");
    assert.equal(otherScope, "claimed");
  });
});
