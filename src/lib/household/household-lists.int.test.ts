// Integration tests for household persistence (RH-0018) against the
// disposable PostgreSQL 18 instance (same lifecycle as the other suites).
//
//   npm run test:db:up      start the disposable database (docker compose)
//   npm run test:db         run all integration suites (this one included)
//   npm run test:db:down    stop and discard the database
//
// Covers the acceptance paths: durable writes across connections, natural
// idempotency (duplicate creates/favorites), idempotency-key replay and
// fingerprint reuse, stale reorder detection, profile isolation, profile
// deletion cascades, home-row source pairing, and transactional recovery
// (a failed mutation leaves nothing behind). Jellyfin is never contacted:
// media identity is (source, external_id) data only.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  addFavorite,
  addCollectionItem,
  addWatchlistItem,
  createCollection,
  createHomeRow,
  createWatchlist,
  deleteCollection,
  deleteHomeRow,
  deleteWatchlist,
  getCollection,
  getWatchlist,
  listCollections,
  listFavorites,
  listHomeRows,
  listWatchlists,
  removeFavorite,
  removeWatchlistItem,
  renameWatchlist,
  reorderCollectionItems,
  reorderHomeRows,
  reorderWatchlistItems,
  requireHomeRow,
  requireMediaRef,
  requireProfile,
  resolveMediaRef,
  updateCollection,
  updateHomeRow
} from "./lists.ts";
// transact and SqlRunner come from store.ts (the RH-0017 kernel)
import { transact, type SqlRunner } from "./store.ts";
import { runIdempotentMutation } from "./idempotency.ts";
import { HouseholdConflictError, HouseholdInputError, HouseholdNotFoundError } from "./errors.ts";
import { parseName } from "./model.ts";
import { runMigrations } from "../db/migrator.ts";

// This suite drives its OWN database (reelhouse_household_lists_test) inside the
// disposable container, created on demand — same pattern as the other
// household suite — so parallel suites can never reset each other's schema.
const LISTS_DATABASE_URL =
  process.env.LISTS_TEST_DATABASE_URL ??
  "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_household_lists_test";

const ADMIN_DATABASE_URL = "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_test";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "db", "migrations");

const MEDIA_A = { source: "jellyfin" as const, externalId: "jf-item-a" };
const MEDIA_B = { source: "jellyfin" as const, externalId: "jf-item-b" };
const MEDIA_C = { source: "jellyfin" as const, externalId: "jf-item-c" };
const MEDIA_D = { source: "jellyfin" as const, externalId: "jf-item-d" };

const pool: Pool = new Pool({ connectionString: LISTS_DATABASE_URL, max: 4 });
let profileA: string;
let profileB: string;

// Every "expected failure" in this suite asserts the RH-0017 error family:
// the same classes api.ts maps to 400/404/409 responses.
type HouseholdErrorClass = typeof HouseholdInputError | typeof HouseholdNotFoundError | typeof HouseholdConflictError;

function assertClass(expected: HouseholdErrorClass, error: unknown): void {
  assert.ok(error instanceof expected, `expected ${expected.name}, got: ${String(error)}`);
}

async function rejectsWith(expected: HouseholdErrorClass, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    assertClass(expected, error);
    return;
  }
  assert.fail(`expected ${expected.name} but the call succeeded`);
}

async function freshProfile(name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO household_profile (display_name) VALUES ($1) RETURNING id",
    [name]
  );
  return result.rows[0].id;
}

beforeEach(async () => {
  // Deterministic per-test state: clear household data (schema stays).
  await pool.query("TRUNCATE home_row, collection, watchlist, favorite, household_profile, idempotency_record CASCADE");
  profileA = await freshProfile("Ava");
  profileB = await freshProfile("Ben");
});

// Wrap pool.query as the SqlRunner the lists store accepts.
const db: SqlRunner = pool;

after(async () => {
  await pool.end();
});

