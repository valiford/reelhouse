// Jellyfin -> media_catalog synchronization engine.
//
// Design (docs/CATALOG_SYNC.md, RH-0016):
// - Identity is (source, external_id); content changes are detected by a
//   canonical fingerprint, so re-syncing unchanged data updates nothing but
//   last_seen_at. Jellyfin is read exclusively through its API.
// - A library is consumed in kind passes (roots -> seasons -> episodes) so a
//   parent row exists before a child is written; a child whose parent row is
//   genuinely absent, an item claimed by two libraries, and items contesting
//   a provider id are QUARANTINED, never merged.
// - Retirement is non-destructive and full-scan-only: missing_since first,
//   retired_at once the policy threshold is met, restored in place on
//   reappearance. Incremental scans (MinDateLastSaved cursor) never retire.
// - Rebuild wipes catalog content in THIS database only and re-reads
//   everything; Jellyfin is never modified.
// - Failure is bounded and redacted: pagination/library-size caps, per-page
//   transactions (completed pages stay committed; a rerun is idempotent),
//   scan rows record outcomes, and every stored or rethrown error is scrubbed
//   of the database URL and truncated.
//
// Like migrator.ts this module avoids `server-only`/aliases so the CLI
// (scripts/catalog-sync.ts) and tests import it under plain Node.

import { Pool } from "pg";
import { redactError } from "../db/config.ts";
import {
  CATALOG_URL_VAR,
  describeCatalogDatabaseConfig,
  loadCatalogDatabaseConfig,
  loadCatalogSyncPolicy,
  type CatalogSyncPolicy
} from "./config.ts";
import type { JellyfinCatalogClient } from "./jellyfin-client.ts";
import { SYNC_QUARANTINE_REASONS } from "./review.ts";
import {
  KIND_RANK,
  mapJellyfinItem,
  mapJellyfinLibrary,
  nameKey,
  type CatalogItemModel,
  type CatalogKind,
  type CatalogLibraryModel
} from "./model.ts";

export const CATALOG_SYNC_JOB = "jellyfin_catalog";

export type CatalogSyncMode = "incremental" | "full" | "rebuild";

