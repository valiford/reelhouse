// Deterministic PostgreSQL integration evidence for RH-0027: household
// profiles, preferences, Jellyfin account links, the watch/continue-watching
// overlay, the append-only playback history, replay-detection keys, and
// profile isolation.
//
// Runs against the disposable loopback PostgreSQL 18 profile
// (docker-compose.dev-db.yml) — never against Synology, and never against
// the reelhouse database: the suite provisions its own database
// (reelhouse_rh0027_test) so it cannot fight parallel suites over shared
// state. Requires two role URLs; without them every case skips so the
// hermetic `npm test` stays hermetic:
//
//   REELHOUSE_TEST_MIGRATE_URL   owner/migrator role, e.g.
//                                postgresql://reelhouse_owner:reelhouse_owner_dev@127.0.0.1:5433/reelhouse
//   REELHOUSE_TEST_DATABASE_URL  application role, e.g.
//                                postgresql://reelhouse_app:reelhouse_app_dev@127.0.0.1:5433/reelhouse
//
// Like the db/catalog suites this file deliberately avoids importing
// pool.ts (`server-only`); the store is driven through an injected runner.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client, Pool, type QueryResultRow } from "pg";
import { loadDatabaseConfig, type DatabaseConfig } from "../db/config.ts";
import { runMigrations } from "../db/migrator.ts";
import { HouseholdConflictError, HouseholdNotFoundError } from "./errors.ts";
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
  putJellyfinLink,
  recordWatchProgress,
  replacePreferences,
  resolveMediaRef,
  transact,
  updateProfile,
  type SqlRunner
} from "./store.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const HOUSEHOLD_DB = "reelhouse_rh0027_test";

const migrateEnv = process.env.REELHOUSE_TEST_MIGRATE_URL;
const appEnv = process.env.REELHOUSE_TEST_DATABASE_URL;

function parse(url: string): DatabaseConfig {
  const result = loadDatabaseConfig({ DATABASE_URL: url });
  if (result.kind !== "valid") {
    throw new Error(`test URL invalid: ${result.kind === "invalid" ? result.errors.join("; ") : "blank"}`);
  }
  return result.config;
}

function urlForDatabase(config: DatabaseConfig, database: string): DatabaseConfig {
  return { ...config, database };
}

async function withClient(config: DatabaseConfig, fn: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionTimeoutMillis: config.connectionTimeoutMs
  });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

const migrateConfig = migrateEnv ? parse(migrateEnv) : undefined;
const appConfig = appEnv ? parse(appEnv) : undefined;

let pool: Pool;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A runner for the pool, so tests exercise the exact code path the API uses.
function runner(db: Pool): SqlRunner {
  return {
    async query<R extends QueryResultRow>(text: string, params?: unknown[]) {
      return db.query<R>(text, params);
    }
  };
}

async function scalar(db: SqlRunner, text: string, params?: unknown[]): Promise<unknown> {
  const result = await db.query<Record<string, unknown>>(text, params);
  const row = result.rows[0];
  if (!row) return undefined;
  const value = Object.values(row)[0];
  return typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
}