// Verify reachability + create/migrate the suite database before anything runs.
await (async () => {
  const admin = new Pool({ connectionString: ADMIN_DATABASE_URL, max: 1 });
  try {
    await admin.query("SELECT 1");
  } catch {
    throw new Error(
      "Disposable PostgreSQL 18 is not reachable. Start it with: npm run test:db:up " +
        "(or point LISTS_TEST_DATABASE_URL at an expendable PostgreSQL 18 database)."
    );
  } finally {
    await admin.end();
  }
  const exists = await withAdmin(async (client) => {
    const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", ["reelhouse_household_lists_test"]);
    return result.rowCount !== 0;
  });
  if (!exists) await withAdmin((client) => client.query("CREATE DATABASE reelhouse_household_lists_test"));
  await runMigrations({ databaseUrl: LISTS_DATABASE_URL, migrationsDir: MIGRATIONS_DIR, log: () => {} });
})();

async function withAdmin<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const admin = new Pool({ connectionString: ADMIN_DATABASE_URL, max: 1 });
  const client = await admin.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await admin.end();
  }
}

describe("profiles and media identity", () => {
  it("fails closed on unknown profiles", async () => {
    await rejectsWith(HouseholdNotFoundError, () => requireProfile(db, "0f0e8c4a-7b1e-4d3e-9f2a-1b2c3d4e5f99"));
  });

  it("resolves media refs idempotently and requires them on read", async () => {
    const first = await resolveMediaRef(db, MEDIA_A.source, MEDIA_A.externalId);
    const second = await resolveMediaRef(db, MEDIA_A.source, MEDIA_A.externalId);
    assert.equal(first, second);
    assert.equal(await requireMediaRef(db, MEDIA_A), first);
    await rejectsWith(HouseholdNotFoundError, () => requireMediaRef(db, { source: "jellyfin", externalId: "never-seen" }));
  });
});

describe("favorites", () => {
  it("adds once, tolerates duplicates, lists deterministically, and removes", async () => {
    const first = await addFavorite(db, profileA, await resolveMediaRef(db, MEDIA_A.source, MEDIA_A.externalId));
    assert.equal(first.created, true);
    const duplicate = await addFavorite(db, profileA, await resolveMediaRef(db, MEDIA_A.source, MEDIA_A.externalId));
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.favorite.createdAt, first.favorite.createdAt);

    await addFavorite(db, profileA, await resolveMediaRef(db, MEDIA_B.source, MEDIA_B.externalId));
    await addFavorite(db, profileA, await resolveMediaRef(db, MEDIA_C.source, MEDIA_C.externalId));
    const favorites = await listFavorites(db, profileA, 200);
    assert.deepEqual(
      favorites.map((favorite) => favorite.externalId),
      ["jf-item-a", "jf-item-b", "jf-item-c"]
    );

    const removed = await removeFavorite(db, profileA, await requireMediaRef(db, MEDIA_B));
    assert.equal(removed.removed, true);
    const removedAgain = await removeFavorite(db, profileA, await requireMediaRef(db, MEDIA_B));
    assert.equal(removedAgain.removed, false);
    assert.equal((await listFavorites(db, profileA, 200)).length, 2);
  });

  it("isolates favorites per profile", async () => {
    await addFavorite(db, profileA, await resolveMediaRef(db, MEDIA_A.source, MEDIA_A.externalId));
    assert.deepEqual(await listFavorites(db, profileB, 200), []);
    await addFavorite(db, profileB, await resolveMediaRef(db, MEDIA_A.source, MEDIA_A.externalId));
    const both = await pool.query("SELECT count(*) AS n FROM favorite");
    assert.equal(Number(both.rows[0].n), 2, "same media under two profiles is two favorites");
  });

  it("cascades when the profile is deleted", async () => {
    await addFavorite(db, profileA, await resolveMediaRef(db, MEDIA_A.source, MEDIA_A.externalId));
    await pool.query("DELETE FROM household_profile WHERE id = $1", [profileA]);
    const remaining = await pool.query("SELECT count(*) AS n FROM favorite");
    assert.equal(Number(remaining.rows[0].n), 0);
  });
});

