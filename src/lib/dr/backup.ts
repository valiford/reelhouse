// Household backup: PostgreSQL household state → checksummed artifact.
//
// Contract (RH-0037):
// - Household state is ReelHouse's only DURABLE data: it exists nowhere but
//   PostgreSQL, so backing it up means capturing a complete household
//   manifest snapshot (the exact contract the household import consumes)
//   plus the integrity record a restore binds to.
// - The capture reads ACTIVE state only (archived profiles/lists, removed
//   entries and tombstoned watch state are not part of the live household),
//   in deterministic order, with canonical UTC timestamps — so backing up an
//   unchanged household twice produces byte-identical manifest content and
//   therefore an identical manifest SHA-256. Artifact provenance (created_at,
//   file checksum) differs; snapshot content does not.
// - Provenance-preserving by construction: the payload carries the
//   first_added_at / first_played_at stamps the loader pins on restore, so
//   capture → restore → capture round-trips to the identical manifest.
// - Fail-closed: the capture validates its own output through the household
//   manifest contract BEFORE any artifact is written — if the loader's
//   schema ever evolves without the capture keeping up, the backup refuses
//   rather than writing an artifact no restore could load.
// - Run provenance: exactly one dr_backup_runs row per attempt, appended
//   like media_sync_runs rows; success records the artifact path, both
//   checksums, byte size, and bounded counts; failure records a scrubbed,
//   bounded detail. The artifact sink is only invoked after capture,
//   validation, and serialization all succeeded.

import type { QueryResultRow } from "pg";
import { normalizeManifest } from "../household/manifest.ts";
import {
  buildHouseholdArtifact,
  formatArtifactFilename,
  serializeArtifact,
  sha256Hex
} from "./artifact.ts";

// Structurally identical to the catalog SyncExecutor and satisfied by
// createPgSyncExecutor; kept local so the DR modules do not depend on
// catalog modules.
export interface DrExecutor {
  query<R extends QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  withTransaction<R>(fn: (tx: DrExecutor) => Promise<R>): Promise<R>;
}

// The household manifest in its INPUT shape — the shape normalizeManifest
// consumes and the shape the artifact format carries. (normalizeManifest's
// OUTPUT is a different normalization — preferences become keyed pairs —
// and is deliberately NOT what an artifact stores: a re-loadable artifact
// must always be in the input shape.)
export interface HouseholdSnapshotManifest {
  profiles: Array<{
    slug: string;
    name: string;
    initials: string | null;
    isDefault: boolean;
    jellyfinUserId: string | null;
    preferences: Record<string, string | number | boolean>;
    favorites: Array<{ jellyfinId: string; addedAt: string | null }>;
    watchlists: Array<{
      slug: string;
      name: string;
      entries: Array<{ jellyfinId: string; addedAt: string | null }>;
    }>;
    homeRows: Array<{
      slug: string;
      kind: string;
      title: string;
      enabled: boolean;
      config: Record<string, string>;
    }>;
    watchState: Array<{
      jellyfinId: string;
      positionTicks: number | null;
      durationTicks: number | null;
      completed: boolean;
      hiddenFromContinue: boolean;
      firstPlayedAt: string | null;
      lastPlayedAt: string | null;
    }>;
    playbackHistory: Array<{
      jellyfinId: string;
      playedAt: string;
      positionTicks: number | null;
      durationTicks: number | null;
      completed: boolean;
    }>;
  }>;
  collections: Array<{
    slug: string;
    name: string;
    description: string | null;
    entries: Array<{ jellyfinId: string; addedAt: string | null }>;
  }>;
}

export interface DrBackupCounts extends Record<string, number> {
  profiles: number;
  preferences: number;
  jellyfinAccounts: number;
  favorites: number;
  watchlists: number;
  watchlistEntries: number;
  collections: number;
  collectionEntries: number;
  homeRows: number;
  watchState: number;
  history: number;
}

