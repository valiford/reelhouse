// Deterministic PostgreSQL integration evidence for RH-0027: favorites,
// watchlists, and curated collections — membership, splice/reorder
// semantics, tolerance to replays, profile isolation, and deletion
// cascades. Same disposable-database harness as household.int.test.ts.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client, Pool, type QueryResultRow } from "pg";
import { loadDatabaseConfig, type DatabaseConfig } from "../db/config.ts";
import { runMigrations } from "../db/migrator.ts";
import { HouseholdConflictError, HouseholdNotFoundError } from "./errors.ts";
import type { SqlRunner } from "./store.ts";
import { createProfile, deleteProfile } from "./store.ts";
import {
  addCollectionItem,
  addFavorite,
  addWatchlistItem,
  createCollection,
  createWatchlist,
  deleteCollection,
  deleteWatchlist,
  getCollection,
  getWatchlist,
  listCollections,
  listFavorites,
  listWatchlists,
  removeCollectionItem,
  removeFavorite,
  removeWatchlistItem,
  renameWatchlist,
  reorderCollectionItems,
  reorderWatchlistItems,
  requireMediaRef,
  requireProfile,
  resolveMediaRef,
  updateCollection
} from "./lists.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const LISTS_DB = "reelhouse_rh0027_lists_test";

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
let db: SqlRunner;

function needsDb(t: import("node:test").TestContext): SqlRunner {
  if (!pool) {
    t.skip("REELHOUSE_TEST_MIGRATE_URL / REELHOUSE_TEST_DATABASE_URL not set (hermetic mode)");
    throw new Error("unreachable");
  }
  return db;
}

async function scalar(text: string, params?: unknown[]): Promise<unknown> {
  const result = await pool.query<Record<string, unknown>>(text, params);
  const row = result.rows[0];
  if (!row) return undefined;
  const value = Object.values(row)[0];
  return typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
}

let nextMediaId = 0;

function mediaRef(): { source: "jellyfin"; id: string } {
  nextMediaId += 1;
  return { source: "jellyfin", id: `jf-list-${nextMediaId}` };
}