describe("watchlists", () => {
  it("creates tolerantly on duplicate names (case-insensitive), lists and renames", async () => {
    const first = await createWatchlist(db, profileA, "Weekend Picks");
    assert.equal(first.created, true);
    // The API layer normalizes names before they reach the store; mirror it.
    const duplicate = await createWatchlist(db, profileA, parseName("  weekend picks ", "name"));
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.watchlist.id, first.watchlist.id);

    await createWatchlist(db, profileA, "Docs");
    const lists = await listWatchlists(db, profileA);
    assert.deepEqual(lists.map((list) => list.name), ["Weekend Picks", "Docs"]);
    assert.deepEqual(await listWatchlists(db, profileB), []);

    await renameWatchlist(db, profileA, first.watchlist.id, "Saturday Picks");
    const renamed = await getWatchlist(db, profileA, first.watchlist.id);
    assert.equal(renamed.name, "Saturday Picks");
    await rejectsWith(HouseholdConflictError, () => renameWatchlist(db, profileA, first.watchlist.id, "DOCS"));
  });

  it("hides another profile's watchlist behind the same 404", async () => {
    const { watchlist } = await createWatchlist(db, profileA, "Mine");
    await rejectsWith(HouseholdNotFoundError, () => getWatchlist(db, profileB, watchlist.id));
    await rejectsWith(HouseholdNotFoundError, () => deleteWatchlist(db, profileB, watchlist.id));
    await rejectsWith(HouseholdNotFoundError, () => renameWatchlist(db, profileB, watchlist.id, "Hijack"));
  });

  it("adds, moves, and removes items with splice positions", async () => {
    const { watchlist } = await createWatchlist(db, profileA, "Splice");
    const a = await resolveMediaRef(db, MEDIA_A.source, MEDIA_A.externalId);
    const b = await resolveMediaRef(db, MEDIA_B.source, MEDIA_B.externalId);
    const c = await resolveMediaRef(db, MEDIA_C.source, MEDIA_C.externalId);
    const d = await resolveMediaRef(db, MEDIA_D.source, MEDIA_D.externalId);

    await addWatchlistItem(db, profileA, watchlist.id, a, undefined);
    await addWatchlistItem(db, profileA, watchlist.id, b, undefined);
    await addWatchlistItem(db, profileA, watchlist.id, c, undefined);
    // Duplicate add without position: no-op that reports the current slot.
    const noOp = await addWatchlistItem(db, profileA, watchlist.id, a, undefined);
    assert.equal(noOp.created, false);
    assert.equal(noOp.item.position, 1);

    // Insert at the front splices the rest down.
    const front = await addWatchlistItem(db, profileA, watchlist.id, d, 1);
    assert.equal(front.created, true);
    assert.equal(front.item.position, 1);
    let view = await getWatchlist(db, profileA, watchlist.id);
    assert.deepEqual(
      view.items.map((item) => [item.externalId, item.position]),
      [
        ["jf-item-d", 1],
        ["jf-item-a", 2],
        ["jf-item-b", 3],
        ["jf-item-c", 4]
      ]
    );

    // Moving within the list keeps a single stable order.
    await addWatchlistItem(db, profileA, watchlist.id, d, 3);
    view = await getWatchlist(db, profileA, watchlist.id);
    assert.deepEqual(
      view.items.map((item) => item.externalId),
      ["jf-item-a", "jf-item-b", "jf-item-d", "jf-item-c"]
    );

    const removed = await removeWatchlistItem(db, profileA, watchlist.id, b);
    assert.equal(removed.removed, true);
    const removedAgain = await removeWatchlistItem(db, profileA, watchlist.id, b);
    assert.equal(removedAgain.removed, false);
  });

  it("reorders atomically and rejects stale sets", async () => {
    const { watchlist } = await createWatchlist(db, profileA, "Reorder");
    const ids: string[] = [];
    for (const media of [MEDIA_A, MEDIA_B, MEDIA_C]) ids.push(await resolveMediaRef(db, media.source, media.externalId));
    // Membership first: reorder renumbers existing members, it never adds.
    for (const id of ids) await addWatchlistItem(db, profileA, watchlist.id, id, undefined);

    const reordered = await reorderWatchlistItems(db, profileA, watchlist.id, [ids[2], ids[0], ids[1]]);
    assert.deepEqual(
      reordered.map((item) => [item.externalId, item.position]),
      [
        ["jf-item-c", 1],
        ["jf-item-a", 2],
        ["jf-item-b", 3]
      ]
    );

    // Missing member and extra member are both stale (and a duplicate
    // submission cannot even reach the store without failing the set check).
    await rejectsWith(HouseholdConflictError, () => reorderWatchlistItems(db, profileA, watchlist.id, [ids[0], ids[1]]));
    await rejectsWith(HouseholdConflictError, () =>
      reorderWatchlistItems(db, profileA, watchlist.id, [ids[0], ids[1], ids[2], ids[0]])
    );
    const view = await getWatchlist(db, profileA, watchlist.id);
    assert.equal(view.items.length, 3, "a rejected reorder must not mutate membership");
  });

  it("deletes with its items", async () => {
    const { watchlist } = await createWatchlist(db, profileA, "Doomed");
    await addWatchlistItem(db, profileA, watchlist.id, await resolveMediaRef(db, MEDIA_A.source, MEDIA_A.externalId), undefined);
    await deleteWatchlist(db, profileA, watchlist.id);
    const items = await pool.query("SELECT count(*) AS n FROM watchlist_item");
    assert.equal(Number(items.rows[0].n), 0);
    await rejectsWith(HouseholdNotFoundError, () => getWatchlist(db, profileA, watchlist.id));
  });
});

