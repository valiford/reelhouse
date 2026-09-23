// Deterministic PostgreSQL integration evidence for the RH-0036 workbench.
//
// Runs against the disposable loopback PostgreSQL 18 profile — never against
// Synology, and never against a live Jellyfin. The catalog is seeded through
// the REAL full-sync runner with a scripted CatalogSource double, so every
// conflict class is grown from what the pipelines actually produce:
//
//   REELHOUSE_TEST_MIGRATE_URL   owner/migrator role
//   REELHOUSE_TEST_DATABASE_URL  application role
//
// Scenarios: migration 0009 (reasons, origin rule, statuses) under the
// least-privilege app role; scan detection of duplicate_file, moved_media,
// and missing_external_id with evidence payloads; bump-not-duplicate
// semantics with first-recorded evidence preserved; scan atomicity on a
// mid-scan failure (nothing recorded, scan row marked failed) with
// recovery; release/discard with the audit trail and the never-resolve-twice
// rule; the remap happy path on a real sync-produced duplicate_identity
// quarantine plus its full failure matrix; bounded list/describe.
//
// This file uses its own temporary database (reelhouse_rh0036_tmp) so it
// cannot interfere with the sibling suites under `node --test`.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { loadDatabaseConfig, type DatabaseConfig } from "../db/config.ts";
import { loadMigrationFiles, runMigrations } from "../db/migrator.ts";
import { createPgSyncExecutor } from "./pg-executor.ts";
import { runFullCatalogSync } from "./sync.ts";
import {
  WorkbenchError,
  WorkbenchParamError,
  describeQuarantine,
  discardQuarantine,
  listQuarantines,
  releaseQuarantine,
  remapQuarantineItem,
  runIdentityScan
} from "./workbench.ts";
import type { CatalogLibrary, CatalogItemsPage, CatalogRawItem, CatalogSource } from "./source.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const TEMP_DB = "reelhouse_rh0036_tmp";

const migrateEnv = process.env.REELHOUSE_TEST_MIGRATE_URL;
const appEnv = process.env.REELHOUSE_TEST_DATABASE_URL;

function configFrom(url: string): DatabaseConfig {
  const result = loadDatabaseConfig({ DATABASE_URL: url });
  if (result.kind !== "valid") throw new Error(`test URL invalid: ${"errors" in result ? result.errors.join("; ") : "blank"}`);
  return result.config;
}

const migrateBase = migrateEnv ? configFrom(migrateEnv) : undefined;
const appBase = appEnv ? configFrom(appEnv) : undefined;