export interface CatalogSyncOptions {
  env: Record<string, string | undefined>;
  client: JellyfinCatalogClient;
  mode: CatalogSyncMode;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface CatalogSyncCounts {
  librariesSeen: number;
  itemsSeen: number;
  itemsUpserted: number;
  itemsUnchanged: number;
  itemsMissing: number;
  itemsRetired: number;
  itemsQuarantined: number;
  itemsSkipped: number;
}

export interface CatalogSyncResult {
  scanId: string;
  mode: CatalogSyncMode;
  status: "succeeded";
  counts: CatalogSyncCounts;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  catalogSummary: string;
}

type Counts = Record<keyof CatalogSyncCounts, number>;

function zeroCounts(): Counts {
  return {
    librariesSeen: 0,
    itemsSeen: 0,
    itemsUpserted: 0,
    itemsUnchanged: 0,
    itemsMissing: 0,
    itemsRetired: 0,
    itemsQuarantined: 0,
    itemsSkipped: 0
  };
}

const ERROR_DETAIL_CAP = 2000;

function boundErrorDetail(message: string): string {
  return message.length <= ERROR_DETAIL_CAP ? message : `${message.slice(0, ERROR_DETAIL_CAP)}…(truncated)`;
}

async function one<T extends { [key: string]: unknown }>(pool: Pool, sql: string, params: unknown[]): Promise<T> {
  const result = await pool.query<T>(sql, params);
  if (result.rows.length === 0) throw new Error("Expected a row from the database but none was returned");
  return result.rows[0];
}

// Kind passes over one library, parents strictly before children.
const LIBRARY_PASSES: Array<{ includeTypes: string[]; kinds: CatalogKind[] }> = [
  { includeTypes: ["Series", "Movie"], kinds: ["series", "movie"] },
  { includeTypes: ["Season"], kinds: ["season"] },
  { includeTypes: ["Episode"], kinds: ["episode"] }
];

export async function runCatalogSync(options: CatalogSyncOptions): Promise<CatalogSyncResult> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());

  const configResult = loadCatalogDatabaseConfig(options.env);
  if (configResult.kind === "unconfigured") {
    throw new Error(`No media_catalog database configured: set ${CATALOG_URL_VAR} and retry`);
  }
  if (configResult.kind === "invalid") {
    throw new Error(`media_catalog configuration is invalid and was rejected: ${configResult.errors.join("; ")}`);
  }
  const config = configResult.config;

  const policyResult = loadCatalogSyncPolicy(options.env);
  if (policyResult.kind === "invalid") {
    throw new Error(`Catalog sync policy is invalid and was rejected: ${policyResult.errors.join("; ")}`);
  }
  const policy = policyResult.policy;

  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl,
    max: policy.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    statement_timeout: policy.statementTimeoutMs,
    query_timeout: policy.statementTimeoutMs,
    application_name: "reelhouse-catalog-sync"
  });

  const startedAt = now();
  const counts = zeroCounts();
  // External ids successfully observed (written or unchanged) in this run; a
  // second sighting of one id is ambiguous (payloads and passes are disjoint).
  const seenThisRun = new Set<string>();

  try {
    await verifySchema(pool);
    const scan = await one<{ id: string }>(
      pool,
      "INSERT INTO catalog_scan (mode, status, started_at) VALUES ($1, 'running', $2) RETURNING id",
      [options.mode, startedAt]
    );
    log(`Catalog sync (${options.mode}) started against ${describeCatalogDatabaseConfig(config)}`);

    try {
      if (options.mode === "rebuild") {
        await pool.query("BEGIN");
        try {
          // Catalog content only, in this database only. Jellyfin is
          // read-only to this job; the reelhouse database is never touched.
          // catalog_identity_override is deliberately absent: operator
          // identity decisions (RH-0023) survive a rebuild by design.
          await pool.query("TRUNCATE catalog_item, catalog_library, catalog_quarantine, catalog_genre, catalog_studio, catalog_person CASCADE");
          await pool.query(
            "INSERT INTO catalog_sync_state (job, cursor) VALUES ($1, '{}'::jsonb) ON CONFLICT (job) DO UPDATE SET cursor = '{}'::jsonb, last_error = NULL",
            [CATALOG_SYNC_JOB]
          );
          await pool.query("COMMIT");
          log("Rebuild: catalog content cleared (scan history kept)");
        } catch (error) {
          await pool.query("ROLLBACK");
          throw error;
        }
      }

      await ensureSyncStateRow(pool);
      const state = await one<{ cursor: Record<string, unknown> }>(
        pool,
        "SELECT cursor FROM catalog_sync_state WHERE job = $1",
        [CATALOG_SYNC_JOB]
      );
      const cursorLibraries = readCursor(state.cursor);

      const sourceLibraries = await options.client.listLibraries();
      const libraries: Array<{ model: CatalogLibraryModel; id: string }> = [];
      for (const raw of sourceLibraries) {
        const mapped = mapJellyfinLibrary(raw);
        if (mapped.outcome === "skip") {
          counts.itemsSkipped += 1;
          continue;
        }
        if (mapped.outcome === "invalid") {
          counts.itemsQuarantined += 1;
          await quarantineLibrary(pool, mapped.externalId, mapped.reason, startedAt);
          log(`Library ${mapped.externalId} quarantined: ${mapped.reason}`);
          continue;
        }
        const id = await upsertLibrary(pool, mapped.model, startedAt);
        libraries.push({ model: mapped.model, id });
        counts.librariesSeen += 1;
      }
      for (const library of libraries) {
        await syncLibraryItems(pool, options, policy, library, {
          startedAt,
          incrementalSince:
            options.mode === "incremental" ? (cursorLibraries[library.model.externalId]?.since ?? null) : null,
          counts,
          now,
          seenThisRun
        });
      }

      if (options.mode !== "incremental") {
        // Non-destructive retirement, full scans only. Two statements on
        // purpose: all statements in one SQL command share one snapshot, so
        // rows just marked missing here must not also retire in the same
        // breath (they cannot be past the threshold yet anyway).
        const missing = await pool.query<{ newly_missing: string }>(
          `WITH missing AS (
             UPDATE catalog_item
                SET missing_since = COALESCE(missing_since, $1)
              WHERE retired_at IS NULL AND missing_since IS NULL AND last_seen_at < $1
              RETURNING 1
           )
           SELECT count(*)::text AS newly_missing FROM missing`,
          [startedAt]
        );
        const retired = await pool.query<{ newly_retired: string }>(
          `WITH retired AS (
             UPDATE catalog_item
                SET retired_at = $1::timestamptz
              WHERE retired_at IS NULL
                AND missing_since IS NOT NULL
                AND missing_since <= $1::timestamptz - ($2::bigint * interval '1 millisecond')
              RETURNING 1
           )
           SELECT count(*)::text AS newly_retired FROM retired`,
          [now(), policy.retirementAfterMs]
        );
        counts.itemsMissing += Number(missing.rows[0].newly_missing);
        counts.itemsRetired += Number(retired.rows[0].newly_retired);

        // Libraries go through the same machine; their counts are visible in
        // catalog_library and the log rather than the scan row.
        const libraryMissing = await pool.query<{ newly_missing: string }>(
          `WITH missing AS (
             UPDATE catalog_library
                SET missing_since = COALESCE(missing_since, $1)
              WHERE retired_at IS NULL AND missing_since IS NULL AND last_seen_at < $1
              RETURNING 1
           )
           SELECT count(*)::text AS newly_missing FROM missing`,
          [startedAt]
        );
        const libraryRetired = await pool.query<{ newly_retired: string }>(
          `WITH retired AS (
             UPDATE catalog_library
                SET retired_at = $1::timestamptz
              WHERE retired_at IS NULL
                AND missing_since IS NOT NULL
                AND missing_since <= $1::timestamptz - ($2::bigint * interval '1 millisecond')
              RETURNING 1
           )
           SELECT count(*)::text AS newly_retired FROM retired`,
          [now(), policy.retirementAfterMs]
        );
        if (Number(libraryMissing.rows[0].newly_missing) > 0 || Number(libraryRetired.rows[0].newly_retired) > 0) {
          log(
            `Library retirement: ${libraryMissing.rows[0].newly_missing} newly missing, ` +
              `${libraryRetired.rows[0].newly_retired} newly retired`
          );
        }
      }

      const nextCursor = {
        libraries: Object.fromEntries(
          libraries.map((library) => [library.model.externalId, { since: startedAt.toISOString() }])
        )
      };
      await pool.query(
        "UPDATE catalog_sync_state SET cursor = $2::jsonb, last_started_at = $3, last_succeeded_at = $3, last_error = NULL WHERE job = $1",
        [CATALOG_SYNC_JOB, JSON.stringify(nextCursor), startedAt]
      );

      const finishedAt = now();
      await pool.query(
        `UPDATE catalog_scan
            SET status = 'succeeded', finished_at = $2, libraries_seen = $3, items_seen = $4,
                items_upserted = $5, items_unchanged = $6, items_missing = $7, items_retired = $8,
                items_quarantined = $9, items_skipped = $10
          WHERE id = $1`,
        [
          scan.id,
          finishedAt,
          counts.librariesSeen,
          counts.itemsSeen,
          counts.itemsUpserted,
          counts.itemsUnchanged,
          counts.itemsMissing,
          counts.itemsRetired,
          counts.itemsQuarantined,
          counts.itemsSkipped
        ]
      );
      log(
        `Catalog sync succeeded: ${counts.itemsUpserted} upserted, ${counts.itemsUnchanged} unchanged, ` +
          `${counts.itemsMissing} newly missing, ${counts.itemsRetired} newly retired, ` +
          `${counts.itemsQuarantined} quarantined, ${counts.itemsSkipped} skipped`
      );

      return {
        scanId: scan.id,
        mode: options.mode,
        status: "succeeded",
        counts: { ...counts },
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        catalogSummary: describeCatalogDatabaseConfig(config)
      };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const detail = boundErrorDetail(redactError(rawMessage, options.env[CATALOG_URL_VAR]));
      try {
        await pool.query(
          "UPDATE catalog_scan SET status = 'failed', finished_at = $2, error = $3, items_seen = $4, items_upserted = $5, items_quarantined = $6 WHERE id = $1",
          [scan.id, now(), detail, counts.itemsSeen, counts.itemsUpserted, counts.itemsQuarantined]
        );
        await pool.query("UPDATE catalog_sync_state SET last_started_at = $2, last_error = $3 WHERE job = $1", [
          CATALOG_SYNC_JOB,
          startedAt,
          detail
        ]);
      } catch (bookkeepingError) {
        log(`Warning: could not record scan failure details: ${String(bookkeepingError)}`);
      }
      throw new Error(`Catalog sync failed: ${detail}`);
    }
  } finally {
    await pool.end();
  }
}

