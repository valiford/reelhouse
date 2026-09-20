// Integration tests for the quarantine review workflow (RH-0023) against
// the disposable PostgreSQL 18 instance (same lifecycle as the db suites).
//
//   npm run test:db:up      start the disposable database (docker compose)
//   npm run test:db         run all integration suites (this one included)
//   npm run test:db:down    stop and discard the database
//
// The suite drives its own database (reelhouse_catalog_review_test) inside
// the disposable container, so it never fights the other suites and never
// touches the production Synology target. Catalog content is built with the
// real sync engine over a fixture Jellyfin client: nothing here requires
// network access, and nothing can modify a real Jellyfin server. The review
// workflow only ever reads that fixture through the catalog database.

import { strict as assert } from "node:assert";
import { before, beforeEach, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type Pool } from "pg";
import { CATALOG_URL_VAR } from "./config.ts";
import type { JellyfinLibraryRaw } from "./model.ts";
import {
  closeCatalogReviewSession,
  listOverrides,
  listQuarantine,
  listWeakIdentity,
  openCatalogReviewSession,
  pinLibrary,
  removeOverride,
  remapProviderClaim,
  resolveQuarantine,
  runDetectors,
  verifyReviewSchema,
  type QuarantineReason
} from "./review.ts";
import { runCatalogSync, type CatalogSyncResult } from "./sync.ts";
import { runMigrations } from "../db/migrator.ts";
import { FixtureJellyfin, T0, movieFixture } from "./test-fixtures.ts";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_test";

const CATALOG_DATABASE_URL =
  process.env.CATALOG_REVIEW_TEST_DATABASE_URL ??
  "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_catalog_review_test";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "db", "migrations-catalog");

const LIBRARIES: JellyfinLibraryRaw[] = [
  { Id: "lib-movies", Name: "Movies", CollectionType: "movies" },
  { Id: "lib-tv", Name: "Shows", CollectionType: "tvshows" }
];

