// Integration tests for the ReelHouse migration system against a disposable
// PostgreSQL 18 instance.
//
//   npm run test:db:up      start the disposable database (docker compose)
//   npm run test:db         run this suite
//   npm run test:db:down    stop and discard the database
//
// TEST_DATABASE_URL overrides the default disposable endpoint; the database
// itself is destructively reset (DROP SCHEMA public CASCADE) by this suite,
// so it must never point at the production Synology target.

import { strict as assert } from "node:assert";
import { before, describe, it } from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { loadMigrationFiles, runMigrations } from "./migrator.ts";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_test";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "db", "migrations");

const EXPECTED_TABLES = [
  "schema_migrations",
  "household_profile",
  "profile_preferences",
  "media_item_ref",
  "jellyfin_account_link",
  "favorite",
  "watchlist",
  "watchlist_item",
  "collection",
  "collection_item",
  "watch_state",
  "playback_event",
  "home_row",
  "sync_cursor",
  "idempotency_record"
].sort();

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function resetSchema(): Promise<void> {
  await withClient(async (client) => {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  });
}

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return undefined;
}

async function expectViolation(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert.equal(pgErrorCode(error), code, `expected SQLSTATE ${code}, got: ${String(error)}`);
    return;
  }
  assert.fail(`expected SQLSTATE ${code} but the statement succeeded`);
}

async function historySnapshot(): Promise<Array<{ name: string; checksum: string }>> {
  return withClient(async (client) => {
    const result = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name"
    );
    return result.rows;
  });
}

async function applyAll(options: { dryRun?: boolean } = {}) {
  return runMigrations({
    databaseUrl: TEST_DATABASE_URL,
    migrationsDir: MIGRATIONS_DIR,
    log: () => {},
    ...options
  });
}

let migrationFileCount = 0;

before(async () => {
  migrationFileCount = (await loadMigrationFiles(MIGRATIONS_DIR)).length;
  try {
    await withClient(async () => {});
  } catch {
    throw new Error(
      "Disposable PostgreSQL 18 is not reachable. Start it with: npm run test:db:up " +
        "(or point TEST_DATABASE_URL at an expendable PostgreSQL 18 database; " +
        "this suite resets the public schema)."
    );
  }
});

describe("apply-from-empty", () => {
  it("applies every migration to an empty schema and records history", async () => {
    await resetSchema();
    const result = await applyAll();
    assert.equal(result.applied.length, migrationFileCount);
    const snapshot = await historySnapshot();
    assert.equal(snapshot.length, migrationFileCount);
    const local = await loadMigrationFiles(MIGRATIONS_DIR);
    for (const file of local) {
      const row = snapshot.find((entry) => entry.name === file.name);
      assert.ok(row, `${file.name} missing from schema_migrations`);
      assert.equal(row.checksum, file.checksum, `${file.name} recorded checksum mismatch`);
    }
  });

  it("creates every expected table", async () => {
    await withClient(async (client) => {
      const result = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
      );
      assert.deepEqual(
        result.rows.map((row) => row.table_name).sort(),
        EXPECTED_TABLES
      );
    });
  });

  it("defaults primary keys to time-ordered UUIDv7", async () => {
    await withClient(async (client) => {
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO household_profile (display_name) VALUES ($1) RETURNING id",
        ["Uuid Probe"]
      );
      const id = inserted.rows[0].id;
      // uuidv7: version nibble (first char of the third group) must be 7.
      assert.equal(id.split("-")[2][0], "7", `expected a v7 uuid, got ${id}`);
      assert.match(id, /^[0-9a-f-]{36}$/);
    });
  });

  it("keeps updated_at fresh via trigger", async () => {
    await withClient(async (client) => {
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO household_profile (display_name) VALUES ($1) RETURNING id",
        ["Trigger Probe"]
      );
      const id = inserted.rows[0].id;
      await new Promise((resolve) => setTimeout(resolve, 50));
      await client.query("UPDATE household_profile SET display_name = $1 WHERE id = $2", [
        "Trigger Probe Renamed",
        id
      ]);
      const row = await client.query<{ created_at: string; updated_at: string }>(
        "SELECT created_at, updated_at FROM household_profile WHERE id = $1",
        [id]
      );
      assert.ok(
        new Date(row.rows[0].updated_at).getTime() > new Date(row.rows[0].created_at).getTime(),
        "updated_at should advance past created_at on update"
      );
    });
  });
});