async function verifySchema(pool: Pool): Promise<void> {
  const required = [
    "catalog_scan",
    "catalog_sync_state",
    "catalog_library",
    "catalog_item",
    "catalog_provider_id",
    "catalog_genre",
    "catalog_studio",
    "catalog_person",
    "catalog_item_genre",
    "catalog_item_studio",
    "catalog_item_person",
    "catalog_quarantine",
    "catalog_identity_override"
  ];
  const result = await pool.query<{ table_name: string; present: boolean }>(
    `SELECT table_name, (to_regclass('public.' || table_name) IS NOT NULL) AS present
       FROM (VALUES ${required.map((table) => `('${table}')`).join(", ")}) AS v(table_name)`
  );
  const missing = required.filter((table) => {
    const row = result.rows.find((entry) => entry.table_name === table);
    return row === undefined || !row.present;
  });
  if (missing.length > 0) {
    throw new Error(
      `media_catalog schema is missing tables (${missing.join(", ")}); run "npm run catalog:migrate" first and retry`
    );
  }
}

async function ensureSyncStateRow(pool: Pool): Promise<void> {
  await pool.query("INSERT INTO catalog_sync_state (job) VALUES ($1) ON CONFLICT (job) DO NOTHING", [CATALOG_SYNC_JOB]);
}

