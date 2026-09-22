// Deterministic PostgreSQL + Jellyfin integration evidence for the RH-0032
// incremental refresh and change-history pipeline.
//
// Runs against the disposable loopback PostgreSQL 18 profile — never against
// Synology, and never against a live Jellyfin: the Jellyfin side is a
// scripted CatalogSource double with canned, timestamped payloads, so every
// scenario is fully deterministic. Without the two role URLs every case
// skips and the hermetic `npm test` stays hermetic:
//
//   REELHOUSE_TEST_MIGRATE_URL   owner/migrator role
//   REELHOUSE_TEST_DATABASE_URL  application role
//
// Scenarios: migration 0006 (change history, watermark, quarantine) applies
// idempotently, the no-baseline fail-closed guard, baseline seeding +
// no-op incremental runs, delta add/update with source-provenanced history,
// sweep removal/restore, watermark freeze on mid-run failure + recovery
// re-coverage, duplicate-identity quarantine, and deterministic replay of a
// full source-state sequence onto a second fresh database.
//
// This file uses its own temporary database (reelhouse_rh0032_tmp) so it
// cannot interfere with the RH-0030/RH-0031 suites even when node --test
// runs all three files as parallel processes.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { loadDatabaseConfig, type DatabaseConfig } from "../db/config.ts";
import { loadMigrationFiles, runMigrations } from "../db/migrator.ts";
import { createPgSyncExecutor } from "./pg-executor.ts";
import { runFullCatalogSync } from "./sync.ts";
import { runIncrementalCatalogSync } from "./incremental.ts";
import type { CatalogLibrary, CatalogItemsPage, CatalogRawItem, CatalogSource } from "./source.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const TEMP_DB = "reelhouse_rh0032_tmp";

const migrateEnv = process.env.REELHOUSE_TEST_MIGRATE_URL;
const appEnv = process.env.REELHOUSE_TEST_DATABASE_URL;