function needsDb(t: { skip: (message?: string) => void }): { migrate: DatabaseConfig; app: DatabaseConfig } {
  if (!migrateBase || !appBase) {
    t.skip("REELHOUSE_TEST_MIGRATE_URL / REELHOUSE_TEST_DATABASE_URL not set (hermetic mode)");
    throw new Error("unreachable");
  }
  return { migrate: migrateBase, app: appBase };
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

// Fixed clock: scan and repair timestamps are constants, so a fixed catalog
// produces identical evidence rows every time.
const FIXED_CLOCK = () => new Date("2025-06-01T12:00:00.000Z");
const OPERATOR = "worker-rh0036";

const SAVED_V1 = "2025-01-01T00:00:00.000Z";
const SAVED_V2 = "2025-03-01T00:00:00.000Z";

function movie(jellyfinId: string, name: string, savedAt: string, overrides: CatalogRawItem = {}): CatalogRawItem {
  return { Id: jellyfinId, Name: name, Type: "Movie", DateLastSaved: savedAt, Etag: `etag-${jellyfinId}`, ...overrides };
}

interface SourceState {
  itemsByLibrary: Map<string, CatalogRawItem[]>;
}

class ScriptedSource implements CatalogSource {
  libraries: CatalogLibrary[];
  state: SourceState;

  constructor(libraries: CatalogLibrary[], state: SourceState) {
    this.libraries = libraries;
    this.state = state;
  }

  async listLibraries(): Promise<CatalogLibrary[]> {
    return this.libraries.map((library) => ({ ...library }));
  }

  async fetchItemsPage(libraryJellyfinId: string, startIndex: number, limit: number): Promise<CatalogItemsPage> {
    const items = this.state.itemsByLibrary.get(libraryJellyfinId) ?? [];
    return { items: items.slice(startIndex, startIndex + limit), totalRecordCount: items.length };
  }

  async fetchChangedItemsPage(
    libraryJellyfinId: string,
    _sinceIso: string,
    startIndex: number,
    limit: number
  ): Promise<CatalogItemsPage> {
    return this.fetchItemsPage(libraryJellyfinId, startIndex, limit);
  }

  async fetchLibraryItemIdsPage(libraryJellyfinId: string, startIndex: number, limit: number): Promise<CatalogItemsPage> {
    return this.fetchItemsPage(libraryJellyfinId, startIndex, limit);
  }
}

function library(jellyfinId: string, name: string, collectionType: string | null): CatalogLibrary {
  return { jellyfinId, name, collectionType };
}

const TWO_LIBRARIES = [library("lib-movies", "Movies", "movies"), library("lib-tv", "TV Shows", "tvshows")];

interface CaseHandle {
  migrate: DatabaseConfig;
  app: DatabaseConfig;
  appPool: Pool;
}

async function withFreshCatalog(
  t: { skip: (message?: string) => void },
  fn: (db: CaseHandle) => Promise<void>
): Promise<void> {
  const { migrate, app } = needsDb(t);
  const migrateTemp = { ...migrate, database: TEMP_DB };
  const appTemp = { ...app, database: TEMP_DB };

  await withClient({ ...migrate, database: "postgres" }, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${TEMP_DB} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${TEMP_DB}`);
  });

  const appPool = new Pool({
    host: appTemp.host,
    port: appTemp.port,
    user: appTemp.user,
    password: appTemp.password,
    database: appTemp.database,
    max: 2,
    connectionTimeoutMillis: appTemp.connectionTimeoutMs,
    statement_timeout: appTemp.statementTimeoutMs
  });

  try {
    const expectedVersions = loadMigrationFiles(MIGRATIONS_DIR).map((file) => file.version);
    const applied = await runMigrations(migrateTemp, MIGRATIONS_DIR, appTemp.user);
    assert.deepEqual(applied.appliedNow, expectedVersions, "all on-disk migrations apply to a fresh database");
    await fn({ migrate: migrateTemp, app: appTemp, appPool });
  } finally {
    await appPool.end();
    await withClient({ ...migrate, database: "postgres" }, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${TEMP_DB} WITH (FORCE)`);
    });
  }
}

async function seedCatalog(db: CaseHandle, state: SourceState): Promise<void> {
  const source = new ScriptedSource(TWO_LIBRARIES, state);
  const result = await runFullCatalogSync(source, createPgSyncExecutor(db.appPool), {
    pageSize: 50,
    clock: FIXED_CLOCK
  });
  assert.equal(result.status, "succeeded");
}

function stateOf(entries: [string, CatalogRawItem[]][]): SourceState {
  return { itemsByLibrary: new Map(entries) };
}

interface QuarantineRow {
  id: string;
  reason: string;
  identity: string;
  status: string;
  occurrences: number;
  run_id: string | null;
  scan_id: string | null;
  payload: Record<string, unknown>;
  detail: string;
  resolved_at: Date | null;
}

async function quarantines(pool: Pool): Promise<QuarantineRow[]> {
  const result = await pool.query<QuarantineRow>(
    `SELECT id::text, reason, identity, status, occurrences, run_id::text AS run_id,
            scan_id::text AS scan_id, payload, detail, resolved_at
     FROM media_item_quarantine ORDER BY id`
  );
  return result.rows;
}

async function lastScan(pool: Pool): Promise<Record<string, unknown>> {
  const result = await pool.query("SELECT * FROM media_identity_scans ORDER BY id DESC LIMIT 1");
  return result.rows[0];
}