interface CursorLibraryState {
  since?: string;
}

function readCursor(cursor: Record<string, unknown>): Record<string, CursorLibraryState> {
  const libraries = cursor.libraries;
  if (typeof libraries !== "object" || libraries === null) return {};
  const out: Record<string, CursorLibraryState> = {};
  for (const [key, value] of Object.entries(libraries as Record<string, unknown>)) {
    if (typeof value === "object" && value !== null) {
      const since = (value as { since?: unknown }).since;
      if (typeof since === "string") out[key] = { since };
    }
  }
  return out;
}

async function upsertLibrary(pool: Pool, model: CatalogLibraryModel, seenAt: Date): Promise<string> {
  const existing = await pool.query<{ id: string; content_hash: string; needs_restore: boolean }>(
    "SELECT id, content_hash, (missing_since IS NOT NULL OR retired_at IS NOT NULL) AS needs_restore FROM catalog_library WHERE source = $1 AND external_id = $2",
    [model.source, model.externalId]
  );
  const row = existing.rows[0];
  if (row === undefined) {
    const inserted = await one<{ id: string }>(
      pool,
      `INSERT INTO catalog_library (source, external_id, name, collection_type, primary_image_tag, content_hash, observed_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
      [model.source, model.externalId, model.name, model.collectionType, model.primaryImageTag, model.contentHash, seenAt]
    );
    return inserted.id;
  }
  if (row.content_hash === model.contentHash && !row.needs_restore) {
    // Fresh, unchanged sighting: only freshness moves, and only if it has not
    // already been bumped by this run (idempotent repeats stay quiet).
    await pool.query("UPDATE catalog_library SET last_seen_at = $2 WHERE id = $1 AND last_seen_at <> $2", [row.id, seenAt]);
    return row.id;
  }
  await pool.query(
    `UPDATE catalog_library
        SET name = $3, collection_type = $4, primary_image_tag = $5, content_hash = $6,
            last_seen_at = $7, missing_since = NULL, retired_at = NULL
      WHERE id = $2`,
    [row.id, model.name, model.collectionType, model.primaryImageTag, model.contentHash, seenAt]
  );
  return row.id;
}

async function quarantineLibrary(
  pool: Pool,
  externalId: string,
  reason: string,
  at: Date
): Promise<void> {
  await pool.query(
    `INSERT INTO catalog_quarantine (source, external_id, reason, detail, payload, first_detected_at, last_detected_at)
     VALUES ('jellyfin', $1, 'invalid_item', $2::jsonb, '{}'::jsonb, $3, $3)
     ON CONFLICT (source, external_id, reason) DO UPDATE
       SET detail = EXCLUDED.detail, last_detected_at = EXCLUDED.last_detected_at, resolved_at = NULL,
           resolution_action = NULL, resolution_note = NULL, resolved_by = NULL`,
    [externalId, JSON.stringify({ reason, entity: "library" }), at]
  );
}

interface SyncLibraryContext {
  startedAt: Date;
  incrementalSince: string | null;
  counts: Counts;
  now: () => Date;
  seenThisRun: Set<string>;
}

async function syncLibraryItems(
  pool: Pool,
  options: CatalogSyncOptions,
  policy: CatalogSyncPolicy,
  library: { model: CatalogLibraryModel; id: string },
  context: SyncLibraryContext
): Promise<void> {
  // Provider-id ownership known so far in this run (first writer wins).
  const claimedProviders = new Map<string, string>();
  // Taxonomy caches shared by every page of the library.
  const genreIds = new Map<string, string>();
  const studioIds = new Map<string, string>();
  const personIds = new Map<string, string>();

  for (const pass of LIBRARY_PASSES) {
    let startIndex = 0;
    let pagesFetched = 0;
    for (;;) {
      if (startIndex >= policy.maxItemsPerLibrary) {
        throw new Error(
          `Library "${library.model.name}" (${library.model.externalId}) reports at least ${startIndex} items, ` +
            `above the ${policy.maxItemsPerLibrary} limit; refusing to truncate the catalog silently`
        );
      }
      if (pagesFetched >= policy.maxPagesPerLibrary) {
        throw new Error(
          `Library "${library.model.name}" (${library.model.externalId}) exceeded ${policy.maxPagesPerLibrary} pages; ` +
            `refusing to truncate the catalog silently`
        );
      }
      const page = await options.client.listItemPage(library.model.externalId, {
        startIndex,
        limit: policy.pageSize,
        includeTypes: pass.includeTypes,
        updatedSince: context.incrementalSince ?? undefined
      });
      pagesFetched += 1;
      context.counts.itemsSeen += page.items.length;

      const mapped = page.items.map(mapJellyfinItem);
      await processPage(pool, library, mapped, pass.kinds, context, {
        claimedProviders,
        genreIds,
        studioIds,
        personIds
      });

      startIndex += page.items.length;
      if (page.items.length < policy.pageSize) break;
    }
  }
}

interface PageCaches {
  claimedProviders: Map<string, string>;
  genreIds: Map<string, string>;
  studioIds: Map<string, string>;
  personIds: Map<string, string>;
}

async function processPage(
  pool: Pool,
  library: { model: CatalogLibraryModel; id: string },
  mapped: Array<ReturnType<typeof mapJellyfinItem>>,
  allowedKinds: CatalogKind[],
  context: SyncLibraryContext,
  caches: PageCaches
): Promise<void> {
  const { counts, seenThisRun } = context;
  const at = context.now();

  const models: CatalogItemModel[] = [];
  for (const entry of mapped) {
    if (entry.outcome === "skip") {
      counts.itemsSkipped += 1;
      continue;
    }
    if (entry.outcome === "invalid") {
      counts.itemsQuarantined += 1;
      await quarantine(
        pool,
        entry.externalId,
        "invalid_item",
        { reason: entry.reason },
        {},
        at
      );
      continue;
    }
    if (!allowedKinds.includes(entry.model.kind)) continue; // another pass owns it
    models.push(entry.model);
  }
  if (models.length === 0) return;

  // One transaction per page: a failed page commits nothing; succeeded pages
  // stay committed and reruns are idempotent.
  await pool.query("BEGIN");
  try {
    const externalIds = models.map((model) => model.externalId);
    const parentIds = [...new Set(models.filter((model) => model.parentExternalId !== null).map((model) => model.parentExternalId as string))];
    const existingRows = await pool.query<{
      id: string;
      external_id: string;
      content_hash: string;
      library_id: string;
    }>(
      "SELECT id, external_id, content_hash, library_id FROM catalog_item WHERE source = 'jellyfin' AND external_id = ANY($1::text[])",
      [externalIds]
    );
    const existingByExternalId = new Map(existingRows.rows.map((row) => [row.external_id, row]));
    const parentRows =
      parentIds.length > 0
        ? await pool.query<{ external_id: string; kind: string }>(
            "SELECT external_id, kind FROM catalog_item WHERE source = 'jellyfin' AND external_id = ANY($1::text[])",
            [parentIds]
          )
        : { rows: [] as Array<{ external_id: string; kind: string }> };
    const parentsByExternalId = new Map(parentRows.rows.map((row) => [row.external_id, row.kind]));

    const dbProviderOwners = await providerOwners(pool, models);
    for (const [key, owner] of dbProviderOwners) {
      if (!caches.claimedProviders.has(key)) caches.claimedProviders.set(key, owner);
    }
    // Operator identity decisions (RH-0023) take precedence over every
    // heuristic below: they are the reviewed answer to an earlier conflict.
    const providerDecisions = await loadProviderOverrides(pool, models);
    const libraryDecisions = await loadLibraryPins(pool, models.map((model) => model.externalId));

    const pending: CatalogItemModel[] = [];
    // Ids already queued from this same page: a payload repeating one id is
    // ambiguous (the second copy must quarantine, not race the first write).
    const queuedInBatch = new Set<string>();
    for (const model of models) {
      let verdict = classifyAmbiguity(
        model,
        { id: library.id, externalId: library.model.externalId },
        existingByExternalId.get(model.externalId),
        caches.claimedProviders,
        seenThisRun,
        providerDecisions,
        libraryDecisions
      );
      if (verdict === null && queuedInBatch.has(model.externalId)) {
        verdict = { reason: "duplicate_external_id", detail: { externalId: model.externalId, seenEarlierInBatch: true } };
      }
      if (verdict === null && model.parentExternalId !== null) {
        const foundParentKind = parentsByExternalId.get(model.parentExternalId);
        if (foundParentKind === undefined || foundParentKind !== model.parentKind) {
          verdict = {
            reason: "orphan_parent",
            detail: {
              parentExternalId: model.parentExternalId,
              expectedParentKind: model.parentKind,
              foundParentKind: foundParentKind ?? null
            }
          };
        }
      }
      if (verdict !== null) {
        counts.itemsQuarantined += 1;
        await quarantine(pool, model.externalId, verdict.reason, verdict.detail, model, at);
        continue;
      }
      // First writer wins for provider ids within a run.
      for (const providerId of model.providerIds) {
        caches.claimedProviders.set(`${providerId.provider}\u0000${providerId.value}`, model.externalId);
      }
      queuedInBatch.add(model.externalId);
      pending.push(model);
    }

    // FK-safe order inside the page (parents first).
    pending.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);

    let batchUpserted = 0;
    let batchUnchanged = 0;
    const writtenExternalIds: string[] = [];
    for (const model of pending) {
      const existing = existingByExternalId.get(model.externalId);
      if (!existing) {
        const id = await insertItem(pool, library.id, model, at);
        await writeRelations(pool, id, model, caches);
        batchUpserted += 1;
        writtenExternalIds.push(model.externalId);
        seenThisRun.add(model.externalId);
        continue;
      }
      if (existing.content_hash === model.contentHash) {
        // library_id moves here too: an operator-pinned item (RH-0023) can
        // legitimately arrive from its new library with unchanged content.
        await pool.query(
          "UPDATE catalog_item SET last_seen_at = $2, missing_since = NULL, retired_at = NULL, library_id = $3 WHERE id = $1 AND (missing_since IS NOT NULL OR retired_at IS NOT NULL OR last_seen_at <> $2 OR library_id <> $3)",
          [existing.id, at, library.id]
        );
        batchUnchanged += 1;
        writtenExternalIds.push(model.externalId);
        seenThisRun.add(model.externalId);
        continue;
      }
      await updateItem(pool, existing.id, library.id, model, at);
      await writeRelations(pool, existing.id, model, caches);
      batchUpserted += 1;
      writtenExternalIds.push(model.externalId);
      seenThisRun.add(model.externalId);
    }

    // A successfully synced item is no longer ambiguous: close any open
    // quarantine records the operator is waiting on. Only sync-owned reasons
    // auto-close here — detector rows (duplicate_path, renamed_identity) are
    // the review workflow's to open and close (RH-0023).
    if (writtenExternalIds.length > 0) {
      await pool.query(
        `UPDATE catalog_quarantine SET resolved_at = $2
          WHERE source = 'jellyfin' AND external_id = ANY($1::text[])
            AND resolved_at IS NULL AND reason = ANY($3::text[])`,
        [writtenExternalIds, at, [...SYNC_QUARANTINE_REASONS]]
      );
    }

    await pool.query("COMMIT");
    counts.itemsUpserted += batchUpserted;
    counts.itemsUnchanged += batchUnchanged;
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

type QuarantineVerdict = {
  reason: "duplicate_provider_id" | "orphan_parent" | "library_conflict" | "duplicate_external_id";
  detail: Record<string, unknown>;
} | null;

function classifyAmbiguity(
  model: CatalogItemModel,
  library: { id: string; externalId: string },
  existing: { library_id: string } | undefined,
  claimedProviders: Map<string, string>,
  seenThisRun: Set<string>,
  providerOverrides: Map<string, string>,
  libraryOverrides: Map<string, string>
): QuarantineVerdict {
  // An operator library pin (RH-0023) decides where this item belongs. A
  // scan from the pinned library is the sanctioned answer — even across an
  // existing row in another library, which becomes an applied move — while a
  // scan from anywhere else is quarantined with the pin as evidence.
  const pinnedLibrary = libraryOverrides.get(model.externalId);
  if (pinnedLibrary !== undefined) {
    if (pinnedLibrary !== library.externalId) {
      return {
        reason: "library_conflict",
        detail: {
          claimedLibraryExternalId: library.externalId,
          existingLibraryId: existing?.library_id ?? null,
          pinnedToLibrary: pinnedLibrary,
          viaOverride: true
        }
      };
    }
  } else if (existing && existing.library_id !== library.id) {
    return {
      reason: "library_conflict",
      detail: { expectedLibraryId: library.id, existingLibraryId: existing.library_id }
    };
  }
  if (seenThisRun.has(model.externalId)) {
    return { reason: "duplicate_external_id", detail: { externalId: model.externalId, seenEarlierInRun: true } };
  }
  for (const providerId of model.providerIds) {
    const key = `${providerId.provider}\u0000${providerId.value}`;
    // An operator remap wins over the run's first-writer ownership.
    const overrideOwner = providerOverrides.get(key);
    const owner = overrideOwner ?? claimedProviders.get(key);
    if (owner !== undefined && owner !== model.externalId) {
      return {
        reason: "duplicate_provider_id",
        detail: {
          provider: providerId.provider,
          value: providerId.value,
          heldBy: owner,
          ...(overrideOwner !== undefined ? { viaOverride: true } : {})
        }
      };
    }
  }
  return null;
}

async function providerOwners(pool: Pool, models: CatalogItemModel[]): Promise<Map<string, string>> {
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const model of models) {
    for (const providerId of model.providerIds) {
      const key = `${providerId.provider}\u0000${providerId.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([providerId.provider, providerId.value]);
    }
  }
  const out = new Map<string, string>();
  if (pairs.length === 0) return out;
  const result = await pool.query<{ provider: string; external_value: string; owner: string }>(
    `SELECT p.provider, p.external_value, ci.external_id AS owner
       FROM catalog_provider_id p
       JOIN catalog_item ci ON ci.id = p.item_id
       JOIN unnest($1::text[], $2::text[]) AS q(provider, external_value)
         ON p.provider = q.provider AND p.external_value = q.external_value`,
    [pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1])]
  );
  for (const row of result.rows) out.set(`${row.provider}\u0000${row.external_value}`, row.owner);
  return out;
}