before(async () => {
  if (!migrateConfig || !appConfig) return;
  await withClient(migrateConfig, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${HOUSEHOLD_DB} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${HOUSEHOLD_DB}`);
    await client.query(`GRANT CONNECT ON DATABASE ${HOUSEHOLD_DB} TO ${appConfig.user}`);
  });
  const testMigrate = urlForDatabase(migrateConfig, HOUSEHOLD_DB);
  const run = await runMigrations(testMigrate, MIGRATIONS_DIR, appConfig.user);
  assert.deepEqual(run.appliedNow, [1, 2, 3, 4, 5, 6, 7, 8]);
  const testApp = urlForDatabase(appConfig, HOUSEHOLD_DB);
  pool = new Pool({
    host: testApp.host,
    port: testApp.port,
    user: testApp.user,
    password: testApp.password,
    database: testApp.database,
    ssl: testApp.ssl,
    max: 2
  });
});

after(async () => {
  if (pool) await pool.end();
});

function needsDb(t: import("node:test").TestContext): SqlRunner {
  if (!pool) {
    t.skip("REELHOUSE_TEST_MIGRATE_URL / REELHOUSE_TEST_DATABASE_URL not set (hermetic mode)");
    throw new Error("unreachable");
  }
  return runner(pool);
}

async function resetHousehold(): Promise<void> {
  // DELETE, not TRUNCATE: the application role is deliberately DML-only
  // (arwd), and the schema's ON DELETE CASCADEs clear every owned row.
  await pool.query("DELETE FROM household_profile");
  await pool.query("DELETE FROM media_item_ref");
  await pool.query("DELETE FROM idempotency_record");
}

// ------------------------------------------------------------------ schema

test("migration history records all eight household migrations and re-applies as a no-op", async (t) => {
  needsDb(t);
  const rows = await pool.query<{ version: number; name: string }>(
    "SELECT version, name FROM public.schema_migrations ORDER BY version"
  );
  assert.deepEqual(
    rows.rows.map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7, 8]
  );
  assert.equal(rows.rows[1].name, "household_profiles_and_preferences");
  assert.equal(rows.rows[7].name, "household_idempotency");

  const testMigrate = urlForDatabase(migrateConfig!, HOUSEHOLD_DB);
  const rerun = await runMigrations(testMigrate, MIGRATIONS_DIR, appConfig!.user);
  assert.deepEqual(rerun.appliedNow, []);
  assert.equal(rerun.skipped, 8);
});

test("the application role can read migration bookkeeping but never write it", async (t) => {
  needsDb(t);
  await assert.rejects(
    pool.query("DELETE FROM public.schema_migrations"),
    /permission denied/
  );
  const read = await pool.query("SELECT count(*) FROM public.schema_migrations");
  assert.equal(Number((read.rows[0] as { count: string }).count), 8);
});

// ---------------------------------------------------------------- profiles

test("profiles: create, read, list, patch, and delete round-trip", async (t) => {
  const db = needsDb(t);
  await resetHousehold();

  const created = await createProfile(db, { displayName: "Vali", preferences: { theme: "dark" } });
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.displayName, "Vali");
  assert.equal(created.isActive, true);
  assert.deepEqual(created.preferences, { theme: "dark" });

  const fetched = await getProfile(db, created.id);
  assert.ok(fetched);
  assert.equal(fetched.displayName, "Vali");
  assert.equal(fetched.createdAt, created.createdAt);

  const listed = await listProfiles(db, { limit: 100 });
  assert.equal(listed.length, 1);

  const renamed = await updateProfile(db, created.id, { displayName: "V’Ali" });
  assert.ok(renamed);
  assert.equal(renamed.displayName, "V’Ali");

  const deactivated = await updateProfile(db, created.id, { isActive: false });
  assert.ok(deactivated);
  assert.equal(deactivated.isActive, false);

  const visibleDefault = await listProfiles(db, { limit: 100 });
  assert.equal(visibleDefault.length, 0, "inactive profiles are hidden by default");
  const visibleAll = await listProfiles(db, { includeInactive: true, limit: 100 });
  assert.equal(visibleAll.length, 1);

  const deleted = await deleteProfile(db, created.id);
  assert.equal(deleted, true);
  assert.equal(await getProfile(db, created.id), null);
  const deletedAgain = await deleteProfile(db, created.id);
  assert.equal(deletedAgain, false);
});

test("profiles: duplicate names conflict case-insensitively", async (t) => {
  const db = needsDb(t);
  await resetHousehold();
  await createProfile(db, { displayName: "Vali" });
  await assert.rejects(
    createProfile(db, { displayName: "vali" }),
    (error: unknown) => error instanceof HouseholdConflictError
  );
  // Trimming is the API validation layer's contract (parseDisplayName); the
  // store is byte-honest, so padded case variants are distinct store input.
});

test("profiles: renaming onto an existing name conflicts", async (t) => {
  const db = needsDb(t);
  await resetHousehold();
  const a = await createProfile(db, { displayName: "Vali" });
  const b = await createProfile(db, { displayName: "Nicole" });
  await assert.rejects(
    updateProfile(db, b.id, { displayName: "VALI" }),
    (error: unknown) => error instanceof HouseholdConflictError
  );
  assert.equal((await getProfile(db, a.id))?.displayName, "Vali");
});

// ------------------------------------------------------------- preferences

test("preferences: PUT replaces the whole object; unknown profiles answer null", async (t) => {
  const db = needsDb(t);
  await resetHousehold();
  const profile = await createProfile(db, { displayName: "Nicole", preferences: { theme: "light" } });

  const replaced = await replacePreferences(db, profile.id, { theme: "dark", autoplay: true });
  assert.deepEqual(replaced?.preferences, { theme: "dark", autoplay: true });

  const replacedAgain = await replacePreferences(db, profile.id, { autoplay: false });
  assert.deepEqual(replacedAgain?.preferences, { autoplay: false }, "no merge semantics");

  // An unknown profile cannot be written through: the preferences FK is
  // classified as a not-found (routes answer 404 from the profile check
  // before reaching this point; this is the defense-in-depth path).
  await assert.rejects(
    replacePreferences(db, "018f0000-0000-7000-8000-00000000dead", {}),
    (error: unknown) => error instanceof HouseholdNotFoundError
  );
});

// ----------------------------------------------------------- jellyfin link

test("jellyfin link: put, get, update, delete; one user can only link to one profile", async (t) => {
  const db = needsDb(t);
  await resetHousehold();
  const vali = await createProfile(db, { displayName: "Vali" });
  const nicole = await createProfile(db, { displayName: "Nicole" });

  const linked = await putJellyfinLink(db, vali.id, "user-a");
  assert.equal(linked.jellyfinUserId, "user-a");
  assert.equal((await getJellyfinLink(db, vali.id))?.jellyfinUserId, "user-a");

  const relinked = await putJellyfinLink(db, vali.id, "user-b");
  assert.equal(relinked.jellyfinUserId, "user-b", "same profile may re-point its link");

  await assert.rejects(
    putJellyfinLink(db, nicole.id, "user-b"),
    (error: unknown) => error instanceof HouseholdConflictError,
    "the same Jellyfin user cannot be linked to a second profile"
  );
  assert.equal(await getJellyfinLink(db, nicole.id), null);

  assert.equal(await deleteJellyfinLink(db, vali.id), true);
  assert.equal(await deleteJellyfinLink(db, vali.id), false);
});

// ------------------------------------------------------------- watch state

test("watch state: progress writes upsert the overlay and append exactly one history row each", async (t) => {
  const db = needsDb(t);
  await resetHousehold();
  const profile = await createProfile(db, { displayName: "Vali" });

  const first = await recordWatchProgress(db, {
    profileId: profile.id,
    source: "jellyfin",
    externalId: "jf-movie-1",
    positionTicks: 600,
    durationTicks: 1200,
    completed: false
  });
  assert.equal(first.externalId, "jf-movie-1");
  assert.equal(first.positionTicks, 600);
  assert.equal(first.completed, false);

  const second = await recordWatchProgress(db, {
    profileId: profile.id,
    source: "jellyfin",
    externalId: "jf-movie-1",
    positionTicks: 900,
    durationTicks: 1200,
    completed: false
  });
  assert.equal(second.positionTicks, 900);

  const overlayRows = await scalar(db, "SELECT count(*) FROM watch_state");
  assert.equal(overlayRows, 1, "the overlay holds exactly one row per (profile, item)");
  const historyRows = await scalar(db, "SELECT count(*) FROM playback_event");
  assert.equal(historyRows, 2, "history is append-only, one event per write");

  const single = await getWatchState(db, profile.id, "jellyfin", "jf-movie-1");
  assert.equal(single?.positionTicks, 900);
});

test("watch state: the same media id across profiles keeps one media ref but separate overlays", async (t) => {
  const db = needsDb(t);
  await resetHousehold();
  const vali = await createProfile(db, { displayName: "Vali" });
  const nicole = await createProfile(db, { displayName: "Nicole" });

  await recordWatchProgress(db, {
    profileId: vali.id,
    source: "jellyfin",
    externalId: "jf-shared",
    positionTicks: 100,
    completed: false
  });
  await recordWatchProgress(db, {
    profileId: nicole.id,
    source: "jellyfin",
    externalId: "jf-shared",
    positionTicks: 200,
    completed: false
  });

  assert.equal(await scalar(db, "SELECT count(*) FROM media_item_ref"), 1);
  assert.equal(await scalar(db, "SELECT count(*) FROM watch_state"), 2);
  assert.equal((await getWatchState(db, vali.id, "jellyfin", "jf-shared"))?.positionTicks, 100);
  assert.equal((await getWatchState(db, nicole.id, "jellyfin", "jf-shared"))?.positionTicks, 200);
});

test("watch state: profile isolation — no query path leaks another profile's rows", async (t) => {
  const db = needsDb(t);
  await resetHousehold();
  const vali = await createProfile(db, { displayName: "Vali" });
  const nicole = await createProfile(db, { displayName: "Nicole" });
  await recordWatchProgress(db, {
    profileId: vali.id,
    source: "jellyfin",
    externalId: "jf-private",
    positionTicks: 500,
    completed: false
  });

  assert.equal((await listWatchState(db, nicole.id, { limit: 50 })).length, 0);
  assert.equal((await listContinueWatching(db, nicole.id, { limit: 50 })).length, 0);
  assert.equal(await getWatchState(db, nicole.id, "jellyfin", "jf-private"), null);
});

test("continue watching: filters completed and zero-position rows, newest activity first", async (t) => {
  const db = needsDb(t);
  await resetHousehold();
  const profile = await createProfile(db, { displayName: "Vali" });

  await recordWatchProgress(db, {
    profileId: profile.id,
    source: "jellyfin",
    externalId: "jf-old",
    positionTicks: 300,
    completed: false
  });
  await sleep(10);
  await recordWatchProgress(db, {
    profileId: profile.id,
    source: "jellyfin",
    externalId: "jf-newest",
    positionTicks: 100,
    completed: false
  });
  await sleep(10);
  await recordWatchProgress(db, {
    profileId: profile.id,
    source: "jellyfin",
    externalId: "jf-done",
    positionTicks: 5000,
    durationTicks: 5000,
    completed: true
  });
  await sleep(10);
  await recordWatchProgress(db, {
    profileId: profile.id,
    source: "jellyfin",
    externalId: "jf-not-started",
    positionTicks: 0,
    completed: false
  });

  const rail = await listContinueWatching(db, profile.id, { limit: 20 });
  assert.deepEqual(
    rail.map((row) => row.externalId),
    ["jf-newest", "jf-old"],
    "completed and zero-position items leave the rail; newest activity leads"
  );

  // Finishing the newest item drops it from the rail too.
  await recordWatchProgress(db, {
    profileId: profile.id,
    source: "jellyfin",
    externalId: "jf-newest",
    positionTicks: 4000,
    durationTicks: 4000,
    completed: true
  });
  const afterFinish = await listContinueWatching(db, profile.id, { limit: 20 });
  assert.deepEqual(afterFinish.map((row) => row.externalId), ["jf-old"]);
});

test("idempotent progress: same key replays without duplicating history, different payload conflicts", async (t) => {
  const db = needsDb(t);
  await resetHousehold();
  const profile = await createProfile(db, { displayName: "Vali" });
  const input = {
    profileId: profile.id,
    source: "jellyfin" as const,
    externalId: "jf-resume",
    positionTicks: 1200,
    durationTicks: 2400,
    completed: false
  };
  const fingerprint = fingerprintWatchProgress(input);

  await transact(pool, async (tx) => {
    const claim = await claimIdempotencyKey(tx, WATCH_PROGRESS_IDEMPOTENCY_SCOPE, "retry-1", fingerprint);
    assert.equal(claim, "claimed");
    await recordWatchProgress(tx, input);
  });
  assert.equal(await scalar(db, "SELECT count(*) FROM playback_event"), 1);

  // A byte-different but semantically identical replay (recomputed from the
  // same normalized input) hits the stored fingerprint: no second append.
  await transact(pool, async (tx) => {
    const claim = await claimIdempotencyKey(tx, WATCH_PROGRESS_IDEMPOTENCY_SCOPE, "retry-1", fingerprint);
    assert.deepEqual(claim, { replay: true });
  });
  assert.equal(await scalar(db, "SELECT count(*) FROM playback_event"), 1);

  // The same key with a different payload is a client bug: conflict.
  await assert.rejects(
    transact(pool, async (tx) => {
      await claimIdempotencyKey(tx, WATCH_PROGRESS_IDEMPOTENCY_SCOPE, "retry-1", "different-fingerprint");
    }),
    (error: unknown) => error instanceof HouseholdConflictError
  );

  // A different key under the same scope claims independently.
  await transact(pool, async (tx) => {
    const claim = await claimIdempotencyKey(tx, WATCH_PROGRESS_IDEMPOTENCY_SCOPE, "retry-2", fingerprint);
    assert.equal(claim, "claimed");
  });
});

// -------------------------------------------------------- deletion cascade

test("deleting a profile cascades every owned row and proves isolation at the schema level", async (t) => {
  const db = needsDb(t);
  await resetHousehold();
  const vali = await createProfile(db, { displayName: "Vali" });
  const nicole = await createProfile(db, { displayName: "Nicole" });

  await recordWatchProgress(db, {
    profileId: vali.id,
    source: "jellyfin",
    externalId: "jf-cascade",
    positionTicks: 10,
    completed: false
  });
  const refId = await resolveMediaRef(db, "jellyfin", "jf-cascade");
  await db.query("INSERT INTO favorite (profile_id, media_ref_id) VALUES ($1, $2)", [vali.id, refId]);
  await putJellyfinLink(db, vali.id, "user-cascade");

  await deleteProfile(db, vali.id);

  assert.equal(await scalar(db, "SELECT count(*) FROM watch_state WHERE profile_id = $1", [vali.id]), 0);
  assert.equal(await scalar(db, "SELECT count(*) FROM playback_event WHERE profile_id = $1", [vali.id]), 0);
  assert.equal(await scalar(db, "SELECT count(*) FROM favorite WHERE profile_id = $1", [vali.id]), 0);
  assert.equal(await scalar(db, "SELECT count(*) FROM jellyfin_account_link WHERE profile_id = $1", [vali.id]), 0);
  // The media ref itself is household-shared identity, not owned by one profile.
  assert.equal(await scalar(db, "SELECT count(*) FROM media_item_ref WHERE id = $1", [refId]), 1);

  // Nicole's state is untouched by Vali's deletion.
  assert.ok(await getProfile(db, nicole.id));
});

// ---------------------------------------------------------- least privilege

test("the application role stays DML-only on the household schema", async (t) => {
  needsDb(t);
  await assert.rejects(
    pool.query("CREATE TABLE public.rh0027_escalate (id integer)"),
    /permission denied for schema public/
  );
  await assert.rejects(
    pool.query("ALTER TABLE household_profile ADD COLUMN smuggled text"),
    /permission denied|must be owner/
  );
});