test("migration 0009 enforces reasons, statuses, and the single-origin rule under the app role", async (t) => {
  await withFreshCatalog(t, async (db) => {
    // Re-running the migrator against the live schema is a no-op.
    const again = await runMigrations(db.migrate, MIGRATIONS_DIR, db.app.user);
    assert.deepEqual(again.appliedNow, []);

    await withClient(db.app, async (client) => {
      const run = await client.query<{ id: string }>(
        "INSERT INTO media_sync_runs (source, mode, status) VALUES ('jellyfin', 'full', 'running') RETURNING id"
      );
      const scan = await client.query<{ id: string }>(
        "INSERT INTO media_identity_scans (status) VALUES ('running') RETURNING id"
      );
      const payload = JSON.stringify({ proof: true });

      // Sync-origin row: allowed, exactly as RH-0032 wrote them.
      await client.query(
        `INSERT INTO media_item_quarantine (source, reason, identity, run_id, payload, detail)
         VALUES ('jellyfin', 'duplicate_identity', 'mov-x', $1, $2::jsonb, 'sync-detected')`,
        [run.rows[0].id, payload]
      );
      // Scan-origin row: allowed for every new reason.
      for (const reason of ["duplicate_file", "moved_media", "missing_external_id"]) {
        await client.query(
          `INSERT INTO media_item_quarantine (source, reason, identity, scan_id, payload, detail)
           VALUES ('jellyfin', $1, 'key-' || $1, $2, $3::jsonb, 'scan-detected')`,
          [reason, scan.rows[0].id, payload]
        );
      }

      // Both origins set, or neither: rejected.
      await assert.rejects(
        client.query(
          `INSERT INTO media_item_quarantine (source, reason, identity, run_id, scan_id, payload, detail)
           VALUES ('jellyfin', 'duplicate_identity', 'mov-y', $1, $2, '{}'::jsonb, 'both')`,
          [run.rows[0].id, scan.rows[0].id]
        ),
        /media_item_quarantine_origin_check/
      );
      await assert.rejects(
        client.query(
          `INSERT INTO media_item_quarantine (source, reason, identity, payload, detail)
           VALUES ('jellyfin', 'duplicate_identity', 'mov-z', '{}'::jsonb, 'neither')`
        ),
        /media_item_quarantine_origin_check/
      );
      // Unknown reasons and statuses stay rejected. The status probe gives
      // resolved_at a value so the composite resolved_check is satisfied and
      // the enum check is what fires.
      await assert.rejects(
        client.query(
          `INSERT INTO media_item_quarantine (source, reason, identity, scan_id, payload, detail)
           VALUES ('jellyfin', 'renamed', 'mov-r', $1, '{}'::jsonb, 'nope')`,
          [scan.rows[0].id]
        ),
        /media_item_quarantine_reason_check/
      );
      await assert.rejects(
        client.query(
          `INSERT INTO media_item_quarantine (source, reason, identity, run_id, payload, detail, status, resolved_at)
           VALUES ('jellyfin', 'duplicate_identity', 'mov-s', $1, '{}'::jsonb, 'nope', 'forgiven', now())`,
          [run.rows[0].id]
        ),
        /media_item_quarantine_status_check/
      );

      // The scan history row follows the run-history conventions: a running
      // scan has no finish time; finishing requires a finish time and vice
      // versa.
      await assert.rejects(
        client.query("INSERT INTO media_identity_scans (status) VALUES ('exploded')"),
        /media_identity_scans_status_check/
      );

      // Audit rows demand an operator and a known action.
      const openRow = await client.query<{ id: string }>(
        "SELECT id FROM media_item_quarantine WHERE identity = 'mov-x'"
      );
      await assert.rejects(
        client.query(
          `INSERT INTO media_identity_repairs (quarantine_id, action, operator, evidence)
           VALUES ($1, 'deleted', $2, '{}'::jsonb)`,
          [openRow.rows[0].id, OPERATOR]
        ),
        /media_identity_repairs_action_check/
      );
      await assert.rejects(
        client.query(
          `INSERT INTO media_identity_repairs (quarantine_id, action, operator, evidence)
           VALUES ($1, 'released', '', '{}'::jsonb)`,
          [openRow.rows[0].id]
        ),
        /media_identity_repairs_operator_check/
      );
    });
  });
});