function configFrom(url: string, overrides: Partial<DatabaseConfig> = {}): DatabaseConfig {
  const result = loadDatabaseConfig({ DATABASE_URL: url });
  if (result.kind !== "valid") throw new Error(`test URL invalid: ${"errors" in result ? result.errors.join("; ") : "blank"}`);
  return { ...result.config, ...overrides };
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

// Fixed clock: every inferred timestamp is a constant, so replays are
// byte-identical down to recorded_at.
const FIXED_CLOCK = () => new Date("2025-03-02T10:00:00.000Z");

// Source save times: V1 is the baseline the full sync seeds; V2 is what the
// first delta window picks up.
const SAVED_V1 = "2025-01-01T00:00:00.000Z";
const SAVED_V2 = "2025-03-01T00:00:00.000Z";

function movie(jellyfinId: string, name: string, savedAt: string, overrides: CatalogRawItem = {}): CatalogRawItem {
  return { Id: jellyfinId, Name: name, Type: "Movie", DateLastSaved: savedAt, Etag: `etag-${jellyfinId}`, ...overrides };
}

interface ScriptedSourceState {
  itemsByLibrary: Map<string, CatalogRawItem[]>;
}

// Deterministic Jellyfin double serving all three query surfaces the
// pipelines consume, with fault injection on the delta cursor and per
// library on the sweep. Explicit fields: Node's TS strip-only mode rejects
// constructor parameter properties.
class ScriptedSource implements CatalogSource {
  libraries: CatalogLibrary[];
  state: ScriptedSourceState;
  failOnDeltaCall?: number;
  failOnSweepLibraryId?: string;
  private deltaCalls = 0;

  constructor(libraries: CatalogLibrary[], state: ScriptedSourceState) {
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
    sinceIso: string,
    startIndex: number,
    limit: number
  ): Promise<CatalogItemsPage> {
    this.deltaCalls += 1;
    if (this.failOnDeltaCall === this.deltaCalls) {
      throw new Error(`simulated Jellyfin outage on delta call ${this.deltaCalls}`);
    }
    const threshold = new Date(sinceIso);
    const items = (this.state.itemsByLibrary.get(libraryJellyfinId) ?? []).filter(
      (entry) => typeof entry.DateLastSaved === "string" && new Date(entry.DateLastSaved) >= threshold
    );
    return { items: items.slice(startIndex, startIndex + limit), totalRecordCount: items.length };
  }

  async fetchLibraryItemIdsPage(
    libraryJellyfinId: string,
    startIndex: number,
    limit: number
  ): Promise<CatalogItemsPage> {
    if (this.failOnSweepLibraryId === libraryJellyfinId) {
      throw new Error(`simulated Jellyfin outage on sweep of ${libraryJellyfinId}`);
    }
    const items = (this.state.itemsByLibrary.get(libraryJellyfinId) ?? []).map((entry) => ({ Id: entry.Id }));
    return { items: items.slice(startIndex, startIndex + limit), totalRecordCount: items.length };
  }
}

function library(jellyfinId: string, name: string, collectionType: string | null): CatalogLibrary {
  return { jellyfinId, name, collectionType };
}

const TWO_LIBRARIES = [library("lib-movies", "Movies", "movies"), library("lib-tv", "TV Shows", "tvshows")];

function baselineState(): ScriptedSourceState {
  return {
    itemsByLibrary: new Map([
      ["lib-movies", [movie("mov-arrival", "Arrival", SAVED_V1, { ProductionYear: 2016, Genres: ["Drama"] })]],
      ["lib-tv", [movie("mov-bare", "Bare Movie", SAVED_V1)]]
    ])
  };
}

interface CaseHandle {
  migrate: DatabaseConfig;
  app: DatabaseConfig;
  appPool: Pool;
}

// Fresh temporary database with all on-disk migrations applied, an app-role
// pool, and a guaranteed teardown.
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

interface ChangeRow {
  change_kind: string;
  jellyfin_id: string;
  source_revision: string | null;
  observed_at: Date;
  recorded_at: Date;
  changed_fields: string[];
}

async function changeHistory(pool: Pool): Promise<ChangeRow[]> {
  const result = await pool.query<ChangeRow>(
    `SELECT change_kind, jellyfin_id, source_revision, observed_at, recorded_at, changed_fields
     FROM media_item_changes ORDER BY id`
  );
  return result.rows.map((row) => ({
    ...row,
    changed_fields: row.changed_fields as unknown as string[]
  }));
}

async function itemState(pool: Pool): Promise<Map<string, { name: string; removed: boolean; first_seen_at: Date; source_observed_at: Date | null }>> {
  const result = await pool.query<{
    jellyfin_id: string;
    name: string;
    removed_at: Date | null;
    first_seen_at: Date;
    source_observed_at: Date | null;
  }>("SELECT jellyfin_id, name, removed_at, first_seen_at, source_observed_at FROM media_items ORDER BY jellyfin_id");
  return new Map(
    result.rows.map((row) => [
      row.jellyfin_id,
      { name: row.name, removed: row.removed_at !== null, first_seen_at: row.first_seen_at, source_observed_at: row.source_observed_at }
    ])
  );
}

async function watermarkState(pool: Pool): Promise<{ watermark: Date; last_run_id: string } | null> {
  const result = await pool.query<{ watermark: Date; last_run_id: string }>(
    "SELECT watermark, last_run_id FROM media_sync_state WHERE source = 'jellyfin'"
  );
  return result.rows[0] ?? null;
}

async function lastRun(pool: Pool): Promise<Record<string, unknown>> {
  const result = await pool.query<Record<string, unknown>>(
    "SELECT * FROM media_sync_runs ORDER BY id DESC LIMIT 1"
  );
  return result.rows[0];
}

test("migration 0006 adds change history, watermark, and quarantine under the same grants model", async (t) => {
  await withFreshCatalog(t, async (db) => {
    await withClient(db.migrate, async (client) => {
      const expectedVersions = loadMigrationFiles(MIGRATIONS_DIR).map((file) => file.version);
      const applied = await client.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version");
      assert.deepEqual(applied.rows.map((row) => row.version), expectedVersions);
    });

    // Re-running the migrator against the live schema is a no-op.
    const again = await runMigrations(db.migrate, MIGRATIONS_DIR, db.app.user);
    assert.deepEqual(again.appliedNow, []);

    // The run mode invariant now spans both pipelines, everything else
    // still fails closed.
    await withClient(db.app, async (client) => {
      await assert.rejects(
        client.query("INSERT INTO media_sync_runs (source, mode, status) VALUES ('jellyfin', 'full', 'exploded')"),
        /media_sync_runs_status_check/
      );
      await assert.rejects(
        client.query("INSERT INTO media_sync_runs (source, mode, status) VALUES ('jellyfin', 'delta', 'running')"),
        /media_sync_runs_mode_check/
      );
      await client.query("INSERT INTO media_sync_runs (source, mode, status) VALUES ('jellyfin', 'incremental', 'running')");
      // The watermark column is provenance, not free-form: only real
      // instants.
      await assert.rejects(
        client.query("INSERT INTO media_sync_state (source, watermark) VALUES ('jellyfin', 'not-a-time')"),
        /invalid input syntax|date\/time/
      );
    });
  });
});

test("an incremental run without a baseline fails closed and records why", async (t) => {
  await withFreshCatalog(t, async (db) => {
    const source = new ScriptedSource(TWO_LIBRARIES, baselineState());
    await assert.rejects(
      runIncrementalCatalogSync(source, createPgSyncExecutor(db.appPool), { pageSize: 50, clock: FIXED_CLOCK }),
      /no incremental baseline/
    );
    const run = await lastRun(db.appPool);
    assert.equal(run.status, "failed");
    assert.equal(run.mode, "incremental");
    assert.match(String(run.error_detail), /no incremental baseline/);
    assert.equal(await watermarkState(db.appPool), null, "no watermark exists without a full sync");
    const items = await db.appPool.query("SELECT count(*) AS count FROM media_items");
    assert.equal(Number(items.rows[0].count), 0, "the refused run wrote nothing");
  });
});

test("a full sync seeds the baseline and an unchanged incremental run records only silence", async (t) => {
  await withFreshCatalog(t, async (db) => {
    const executor = createPgSyncExecutor(db.appPool);
    const full = await runFullCatalogSync(new ScriptedSource(TWO_LIBRARIES, baselineState()), executor, {
      pageSize: 50,
      clock: FIXED_CLOCK
    });
    assert.equal(full.status, "succeeded");
    const seeded = await watermarkState(db.appPool);
    assert.ok(seeded, "the full sync seeds media_sync_state");
    assert.equal(seeded.watermark.getTime(), Date.parse(SAVED_V1), "watermark = newest observed DateLastSaved");

    const before = await itemState(db.appPool);
    const first = await runIncrementalCatalogSync(new ScriptedSource(TWO_LIBRARIES, baselineState()), executor, {
      pageSize: 50,
      clock: FIXED_CLOCK
    });
    assert.equal(first.status, "succeeded");
    assert.equal(first.changesRecorded, 0, "unchanged source: no change rows at all");
    assert.equal(first.itemsUpserted, 2, "delta re-covered the window window idempotently");
    assert.equal(first.itemsTombstoned, 0);
    assert.deepEqual(await itemState(db.appPool), before, "catalog state untouched");

    const second = await runIncrementalCatalogSync(new ScriptedSource(TWO_LIBRARIES, baselineState()), executor, {
      pageSize: 50,
      clock: FIXED_CLOCK
    });
    assert.equal(second.changesRecorded, 0);
    assert.equal(second.watermark, first.watermark, "watermark stable without new saves");

    const history = await changeHistory(db.appPool);
    // The only history is the full sync's initial load; both incrementals
    // recorded nothing.
    assert.deepEqual(
      history.map((row) => [row.change_kind, row.jellyfin_id]),
      [
        ["added", "mov-arrival"],
        ["added", "mov-bare"]
      ]
    );
    const runs = await db.appPool.query<{ modes: string[]; statuses: string[] }>(
      "SELECT array_agg(mode ORDER BY id) AS modes, array_agg(status ORDER BY id) AS statuses FROM media_sync_runs"
    );
    assert.deepEqual(runs.rows[0].modes, ["full", "incremental", "incremental"]);
    assert.deepEqual(runs.rows[0].statuses, ["succeeded", "succeeded", "succeeded"]);
  });
});

test("delta adds and updates carry source provenance into the change history", async (t) => {
  await withFreshCatalog(t, async (db) => {
    const executor = createPgSyncExecutor(db.appPool);
    await runFullCatalogSync(new ScriptedSource(TWO_LIBRARIES, baselineState()), executor, {
      pageSize: 50,
      clock: FIXED_CLOCK
    });
    const firstSeen = (await itemState(db.appPool)).get("mov-arrival")!.first_seen_at;

    const mutated = baselineState();
    mutated.itemsByLibrary.set("lib-movies", [
      movie("mov-arrival", "Arrival", SAVED_V1, { ProductionYear: 2016, Genres: ["Drama"] }),
      movie("mov-renamed", "Renamed Movie", SAVED_V2),
      movie("mov-new", "Brand New", SAVED_V2, { ProductionYear: 2026, Etag: "etag-brand-new" })
    ]);

    const run = await runIncrementalCatalogSync(new ScriptedSource(TWO_LIBRARIES, mutated), executor, {
      pageSize: 50,
      clock: FIXED_CLOCK
    });
    assert.equal(run.status, "succeeded");
    assert.equal(run.changesRecorded, 2, "one add, one update");
    assert.equal(new Date(run.windowStart).getTime(), Date.parse(SAVED_V1) - 1_000, "window overlaps by one second");
    assert.equal(new Date(run.watermark).getTime(), Date.parse(SAVED_V2), "watermark advanced to the newest save");

    const state = await itemState(db.appPool);
    assert.equal(state.get("mov-new")!.name, "Brand New");
    assert.equal(state.get("mov-renamed")!.name, "Renamed Movie");
    assert.equal(state.get("mov-new")!.source_observed_at?.getTime(), Date.parse(SAVED_V2));

    const history = await changeHistory(db.appPool);
    // Prefix: the full sync's initial load. Then exactly one add per new id.
    assert.deepEqual(
      history.map((row) => [row.change_kind, row.jellyfin_id]),
      [
        ["added", "mov-arrival"],
        ["added", "mov-bare"],
        ["added", "mov-renamed"],
        ["added", "mov-new"]
      ],
      "new ids land as adds, each recorded exactly once"
    );
    const added = history[3];
    assert.equal(added.source_revision, "etag-brand-new");
    assert.equal(added.observed_at.getTime(), Date.parse(SAVED_V2), "observed_at is the source's save time");
    assert.deepEqual(added.changed_fields, []);

    // Provenance survives: first_seen_at never moves.
    assert.equal(state.get("mov-arrival")!.first_seen_at.getTime(), firstSeen.getTime());
  });
});

test("the presence sweep retires absent items and restores returning ones", async (t) => {
  await withFreshCatalog(t, async (db) => {
    const executor = createPgSyncExecutor(db.appPool);
    await runFullCatalogSync(new ScriptedSource(TWO_LIBRARIES, baselineState()), executor, {
      pageSize: 50,
      clock: FIXED_CLOCK
    });
    const before = await itemState(db.appPool);

    // mov-bare vanishes without ever being "saved": only the sweep can see it.
    const emptied = baselineState();
    emptied.itemsByLibrary.set("lib-tv", []);

    const removal = await runIncrementalCatalogSync(new ScriptedSource(TWO_LIBRARIES, emptied), executor, {
      pageSize: 50,
      clock: FIXED_CLOCK
    });
    assert.equal(removal.status, "succeeded");
    assert.equal(removal.itemsTombstoned, 1);
    assert.equal(removal.changesRecorded, 1);
    assert.ok((await itemState(db.appPool)).get("mov-bare")!.removed, "retired, not deleted");
    assert.equal(
      (await watermarkState(db.appPool))!.watermark.getTime(),
      Date.parse(SAVED_V1),
      "sweep-only runs do not advance the watermark"
    );

    const removalHistory = (await changeHistory(db.appPool)).at(-1)!;
    assert.equal(removalHistory.change_kind, "removed");
    assert.equal(removalHistory.jellyfin_id, "mov-bare");
    assert.equal(removalHistory.source_revision, null, "removals are inferred, not source-observed");
    assert.equal(removalHistory.observed_at.getTime(), FIXED_CLOCK().getTime());

    // mov-bare returns with its OLD save time: the sweep restores it, and
    // first_seen_at survives the whole round trip.
    const restored = await runIncrementalCatalogSync(new ScriptedSource(TWO_LIBRARIES, baselineState()), executor, {
      pageSize: 50,
      clock: FIXED_CLOCK
    });
    assert.equal(restored.itemsRestored, 1);
    const after = await itemState(db.appPool);
    assert.equal(after.get("mov-bare")!.removed, false);
    assert.equal(after.get("mov-bare")!.first_seen_at.getTime(), before.get("mov-bare")!.first_seen_at.getTime());
    const restoreHistory = (await changeHistory(db.appPool)).at(-1)!;
    assert.equal(restoreHistory.change_kind, "restored");
    assert.equal(restoreHistory.jellyfin_id, "mov-bare");
  });
});

test("a mid-run failure freezes the watermark and the next run re-covers the window", async (t) => {
  await withFreshCatalog(t, async (db) => {
    const executor = createPgSyncExecutor(db.appPool);
    await runFullCatalogSync(new ScriptedSource(TWO_LIBRARIES, baselineState()), executor, {
      pageSize: 50,
      clock: FIXED_CLOCK
    });

    const mutated = baselineState();
    mutated.itemsByLibrary.set("lib-movies", [movie("mov-new", "Brand New", SAVED_V2)]);
    mutated.itemsByLibrary.set("lib-tv", [movie("mov-bare", "Bare Movie (Renamed)", SAVED_V2)]);

    // The first delta call (lib-movies) succeeds; the second (lib-tv) fails.
    const failing = new ScriptedSource(TWO_LIBRARIES, mutated);
    failing.failOnDeltaCall = 2;
    await assert.rejects(
      runIncrementalCatalogSync(failing, executor, { pageSize: 50, clock: FIXED_CLOCK }),
      /simulated Jellyfin outage on delta call 2/
    );
    const failedRun = await lastRun(db.appPool);
    assert.equal(failedRun.status, "failed");
    assert.equal(
      (await watermarkState(db.appPool))!.watermark.getTime(),
      Date.parse(SAVED_V1),
      "a failed run never advances the watermark"
    );
    assert.ok((await itemState(db.appPool)).get("mov-new"), "the committed batch stayed durable");

    // Recovery re-covers the same window: no duplicate change rows for the
    // already-applied item, and the remaining delta applies.
    const recovery = await runIncrementalCatalogSync(new ScriptedSource(TWO_LIBRARIES, mutated), executor, {
      pageSize: 50,
      clock: FIXED_CLOCK
    });
    assert.equal(recovery.status, "succeeded");
    assert.equal(recovery.changesRecorded, 1, "only the not-yet-applied delta produces history");
    assert.equal(
      (await watermarkState(db.appPool))!.watermark.getTime(),
      Date.parse(SAVED_V2),
      "the healthy run advances coverage"
    );
    assert.equal((await itemState(db.appPool)).get("mov-bare")!.name, "Bare Movie (Renamed)");

    const history = await changeHistory(db.appPool);
    const movNewAdds = history.filter((row) => row.jellyfin_id === "mov-new" && row.change_kind === "added");
    assert.equal(movNewAdds.length, 1, "re-covered adds are idempotent, history stays truthful");
    // Prefix: the full sync's initial load. Then: the failed run committed
    // lib-movies' delta AND its sweep (mov-arrival was absent there), and
    // the recovery run completed lib-tv.
    assert.deepEqual(
      history.map((row) => [row.change_kind, row.jellyfin_id]),
      [
        ["added", "mov-arrival"],
        ["added", "mov-bare"],
        ["added", "mov-new"],
        ["removed", "mov-arrival"],
        ["updated", "mov-bare"]
      ]
    );
    const renamed = history[4];
    assert.deepEqual(renamed.changed_fields, ["name"], "the update names exactly what moved");
  });
});

test("conflicting duplicate identities quarantine instead of overwriting", async (t) => {
  await withFreshCatalog(t, async (db) => {
    const executor = createPgSyncExecutor(db.appPool);
    await runFullCatalogSync(new ScriptedSource(TWO_LIBRARIES, baselineState()), executor, {
      pageSize: 50,
      clock: FIXED_CLOCK
    });

    // The same Jellyfin id reported under both libraries with differing
    // content, inside one delta window.
    const conflicting = baselineState();
    conflicting.itemsByLibrary.get("lib-movies")!.push(movie("mov-twin", "Twin (Movies)", SAVED_V2));
    conflicting.itemsByLibrary.get("lib-tv")!.push(movie("mov-twin", "Twin (TV)", SAVED_V2, { Etag: "etag-twin-b" }));

    const run = await runIncrementalCatalogSync(new ScriptedSource(TWO_LIBRARIES, conflicting), executor, {
      pageSize: 50,
      clock: FIXED_CLOCK
    });
    assert.equal(run.status, "succeeded", "quarantine is non-destructive: the run still succeeds");
    assert.equal(run.itemsQuarantined, 1);
    assert.equal(run.changesRecorded, 1, "only the first occurrence is recorded as an add");

    const rows = await db.appPool.query<{ jellyfin_id: string; name: string; library: string }>(
      `SELECT i.jellyfin_id, i.name, l.jellyfin_id AS library
       FROM media_items i JOIN media_libraries l ON l.id = i.library_id
       WHERE i.jellyfin_id = 'mov-twin'`
    );
    assert.deepEqual(rows.rows, [{ jellyfin_id: "mov-twin", name: "Twin (Movies)", library: "lib-movies" }],
      "first occurrence wins deterministically");

    const quarantined = await db.appPool.query<{
      identity: string;
      reason: string;
      occurrences: number;
      status: string;
      payload: Record<string, unknown>;
      detail: string;
    }>("SELECT identity, reason, occurrences, status, payload, detail FROM media_item_quarantine");
    assert.equal(quarantined.rows.length, 1);
    const record = quarantined.rows[0];
    assert.equal(record.identity, "mov-twin");
    assert.equal(record.reason, "duplicate_identity");
    assert.equal(record.status, "quarantined");
    assert.equal(record.occurrences, 1);
    assert.equal(record.payload.libraryJellyfinId, "lib-tv", "the payload evidences the conflicting placement");
    assert.match(record.detail, /differing placement\/content/);

    // Re-seeing the same conflict bumps the existing row; it never multiplies.
    const again = await runIncrementalCatalogSync(new ScriptedSource(TWO_LIBRARIES, conflicting), executor, {
      pageSize: 50,
      clock: FIXED_CLOCK
    });
    assert.equal(again.itemsQuarantined, 1);
    const bumped = await db.appPool.query<{ occurrences: number; count: string }>(
      "SELECT occurrences, count(*) AS count FROM media_item_quarantine GROUP BY occurrences"
    );
    assert.equal(bumped.rows.length, 1);
    assert.equal(Number(bumped.rows[0].occurrences), 2);
    assert.equal(Number(bumped.rows[0].count), 1);
  });
});

test("replaying the same source sequence onto a fresh database reproduces an identical history", async (t) => {
  // The scripted evolution, applied twice to two independent fresh catalogs:
  // S1 adds and renames, S2 removes, S3 brings everything back.
  function stateFor(step: number): ScriptedSourceState {
    const state = baselineState();
    if (step >= 1) {
      state.itemsByLibrary.set("lib-movies", [
        movie("mov-arrival", "Arrival", SAVED_V1, { ProductionYear: 2016, Genres: ["Drama"] }),
        movie("mov-renamed", "Renamed Movie", SAVED_V2),
        movie("mov-new", "Brand New", SAVED_V2)
      ]);
    }
    if (step === 2) {
      state.itemsByLibrary.set("lib-tv", []);
    }
    return state;
  }

  async function replay(t2: { skip: (message?: string) => void }): Promise<ChangeRow[]> {
    let history: ChangeRow[] = [];
    await withFreshCatalog(t2, async (db) => {
      const executor = createPgSyncExecutor(db.appPool);
      await runFullCatalogSync(new ScriptedSource(TWO_LIBRARIES, stateFor(0)), executor, { pageSize: 50, clock: FIXED_CLOCK });
      await runIncrementalCatalogSync(new ScriptedSource(TWO_LIBRARIES, stateFor(1)), executor, { pageSize: 50, clock: FIXED_CLOCK });
      await runIncrementalCatalogSync(new ScriptedSource(TWO_LIBRARIES, stateFor(2)), executor, { pageSize: 50, clock: FIXED_CLOCK });
      await runIncrementalCatalogSync(new ScriptedSource(TWO_LIBRARIES, stateFor(3)), executor, { pageSize: 50, clock: FIXED_CLOCK });
      history = await changeHistory(db.appPool);
    });
    return history;
  }

  const first = await replay(t);
  const second = await replay(t);
  assert.ok(first.length >= 4, `the scenario generated history (${first.length} rows)`);
  assert.deepEqual(second, first, "same source sequence in, identical history out");
  assert.deepEqual(
    first.map((row) => [row.change_kind, row.jellyfin_id]),
    [
      ["added", "mov-arrival"],
      ["added", "mov-bare"],
      ["added", "mov-renamed"],
      ["added", "mov-new"],
      ["removed", "mov-bare"],
      ["restored", "mov-bare"]
    ],
    "the recorded evolution is exactly add/add/add/add/remove/restore"
  );
});