// Operator provider-id remaps (catalog_identity_override, RH-0023) covering
// this page's provider ids: (provider, value) -> canonical owner external id.
async function loadProviderOverrides(pool: Pool, models: CatalogItemModel[]): Promise<Map<string, string>> {
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const model of models) {
    for (const providerId of model.providerIds) {
      const key = `${providerId.provider}\u0000${providerId.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([providerId.provider, providerId.value]);
    }
  }
  const out = new Map<string, string>();
  if (pairs.length === 0) return out;
  const result = await pool.query<{ provider: string; external_value: string; canonical_external_id: string }>(
    `SELECT o.provider, o.external_value, o.canonical_external_id
       FROM catalog_identity_override o
       JOIN unnest($1::text[], $2::text[]) AS q(provider, external_value)
         ON o.provider = q.provider AND o.external_value = q.external_value
      WHERE o.source = 'jellyfin' AND o.kind = 'provider_claim'`,
    [pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1])]
  );
  for (const row of result.rows) out.set(`${row.provider}\u0000${row.external_value}`, row.canonical_external_id);
  return out;
}

// Operator library pins for this page's items: item external id -> library
// external id.
async function loadLibraryPins(pool: Pool, externalIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (externalIds.length === 0) return out;
  const result = await pool.query<{ external_id: string; canonical_external_id: string }>(
    `SELECT external_id, canonical_external_id
       FROM catalog_identity_override
      WHERE source = 'jellyfin' AND kind = 'library_pin' AND external_id = ANY($1::text[])`,
    [externalIds]
  );
  for (const row of result.rows) out.set(row.external_id, row.canonical_external_id);
  return out;
}

async function quarantine(
  pool: Pool,
  externalId: string,
  reason: "duplicate_provider_id" | "duplicate_external_id" | "orphan_parent" | "invalid_item" | "library_conflict",
  detail: Record<string, unknown>,
  model: CatalogItemModel | Record<string, never>,
  at: Date
): Promise<void> {
  await pool.query(
    `INSERT INTO catalog_quarantine (source, external_id, reason, detail, payload, first_detected_at, last_detected_at)
     VALUES ('jellyfin', $1, $2, $3::jsonb, $4::jsonb, $5, $5)
     ON CONFLICT (source, external_id, reason) DO UPDATE
       SET detail = EXCLUDED.detail,
           payload = EXCLUDED.payload,
           last_detected_at = EXCLUDED.last_detected_at,
           resolved_at = NULL,
           resolution_action = NULL,
           resolution_note = NULL,
           resolved_by = NULL`,
    [externalId, reason, JSON.stringify(detail), JSON.stringify(model), at]
  );
}

async function insertItem(pool: Pool, libraryId: string, model: CatalogItemModel, at: Date): Promise<string> {
  const inserted = await one<{ id: string }>(
    pool,
    `INSERT INTO catalog_item (
       library_id, source, external_id, kind, parent_external_id, name, sort_name, original_title,
       production_year, premiere_date, overview, official_rating, community_rating, runtime_seconds,
       index_number, parent_index_number, path, container, size_bytes, date_created, primary_image_tag,
       source_revision, content_hash, observed_at, last_seen_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $24
     ) RETURNING id`,
    [
      libraryId,
      model.source,
      model.externalId,
      model.kind,
      model.parentExternalId,
      model.name,
      model.sortName,
      model.originalTitle,
      model.productionYear,
      model.premiereDate,
      model.overview,
      model.officialRating,
      model.communityRating,
      model.runtimeSeconds,
      model.indexNumber,
      model.parentIndexNumber,
      model.path,
      model.container,
      model.sizeBytes,
      model.dateCreated,
      model.primaryImageTag,
      model.sourceRevision,
      model.contentHash,
      at
    ]
  );
  return inserted.id;
}

async function updateItem(pool: Pool, id: string, libraryId: string, model: CatalogItemModel, at: Date): Promise<void> {
  await pool.query(
    `UPDATE catalog_item SET
       library_id = $2, kind = $3, parent_external_id = $4, name = $5, sort_name = $6,
       original_title = $7, production_year = $8, premiere_date = $9, overview = $10,
       official_rating = $11, community_rating = $12, runtime_seconds = $13, index_number = $14,
       parent_index_number = $15, path = $16, container = $17, size_bytes = $18, date_created = $19,
       primary_image_tag = $20, source_revision = $21, content_hash = $22,
       last_seen_at = $23, missing_since = NULL, retired_at = NULL
     WHERE id = $1`,
    [
      id,
      libraryId,
      model.kind,
      model.parentExternalId,
      model.name,
      model.sortName,
      model.originalTitle,
      model.productionYear,
      model.premiereDate,
      model.overview,
      model.officialRating,
      model.communityRating,
      model.runtimeSeconds,
      model.indexNumber,
      model.parentIndexNumber,
      model.path,
      model.container,
      model.sizeBytes,
      model.dateCreated,
      model.primaryImageTag,
      model.sourceRevision,
      model.contentHash,
      at
    ]
  );
}

async function writeRelations(pool: Pool, itemId: string, model: CatalogItemModel, caches: PageCaches): Promise<void> {
  // Relations are a function of content: rewritten only when the content hash
  // changed (insert or update), inside the same page transaction.
  await pool.query("DELETE FROM catalog_item_genre WHERE item_id = $1", [itemId]);
  await pool.query("DELETE FROM catalog_item_studio WHERE item_id = $1", [itemId]);
  await pool.query("DELETE FROM catalog_item_person WHERE item_id = $1", [itemId]);
  await pool.query("DELETE FROM catalog_provider_id WHERE item_id = $1", [itemId]);

  for (let index = 0; index < model.genres.length; index += 1) {
    const id = await getOrCreateTaxonomy(pool, caches.genreIds, "catalog_genre", model.genres[index]);
    await pool.query(
      "INSERT INTO catalog_item_genre (item_id, genre_id, list_order) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [itemId, id, index]
    );
  }
  for (let index = 0; index < model.studios.length; index += 1) {
    const id = await getOrCreateTaxonomy(pool, caches.studioIds, "catalog_studio", model.studios[index]);
    await pool.query(
      "INSERT INTO catalog_item_studio (item_id, studio_id, list_order) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [itemId, id, index]
    );
  }
  for (const person of model.people) {
    const id = await getOrCreatePerson(pool, caches.personIds, person.name, person.providerIds);
    await pool.query(
      "INSERT INTO catalog_item_person (item_id, person_id, list_order, role_type, role_name) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
      [itemId, id, person.listOrder, person.roleType, person.roleName]
    );
  }
  for (const providerId of model.providerIds) {
    await pool.query(
      "INSERT INTO catalog_provider_id (item_id, provider, external_value) VALUES ($1, $2, $3) ON CONFLICT (item_id, provider) DO UPDATE SET external_value = EXCLUDED.external_value",
      [itemId, providerId.provider, providerId.value]
    );
  }
}

async function getOrCreateTaxonomy(
  pool: Pool,
  cache: Map<string, string>,
  table: "catalog_genre" | "catalog_studio",
  name: string
): Promise<string> {
  const key = nameKey(name);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const row = await one<{ id: string }>(
    pool,
    `INSERT INTO ${table} (name, name_key) VALUES ($1, $2)
     ON CONFLICT (name_key) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name, key]
  );
  cache.set(key, row.id);
  return row.id;
}

async function getOrCreatePerson(
  pool: Pool,
  cache: Map<string, string>,
  name: string,
  providerIds: Record<string, string>
): Promise<string> {
  const key = nameKey(name);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const row = await one<{ id: string }>(
    pool,
    `INSERT INTO catalog_person (name, name_key, provider_ids) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (name_key) DO UPDATE SET provider_ids = EXCLUDED.provider_ids
     RETURNING id`,
    [name, key, JSON.stringify(providerIds)]
  );
  cache.set(key, row.id);
  return row.id;
}