describe("repeat-run idempotency", () => {
  it("applies nothing new on a second run", async () => {
    const before = await historySnapshot();
    const result = await applyAll();
    assert.equal(result.applied.length, 0);
    assert.equal(result.alreadyApplied, migrationFileCount);
    const after = await historySnapshot();
    assert.deepEqual(after, before);
  });

  it("dry-run on a migrated database changes nothing", async () => {
    const before = await historySnapshot();
    const result = await applyAll({ dryRun: true });
    assert.equal(result.applied.length, 0);
    assert.deepEqual(await historySnapshot(), before);
  });

  it("dry-run on an empty database applies nothing", async () => {
    await resetSchema();
    const result = await applyAll({ dryRun: true });
    assert.equal(result.applied.length, 0);
    assert.equal((await historySnapshot()).length, 0);
  });
});

describe("schema constraints", () => {
  let profileA = "";
  let profileB = "";
  let refOne = "";
  let refTwo = "";
  let watchlistA = "";
  let collectionX = "";

  before(async () => {
    await resetSchema();
    await applyAll();
    await withClient(async (client) => {
      profileA = (
        await client.query<{ id: string }>(
          "INSERT INTO household_profile (display_name) VALUES ('V''Ali') RETURNING id"
        )
      ).rows[0].id;
      profileB = (
        await client.query<{ id: string }>(
          "INSERT INTO household_profile (display_name) VALUES ('Nicole') RETURNING id"
        )
      ).rows[0].id;
      refOne = (
        await client.query<{ id: string }>(
          "INSERT INTO media_item_ref (source, external_id) VALUES ('jellyfin', 'item-1') RETURNING id"
        )
      ).rows[0].id;
      refTwo = (
        await client.query<{ id: string }>(
          "INSERT INTO media_item_ref (source, external_id) VALUES ('jellyfin', 'item-2') RETURNING id"
        )
      ).rows[0].id;
      watchlistA = (
        await client.query<{ id: string }>(
          "INSERT INTO watchlist (profile_id, name) VALUES ($1, 'Family Queue') RETURNING id",
          [profileA]
        )
      ).rows[0].id;
      collectionX = (
        await client.query<{ id: string }>(
          "INSERT INTO collection (name, created_by_profile_id) VALUES ('Rainy Day', $1) RETURNING id",
          [profileA]
        )
      ).rows[0].id;
    });
  });

  it("enforces case-insensitive unique profile display names", async () => {
    await expectViolation(
      () =>
        withClient((client) =>
          client.query("INSERT INTO household_profile (display_name) VALUES ('v''ali')")
        ),
      "23505"
    );
  });

  it("rejects blank profile display names", async () => {
    await expectViolation(
      () =>
        withClient((client) =>
          client.query("INSERT INTO household_profile (display_name) VALUES ('   ')")
        ),
      "23514"
    );
  });

  it("requires a display_name", async () => {
    await expectViolation(
      () => withClient((client) => client.query("INSERT INTO household_profile (display_name) VALUES (NULL)")),
      "23502"
    );
  });

  it("enforces unique (source, external_id) media identity", async () => {
    await expectViolation(
      () =>
        withClient((client) =>
          client.query("INSERT INTO media_item_ref (source, external_id) VALUES ('jellyfin', 'item-1')")
        ),
      "23505"
    );
  });

  it("restricts media_item_ref.source to known authorities", async () => {
    await expectViolation(
      () =>
        withClient((client) =>
          client.query("INSERT INTO media_item_ref (source, external_id) VALUES ('kodi', 'x')")
        ),
      "23514"
    );
  });

  it("keeps jellyfin account links 1:1 in both directions", async () => {
    // First (valid) link for profileA; then both directions of the 1:1
    // must refuse a second link.
    await withClient((client) =>
      client.query("INSERT INTO jellyfin_account_link (profile_id, jellyfin_user_id) VALUES ($1, 'jf-user-9')", [
        profileA
      ])
    );
    await expectViolation(
      () =>
        withClient((client) =>
          client.query("INSERT INTO jellyfin_account_link (profile_id, jellyfin_user_id) VALUES ($1, 'jf-user-a')", [
            profileA
          ])
        ),
      "23505"
    );
    await expectViolation(
      () =>
        withClient((client) =>
          client.query("INSERT INTO jellyfin_account_link (profile_id, jellyfin_user_id) VALUES ($1, 'jf-user-9')", [
            profileB
          ])
        ),
      "23505"
    );
  });

  it("enforces unique favorites per (profile, media)", async () => {
    await expectViolation(
      () =>
        withClient((client) =>
          client.query("INSERT INTO favorite (profile_id, media_ref_id) VALUES ($1, $2)", [profileA, refOne])
        ).then(() =>
          withClient((client2) =>
            client2.query("INSERT INTO favorite (profile_id, media_ref_id) VALUES ($1, $2)", [profileA, refOne])
          )
        ),
      "23505"
    );
  });

  it("rejects favorites pointing at missing rows", async () => {
    await expectViolation(
      () =>
        withClient((client) =>
          client.query(
            "INSERT INTO favorite (profile_id, media_ref_id) VALUES ($1, $2)",
            [profileA, "00000000-0000-0000-0000-000000000000"]
          )
        ),
      "23503"
    );
  });

  it("enforces case-insensitive unique watchlist names per profile", async () => {
    await expectViolation(
      () =>
        withClient((client) =>
          client.query("INSERT INTO watchlist (profile_id, name) VALUES ($1, 'family queue')", [profileA])
        ),
      "23505"
    );
  });

  it("rejects invalid watchlist item positions and unknown media", async () => {
    await expectViolation(
      () =>
        withClient((client) =>
          client.query(
            "INSERT INTO watchlist_item (watchlist_id, media_ref_id, position) VALUES ($1, $2, 0)",
            [watchlistA, refOne]
          )
        ),
      "23514"
    );
    await expectViolation(
      () =>
        withClient((client) =>
          client.query(
            "INSERT INTO watchlist_item (watchlist_id, media_ref_id, position) VALUES ($1, $2, 1)",
            [watchlistA, "00000000-0000-0000-0000-000000000000"]
          )
        ),
      "23503"
    );
  });

  it("keeps preferences a JSON object", async () => {
    await expectViolation(
      () =>
        withClient((client) =>
          client.query("INSERT INTO profile_preferences (profile_id, preferences) VALUES ($1, $2::jsonb)", [
            profileA,
            "[1,2]"
          ])
        ),
      "23514"
    );
  });

  it("enforces watch_state sanity checks", async () => {
    await expectViolation(
      () =>
        withClient((client) =>
          client.query(
            "INSERT INTO watch_state (profile_id, media_ref_id, position_ticks) VALUES ($1, $2, -1)",
            [profileA, refOne]
          )
        ),
      "23514"
    );
    await expectViolation(
      () =>
        withClient((client) =>
          client.query(
            "INSERT INTO watch_state (profile_id, media_ref_id, position_ticks, duration_ticks) VALUES ($1, $2, 200, 100)",
            [profileA, refOne]
          )
        ),
      "23514"
    );
  });

  it("pairs home_row source_kind with exactly one source", async () => {
    await expectViolation(
      () =>
        withClient((client) =>
          client.query(
            "INSERT INTO home_row (row_key, title, source_kind, source_key, position) VALUES ('movies', 'Movies', 'collection', NULL, 1)"
          )
        ),
      "23514"
    );
    await expectViolation(
      () =>
        withClient((client) =>
          client.query(
            "INSERT INTO home_row (row_key, title, source_kind, collection_id, position) VALUES ('rainy', 'Rainy Day', 'jellyfin_section', $1, 2)",
            [collectionX]
          )
        ),
      "23514"
    );
  });

  it("rejects duplicate home_row keys and invalid playback provenance", async () => {
    await expectViolation(
      () =>
        withClient((client) =>
          client.query(
            "INSERT INTO home_row (row_key, title, source_kind, source_key, position) VALUES ('movies', 'Movies', 'jellyfin_section', 'section-1', 1)"
          )
        ).then(() =>
          withClient((client2) =>
            client2.query(
              "INSERT INTO home_row (row_key, title, source_kind, source_key, position) VALUES ('movies', 'Movies again', 'jellyfin_section', 'section-2', 2)"
            )
          )
        ),
      "23505"
    );
    await expectViolation(
      () =>
        withClient((client) =>
          client.query(
            "INSERT INTO playback_event (profile_id, media_ref_id, recorded_by) VALUES ($1, $2, 'kodi_import')",
            [profileA, refOne]
          )
        ),
      "23514"
    );
  });

  it("enforces unique idempotency keys per scope", async () => {
    await withClient((client) =>
      client.query("INSERT INTO idempotency_record (scope, idempotency_key) VALUES ('sync', 'op-1')")
    );
    await expectViolation(
      () =>
        withClient((client) =>
          client.query("INSERT INTO idempotency_record (scope, idempotency_key) VALUES ('sync', 'op-1')")
        ),
      "23505"
    );
  });

  it("cascades profile deletion and nulls collection provenance", async () => {
    await withClient(async (client) => {
      // Uniqueness tests above already persisted (profileA, refOne) and a
      // jellyfin link for profileA; cascade fixtures use refTwo and start
      // from a clean link slate.
      await client.query("DELETE FROM jellyfin_account_link WHERE profile_id = $1", [profileA]);
      await client.query("INSERT INTO favorite (profile_id, media_ref_id) VALUES ($1, $2)", [profileA, refTwo]);
      await client.query(
        "INSERT INTO watchlist_item (watchlist_id, media_ref_id, position) VALUES ($1, $2, 1)",
        [watchlistA, refTwo]
      );
      await client.query(
        "INSERT INTO watch_state (profile_id, media_ref_id, position_ticks, duration_ticks) VALUES ($1, $2, 50, 100)",
        [profileA, refTwo]
      );
      await client.query("INSERT INTO playback_event (profile_id, media_ref_id) VALUES ($1, $2)", [
        profileA,
        refTwo
      ]);
      await client.query("INSERT INTO profile_preferences (profile_id, preferences) VALUES ($1, '{}'::jsonb)", [
        profileA
      ]);
      await client.query("INSERT INTO jellyfin_account_link (profile_id, jellyfin_user_id) VALUES ($1, 'jf-va')", [
        profileA
      ]);

      await client.query("DELETE FROM household_profile WHERE id = $1", [profileA]);

      for (const table of [
        "favorite",
        "watchlist",
        "watch_state",
        "playback_event",
        "profile_preferences",
        "jellyfin_account_link"
      ]) {
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table} WHERE ${table === "collection" ? "created_by_profile_id" : "profile_id"} = $1`,
          [profileA]
        );
        assert.equal(result.rows[0].count, "0", `${table} rows survived profile deletion`);
      }

      const collection = await client.query<{ created_by_profile_id: string | null }>(
        "SELECT created_by_profile_id FROM collection WHERE id = $1",
        [collectionX]
      );
      assert.equal(collection.rows[0].created_by_profile_id, null, "collection must survive with nulled provenance");
    });
  });
});

describe("mutated history refusal", () => {
  async function withCopiedMigrations(mutate: (dir: string) => Promise<void>, fn: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "reelhouse-history-test-"));
    try {
      await cp(MIGRATIONS_DIR, dir, { recursive: true });
      await mutate(dir);
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("refuses to run when an applied migration is edited", async () => {
    const before = await historySnapshot();
    await withCopiedMigrations(
      async (dir) => {
        const original = await readFile(join(dir, "0004_favorites.sql"), "utf8");
        await writeFile(join(dir, "0004_favorites.sql"), original + "\n-- tampered");
      },
      async (dir) => {
        await assert.rejects(
          runMigrations({ databaseUrl: TEST_DATABASE_URL, migrationsDir: dir, log: () => {} }),
          /no longer matches its recorded checksum/
        );
      }
    );
    assert.deepEqual(await historySnapshot(), before);
  });

  it("refuses to run when an applied migration file is missing", async () => {
    const before = await historySnapshot();
    await withCopiedMigrations(
      async (dir) => {
        // Drop the NEWEST applied migration so the local tree stays
        // contiguous but the recorded history has a file it cannot find.
        await rm(join(dir, "0009_sync_cursors_and_idempotency.sql"));
      },
      async (dir) => {
        await assert.rejects(
          runMigrations({ databaseUrl: TEST_DATABASE_URL, migrationsDir: dir, log: () => {} }),
          /is missing from the local migrations directory/
        );
      }
    );
    assert.deepEqual(await historySnapshot(), before);
  });

  it("still applies cleanly against the real directory after refusals", async () => {
    const result = await applyAll();
    assert.equal(result.applied.length, 0);
  });
});

describe("concurrent runs", () => {
  it("serializes two runners so each migration applies exactly once", async () => {
    await resetSchema();
    const [first, second] = await Promise.all([applyAll(), applyAll()]);
    assert.equal(first.applied.length + second.applied.length, migrationFileCount);
    assert.equal((await historySnapshot()).length, migrationFileCount);
    const third = await applyAll();
    assert.equal(third.applied.length, 0);
  });
});