async function withClient<T>(databaseUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createDatabaseIfMissing(adminUrl: string, name: string): Promise<void> {
  await withClient(adminUrl, async (client) => {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE ${name}`);
  });
}

async function resetCatalogTables(): Promise<void> {
  await withClient(CATALOG_DATABASE_URL, async (client) => {
    await client.query(
      "TRUNCATE catalog_item, catalog_library, catalog_quarantine, catalog_genre, catalog_studio, catalog_person, catalog_scan, catalog_sync_state, catalog_identity_override CASCADE"
    );
  });
}

function baseEnv(): Record<string, string> {
  return { [CATALOG_URL_VAR]: CATALOG_DATABASE_URL, MEDIA_CATALOG_RETIREMENT_DAYS: "1" };
}

async function runSync(fixture: FixtureJellyfin, mode: "incremental" | "full" | "rebuild", clock: Date): Promise<CatalogSyncResult> {
  return runCatalogSync({ env: baseEnv(), client: fixture, mode, now: () => clock, log: () => {} });
}

async function withReviewPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const session = await openCatalogReviewSession(baseEnv());
  try {
    return await fn(session.pool);
  } finally {
    await closeCatalogReviewSession(session);
  }
}

interface QuarantineRecord {
  external_id: string;
  reason: string;
  detail: Record<string, unknown>;
  resolved_at: Date | null;
  resolution_action: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
}

async function quarantineRows(client: Client, where = "true"): Promise<QuarantineRecord[]> {
  const result = await client.query<QuarantineRecord>(
    `SELECT external_id, reason, detail, resolved_at, resolution_action, resolution_note, resolved_by
       FROM catalog_quarantine WHERE ${where} ORDER BY external_id, reason`
  );
  return result.rows;
}

async function itemRow(client: Client, externalId: string): Promise<Record<string, unknown> | null> {
  const result = await client.query("SELECT * FROM catalog_item WHERE source = 'jellyfin' AND external_id = $1", [
    externalId
  ]);
  return result.rows[0] ?? null;
}

let fixtureClock = T0;

function tick(ms: number): Date {
  fixtureClock = new Date(fixtureClock.getTime() + ms);
  return fixtureClock;
}

before(async () => {
  await withClient(TEST_DATABASE_URL, async () => {});
  await createDatabaseIfMissing(TEST_DATABASE_URL, "reelhouse_catalog_review_test");
  await withClient(CATALOG_DATABASE_URL, async (client) => {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  });
  await runMigrations({ databaseUrl: CATALOG_DATABASE_URL, migrationsDir: MIGRATIONS_DIR, log: () => {} });
  const repeat = await runMigrations({ databaseUrl: CATALOG_DATABASE_URL, migrationsDir: MIGRATIONS_DIR, log: () => {} });
  assert.equal(repeat.applied.length, 0, "catalog migrations must be idempotent on repeat");
});

describe("catalog quarantine review", () => {
  beforeEach(async () => {
    await resetCatalogTables();
    fixtureClock = T0;
  });

  it("detects duplicate paths across live items and records only the later claimant", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [LIBRARIES[0] as JellyfinLibraryRaw];
    fixture.items.set("lib-movies", [movieFixture("m-1", { Path: "/media/shared.mkv" })]);
    await runSync(fixture, "full", tick(0));
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { Path: "/media/shared.mkv" }),
      movieFixture("m-2", { Path: "/media/shared.mkv" })
    ]);
    await runSync(fixture, "full", tick(60_000));

    const result = await withReviewPool((pool) => runDetectors(pool, tick(1000), () => {}));
    assert.equal(result.duplicatePathFindings, 1);
    assert.equal(result.renamedIdentityFindings, 0);
    assert.equal(result.recorded, 1);
    assert.equal(result.truncated, false);

    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const rows = await quarantineRows(client, "reason = 'duplicate_path'");
      assert.equal(rows.length, 1);
      const finding = rows[0];
      assert.ok(finding !== undefined);
      assert.equal(finding.external_id, "m-2", "the incumbent is never the finding");
      assert.equal(finding.resolved_at, null);
      assert.deepEqual(finding.detail, {
        path: "/media/shared.mkv",
        incumbentExternalId: "m-1",
        incumbentObservedAt: new Date(T0).toISOString()
      });
    });
  });

  it("never lets a successful sync auto-close detector rows", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [LIBRARIES[0] as JellyfinLibraryRaw];
    fixture.items.set("lib-movies", [movieFixture("m-1", { Path: "/media/shared.mkv" })]);
    await runSync(fixture, "full", tick(0));
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { Path: "/media/shared.mkv" }),
      movieFixture("m-2", { Path: "/media/shared.mkv" })
    ]);
    await runSync(fixture, "full", tick(60_000));
    await withReviewPool((pool) => runDetectors(pool, tick(1000), () => {}));

    // m-2 keeps syncing successfully; the detector finding must stay open.
    const result = await runSync(fixture, "full", tick(60_000));
    assert.equal(result.counts.itemsQuarantined, 0);
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const rows = await quarantineRows(client, "reason = 'duplicate_path'");
      const finding = rows[0];
      assert.ok(finding !== undefined);
      assert.equal(finding.resolved_at, null, "auto-resolution is scoped to sync-owned reasons");
    });
  });

  it("honors a dismissal across detector re-runs until the conflict truly changes", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [LIBRARIES[0] as JellyfinLibraryRaw];
    fixture.items.set("lib-movies", [movieFixture("m-1", { Path: "/media/shared.mkv" })]);
    await runSync(fixture, "full", tick(0));
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { Path: "/media/shared.mkv" }),
      movieFixture("m-2", { Path: "/media/shared.mkv" })
    ]);
    await runSync(fixture, "full", tick(60_000));
    await withReviewPool((pool) => runDetectors(pool, tick(1000), () => {}));

    const [entry] = await withReviewPool((pool) => listQuarantine(pool, { status: "open", reason: null, limit: 10 }));
    assert.ok(entry !== undefined);
    const resolved = await withReviewPool((pool) =>
      resolveQuarantine(pool, entry.id, { action: "dismissed", note: "known doubles", by: "alex" }, tick(1000))
    );
    assert.equal(resolved.state, "dismissed");

    // Re-detection does not reopen a dismissed finding.
    const again = await withReviewPool((pool) => runDetectors(pool, tick(1000), () => {}));
    assert.equal(again.recorded, 0);
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const rows = await quarantineRows(client, "reason = 'duplicate_path'");
      const finding = rows[0];
      assert.ok(finding !== undefined);
      assert.ok(finding.resolved_at !== null);
      assert.equal(finding.resolution_action, "dismissed");
    });

    // The duplicate goes away: the row stays closed and the detector does
    // not rewrite dismissed history.
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { Path: "/media/shared.mkv" }),
      movieFixture("m-2", { Path: "/media/unique.mkv" })
    ]);
    await runSync(fixture, "full", tick(60_000));
    const healed = await withReviewPool((pool) => runDetectors(pool, tick(1000), () => {}));
    assert.equal(healed.duplicatePathFindings, 0);
    assert.equal(healed.recorded, 0, "dismissed rows are never rewritten by the detector");
  });

  it("closes stale detector findings once the catalog heals", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [LIBRARIES[0] as JellyfinLibraryRaw];
    fixture.items.set("lib-movies", [movieFixture("m-1", { Path: "/media/shared.mkv" })]);
    await runSync(fixture, "full", tick(0));
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { Path: "/media/shared.mkv" }),
      movieFixture("m-2", { Path: "/media/shared.mkv" })
    ]);
    await runSync(fixture, "full", tick(60_000));
    await withReviewPool((pool) => runDetectors(pool, tick(1000), () => {}));

    fixture.items.set("lib-movies", [
      movieFixture("m-1", { Path: "/media/shared.mkv" }),
      movieFixture("m-2", { Path: "/media/unique.mkv" })
    ]);
    await runSync(fixture, "full", tick(60_000));
    const healed = await withReviewPool((pool) => runDetectors(pool, tick(1000), () => {}));
    assert.equal(healed.closed, 1);
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const rows = await quarantineRows(client, "reason = 'duplicate_path'");
      const finding = rows[0];
      assert.ok(finding !== undefined);
      assert.ok(finding.resolved_at !== null, "an automatic close sets only resolved_at");
      assert.equal(finding.resolution_action, null);
    });
  });

  it("records renamed_identity when a missing item's path reappears on a new id", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [LIBRARIES[0] as JellyfinLibraryRaw];
    fixture.items.set("lib-movies", [movieFixture("m-5", { Path: "/media/moved.mkv" })]);
    await runSync(fixture, "full", tick(0));

    // m-5 leaves; the next full scan marks it missing.
    fixture.items.set("lib-movies", [movieFixture("m-1", { Path: "/media/other.mkv" })]);
    await runSync(fixture, "full", tick(60_000));
    // A brand-new id shows up on the same file path.
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { Path: "/media/other.mkv" }),
      movieFixture("m-6", { Path: "/media/moved.mkv" })
    ]);
    await runSync(fixture, "full", tick(60_000));

    const result = await withReviewPool((pool) => runDetectors(pool, tick(1000), () => {}));
    assert.equal(result.renamedIdentityFindings, 1);
    assert.equal(result.duplicatePathFindings, 0, "a missing item is a rename candidate, not a duplicate");

    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const rows = await quarantineRows(client, "reason = 'renamed_identity'");
      assert.equal(rows.length, 1);
      const finding = rows[0];
      assert.ok(finding !== undefined);
      assert.equal(finding.external_id, "m-5", "the old identity is reported, never rewritten");
      assert.deepEqual(finding.detail, {
        path: "/media/moved.mkv",
        successorExternalId: "m-6",
        successorObservedAt: new Date(T0.getTime() + 120_000).toISOString(),
        missingSince: new Date(T0.getTime() + 60_000).toISOString(),
        retiredAt: null
      });
      assert.equal(finding.resolved_at, null);
    });
  });

  it("re-opens a reviewed entry when the conflict re-detected is still real", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [LIBRARIES[0] as JellyfinLibraryRaw];
    fixture.items.set("lib-movies", [movieFixture("m-1", { Path: "/media/shared.mkv" })]);
    await runSync(fixture, "full", tick(0));
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { Path: "/media/shared.mkv" }),
      movieFixture("m-2", { Path: "/media/shared.mkv" })
    ]);
    await runSync(fixture, "full", tick(60_000));
    await withReviewPool((pool) => runDetectors(pool, tick(1000), () => {}));
    const [entry] = await withReviewPool((pool) => listQuarantine(pool, { status: "open", reason: null, limit: 10 }));
    assert.ok(entry !== undefined);
    await withReviewPool((pool) =>
      resolveQuarantine(pool, entry.id, { action: "source_fixed", note: "upstream says fixed", by: "alex" }, tick(1000))
    );

    // The conflict is still real: re-detection re-opens and clears the stale
    // operator verdict rather than letting it masquerade as health.
    const again = await withReviewPool((pool) => runDetectors(pool, tick(1000), () => {}));
    assert.equal(again.recorded, 1, "the resolved entry is re-opened");
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const rows = await quarantineRows(client, "reason = 'duplicate_path'");
      const finding = rows[0];
      assert.ok(finding !== undefined);
      assert.equal(finding.resolved_at, null);
      assert.equal(finding.resolution_action, null);
      assert.equal(finding.resolution_note, null);
      assert.equal(finding.resolved_by, null);
    });
  });

  it("remaps a provider id and the sync then enforces the decision deterministically", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [LIBRARIES[0] as JellyfinLibraryRaw];
    fixture.items.set("lib-movies", [movieFixture("m-1", { ProviderIds: { Imdb: "tt111" } })]);
    await runSync(fixture, "full", tick(0));
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { ProviderIds: { Imdb: "tt111" } }),
      movieFixture("m-3", { ProviderIds: { Imdb: "tt111" }, Name: "Impostor" })
    ]);
    await runSync(fixture, "full", tick(60_000));

    const result = await withReviewPool((pool) =>
      remapProviderClaim(pool, { provider: "imdb", value: "tt111", canonicalExternalId: "m-1", note: "m-1 is the real one", by: "alex" }, tick(1000))
    );
    assert.equal(result.override.canonicalExternalId, "m-1");
    assert.equal(result.resolvedEntries, 1);

    // The challenger keeps claiming the id: the next scan quarantines it by
    // override decision, not by first-writer luck, and the entry re-opens.
    await runSync(fixture, "full", tick(60_000));
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const rows = await quarantineRows(client, "reason = 'duplicate_provider_id' AND resolved_at IS NULL");
      assert.equal(rows.length, 1);
      const finding = rows[0];
      assert.ok(finding !== undefined);
      assert.equal(finding.external_id, "m-3");
      assert.deepEqual([finding.detail.heldBy, finding.detail.viaOverride], ["m-1", true]);
      const overrides = await client.query("SELECT count(*)::int AS n FROM catalog_identity_override");
      assert.equal(overrides.rows[0].n, 1);
    });

    // The challenger gets its own identity back and syncs; the decision stays.
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { ProviderIds: { Imdb: "tt111" } }),
      movieFixture("m-3", { ProviderIds: { Imdb: "tt333" }, Name: "Impostor" })
    ]);
    const healed = await runSync(fixture, "full", tick(60_000));
    assert.equal(healed.counts.itemsUpserted, 1);
    await withReviewPool(async (pool) => {
      const overrides = await listOverrides(pool, 10);
      assert.equal(overrides.length, 1);
      assert.equal(overrides[0]?.provider, "imdb");
    });
  });

  it("a dismissed sync finding still re-opens when the sync sees the conflict again", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [LIBRARIES[0] as JellyfinLibraryRaw];
    fixture.items.set("lib-movies", [movieFixture("m-1", { ProviderIds: { Imdb: "tt111" } })]);
    await runSync(fixture, "full", tick(0));
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { ProviderIds: { Imdb: "tt111" } }),
      movieFixture("m-3", { ProviderIds: { Imdb: "tt111" }, Name: "Impostor" })
    ]);
    await runSync(fixture, "full", tick(60_000));
    const [entry] = await withReviewPool((pool) => listQuarantine(pool, { status: "open", reason: null, limit: 10 }));
    assert.ok(entry !== undefined);
    await withReviewPool((pool) =>
      resolveQuarantine(pool, entry.id, { action: "dismissed", note: "will watch it", by: "alex" }, tick(1000))
    );

    // Sync-owned reasons re-open on re-detection: the sync cannot know what
    // a dismissal meant, so it keeps reporting until reality changes.
    await runSync(fixture, "full", tick(60_000));
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const rows = await quarantineRows(client, "external_id = 'm-3'");
      const finding = rows[0];
      assert.ok(finding !== undefined);
      assert.equal(finding.resolved_at, null);
      assert.equal(finding.resolution_action, null);
    });
  });

  it("pins an item to a library, applies the sanctioned move, and enforces the pin", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = LIBRARIES;
    fixture.items.set("lib-movies", [movieFixture("m-1")]);
    fixture.items.set("lib-tv", []);
    await runSync(fixture, "full", tick(0));

    // A second library claims m-1: library_conflict.
    fixture.items.set("lib-tv", [movieFixture("m-1", { Name: "Duplicate Claim" })]);
    await runSync(fixture, "full", tick(60_000));
    const [entry] = await withReviewPool((pool) => listQuarantine(pool, { status: "open", reason: null, limit: 10 }));
    assert.ok(entry !== undefined);
    assert.equal(entry.reason, "library_conflict");

    const result = await withReviewPool((pool) =>
      pinLibrary(pool, { externalId: "m-1", libraryExternalId: "lib-tv", note: "moved on purpose", by: "alex" }, tick(1000))
    );
    assert.equal(result.resolvedEntries, 1);

    // The claimed library is now the sanctioned one: with the item only
    // streaming from there, the scan moves it without a conflict.
    fixture.items.set("lib-movies", []);
    fixture.items.set("lib-tv", [movieFixture("m-1", { Name: "Duplicate Claim" })]);
    const moved = await runSync(fixture, "full", tick(60_000));
    assert.equal(moved.counts.itemsQuarantined, 0);
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const row = await itemRow(client, "m-1");
      assert.ok(row !== null);
      const libTv = await client.query("SELECT id FROM catalog_library WHERE external_id = 'lib-tv'");
      assert.equal(row.library_id, (libTv.rows[0] as { id: string }).id, "the sanctioned move is applied");
    });

    // Back in the old library: quarantined with the pin as evidence.
    fixture.items.set("lib-tv", []);
    fixture.items.set("lib-movies", [movieFixture("m-1")]);
    await runSync(fixture, "full", tick(60_000));
    await withClient(CATALOG_DATABASE_URL, async (client) => {
      const rows = await quarantineRows(client, "reason = 'library_conflict' AND resolved_at IS NULL");
      assert.equal(rows.length, 1);
      const finding = rows[0];
      assert.ok(finding !== undefined);
      assert.deepEqual([finding.detail.pinnedToLibrary, finding.detail.viaOverride], ["lib-tv", true]);
    });

    // Retracting the pin removes the enforcement: the item syncs again from
    // the library that holds it, and no new conflict is raised.
    const [override] = await withReviewPool((pool) => listOverrides(pool, 10));
    assert.ok(override !== undefined);
    await withReviewPool((pool) => removeOverride(pool, override.id));
    fixture.items.set("lib-movies", []);
    fixture.items.set("lib-tv", [movieFixture("m-1")]);
    await runSync(fixture, "full", tick(60_000));
    const after = await withReviewPool((pool) => listQuarantine(pool, { status: "open", reason: "library_conflict", limit: 10 }));
    assert.equal(after.length, 0, "the sync's own judgment resumes once the pin is gone");
  });

  it("preserves identity overrides across a rebuild while quarantine content wipes", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [LIBRARIES[0] as JellyfinLibraryRaw];
    fixture.items.set("lib-movies", [movieFixture("m-1", { ProviderIds: { Imdb: "tt111" } })]);
    await runSync(fixture, "full", tick(0));
    const remapped = await withReviewPool((pool) =>
      remapProviderClaim(pool, { provider: "imdb", value: "tt111", canonicalExternalId: "m-1", note: null, by: "alex" }, tick(1000))
    );
    assert.equal(remapped.override.canonicalExternalId, "m-1");

    // The decision is enforced immediately: a challenger quarantines by
    // override, not by first-writer luck.
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { ProviderIds: { Imdb: "tt111" } }),
      movieFixture("m-3", { ProviderIds: { Imdb: "tt111" }, Name: "Impostor" })
    ]);
    await runSync(fixture, "full", tick(60_000));
    const before = await withReviewPool((pool) => listQuarantine(pool, { status: "open", reason: "duplicate_provider_id", limit: 10 }));
    assert.equal(before.length, 1);

    // The rebuild wipes quarantine content but keeps the operator decision.
    fixture.items.set("lib-movies", [movieFixture("m-1", { ProviderIds: { Imdb: "tt111" } })]);
    await runSync(fixture, "rebuild", tick(60_000));
    await withReviewPool(async (pool) => {
      const overrides = await listOverrides(pool, 10);
      assert.equal(overrides.length, 1, "operator identity decisions survive a rebuild");
      const leftovers = await listQuarantine(pool, { status: "all", reason: null, limit: 10 });
      assert.equal(leftovers.length, 0, "the rebuild cleared quarantine history");
    });

    // And the surviving decision is still enforced on the next scan.
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { ProviderIds: { Imdb: "tt111" } }),
      movieFixture("m-3", { ProviderIds: { Imdb: "tt111" }, Name: "Impostor" })
    ]);
    await runSync(fixture, "full", tick(60_000));
    const enforced = await withReviewPool((pool) => listQuarantine(pool, { status: "open", reason: null, limit: 10 }));
    assert.equal(enforced.length, 1);
    assert.equal(enforced[0]?.externalId, "m-3");
    assert.deepEqual([enforced[0]?.detail.viaOverride, enforced[0]?.detail.heldBy], [true, "m-1"]);
  });

  it("reports weak identity for movies and series without provider ids only", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = LIBRARIES;
    fixture.items.set("lib-movies", [
      movieFixture("m-1", { ProviderIds: {} }),
      movieFixture("m-2", { Path: "/media/m-2.mkv" })
    ]);
    fixture.items.set("lib-tv", [
      { Id: "se-1", Name: "Identity Show", Type: "Series", DateLastSaved: T0.toISOString() },
      { Id: "ep-1", Name: "Pilot", Type: "Episode", SeriesId: "se-1", DateLastSaved: T0.toISOString() }
    ]);
    await runSync(fixture, "full", tick(0));

    const weak = await withReviewPool((pool) => listWeakIdentity(pool, 100));
    const ids = weak.map((entry) => entry.externalId);
    assert.deepEqual(ids.sort(), ["m-1", "se-1"], "episodes inherit identity from parents and are not reported");
  });

  it("fails closed on unknown references and invalid filters", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [LIBRARIES[0] as JellyfinLibraryRaw];
    fixture.items.set("lib-movies", [movieFixture("m-1")]);
    await runSync(fixture, "full", tick(0));

    await withReviewPool(async (pool) => {
      await assert.rejects(
        resolveQuarantine(pool, "018f4d3e-7c1a-7cc2-9d3e-2f5a6b7c8d9e", { action: "dismissed", note: null, by: "alex" }, tick(1000)),
        /No quarantine entry/
      );
      await assert.rejects(
        remapProviderClaim(pool, { provider: "imdb", value: "tt999", canonicalExternalId: "ghost", note: null, by: "alex" }, tick(1000)),
        /no catalog item with external id ghost/
      );
      await assert.rejects(
        pinLibrary(pool, { externalId: "m-1", libraryExternalId: "lib-ghost", note: null, by: "alex" }, tick(1000)),
        /no catalog library with external id lib-ghost/
      );
      await assert.rejects(
        // Runtime filter validation: the type system is bypassed on purpose.
        listQuarantine(pool, { status: "open", reason: "made_up" as QuarantineReason, limit: 10 }),
        /Invalid quarantine reason filter/
      );
      await assert.rejects(
        removeOverride(pool, "018f4d3e-7c1a-7cc2-9d3e-2f5a6b7c8d9e"),
        /No identity override/
      );
    });
  });

  it("enforces schema guards on resolution shape and override shape", async () => {
    const fixture = new FixtureJellyfin();
    fixture.libraries = [LIBRARIES[0] as JellyfinLibraryRaw];
    fixture.items.set("lib-movies", [movieFixture("m-1")]);
    await runSync(fixture, "full", tick(0));

    await withClient(CATALOG_DATABASE_URL, async (client) => {
      await assert.rejects(
        client.query(
          "INSERT INTO catalog_quarantine (source, external_id, reason, resolved_at, resolution_action, resolved_by) VALUES ('jellyfin', 'x-shape', 'duplicate_path', now(), 'dismissed', NULL)"
        ),
        /catalog_quarantine_resolution_shape/
      );
      await assert.rejects(
        client.query(
          "INSERT INTO catalog_quarantine (source, external_id, reason, resolution_action) VALUES ('jellyfin', 'x-shape2', 'duplicate_path', 'made_up')"
        ),
        /catalog_quarantine_resolution_action_check/
      );
      await assert.rejects(
        client.query(
          "INSERT INTO catalog_identity_override (source, kind, provider, external_value, external_id, canonical_external_id, reason, created_by) VALUES ('jellyfin', 'provider_claim', 'imdb', 'tt1', 'm-1', 'm-1', 'why', 'alex')"
        ),
        /catalog_identity_override_provider_claim_shape/
      );
      await assert.rejects(
        client.query(
          "INSERT INTO catalog_identity_override (source, kind, external_id, canonical_external_id, reason, created_by) VALUES ('jellyfin', 'library_pin', 'm-1', 'm-1', 'why', 'alex')"
        ),
        /catalog_identity_override_no_self_pin/
      );
      await client.query(
        "INSERT INTO catalog_identity_override (source, kind, provider, external_value, canonical_external_id, reason, created_by) VALUES ('jellyfin', 'provider_claim', 'imdb', 'tt1', 'm-1', 'why', 'alex')"
      );
      await assert.rejects(
        client.query(
          "INSERT INTO catalog_identity_override (source, kind, provider, external_value, canonical_external_id, reason, created_by) VALUES ('jellyfin', 'provider_claim', 'imdb', 'tt1', 'm-2', 'why again', 'bob')"
        ),
        /catalog_identity_override_provider_claim_uidx/,
        "one decision per contested provider id"
      );
    });
  });

  it("verifyReviewSchema names the missing review surface", async () => {
    const empty = await openCatalogReviewSession({
      [CATALOG_URL_VAR]: "postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_catalog_review_empty"
    });
    try {
      await withClient(TEST_DATABASE_URL, async () => {});
      await createDatabaseIfMissing(TEST_DATABASE_URL, "reelhouse_catalog_review_empty");
      await assert.rejects(verifyReviewSchema(empty.pool), /catalog:migrate/);
    } finally {
      await closeCatalogReviewSession(empty);
    }
  });
});