export interface HouseholdBackup {
  runId: number;
  status: "succeeded";
  artifactFilename: string;
  artifactPath: string;
  artifactBytes: number;
  artifactSha256: string;
  manifestSha256: string;
  rowsCaptured: number;
  counts: DrBackupCounts;
  manifest: HouseholdSnapshotManifest;
}

export interface DrBackupFailure {
  runId: number;
  status: "failed";
  errorDetail: string;
}

export class DrBackupError extends Error {
  readonly summary: DrBackupFailure;

  constructor(message: string, summary: DrBackupFailure) {
    super(message);
    this.name = "DrBackupError";
    this.summary = summary;
  }
}

export interface HouseholdBackupOptions {
  // Deterministic clock for the artifact's created_at stamp (the ledger
  // rows use the database clock, like every other run history). Defaults to
  // the wall clock; tests inject a fixed one.
  clock?: () => Date;
  // Receives the fully validated artifact content and returns the final
  // path (as the operator should record it) and byte length. The core
  // module never touches the filesystem; the CLI sinks to disk and tests
  // sink to memory.
  sink: (filename: string, content: string) => Promise<{ path: string; bytes: number }>;
}

interface ProfileRow extends QueryResultRow {
  id: string | number;
  slug: string;
  display_name: string;
  initials: string | null;
  is_default: boolean;
}

interface PreferenceRow extends QueryResultRow {
  profile_id: string | number;
  key: string;
  value: string | number | boolean;
}

interface AccountRow extends QueryResultRow {
  profile_id: string | number;
  jellyfin_user_id: string;
}

interface ListRow extends QueryResultRow {
  id: string | number;
  profile_id: string | number;
  slug: string;
  name: string;
}

interface EntryRow extends QueryResultRow {
  owner_id: string | number;
  jellyfin_id: string;
  first_added_at: Date | string;
}

interface ProfileEntryRow extends QueryResultRow {
  profile_id: string | number;
  jellyfin_id: string;
  first_added_at: Date | string;
}

interface HomeRowRow extends QueryResultRow {
  profile_id: string | number;
  slug: string;
  kind: string;
  title: string;
  enabled: boolean;
  config: Record<string, string>;
}

interface WatchStateRow extends QueryResultRow {
  profile_id: string | number;
  jellyfin_id: string;
  position_ticks: string | number | null;
  duration_ticks: string | number | null;
  completed: boolean;
  hidden_from_continue: boolean;
  first_played_at: Date | string;
  last_played_at: Date | string | null;
}

interface HistoryRow extends QueryResultRow {
  profile_id: string | number;
  jellyfin_id: string;
  played_at: Date | string;
  position_ticks: string | number | null;
  duration_ticks: string | number | null;
  completed: boolean;
}

// bigint columns arrive as strings via pg; the manifest contract wants safe
// integers. A value outside the JS safe range fails here rather than
// corrupting on the wire.
function ticksOf(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`watch ticks value ${JSON.stringify(value)} is not a non-negative safe integer`);
  }
  return parsed;
}

function isoOf(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : isoOf(value);
}