test("scan grows duplicate_file quarantines from a real sync and bumps instead of duplicating", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await seedCatalog(
      db,
      stateOf([
        [
          "lib-movies",
          [
            movie("mov-a", "A", SAVED_V1, { Path: "/media/shared.mkv" }),
            movie("mov-b", "B", SAVED_V1, { Path: "/media/shared.mkv" })
          ]
        ],
        ["lib-tv", [movie("mov-c", "C", SAVED_V1, { Path: "/media/c.mkv", ProviderIds: { Imdb: "tt-c" } })]]
      ])
    );

    const first = await runIdentityScan(createPgSyncExecutor(db.appPool), { clock: FIXED_CLOCK });
    assert.equal(first.status, "succeeded");
    assert.equal(first.duplicateFile, 1);
    assert.equal(first.movedMedia, 0);
    assert.equal(first.missingExternalId, 2, "mov-a and mov-b carry no provider IDs");
    assert.equal(first.quarantinesOpened, 3);
    assert.equal(first.quarantinesBumped, 0);
    assert.equal(first.truncated, false);

    const rows = await quarantines(db.appPool);
    assert.equal(rows.length, 3);
    const dup = rows.find((row) => row.reason === "duplicate_file")!;
    assert.equal(dup.identity, "/media/shared.mkv");
    assert.equal(dup.status, "quarantined");
    assert.equal(dup.occurrences, 1);
    assert.equal(dup.run_id, null, "scan rows reference the scan, not a sync run");
    assert.notEqual(dup.scan_id, null);
    assert.deepEqual(
      (dup.payload.items as { jellyfinId: string }[]).map((item) => item.jellyfinId).sort(),
      ["mov-a", "mov-b"]
    );
    assert.match(dup.detail, /2 active catalog items claim file/);

    const missing = rows.filter((row) => row.reason === "missing_external_id");
    assert.deepEqual(
      missing.map((row) => row.identity).sort(),
      ["mov-a", "mov-b"],
      "the provider-anchored movie is never flagged"
    );

    // The scan history row records the run like a sync run does.
    const scan = await lastScan(db.appPool);
    assert.equal(scan.status, "succeeded");
    assert.equal(Number(scan.findings_duplicate_file), 1);
    assert.equal(Number(scan.quarantines_opened), 3);
    assert.notEqual(scan.finished_at, null);

    // mov-b is renamed underneath the open conflict; the NEXT scan bumps
    // occurrences, rewrites the detail, but keeps the FIRST evidence payload.
    await seedCatalog(
      db,
      stateOf([
        [
          "lib-movies",
          [
            movie("mov-a", "A", SAVED_V1, { Path: "/media/shared.mkv" }),
            movie("mov-b", "B (Renamed)", SAVED_V2, { Path: "/media/shared.mkv" })
          ]
        ],
        ["lib-tv", [movie("mov-c", "C", SAVED_V1, { Path: "/media/c.mkv", ProviderIds: { Imdb: "tt-c" } })]]
      ])
    );
    const second = await runIdentityScan(createPgSyncExecutor(db.appPool), { clock: FIXED_CLOCK });
    assert.equal(second.quarantinesOpened, 0);
    assert.equal(second.quarantinesBumped, 3);

    const after = await quarantines(db.appPool);
    assert.equal(after.length, 3, "no duplicate open rows");
    const bumped = after.find((row) => row.reason === "duplicate_file")!;
    assert.equal(bumped.occurrences, 2);
    assert.deepEqual(
      (bumped.payload.items as { name: string }[]).map((item) => item.name).sort(),
      ["A", "B"],
      "the first-recorded payload stays as evidence"
    );
  });
});

test("scan detects moved media and drops the finding once the identity question is settled", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await seedCatalog(
      db,
      stateOf([
        ["lib-movies", [movie("mov-old", "Old Name", SAVED_V1, { Path: "/media/gone.mkv" })]],
        ["lib-tv", [movie("mov-c", "C", SAVED_V1, { Path: "/media/c.mkv", ProviderIds: { Imdb: "tt-c" } })]]
      ])
    );

    // The file re-appears under a NEW Jellyfin identity; the sweep retires
    // mov-old. That is the moved/renamed-media signature.
    await seedCatalog(
      db,
      stateOf([
        ["lib-movies", [movie("mov-new", "New Name", SAVED_V2, { Path: "/media/gone.mkv", ProviderIds: { Imdb: "tt-new" } })]],
        ["lib-tv", [movie("mov-c", "C", SAVED_V1, { Path: "/media/c.mkv", ProviderIds: { Imdb: "tt-c" } })]]
      ])
    );

    const scan = await runIdentityScan(createPgSyncExecutor(db.appPool), { clock: FIXED_CLOCK });
    assert.equal(scan.movedMedia, 1);
    assert.equal(scan.duplicateFile, 0, "one live item on the path is not a duplicate");

    const moved = (await quarantines(db.appPool)).find((row) => row.reason === "moved_media")!;
    assert.equal(moved.identity, "/media/gone.mkv");
    assert.deepEqual((moved.payload.active as { jellyfinId: string }[]).map((item) => item.jellyfinId), ["mov-new"]);
    assert.equal((moved.payload.tombstoned as { jellyfinId: string }[])[0].jellyfinId, "mov-old");
    assert.notEqual((moved.payload.tombstoned as { removedAt: string }[])[0].removedAt, undefined);

    // mov-old comes back as itself: the path now has two live owners (a
    // duplicate_file), but no retired claimant — moved_media disappears.
    await seedCatalog(
      db,
      stateOf([
        [
          "lib-movies",
          [
            movie("mov-old", "Old Name", SAVED_V1, { Path: "/media/gone.mkv" }),
            movie("mov-new", "New Name", SAVED_V2, { Path: "/media/gone.mkv", ProviderIds: { Imdb: "tt-new" } })
          ]
        ],
        ["lib-tv", [movie("mov-c", "C", SAVED_V1, { Path: "/media/c.mkv", ProviderIds: { Imdb: "tt-c" } })]]
      ])
    );
    const after = await runIdentityScan(createPgSyncExecutor(db.appPool), { clock: FIXED_CLOCK });
    assert.equal(after.movedMedia, 0, "a restore settles the moved-media question");
    assert.equal(after.duplicateFile, 1);
    // The moved_media quarantine from the previous scan stays open until an
    // operator resolves it — scans never auto-close.
    const rows = await quarantines(db.appPool);
    assert.equal(rows.filter((row) => row.reason === "moved_media" && row.status === "quarantined").length, 1);
  });
});