describe("collections", () => {
  it("creates household collections with creator provenance and unique names", async () => {
    const first = await createCollection(db, {
      name: "Rainy Sunday",
      description: "Slow cinema for wet afternoons",
      createdByProfileId: profileA
    });
    assert.equal(first.created, true);
    const duplicate = await createCollection(db, { name: "rainy sunday", createdByProfileId: profileB });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.collection.id, first.collection.id);
    assert.equal(first.collection.createdByProfileId, profileA);

    const all = await listCollections(db);
    assert.equal(all.length, 1);
    assert.equal(all[0].itemCount, 0);

    const updated = await updateCollection(db, first.collection.id, { description: "Updated" });
    assert.equal(updated.description, "Updated");
    // Renaming to your own name is a no-op success; renaming onto ANOTHER
    // collection's name is the strict conflict.
    await updateCollection(db, first.collection.id, { name: "Rainy Sunday" });
    const other = await createCollection(db, { name: "Other Shelf" });
    await rejectsWith(HouseholdConflictError, () =>
      updateCollection(db, first.collection.id, { name: "other shelf" })
    );
    assert.notEqual(other.collection.id, first.collection.id);
  });

  it("manages membership with the same positioned semantics", async () => {
    const { collection } = await createCollection(db, { name: "Membership" });
    const a = await resolveMediaRef(db, MEDIA_A.source, MEDIA_A.externalId);
    const b = await resolveMediaRef(db, MEDIA_B.source, MEDIA_B.externalId);
    await addCollectionItem(db, collection.id, a, undefined);
    await addCollectionItem(db, collection.id, b, 1);
    let view = await getCollection(db, collection.id);
    assert.deepEqual(
      view.items.map((item) => item.externalId),
      ["jf-item-b", "jf-item-a"]
    );
    await rejectsWith(HouseholdConflictError, () => reorderCollectionItems(db, collection.id, [a]));

    view = await getCollection(db, collection.id);
    assert.equal(view.items.length, 2);
  });

  it("cascades membership and collection-sourced home rows on delete", async () => {
    const { collection } = await createCollection(db, { name: "Doomed Collection" });
    await addCollectionItem(db, collection.id, await resolveMediaRef(db, MEDIA_A.source, MEDIA_A.externalId), undefined);
    const { row } = await createHomeRow(db, {
      rowKey: "collection_row",
      title: "From Collection",
      source: { kind: "collection", collectionId: collection.id }
    });
    await deleteCollection(db, collection.id);
    assert.equal(Number((await pool.query("SELECT count(*) AS n FROM collection_item")).rows[0].n), 0);
    await rejectsWith(HouseholdNotFoundError, () => requireHomeRow(db, row.id));
  });
});