before(async () => {
  if (!migrateConfig || !appConfig) return;
  await withClient(migrateConfig, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${LISTS_DB} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${LISTS_DB}`);
    await client.query(`GRANT CONNECT ON DATABASE ${LISTS_DB} TO ${appConfig.user}`);
  });
  const run = await runMigrations(urlForDatabase(migrateConfig, LISTS_DB), MIGRATIONS_DIR, appConfig.user);
  assert.deepEqual(run.appliedNow, [1, 2, 3, 4, 5, 6, 7, 8]);
  const testApp = urlForDatabase(appConfig, LISTS_DB);
  pool = new Pool({
    host: testApp.host,
    port: testApp.port,
    user: testApp.user,
    password: testApp.password,
    database: testApp.database,
    ssl: testApp.ssl,
    max: 2
  });
  db = {
    async query<R extends QueryResultRow>(text: string, params?: unknown[]) {
      return pool.query<R>(text, params);
    }
  };
});

after(async () => {
  if (pool) await pool.end();
});

async function resetAll(): Promise<void> {
  // DELETE, not TRUNCATE: the application role is deliberately DML-only
  // (arwd), and the schema's ON DELETE CASCADEs clear every owned row.
  await pool.query("DELETE FROM household_profile");
  await pool.query("DELETE FROM media_item_ref");
  await pool.query("DELETE FROM collection");
  await pool.query("DELETE FROM watchlist");
}

// ---------------------------------------------------------------- favorites

test("favorites: add is idempotent, list is stable, remove is honest", async (t) => {
  needsDb(t);
  await resetAll();
  const profile = await createProfile(db, { displayName: "Vali" });
  const ref = mediaRef();
  const mediaRefId = await resolveMediaRef(db, ref.source, ref.id);

  const first = await addFavorite(db, profile.id, mediaRefId);
  assert.equal(first.created, true);
  assert.equal(first.favorite.externalId, ref.id);

  const replay = await addFavorite(db, profile.id, mediaRefId);
  assert.equal(replay.created, false);
  assert.equal(replay.favorite.createdAt, first.favorite.createdAt, "the original timestamp survives a replay");

  const listed = await listFavorites(db, profile.id, 100);
  assert.equal(listed.length, 1);

  const removed = await removeFavorite(db, profile.id, mediaRefId);
  assert.equal(removed.removed, true);
  const removedAgain = await removeFavorite(db, profile.id, mediaRefId);
  assert.equal(removedAgain.removed, false);
  assert.equal((await listFavorites(db, profile.id, 100)).length, 0);
});

test("favorites: profile isolation — another profile's favorite is invisible and removable only by its owner", async (t) => {
  needsDb(t);
  await resetAll();
  const vali = await createProfile(db, { displayName: "Vali" });
  const nicole = await createProfile(db, { displayName: "Nicole" });
  const mediaRefId = await resolveMediaRef(db, "jellyfin", "jf-secret");

  await addFavorite(db, vali.id, mediaRefId);
  assert.equal((await listFavorites(db, nicole.id, 100)).length, 0);

  // Nicole removing "her" copy of the favorite cannot touch Vali's row…
  const removed = await removeFavorite(db, nicole.id, mediaRefId);
  assert.equal(removed.removed, false);
  assert.equal((await listFavorites(db, vali.id, 100)).length, 1);
});

test("favorites and lists refuse unknown profiles with a not-found", async (t) => {
  needsDb(t);
  await resetAll();
  const ghost = "018f0000-0000-7000-8000-00000000dead";
  // The API guard answers not-found before any write is attempted.
  await assert.rejects(
    requireProfile(db, ghost),
    (error: unknown) => error instanceof HouseholdNotFoundError
  );
  // Direct store writes without that guard hit the schema's FK — the same
  // not-found classification, one layer deeper (defense in depth).
  await assert.rejects(
    addFavorite(db, ghost, await resolveMediaRef(db, "jellyfin", "jf-x")),
    /foreign key/
  );
  await assert.rejects(
    createWatchlist(db, ghost, "Ghost list"),
    /foreign key/
  );
});

// --------------------------------------------------------------- watchlists

test("watchlists: create tolerates repeats, rename conflicts, foreign lists are 404", async (t) => {
  needsDb(t);
  await resetAll();
  const vali = await createProfile(db, { displayName: "Vali" });
  const nicole = await createProfile(db, { displayName: "Nicole" });

  const created = await createWatchlist(db, vali.id, "Weekend");
  assert.equal(created.created, true);
  const repeated = await createWatchlist(db, vali.id, "weekend");
  assert.equal(repeated.created, false);
  assert.equal(repeated.watchlist.id, created.watchlist.id, "case-insensitive repeat returns the existing list");

  const renamed = await renameWatchlist(db, vali.id, created.watchlist.id, "Sunday");
  assert.equal(renamed.name, "Sunday");

  const second = await createWatchlist(db, vali.id, "Weekday");
  await assert.rejects(
    renameWatchlist(db, vali.id, second.watchlist.id, "SUNDAY"),
    (error: unknown) => error instanceof HouseholdConflictError
  );

  await assert.rejects(
    getWatchlist(db, nicole.id, created.watchlist.id),
    (error: unknown) => error instanceof HouseholdNotFoundError,
    "a foreign watchlist is indistinguishable from a missing one"
  );
  await assert.rejects(
    deleteWatchlist(db, nicole.id, created.watchlist.id),
    (error: unknown) => error instanceof HouseholdNotFoundError
  );

  const listed = await listWatchlists(db, vali.id);
  assert.equal(listed.length, 2);
  assert.equal((await listWatchlists(db, nicole.id)).length, 0);
});

test("watchlist items: append, splice, move, remove, and deterministic read order", async (t) => {
  needsDb(t);
  await resetAll();
  const profile = await createProfile(db, { displayName: "Vali" });
  const list = (await createWatchlist(db, profile.id, "Queue")).watchlist;

  const a = mediaRef();
  const b = mediaRef();
  const c = mediaRef();
  const idA = await resolveMediaRef(db, a.source, a.id);
  const idB = await resolveMediaRef(db, b.source, b.id);
  const idC = await resolveMediaRef(db, c.source, c.id);

  await addWatchlistItem(db, profile.id, list.id, idA, undefined);
  await addWatchlistItem(db, profile.id, list.id, idB, undefined);
  await addWatchlistItem(db, profile.id, list.id, idC, undefined);
  let detail = await getWatchlist(db, profile.id, list.id);
  assert.deepEqual(detail.items.map((item) => item.mediaRefId), [idA, idB, idC]);
  assert.deepEqual(detail.items.map((item) => item.position), [1, 2, 3]);

  // Re-add without a position is a no-op replay.
  const replay = await addWatchlistItem(db, profile.id, list.id, idB, undefined);
  assert.equal(replay.created, false);
  assert.equal(replay.item.position, 2);

  // Splice D into position 1: everyone else shifts down.
  const d = mediaRef();
  const idD = await resolveMediaRef(db, d.source, d.id);
  const spliced = await addWatchlistItem(db, profile.id, list.id, idD, 1);
  assert.equal(spliced.created, true);
  assert.equal(spliced.item.position, 1);
  detail = await getWatchlist(db, profile.id, list.id);
  assert.deepEqual(detail.items.map((item) => item.mediaRefId), [idD, idA, idB, idC]);
  assert.deepEqual(detail.items.map((item) => item.position), [1, 2, 3, 4]);

  // Move C to position 1: D..C shift up first.
  const moved = await addWatchlistItem(db, profile.id, list.id, idC, 1);
  assert.equal(moved.created, false);
  assert.equal(moved.item.position, 1);
  detail = await getWatchlist(db, profile.id, list.id);
  assert.deepEqual(detail.items.map((item) => item.mediaRefId), [idC, idD, idA, idB]);

  const removed = await removeWatchlistItem(db, profile.id, list.id, idD);
  assert.equal(removed.removed, true);
  detail = await getWatchlist(db, profile.id, list.id);
  assert.deepEqual(detail.items.map((item) => item.mediaRefId), [idC, idA, idB]);
});

test("watchlist reorder: full-set reorder renumbers 1..n; a stale set is a conflict", async (t) => {
  needsDb(t);
  await resetAll();
  const profile = await createProfile(db, { displayName: "Vali" });
  const list = (await createWatchlist(db, profile.id, "Order matters")).watchlist;
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const ref = mediaRef();
    ids.push(await resolveMediaRef(db, ref.source, ref.id));
  }
  for (const id of ids) await addWatchlistItem(db, profile.id, list.id, id, undefined);

  const reversed = await reorderWatchlistItems(db, profile.id, list.id, [ids[2], ids[1], ids[0]]);
  assert.deepEqual(reversed.map((item) => item.mediaRefId), [ids[2], ids[1], ids[0]]);
  assert.deepEqual(reversed.map((item) => item.position), [1, 2, 3]);

  await assert.rejects(
    reorderWatchlistItems(db, profile.id, list.id, [ids[2], ids[1]]),
    (error: unknown) => error instanceof HouseholdConflictError
  );

  // Reordering a foreign list is a 404, not a partial write.
  const nicole = await createProfile(db, { displayName: "Nicole" });
  await assert.rejects(
    reorderWatchlistItems(db, nicole.id, list.id, [ids[2], ids[1], ids[0]]),
    (error: unknown) => error instanceof HouseholdNotFoundError
  );
});

test("deleting a watchlist cascades its items", async (t) => {
  needsDb(t);
  await resetAll();
  const profile = await createProfile(db, { displayName: "Vali" });
  const list = (await createWatchlist(db, profile.id, "Doomed")).watchlist;
  const ref = mediaRef();
  await addWatchlistItem(db, profile.id, list.id, await resolveMediaRef(db, ref.source, ref.id), undefined);

  const deleted = await deleteWatchlist(db, profile.id, list.id);
  assert.equal(deleted.deleted, true);
  assert.equal(await scalar("SELECT count(*) FROM watchlist_item WHERE watchlist_id = $1", [list.id]), 0);
  assert.equal(await scalar("SELECT count(*) FROM watchlist WHERE id = $1", [list.id]), 0);
});

// -------------------------------------------------------------- collections

test("collections: household-level create, update, and creator-provenance survival", async (t) => {
  needsDb(t);
  await resetAll();
  const vali = await createProfile(db, { displayName: "Vali" });

  const created = await createCollection(db, {
    name: "Family Picks",
    description: "Friday night",
    createdByProfileId: vali.id
  });
  assert.equal(created.created, true);
  assert.equal(created.collection.createdByProfileId, vali.id);

  const repeated = await createCollection(db, { name: "family picks" });
  assert.equal(repeated.created, false);
  assert.equal(repeated.collection.id, created.collection.id);

  const renamed = await updateCollection(db, created.collection.id, { name: "Fridge Picks" });
  assert.equal(renamed.name, "Fridge Picks");
  assert.equal(renamed.description, "Friday night", "absent fields keep their values");

  const described = await updateCollection(db, created.collection.id, { description: "" });
  assert.equal(described.description, "");

  const other = await createCollection(db, { name: "Sleepover" });
  await assert.rejects(
    updateCollection(db, other.collection.id, { name: "FRIDGE PICKS" }),
    (error: unknown) => error instanceof HouseholdConflictError
  );

  assert.equal((await listCollections(db)).length, 2);

  // Deleting the creator profiles the collection survives, provenance nulled.
  await deleteProfile(db, vali.id);
  const survived = await getCollection(db, created.collection.id);
  assert.ok(survived);
  assert.equal(survived.createdByProfileId, null);
});

test("collection items: splice and reorder like watchlists, cascade on delete", async (t) => {
  needsDb(t);
  await resetAll();
  const collection = (await createCollection(db, { name: "Road trip" })).collection;

  const ids = [];
  for (let i = 0; i < 3; i++) {
    const ref = mediaRef();
    ids.push(await resolveMediaRef(db, ref.source, ref.id));
    await addCollectionItem(db, collection.id, ids[i], undefined);
  }
  const spliced = await addCollectionItem(db, collection.id, ids[2], 1);
  assert.equal(spliced.created, false, "moving an existing member is not a create");
  assert.equal(spliced.item.position, 1);

  const detail = await getCollection(db, collection.id);
  assert.deepEqual(detail.items.map((item) => item.mediaRefId), [ids[2], ids[0], ids[1]]);

  const reordered = await reorderCollectionItems(db, collection.id, [ids[1], ids[0], ids[2]]);
  assert.deepEqual(reordered.map((item) => item.position), [1, 2, 3]);

  const removed = await removeCollectionItem(db, collection.id, ids[0]);
  assert.equal(removed.removed, true);
  assert.equal((await getCollection(db, collection.id)).items.length, 2);

  const deleted = await deleteCollection(db, collection.id);
  assert.equal(deleted.deleted, true);
  assert.equal(await scalar("SELECT count(*) FROM collection_item WHERE collection_id = $1", [collection.id]), 0);
});

test("the media bridge requires exact (source, external_id) identity on read", async (t) => {
  needsDb(t);
  await resetAll();
  await resolveMediaRef(db, "jellyfin", "jf-known");
  assert.ok(await requireMediaRef(db, { source: "jellyfin", externalId: "jf-known" }));
  await assert.rejects(
    requireMediaRef(db, { source: "jellyfin", externalId: "jf-unknown" }),
    (error: unknown) => error instanceof HouseholdNotFoundError
  );
  await assert.rejects(
    requireMediaRef(db, { source: "jellyfin", externalId: "JF-KNOWN" }),
    (error: unknown) => error instanceof HouseholdNotFoundError,
    "external ids are case-sensitive identity data"
  );
});