function n(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

export async function runHouseholdBackup(
  executor: DrExecutor,
  options: HouseholdBackupOptions
): Promise<HouseholdBackup> {
  const clock = options.clock ?? (() => new Date());

  const runRow = await executor.query<{ id: string | number }>(
    "INSERT INTO dr_backup_runs (scope) VALUES ('household') RETURNING id"
  );
  const runId = n(runRow.rows[0].id);

  try {
    const captured = await captureHouseholdSnapshot(executor);
    // Fail closed on contract drift: run the captured snapshot through the
    // one authority for manifest shape BEFORE anything is written anywhere.
    // The artifact itself stores the input shape, so a restore can load it
    // the same way.
    normalizeManifest(captured.manifest);
    const manifest = captured.manifest;

    const createdAt = clock().toISOString();
    const filename = formatArtifactFilename(createdAt);
    const artifact = buildHouseholdArtifact(manifest, createdAt);
    const content = serializeArtifact(artifact);
    const artifactSha256 = sha256Hex(content);

    const sunk = await options.sink(filename, content);

    const counts = captured.counts;
    const rowsCaptured = Object.values(counts).reduce((sum, value) => sum + value, 0);
    await executor.query(
      `UPDATE dr_backup_runs SET status = 'succeeded', finished_at = now(),
         artifact_path = $2, artifact_sha256 = $3, manifest_sha256 = $4,
         artifact_bytes = $5, rows_captured = $6, counts = $7::jsonb
       WHERE id = $1`,
      [runId, sunk.path, artifactSha256, artifact.manifest_sha256, sunk.bytes, rowsCaptured, JSON.stringify(counts)]
    );

    return {
      runId,
      status: "succeeded",
      artifactFilename: filename,
      artifactPath: sunk.path,
      artifactBytes: sunk.bytes,
      artifactSha256,
      manifestSha256: artifact.manifest_sha256,
      rowsCaptured,
      counts,
      manifest
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const detail = raw.slice(0, 500);
    try {
      await executor.query(
        `UPDATE dr_backup_runs SET status = 'failed', finished_at = now(), error_detail = $2
         WHERE id = $1`,
        [runId, detail]
      );
    } catch {
      // The original failure propagates; a bookkeeping failure must not
      // mask it.
    }
    throw new DrBackupError(`household backup failed and was recorded (run #${runId}): ${detail}`, {
      runId,
      status: "failed",
      errorDetail: detail
    });
  }
}

interface CapturedSnapshot {
  manifest: HouseholdSnapshotManifest;
  counts: DrBackupCounts;
}

// One consistent read pass over the ACTIVE household. Ordering is pinned
// (slugs, then positions, then ids) so the manifest serialization is stable
// across runs; timestamps canonicalize to UTC ISO-8601.
async function captureHouseholdSnapshot(executor: DrExecutor): Promise<CapturedSnapshot> {
  const profileRows = (
    await executor.query<ProfileRow>(
      `SELECT id, slug, display_name, initials, is_default FROM household_profiles
       WHERE archived_at IS NULL ORDER BY slug`
    )
  ).rows;
  const profileIds = profileRows.map((row) => row.id);

  const counts: DrBackupCounts = {
    profiles: profileRows.length,
    preferences: 0,
    jellyfinAccounts: 0,
    favorites: 0,
    watchlists: 0,
    watchlistEntries: 0,
    collections: 0,
    collectionEntries: 0,
    homeRows: 0,
    watchState: 0,
    history: 0
  };

  // The zero-profile case refuses to produce an artifact: the household
  // import refuses to RECONCILE a household to empty (its zero-profile
  // guard), so an "empty household" backup could never be restored — a
  // backup that cannot be restored is not a backup.
  if (profileRows.length === 0) {
    throw new Error(
      "the household has no active profiles; refusing to produce an artifact no restore could load (the import refuses zero-profile snapshots)"
    );
  }

  const preferenceRows = (
    await executor.query<PreferenceRow>(
      `SELECT profile_id, key, value FROM household_preferences
       WHERE profile_id = ANY($1::bigint[]) ORDER BY profile_id, key`
, [profileIds]
    )
  ).rows;
  const accountRows = (
    await executor.query<AccountRow>(
      `SELECT profile_id, jellyfin_user_id FROM household_jellyfin_accounts
       WHERE profile_id = ANY($1::bigint[]) ORDER BY profile_id, jellyfin_user_id`
, [profileIds]
    )
  ).rows;
  const favoriteRows = (
    await executor.query<ProfileEntryRow>(
      `SELECT profile_id, jellyfin_id, first_added_at FROM household_favorites
       WHERE removed_at IS NULL AND profile_id = ANY($1::bigint[])
       ORDER BY profile_id, position, jellyfin_id`
, [profileIds]
    )
  ).rows;
  const watchlistRows = (
    await executor.query<ListRow>(
      `SELECT id, profile_id, slug, name FROM household_watchlists
       WHERE archived_at IS NULL AND profile_id = ANY($1::bigint[])
       ORDER BY profile_id, slug`
, [profileIds]
    )
  ).rows;
  const watchlistEntryRows = (
    await executor.query<EntryRow>(
      `SELECT w.id AS owner_id, e.jellyfin_id, e.first_added_at
       FROM household_watchlist_entries e
       JOIN household_watchlists w ON w.id = e.watchlist_id
       WHERE e.removed_at IS NULL AND w.archived_at IS NULL AND w.profile_id = ANY($1::bigint[])
       ORDER BY w.id, e.position, e.jellyfin_id`
, [profileIds]
    )
  ).rows;
  const homeRowRows = (
    await executor.query<HomeRowRow>(
      `SELECT profile_id, slug, kind, title, enabled, config FROM household_home_rows
       WHERE archived_at IS NULL AND profile_id = ANY($1::bigint[])
       ORDER BY profile_id, position, slug`
, [profileIds]
    )
  ).rows;
  const watchStateRows = (
    await executor.query<WatchStateRow>(
      `SELECT profile_id, jellyfin_id, position_ticks, duration_ticks, completed,
              hidden_from_continue, first_played_at, last_played_at
       FROM household_watch_state
       WHERE removed_at IS NULL AND profile_id = ANY($1::bigint[])
       ORDER BY profile_id, jellyfin_id`
, [profileIds]
    )
  ).rows;
  const historyRows = (
    await executor.query<HistoryRow>(
      `SELECT profile_id, jellyfin_id, played_at, position_ticks, duration_ticks, completed
       FROM household_playback_history
       WHERE profile_id = ANY($1::bigint[])
       ORDER BY profile_id, played_at, jellyfin_id`
, [profileIds]
    )
  ).rows;

  const collections = await captureCollections(executor, counts);

  const preferencesByProfile = groupByProfileId(preferenceRows);
  const accountsByProfile = groupByProfileId(accountRows);
  const favoritesByProfile = groupByProfileId(favoriteRows);
  const homeRowsByProfile = groupByProfileId(homeRowRows);
  const watchStateByProfile = groupByProfileId(watchStateRows);
  const historyByProfile = groupByProfileId(historyRows);
  const watchlistsByProfile = groupByProfileId(watchlistRows);
  const entriesByList = new Map<string, EntryRow[]>();
  for (const entry of watchlistEntryRows) {
    const key = String(entry.owner_id);
    const bucket = entriesByList.get(key);
    if (bucket) bucket.push(entry);
    else entriesByList.set(key, [entry]);
  }

  const profiles = profileRows.map((profile) => {
    const key = String(profile.id);
    const watchlists = (watchlistsByProfile.get(key) ?? []).map((list) => ({
      slug: list.slug,
      name: list.name,
      entries: (entriesByList.get(String(list.id)) ?? []).map((entry) => ({
        jellyfinId: entry.jellyfin_id,
        addedAt: isoOf(entry.first_added_at)
      }))
    }));

    const accounts = accountsByProfile.get(key) ?? [];
    if (accounts.length > 1) {
      // The schema forbids this (one link per profile per source); refuse to
      // guess which one is real.
      throw new Error(`profile "${profile.slug}" carries ${accounts.length} Jellyfin account links`);
    }

    // Preferences are captured in the manifest's INPUT shape: an object
    // keyed by preference key, in deterministic (sorted) order.
    const preferences: Record<string, string | number | boolean> = {};
    for (const entry of preferencesByProfile.get(key) ?? []) {
      preferences[entry.key] = entry.value;
    }

    return {
      slug: profile.slug,
      name: profile.display_name,
      initials: profile.initials,
      isDefault: profile.is_default,
      jellyfinUserId: accounts.length === 1 ? accounts[0].jellyfin_user_id : null,
      preferences,
      favorites: (favoritesByProfile.get(key) ?? []).map((entry) => ({
        jellyfinId: entry.jellyfin_id,
        addedAt: isoOf(entry.first_added_at)
      })),
      watchlists,
      homeRows: (homeRowsByProfile.get(key) ?? []).map((row) => ({
        slug: row.slug,
        kind: row.kind,
        title: row.title,
        enabled: row.enabled,
        config: row.config
      })),
      watchState: (watchStateByProfile.get(key) ?? []).map((entry) => ({
        jellyfinId: entry.jellyfin_id,
        positionTicks: ticksOf(entry.position_ticks),
        durationTicks: ticksOf(entry.duration_ticks),
        completed: entry.completed,
        hiddenFromContinue: entry.hidden_from_continue,
        firstPlayedAt: isoOf(entry.first_played_at),
        lastPlayedAt: isoOrNull(entry.last_played_at)
      })),
      playbackHistory: (historyByProfile.get(key) ?? []).map((entry) => ({
        jellyfinId: entry.jellyfin_id,
        playedAt: isoOf(entry.played_at),
        positionTicks: ticksOf(entry.position_ticks),
        durationTicks: ticksOf(entry.duration_ticks),
        completed: entry.completed
      }))
    };
  });

  // Counts come from the raw read results, not the mapped output: every row
  // read is exactly one captured row. (collections/collectionEntries are
  // filled by captureCollections, which reads them with their entries.)
  counts.preferences = preferenceRows.length;
  counts.jellyfinAccounts = accountRows.length;
  counts.favorites = favoriteRows.length;
  counts.watchlists = watchlistRows.length;
  counts.watchlistEntries = watchlistEntryRows.length;
  counts.homeRows = homeRowRows.length;
  counts.watchState = watchStateRows.length;
  counts.history = historyRows.length;

  return {
    manifest: { profiles, collections },
    counts
  };
}

interface CollectionRow extends QueryResultRow {
  id: string | number;
  slug: string;
  name: string;
  description: string | null;
}

async function captureCollections(
  executor: DrExecutor,
  counts: DrBackupCounts
): Promise<Array<{ slug: string; name: string; description: string | null; entries: Array<{ jellyfinId: string; addedAt: string }> }>> {
  const collectionRows = (
    await executor.query<CollectionRow>(
      `SELECT id, slug, name, description FROM household_collections
       WHERE archived_at IS NULL ORDER BY slug`
    )
  ).rows;
  // Only entries of ACTIVE collections are part of the live household.
  const entryRows = (
    await executor.query<EntryRow>(
      `SELECT c.id AS owner_id, e.jellyfin_id, e.first_added_at
       FROM household_collection_entries e
       JOIN household_collections c ON c.id = e.collection_id
       WHERE e.removed_at IS NULL AND c.archived_at IS NULL
       ORDER BY c.id, e.position, e.jellyfin_id`
    )
  ).rows;
  counts.collections = collectionRows.length;
  counts.collectionEntries = entryRows.length;

  const entriesByCollection = new Map<string, EntryRow[]>();
  for (const entry of entryRows) {
    const key = String(entry.owner_id);
    const bucket = entriesByCollection.get(key);
    if (bucket) bucket.push(entry);
    else entriesByCollection.set(key, [entry]);
  }

  return collectionRows.map((collection) => ({
    slug: collection.slug,
    name: collection.name,
    description: collection.description,
    entries: (entriesByCollection.get(String(collection.id)) ?? []).map((entry) => ({
      jellyfinId: entry.jellyfin_id,
      addedAt: isoOf(entry.first_added_at)
    }))
  }));
}

function groupByProfileId<T extends { profile_id: string | number }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = String(row.profile_id);
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  }
  return map;
}