test("missing-external-id detection spares episodic content and provider-anchored items", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await seedCatalog(
      db,
      stateOf([
        [
          "lib-tv",
          [
            {
              Id: "ser-x",
              Name: "Series X",
              Type: "Series",
              DateLastSaved: SAVED_V1,
              Etag: "etag-ser-x",
              ProviderIds: { Tvdb: "tvdb-1" }
            },
            { Id: "ser-y", Name: "Series Y (bare)", Type: "Series", DateLastSaved: SAVED_V1, Etag: "etag-ser-y" },
            {
              Id: "ep-x1",
              Name: "Pilot",
              Type: "Episode",
              DateLastSaved: SAVED_V1,
              Etag: "etag-ep",
              SeriesId: "ser-x"
            }
          ]
        ],
        ["lib-movies", [movie("mov-ok", "Anchored", SAVED_V1, { Path: "/media/ok.mkv", ProviderIds: { Imdb: "tt-ok" } })]]
      ])
    );

    const scan = await runIdentityScan(createPgSyncExecutor(db.appPool), { clock: FIXED_CLOCK });
    assert.deepEqual(scan.missingExternalId, 1, "only the bare series");
    const rows = await quarantines(db.appPool);
    assert.deepEqual(rows.filter((row) => row.reason === "missing_external_id").map((row) => row.identity), ["ser-y"]);
    assert.equal(rows.filter((row) => row.identity === "ep-x1").length, 0, "episodes are never flagged");
  });
});