describe("home rows", () => {
  it("creates with unique keys, splices positions, updates and deletes", async () => {
    const first = await createHomeRow(db, {
      rowKey: "continue_watching",
      title: "Continue Watching",
      source: { kind: "jellyfin_section", sourceKey: "jf-section-1" }
    });
    assert.equal(first.created, true);
    const duplicate = await createHomeRow(db, {
      rowKey: "continue_watching",
      title: "Different Title",
      source: { kind: "jellyfin_section", sourceKey: "jf-section-2" }
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.row.id, first.row.id);
    assert.equal(duplicate.row.title, "Continue Watching", "duplicate create never overwrites");

    await createHomeRow(db, {
      rowKey: "recently_added",
      title: "Recently Added",
      source: { kind: "jellyfin_section", sourceKey: "jf-section-1" }
    });
    const front = await createHomeRow(db, {
      rowKey: "movie_night",
      title: "Movie Night",
      source: { kind: "jellyfin_section", sourceKey: "jf-section-3" },
      position: 1
    });
    assert.equal(front.created, true);
    let rows = await listHomeRows(db);
    assert.deepEqual(
      rows.map((row) => [row.rowKey, row.position]),
      [
        ["movie_night", 1],
        ["continue_watching", 2],
        ["recently_added", 3]
      ]
    );

    const updated = await updateHomeRow(db, front.row.id, { isEnabled: false });
    assert.equal(updated.isEnabled, false);
    assert.equal(updated.rowKey, "movie_night");

    await deleteHomeRow(db, front.row.id);
    rows = await listHomeRows(db);
    assert.equal(rows.length, 2);
    await rejectsWith(HouseholdNotFoundError, () => deleteHomeRow(db, front.row.id));
  });

  it("requires an existing collection for collection sources", async () => {
    await rejectsWith(HouseholdNotFoundError, () =>
      createHomeRow(db, {
        rowKey: "ghost_collection",
        title: "Ghost",
        source: { kind: "collection", collectionId: "0f0e8c4a-7b1e-4d3e-9f2a-1b2c3d4e5f61" }
      })
    );
  });

  it("reorders as a full permutation or rejects as stale", async () => {
    const one = await createHomeRow(db, { rowKey: "row_one", title: "One", source: { kind: "jellyfin_section", sourceKey: "s1" } });
    const two = await createHomeRow(db, { rowKey: "row_two", title: "Two", source: { kind: "jellyfin_section", sourceKey: "s1" } });
    const three = await createHomeRow(db, { rowKey: "row_three", title: "Three", source: { kind: "jellyfin_section", sourceKey: "s1" } });

    const reordered = await reorderHomeRows(db, [three.row.id, one.row.id, two.row.id]);
    assert.deepEqual(
      reordered.map((row) => [row.rowKey, row.position]),
      [
        ["row_three", 1],
        ["row_one", 2],
        ["row_two", 3]
      ]
    );
    await rejectsWith(HouseholdConflictError, () => reorderHomeRows(db, [one.row.id, two.row.id]));
    const after = await listHomeRows(db);
    assert.deepEqual(
      after.map((row) => row.position),
      [1, 2, 3],
      "a rejected reorder must not corrupt positions"
    );
  });
});

describe("idempotent mutations", () => {
  it("stores the original response and replays it byte-for-byte", async () => {
    const fingerprint = "fp-replay";
    const first = await runIdempotentMutation(pool, {
      scope: "favorites.add",
      key: "client-key-1",
      fingerprint,
      apply: async (tx) => {
        const mediaRefId = await resolveMediaRef(tx, MEDIA_A.source, MEDIA_A.externalId);
        const { favorite, created } = await addFavorite(tx, profileA, mediaRefId);
        return { status: created ? 201 : 200, body: { created, favorite } };
      }
    });
    assert.equal(first.replayed, false);
    assert.equal(first.status, 201);

    const replay = await runIdempotentMutation(pool, {
      scope: "favorites.add",
      key: "client-key-1",
      fingerprint,
      apply: async () => {
        throw new Error("replay must not re-execute the mutation");
      }
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.status, first.status, "replay must serve the original status");
    assert.deepEqual(replay.body, first.body, "replay must serve the original body");

    // Exactly one favorite row exists despite two executions of the flow.
    assert.equal(Number((await pool.query("SELECT count(*) AS n FROM favorite")).rows[0].n), 1);
  });

  it("rejects key reuse with a different fingerprint", async () => {
    await runIdempotentMutation(pool, {
      scope: "favorites.add",
      key: "client-key-2",
      fingerprint: "fp-original",
      apply: async (tx) => {
        const mediaRefId = await resolveMediaRef(tx, MEDIA_A.source, MEDIA_A.externalId);
        await addFavorite(tx, profileA, mediaRefId);
        return { status: 201, body: { created: true } };
      }
    });
    await rejectsWith(HouseholdConflictError, () =>
      runIdempotentMutation(pool, {
        scope: "favorites.add",
        key: "client-key-2",
        fingerprint: "fp-different",
        apply: async () => ({ status: 201, body: { created: true } })
      })
    );
    // A different scope may reuse the same client key.
    const otherScope = await runIdempotentMutation(pool, {
      scope: "watchlists.create",
      key: "client-key-2",
      fingerprint: "fp-watchlist",
      apply: async (tx) => {
        const { watchlist } = await createWatchlist(tx, profileA, "Keyed");
        return { status: 201, body: { created: true, id: watchlist.id } };
      }
    });
    assert.equal(otherScope.replayed, false);
  });

  it("rolls back the whole mutation when a step fails mid-transaction", async () => {
    await rejectsWith(HouseholdNotFoundError, () =>
      transact(pool, async (tx) => {
        // A write that succeeds, followed by one that must fail: the
        // committed result must contain neither.
        await addFavorite(tx, profileA, await resolveMediaRef(tx, MEDIA_A.source, MEDIA_A.externalId));
        await requireProfile(tx, "0f0e8c4a-7b1e-4d3e-9f2a-1b2c3d4e5f99");
      })
    );
    assert.equal(Number((await pool.query("SELECT count(*) AS n FROM favorite")).rows[0].n), 0);

    // A failed (and therefore rolled back) idempotency claim frees the key.
    await rejectsWith(HouseholdNotFoundError, () =>
      runIdempotentMutation(pool, {
        scope: "favorites.add",
        key: "retry-key",
        fingerprint: "fp-retry",
        apply: async (tx) => {
          await requireProfile(tx, "0f0e8c4a-7b1e-4d3e-9f2a-1b2c3d4e5f99");
          return { status: 201, body: {} };
        }
      })
    );
    assert.equal(
      Number((await pool.query("SELECT count(*) AS n FROM idempotency_record")).rows[0].n),
      0,
      "a rolled-back attempt must not consume its idempotency key"
    );
  });

  it("keeps responses within the bounded replay contract", async () => {
    // The 8 KiB CHECK lives in the schema; prove it rejects oversized bodies.
    const bigBody = { payload: "x".repeat(20_000) };
    await pool
      .query(
        "INSERT INTO idempotency_record (scope, idempotency_key, fingerprint, response_status, response_body) VALUES ($1, $2, $3, 200, $4::jsonb)",
        ["bounded.test", "oversized", "fp", JSON.stringify(bigBody)]
      )
      .then(
        () => assert.fail("oversized response body must violate idempotency_record_response_shape"),
        (error: unknown) => {
          const code = (error as { code?: string }).code;
          assert.equal(code, "23514", `expected CHECK violation 23514, got ${String(error)}`);
        }
      );
  });
});