test("a failing detector aborts the whole scan atomically and records the failure", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await seedCatalog(
      db,
      stateOf([
        [
          "lib-movies",
          [
            movie("mov-a", "A", SAVED_V1, { Path: "/media/shared.mkv" }),
            movie("mov-b", "B", SAVED_V1, { Path: "/media/shared.mkv" })
          ]
        ],
        ["lib-tv", [movie("mov-c", "C", SAVED_V1, { Path: "/media/c.mkv", ProviderIds: { Imdb: "tt-c" } })]]
      ])
    );

    // Break the missing_external_id detector for the app role: the whole
    // scan — including already-satisfied duplicate_file findings — must
    // commit nothing.
    await withClient(db.migrate, async (client) => {
      await client.query("REVOKE SELECT ON public.media_item_provider_ids FROM " + db.app.user);
    });
    await assert.rejects(
      runIdentityScan(createPgSyncExecutor(db.appPool), { clock: FIXED_CLOCK }),
      (error: unknown) => error instanceof WorkbenchError && /permission denied/.test(error.message)
    );

    const failed = await lastScan(db.appPool);
    assert.equal(failed.status, "failed");
    assert.match(String(failed.error_detail), /permission denied/);
    const rows = await quarantines(db.appPool);
    assert.equal(rows.length, 0, "the rolled-back scan recorded no conflicts");

    // Restore the grant: the next scan is a clean recovery.
    await withClient(db.migrate, async (client) => {
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_item_provider_ids TO ` + db.app.user
      );
    });
    const recovery = await runIdentityScan(createPgSyncExecutor(db.appPool), { clock: FIXED_CLOCK });
    assert.equal(recovery.status, "succeeded");
    assert.equal(recovery.quarantinesOpened, 3);
    assert.equal((await quarantines(db.appPool)).length, 3);
  });
});

test("release and discard resolve with a full audit trail and never resolve twice", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await seedCatalog(
      db,
      stateOf([
        [
          "lib-movies",
          [
            movie("mov-a", "A", SAVED_V1, { Path: "/media/shared.mkv" }),
            movie("mov-b", "B", SAVED_V1, { Path: "/media/shared.mkv" })
          ]
        ],
        ["lib-tv", [movie("mov-c", "C", SAVED_V1, { Path: "/media/c.mkv", ProviderIds: { Imdb: "tt-c" } })]]
      ])
    );
    const executor = createPgSyncExecutor(db.appPool);
    await runIdentityScan(executor, { clock: FIXED_CLOCK });
    const open = await quarantines(db.appPool);
    const dup = open.find((row) => row.reason === "duplicate_file")!;
    const missing = open.find((row) => row.reason === "missing_external_id")!;

    // No operator, no write: audit without an actor fails closed.
    await assert.rejects(
      releaseQuarantine(executor, { quarantineId: Number(dup.id), operator: undefined }),
      WorkbenchParamError
    );
    assert.equal((await quarantines(db.appPool)).every((row) => row.status === "quarantined"), true);

    const released = await releaseQuarantine(executor, {
      quarantineId: Number(dup.id),
      operator: OPERATOR,
      note: "confirmed in Jellyfin: only one import exists",
      clock: FIXED_CLOCK
    });
    assert.equal(released.status, "released");
    assert.equal(released.reason, "duplicate_file");
    assert.notEqual(released.auditId, undefined);

    const releasedRow = (await quarantines(db.appPool)).find((row) => row.id === dup.id)!;
    assert.equal(releasedRow.status, "released");
    assert.notEqual(releasedRow.resolved_at, null);

    const discarded = await discardQuarantine(executor, {
      quarantineId: Number(missing.id),
      operator: OPERATOR,
      clock: FIXED_CLOCK
    });
    assert.equal(discarded.status, "discarded");

    // Resolved rows never resolve again — by any action.
    for (const retry of [
      () => releaseQuarantine(executor, { quarantineId: Number(dup.id), operator: OPERATOR }),
      () => discardQuarantine(executor, { quarantineId: Number(dup.id), operator: OPERATOR })
    ]) {
      await assert.rejects(retry, (error: unknown) => error instanceof WorkbenchError && /already resolved/.test(error.message));
    }
    await assert.rejects(
      releaseQuarantine(executor, { quarantineId: 999999, operator: OPERATOR }),
      (error: unknown) => error instanceof WorkbenchError && /does not exist/.test(error.message)
    );

    // Exactly one audit row per resolution, in order, with evidence.
    const audit = await db.appPool.query<{ action: string; operator: string; note: string | null; evidence: Record<string, unknown> }>(
      "SELECT action, operator, note, evidence FROM media_identity_repairs ORDER BY id"
    );
    assert.deepEqual(audit.rows.map((row) => row.action), ["released", "discarded"]);
    assert.deepEqual(audit.rows.map((row) => row.operator), [OPERATOR, OPERATOR]);
    assert.equal(audit.rows[0].note, "confirmed in Jellyfin: only one import exists");
    assert.equal((audit.rows[0].evidence.quarantine as Record<string, unknown>).reason, "duplicate_file");

    // list() defaults put open rows first and honor filters.
    const listing = await listQuarantines(executor, {});
    assert.equal(listing[0].status, "quarantined", "open rows come first regardless of id order");
    assert.deepEqual(
      [...listing.map((row) => row.status)].sort(),
      ["discarded", "quarantined", "released"],
      "every row appears exactly once"
    );
    const onlyReleased = await listQuarantines(executor, { status: "released" });
    assert.equal(onlyReleased.length, 1);
    await assert.rejects(listQuarantines(executor, { status: "bogus" }), WorkbenchParamError);

    // describe() bundles the quarantine, item projections, and repairs.
    const inspection = await describeQuarantine(executor, Number(dup.id));
    assert.equal(inspection.quarantine.identity, "/media/shared.mkv");
    assert.deepEqual(
      inspection.items.map((item) => item.jellyfin_id).sort(),
      ["mov-a", "mov-b"]
    );
    assert.equal(inspection.repairs.length, 1);
    await assert.rejects(
      describeQuarantine(executor, 999999),
      (error: unknown) => error instanceof WorkbenchError && /does not exist/.test(error.message)
    );
  });
});

test("remap re-points a sync-quarantined identity and its failure matrix stays fail-closed", async (t) => {
  await withFreshCatalog(t, async (db) => {
    const executor = createPgSyncExecutor(db.appPool);
    // Grow a real duplicate_identity quarantine: the same Jellyfin id
    // reported under both libraries with differing content in one run.
    const conflicting = stateOf([
      ["lib-movies", [movie("mov-twin", "Twin (Movies)", SAVED_V1)]],
      ["lib-tv", [movie("mov-c", "C", SAVED_V1, { Path: "/media/c.mkv", ProviderIds: { Imdb: "tt-c" } })]]
    ]);
    await seedCatalog(db, conflicting);
    const conflictingRun = stateOf([
      ["lib-movies", [movie("mov-twin", "Twin (Movies)", SAVED_V1), movie("mov-twin", "Twin (Movies)", SAVED_V1)]],
      [
        "lib-tv",
        [
          movie("mov-twin", "Twin (TV)", SAVED_V2, { Etag: "etag-twin-b" }),
          movie("mov-c", "C", SAVED_V1, { Path: "/media/c.mkv", ProviderIds: { Imdb: "tt-c" } })
        ]
      ]
    ]);
    await seedCatalog(db, conflictingRun);
    let open = (await quarantines(db.appPool)).filter((row) => row.status === "quarantined" && row.reason === "duplicate_identity");
    assert.equal(open.length, 1, "the sync quarantined the conflicting identity");
    const quarantineId = Number(open[0].id);

    const itemLibrary = async (): Promise<string> => {
      const result = await db.appPool.query<{ library: string }>(
        `SELECT l.jellyfin_id AS library FROM media_items i JOIN media_libraries l ON l.id = i.library_id
         WHERE i.jellyfin_id = 'mov-twin' AND i.removed_at IS NULL`
      );
      return result.rows[0].library;
    };
    assert.equal(await itemLibrary(), "lib-movies", "the sync's first-occurrence choice");

    // Failure matrix — each rejection leaves placement, status, and audit
    // untouched.
    await assert.rejects(
      remapQuarantineItem(executor, { quarantineId, targetLibraryJellyfinId: "lib-ghost", operator: OPERATOR }),
      (error: unknown) => error instanceof WorkbenchError && /target library/.test(error.message)
    );
    await assert.rejects(
      remapQuarantineItem(executor, { quarantineId, targetLibraryJellyfinId: "lib-movies", operator: OPERATOR }),
      (error: unknown) => error instanceof WorkbenchError && /release instead of remap/.test(error.message)
    );
    await assert.rejects(
      remapQuarantineItem(executor, { quarantineId, targetLibraryJellyfinId: "lib-tv", operator: undefined }),
      WorkbenchParamError
    );
    assert.equal(await itemLibrary(), "lib-movies", "failed remaps never moved anything");
    assert.equal((await db.appPool.query("SELECT count(*) AS n FROM media_identity_repairs")).rows[0].n, "0");

    // Happy path: the operator chooses the TV placement.
    const remapped = await remapQuarantineItem(executor, {
      quarantineId,
      targetLibraryJellyfinId: "lib-tv",
      operator: OPERATOR,
      note: "TV placement verified against Jellyfin",
      clock: FIXED_CLOCK
    });
    assert.equal(remapped.status, "released");
    assert.equal(remapped.itemJellyfinId, "mov-twin");
    assert.equal(remapped.fromLibraryJellyfinId, "lib-movies");
    assert.equal(remapped.toLibraryJellyfinId, "lib-tv");
    assert.equal(await itemLibrary(), "lib-tv", "the placement moved exactly once");

    const audit = await db.appPool.query<{ action: string; evidence: Record<string, unknown> }>(
      "SELECT action, evidence FROM media_identity_repairs ORDER BY id"
    );
    assert.deepEqual(audit.rows.map((row) => row.action), ["remapped"]);
    const placement = audit.rows[0].evidence.placement as Record<string, Record<string, string>>;
    assert.deepEqual(placement, {
      from: { libraryJellyfinId: "lib-movies" },
      to: { libraryJellyfinId: "lib-tv" }
    });
    const resolvedRow = (await quarantines(db.appPool)).find((row) => row.id === String(quarantineId))!;
    assert.equal(resolvedRow.status, "released");
    assert.notEqual(resolvedRow.resolved_at, null);

    await assert.rejects(
      remapQuarantineItem(executor, { quarantineId, targetLibraryJellyfinId: "lib-movies", operator: OPERATOR }),
      (error: unknown) => error instanceof WorkbenchError && /already resolved/.test(error.message)
    );

    // A re-occurrence of the same conflict opens a NEW row (the released one
    // stays as history), and remap refuses wrong-reason rows.
    await seedCatalog(db, conflictingRun);
    open = (await quarantines(db.appPool)).filter((row) => row.status === "quarantined" && row.reason === "duplicate_identity");
    assert.equal(open.length, 1, "a fresh open quarantine for the re-observed conflict");
    const secondId = Number(open[0].id);
    assert.notEqual(secondId, quarantineId);

    // Missing external id → remap refuses the reason…
    const missingScan = await runIdentityScan(executor, { clock: FIXED_CLOCK });
    assert.ok(missingScan.missingExternalId >= 1, "mov-twin carries no provider IDs");
    const bare = (await quarantines(db.appPool)).find(
      (row) => row.reason === "missing_external_id" && row.identity === "mov-twin" && row.status === "quarantined"
    );
    assert.notEqual(bare, undefined);
    await assert.rejects(
      remapQuarantineItem(executor, { quarantineId: Number(bare!.id), targetLibraryJellyfinId: "lib-tv", operator: OPERATOR }),
      (error: unknown) => error instanceof WorkbenchError && /duplicate_identity/.test(error.message)
    );

    // …and once the sync tombstones the identity, remap refuses the dead item.
    await seedCatalog(
      db,
      stateOf([
        ["lib-movies", []],
        ["lib-tv", [movie("mov-c", "C", SAVED_V1, { Path: "/media/c.mkv", ProviderIds: { Imdb: "tt-c" } })]]
      ])
    );
    await assert.rejects(
      remapQuarantineItem(executor, { quarantineId: secondId, targetLibraryJellyfinId: "lib-movies", operator: OPERATOR }),
      (error: unknown) => error instanceof WorkbenchError && /no active catalog item/.test(error.message)
    );
    // The refused remap left the quarantine open; the operator can still
    // release it plainly.
    const released = await releaseQuarantine(executor, { quarantineId: secondId, operator: OPERATOR, clock: FIXED_CLOCK });
    assert.equal(released.status, "released");
  });
});

test("scanning a fixed catalog twice replays deterministically", async (t) => {
  async function replay(t2: { skip: (message?: string) => void }): Promise<{ opened: number; bumped: number; rows: { reason: string; identity: string; occurrences: number }[] }> {
    let out!: { opened: number; bumped: number; rows: { reason: string; identity: string; occurrences: number }[] };
    await withFreshCatalog(t2, async (db) => {
      await seedCatalog(
        db,
        stateOf([
          [
            "lib-movies",
            [
              movie("mov-a", "A", SAVED_V1, { Path: "/media/shared.mkv" }),
              movie("mov-b", "B", SAVED_V1, { Path: "/media/shared.mkv" })
            ]
          ],
          ["lib-tv", [movie("mov-c", "C", SAVED_V1, { Path: "/media/c.mkv", ProviderIds: { Imdb: "tt-c" } })]]
        ])
      );
      const executor = createPgSyncExecutor(db.appPool);
      await runIdentityScan(executor, { clock: FIXED_CLOCK });
      const second = await runIdentityScan(executor, { clock: FIXED_CLOCK });
      const rows = await quarantines(db.appPool);
      out = {
        opened: second.quarantinesOpened,
        bumped: second.quarantinesBumped,
        rows: rows.map((row) => ({ reason: row.reason, identity: row.identity, occurrences: Number(row.occurrences) }))
      };
    });
    return out;
  }

  const first = await replay(t);
  const second = await replay(t);
  assert.deepEqual(second, first, "same catalog in, identical scan evidence out");
  assert.equal(first.opened, 0);
  assert.equal(first.bumped, 3);
});
