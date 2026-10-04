// Household import: normalized manifest snapshot → PostgreSQL household state.
//
// Contract (RH-0033):
// - The manifest is a COMPLETE household snapshot. Reconciliation is scoped
//   to what the snapshot covers: a profile absent from the payload is
//   archived, a favorite/watch-state entry absent for a confirmed profile is
//   tombstoned, a list/home row/collection absent is archived — never
//   deleted. Re-adding clears the tombstone and preserves first_added_at /
//   first_played_at (set once, never rewritten).
// - Idempotent: every upsert is guarded with IS DISTINCT so re-importing an
//   unchanged snapshot performs no visible write — updated_at never moves on
//   a no-op, playback history appends nothing (deterministic event identity),
//   and full-table dumps stay byte-identical. Write counters come from
//   RETURNING, so a no-op re-import reports zero writes.
// - Profile isolation is structural: every profile-scoped statement is
//   parameterized by profile_id and scoped again in its WHERE clause, so one
//   profile's snapshot can never rewrite, remove, or leak another's rows.
// - Provenance: item-scoped rows carry (source, jellyfin_id) and a nullable
//   resolved link into media_items (COALESCE-preserved: a payload imported
//   before the catalog knows the item links up automatically on a later
//   import and never silently unlinks). The run row is the freshness record.
// - Fail-closed: a snapshot with zero profiles refuses to reconcile the
//   household to empty; the whole mutation is ONE transaction (snapshots are
//   bounded by the manifest limits), so any failure leaves zero partial
//   state, is recorded on the run row with a scrubbed detail, and the retry
//   is a clean recovery.

import type { QueryResultRow } from "pg";
import type {
  ManifestProfile,
  NormalizedManifest
} from "./manifest.ts";

// Structurally identical to the catalog SyncExecutor (and satisfied by
// createPgSyncExecutor), kept local so the household loader does not depend
// on catalog modules.
export interface HouseholdExecutor {
  query<R extends QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  withTransaction<R>(fn: (tx: HouseholdExecutor) => Promise<R>): Promise<R>;
}

export interface HouseholdImportCounters {
  profilesSeen: number;
  profilesUpserted: number;
  profilesArchived: number;
  preferencesUpserted: number;
  favoritesUpserted: number;
  favoritesRemoved: number;
  watchlistsUpserted: number;
  watchlistsArchived: number;
  watchlistEntriesUpserted: number;
  watchlistEntriesRemoved: number;
  collectionsUpserted: number;
  collectionsArchived: number;
  collectionEntriesUpserted: number;
  collectionEntriesRemoved: number;
  homeRowsUpserted: number;
  homeRowsArchived: number;
  watchStateUpserted: number;
  watchStateRemoved: number;
  historyAppended: number;
  unresolvedLinks: number;
  conflictsSkipped: number;
}

export interface HouseholdImportResult extends HouseholdImportCounters {
  runId: number;
  status: "succeeded";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface HouseholdImportFailure extends HouseholdImportCounters {
  runId: number;
  status: "failed";
  errorDetail: string;
}

export class HouseholdImportError extends Error {
  readonly summary: HouseholdImportFailure;

  constructor(message: string, summary: HouseholdImportFailure) {
    super(message);
    this.name = "HouseholdImportError";
    this.summary = summary;
  }
}

export interface HouseholdImportOptions {
  // Deterministic clock for the reported started/finished stamps. Defaults
  // to the wall clock; tests inject a fixed one.
  clock?: () => Date;
}

interface IdRow extends QueryResultRow {
  id: string | number;
}

interface SlugIdRow extends QueryResultRow {
  id: string | number;
  slug: string;
}

interface JellyfinIdRow extends QueryResultRow {
  id: string | number;
  jellyfin_id: string;
}

export const ZERO_PROFILE_GUARD =
  "the household snapshot declares no profiles; refusing to reconcile the household to empty (check the manifest source)";

// Counter fields in household_sync_runs column order — COMPLETE_RUN's SQL
// and both parameter arrays below are built from this list so placeholders
// and values can never drift apart.
const COUNTER_FIELDS = [
  "profilesSeen",
  "profilesUpserted",
  "profilesArchived",
  "preferencesUpserted",
  "favoritesUpserted",
  "favoritesRemoved",
  "watchlistsUpserted",
  "watchlistsArchived",
  "watchlistEntriesUpserted",
  "watchlistEntriesRemoved",
  "collectionsUpserted",
  "collectionsArchived",
  "collectionEntriesUpserted",
  "collectionEntriesRemoved",
  "homeRowsUpserted",
  "homeRowsArchived",
  "watchStateUpserted",
  "watchStateRemoved",
  "historyAppended",
  "unresolvedLinks",
  "conflictsSkipped"
] as const;

export function freshCounters(): HouseholdImportCounters {
  return {
    profilesSeen: 0,
    profilesUpserted: 0,
    profilesArchived: 0,
    preferencesUpserted: 0,
    favoritesUpserted: 0,
    favoritesRemoved: 0,
    watchlistsUpserted: 0,
    watchlistsArchived: 0,
    watchlistEntriesUpserted: 0,
    watchlistEntriesRemoved: 0,
    collectionsUpserted: 0,
    collectionsArchived: 0,
    collectionEntriesUpserted: 0,
    collectionEntriesRemoved: 0,
    homeRowsUpserted: 0,
    homeRowsArchived: 0,
    watchStateUpserted: 0,
    watchStateRemoved: 0,
    historyAppended: 0,
    unresolvedLinks: 0,
    conflictsSkipped: 0
  };
}

export const INSERT_RUN = "INSERT INTO household_sync_runs (status) VALUES ('running') RETURNING id";

// $1 run id, $2 status, $3..$23 counters in COUNTER_FIELDS order, $24 detail.
export const COMPLETE_RUN = `UPDATE household_sync_runs SET
    status = $2, finished_at = now(),
    profiles_seen = $3, profiles_upserted = $4, profiles_archived = $5,
    preferences_upserted = $6,
    favorites_upserted = $7, favorites_removed = $8,
    watchlists_upserted = $9, watchlists_archived = $10,
    watchlist_entries_upserted = $11, watchlist_entries_removed = $12,
    collections_upserted = $13, collections_archived = $14,
    collection_entries_upserted = $15, collection_entries_removed = $16,
    home_rows_upserted = $17, home_rows_archived = $18,
    watch_state_upserted = $19, watch_state_removed = $20,
    history_appended = $21, unresolved_links = $22, conflicts_skipped = $23,
    error_detail = $24
  WHERE id = $1`;

// Demote defaults the snapshot does not re-assert BEFORE upserts apply the
// payload's default, so the partial unique index can never be violated
// mid-transaction. IS DISTINCT FROM keeps the no-default case ($1 NULL)
// demoting every active default.
const DEMOTE_STALE_DEFAULTS = `UPDATE household_profiles SET
    is_default = false, updated_at = now()
  WHERE is_default AND archived_at IS NULL AND slug IS DISTINCT FROM $1`;

// A Jellyfin user moving between profiles must not collide with the global
// unique (source, jellyfin_user_id): before the upserts, any account row
// whose owner differs from the profile the snapshot assigns that user to is
// removed (and re-inserted under the new owner by the upsert). Rows the
// snapshot re-asserts on the same profile are untouched (linked_at
// survives). Parameters are aligned (userId, assignedProfileId) pairs.
const DELETE_MOVED_ACCOUNTS = `DELETE FROM household_jellyfin_accounts a
  WHERE a.source = 'jellyfin'
    AND EXISTS (
      SELECT 1 FROM unnest($1::text[], $2::bigint[]) AS u(uid, pid)
      WHERE a.jellyfin_user_id = u.uid AND a.profile_id <> u.pid
    )`;

// Snapshot semantics for the link itself: a profile whose payload carries no
// Jellyfin user is unlinked (the pointer row goes; profile rows stay).
const DELETE_ACCOUNT_FOR_PROFILE =
  "DELETE FROM household_jellyfin_accounts WHERE profile_id = $1";

// The guard makes an unchanged profile a no-op (no RETURNING row, updated_at
// untouched); re-import after archive clears the tombstone, which IS a
// change. created_at is the set-once provenance stamp.
export const UPSERT_PROFILE = `INSERT INTO household_profiles (slug, display_name, initials, is_default)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (slug) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    initials = EXCLUDED.initials,
    is_default = EXCLUDED.is_default,
    archived_at = NULL,
    updated_at = now()
  WHERE (household_profiles.display_name, household_profiles.initials,
         household_profiles.is_default, household_profiles.archived_at)
    IS DISTINCT FROM (EXCLUDED.display_name, EXCLUDED.initials, EXCLUDED.is_default, NULL)
  RETURNING id`;

// Snapshot semantics for preferences: a key absent from a confirmed
// profile's payload is removed (preferences are state, not history; the run
// row is the record of the import that removed it).
export const DELETE_ABSENT_PREFERENCES =
  "DELETE FROM household_preferences WHERE profile_id = $1 AND key <> ALL($2::text[])";

export const UPSERT_PREFERENCE = `INSERT INTO household_preferences (profile_id, key, value)
  VALUES ($1, $2, $3::jsonb)
  ON CONFLICT (profile_id, key) DO UPDATE SET
    value = EXCLUDED.value, updated_at = now()
  WHERE household_preferences.value IS DISTINCT FROM EXCLUDED.value
  RETURNING profile_id`;

export const UPSERT_JF_ACCOUNT = `INSERT INTO household_jellyfin_accounts (profile_id, source, jellyfin_user_id)
  VALUES ($1, 'jellyfin', $2)
  ON CONFLICT (profile_id, source) DO UPDATE SET
    jellyfin_user_id = EXCLUDED.jellyfin_user_id, updated_at = now()
  WHERE household_jellyfin_accounts.jellyfin_user_id IS DISTINCT FROM EXCLUDED.jellyfin_user_id
  RETURNING profile_id`;

// item_id is a resolved provenance link: COALESCE keeps the last known link
// when this payload cannot resolve one. first_added_at is set once (the
// payload may pin it; otherwise the first import stamps it). The guard makes
// a value-identical re-write a true no-op (no RETURNING row, no row
// version), while a re-add (tombstone cleared), a reorder, or a newly
// resolved link still writes.
export const UPSERT_FAVORITE = `INSERT INTO household_favorites
    (profile_id, source, jellyfin_id, item_id, position, first_added_at)
  VALUES ($1, 'jellyfin', $2, $3, $4, COALESCE($5::timestamptz, now()))
  ON CONFLICT (profile_id, source, jellyfin_id) DO UPDATE SET
    item_id = COALESCE(EXCLUDED.item_id, household_favorites.item_id),
    position = EXCLUDED.position,
    removed_at = NULL
  WHERE (COALESCE(EXCLUDED.item_id, household_favorites.item_id), EXCLUDED.position, household_favorites.removed_at)
    IS DISTINCT FROM (household_favorites.item_id, household_favorites.position, NULL)
  RETURNING jellyfin_id`;

export const REMOVE_ABSENT_FAVORITES = `UPDATE household_favorites SET removed_at = now()
  WHERE profile_id = $1 AND removed_at IS NULL AND jellyfin_id <> ALL($2::text[])
  RETURNING jellyfin_id`;

export const UPSERT_WATCHLIST = `INSERT INTO household_watchlists (profile_id, slug, name)
  VALUES ($1, $2, $3)
  ON CONFLICT (profile_id, slug) DO UPDATE SET
    name = EXCLUDED.name, archived_at = NULL, updated_at = now()
  WHERE (household_watchlists.name, household_watchlists.archived_at)
    IS DISTINCT FROM (EXCLUDED.name, NULL)
  RETURNING id`;

export const UPSERT_WATCHLIST_ENTRY = `INSERT INTO household_watchlist_entries
    (watchlist_id, source, jellyfin_id, item_id, position, first_added_at)
  VALUES ($1, 'jellyfin', $2, $3, $4, COALESCE($5::timestamptz, now()))
  ON CONFLICT (watchlist_id, source, jellyfin_id) DO UPDATE SET
    item_id = COALESCE(EXCLUDED.item_id, household_watchlist_entries.item_id),
    position = EXCLUDED.position,
    removed_at = NULL
  WHERE (COALESCE(EXCLUDED.item_id, household_watchlist_entries.item_id), EXCLUDED.position, household_watchlist_entries.removed_at)
    IS DISTINCT FROM (household_watchlist_entries.item_id, household_watchlist_entries.position, NULL)
  RETURNING jellyfin_id`;

export const REMOVE_ABSENT_WATCHLIST_ENTRIES = `UPDATE household_watchlist_entries SET removed_at = now()
  WHERE watchlist_id = $1 AND removed_at IS NULL AND jellyfin_id <> ALL($2::text[])
  RETURNING jellyfin_id`;

export const ARCHIVE_ABSENT_WATCHLISTS = `UPDATE household_watchlists SET
    archived_at = now(), updated_at = now()
  WHERE profile_id = $1 AND archived_at IS NULL AND slug <> ALL($2::text[])
  RETURNING slug`;

export const UPSERT_COLLECTION = `INSERT INTO household_collections (slug, name, description)
  VALUES ($1, $2, $3)
  ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description,
    archived_at = NULL, updated_at = now()
  WHERE (household_collections.name, household_collections.description, household_collections.archived_at)
    IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.description, NULL)
  RETURNING id`;

export const UPSERT_COLLECTION_ENTRY = `INSERT INTO household_collection_entries
    (collection_id, source, jellyfin_id, item_id, position, first_added_at)
  VALUES ($1, 'jellyfin', $2, $3, $4, COALESCE($5::timestamptz, now()))
  ON CONFLICT (collection_id, source, jellyfin_id) DO UPDATE SET
    item_id = COALESCE(EXCLUDED.item_id, household_collection_entries.item_id),
    position = EXCLUDED.position,
    removed_at = NULL
  WHERE (COALESCE(EXCLUDED.item_id, household_collection_entries.item_id), EXCLUDED.position, household_collection_entries.removed_at)
    IS DISTINCT FROM (household_collection_entries.item_id, household_collection_entries.position, NULL)
  RETURNING jellyfin_id`;

export const REMOVE_ABSENT_COLLECTION_ENTRIES = `UPDATE household_collection_entries SET removed_at = now()
  WHERE collection_id = $1 AND removed_at IS NULL AND jellyfin_id <> ALL($2::text[])
  RETURNING jellyfin_id`;

export const ARCHIVE_ABSENT_COLLECTIONS = `UPDATE household_collections SET
    archived_at = now(), updated_at = now()
  WHERE archived_at IS NULL AND slug <> ALL($1::text[])
  RETURNING slug`;

export const UPSERT_HOME_ROW = `INSERT INTO household_home_rows
    (profile_id, slug, kind, title, position, enabled, config)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
  ON CONFLICT (profile_id, slug) DO UPDATE SET
    kind = EXCLUDED.kind, title = EXCLUDED.title, position = EXCLUDED.position,
    enabled = EXCLUDED.enabled, config = EXCLUDED.config,
    archived_at = NULL, updated_at = now()
  WHERE (household_home_rows.kind, household_home_rows.title, household_home_rows.position,
         household_home_rows.enabled, household_home_rows.config, household_home_rows.archived_at)
    IS DISTINCT FROM (EXCLUDED.kind, EXCLUDED.title, EXCLUDED.position, EXCLUDED.enabled, EXCLUDED.config, NULL)
  RETURNING id`;

export const ARCHIVE_ABSENT_HOME_ROWS = `UPDATE household_home_rows SET
    archived_at = now(), updated_at = now()
  WHERE profile_id = $1 AND archived_at IS NULL AND slug <> ALL($2::text[])
  RETURNING slug`;

// first_played_at is set once (payload-provided on first sight, else the
// import instant) and never rewritten by later payloads.
export const UPSERT_WATCH_STATE = `INSERT INTO household_watch_state
    (profile_id, source, jellyfin_id, item_id, position_ticks, duration_ticks,
     completed, hidden_from_continue, first_played_at, last_played_at)
  VALUES ($1, 'jellyfin', $2, $3, $4, $5, $6, $7,
          COALESCE($8::timestamptz, now()), COALESCE($9::timestamptz, $8::timestamptz, now()))
  ON CONFLICT (profile_id, source, jellyfin_id) DO UPDATE SET
    item_id = COALESCE(EXCLUDED.item_id, household_watch_state.item_id),
    position_ticks = EXCLUDED.position_ticks,
    duration_ticks = EXCLUDED.duration_ticks,
    completed = EXCLUDED.completed,
    hidden_from_continue = EXCLUDED.hidden_from_continue,
    last_played_at = EXCLUDED.last_played_at,
    removed_at = NULL,
    updated_at = now()
  WHERE (household_watch_state.position_ticks, household_watch_state.duration_ticks,
         household_watch_state.completed, household_watch_state.hidden_from_continue,
         household_watch_state.last_played_at, household_watch_state.removed_at,
         COALESCE(EXCLUDED.item_id, household_watch_state.item_id))
    IS DISTINCT FROM (EXCLUDED.position_ticks, EXCLUDED.duration_ticks,
                      EXCLUDED.completed, EXCLUDED.hidden_from_continue,
                      EXCLUDED.last_played_at, NULL,
                      COALESCE(EXCLUDED.item_id, household_watch_state.item_id))
  RETURNING jellyfin_id`;

export const REMOVE_ABSENT_WATCH_STATE = `UPDATE household_watch_state SET removed_at = now(), updated_at = now()
  WHERE profile_id = $1 AND removed_at IS NULL AND jellyfin_id <> ALL($2::text[])
  RETURNING jellyfin_id`;

// Append-only with a deterministic event identity; replaying the same
// history appends nothing (RETURNING only fires for actually-inserted rows).
export const INSERT_HISTORY = `INSERT INTO household_playback_history
    (profile_id, source, jellyfin_id, item_id, played_at, position_ticks, duration_ticks, completed)
  VALUES ($1, 'jellyfin', $2, $3, $4::timestamptz, $5, $6, $7)
  ON CONFLICT (profile_id, source, jellyfin_id, played_at) DO NOTHING
  RETURNING id`;

// Archiving is a tombstone; the archived profile's children stay in place
// (isolation and history survive), it simply drops out of the active
// household until a later snapshot re-asserts it.
export const ARCHIVE_ABSENT_PROFILES = `UPDATE household_profiles SET
    archived_at = now(), updated_at = now(), is_default = false
  WHERE archived_at IS NULL AND slug <> ALL($1::text[])
  RETURNING slug`;

export function recordFailureDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

export async function failRun(
  executor: HouseholdExecutor,
  runId: number,
  counters: HouseholdImportCounters,
  detail: string
): Promise<void> {
  try {
    await executor.query(COMPLETE_RUN, [
      runId,
      "failed",
      ...COUNTER_FIELDS.map((field) => counters[field]),
      detail
    ]);
  } catch {
    /* original failure is reported instead */
  }
}

async function countApplied(tx: HouseholdExecutor, text: string, params: unknown[]): Promise<number> {
  const result = await tx.query(text, params);
  return result.rows.length;
}

// Resolves every Jellyfin id referenced anywhere in the snapshot against the
// media catalog in one query. Unknown ids are tolerated and counted: a
// household can reference an item before the catalog has synced it, and the
// link lands automatically on a later import.
async function resolveItemLinks(
  tx: HouseholdExecutor,
  manifest: NormalizedManifest
): Promise<{ linkByJellyfinId: Map<string, number>; unresolved: number }> {
  const referenced = new Set<string>();
  for (const profile of manifest.profiles) {
    for (const entry of profile.favorites) referenced.add(entry.jellyfinId);
    for (const list of profile.watchlists) {
      for (const entry of list.entries) referenced.add(entry.jellyfinId);
    }
    for (const entry of profile.watchState) referenced.add(entry.jellyfinId);
    for (const entry of profile.playbackHistory) referenced.add(entry.jellyfinId);
  }
  for (const collection of manifest.collections) {
    for (const entry of collection.entries) referenced.add(entry.jellyfinId);
  }

  const linkByJellyfinId = new Map<string, number>();
  if (referenced.size === 0) return { linkByJellyfinId, unresolved: 0 };
  const rows = await tx.query<JellyfinIdRow>(
    "SELECT id, jellyfin_id FROM media_items WHERE source = 'jellyfin' AND jellyfin_id = ANY($1::text[])",
    [[...referenced]]
  );
  for (const row of rows.rows) linkByJellyfinId.set(row.jellyfin_id, Number(row.id));
  return { linkByJellyfinId, unresolved: referenced.size - linkByJellyfinId.size };
}

// Lands one profile's snapshot under an already-resolved profile id. Every
// statement is scoped by profile_id, so cross-profile isolation holds by
// construction.
async function importProfile(
  tx: HouseholdExecutor,
  params: {
    profile: ManifestProfile;
    profileId: number;
    linkByJellyfinId: Map<string, number>;
    counters: HouseholdImportCounters;
  }
): Promise<void> {
  const { profile, profileId, linkByJellyfinId, counters } = params;
  const linkOf = (jellyfinId: string): number | null => linkByJellyfinId.get(jellyfinId) ?? null;

  for (const preference of profile.preferences) {
    counters.preferencesUpserted += await countApplied(tx, UPSERT_PREFERENCE, [
      profileId,
      preference.key,
      JSON.stringify(preference.value)
    ]);
  }
  await tx.query(DELETE_ABSENT_PREFERENCES, [
    profileId,
    profile.preferences.map((preference) => preference.key)
  ]);

  if (profile.jellyfinUserId !== null) {
    await tx.query(UPSERT_JF_ACCOUNT, [profileId, profile.jellyfinUserId]);
  } else {
    await tx.query(DELETE_ACCOUNT_FOR_PROFILE, [profileId]);
  }

  for (const [index, entry] of profile.favorites.entries()) {
    counters.favoritesUpserted += await countApplied(tx, UPSERT_FAVORITE, [
      profileId,
      entry.jellyfinId,
      linkOf(entry.jellyfinId),
      index + 1,
      entry.addedAt
    ]);
  }
  const removedFavorites = await tx.query<{ jellyfin_id: string }>(REMOVE_ABSENT_FAVORITES, [
    profileId,
    profile.favorites.map((entry) => entry.jellyfinId)
  ]);
  counters.favoritesRemoved += removedFavorites.rows.length;

  for (const list of profile.watchlists) {
    counters.watchlistsUpserted += await countApplied(tx, UPSERT_WATCHLIST, [
      profileId,
      list.slug,
      list.name
    ]);
  }
  if (profile.watchlists.length) {
    const rows = await tx.query<SlugIdRow>(
      "SELECT id, slug FROM household_watchlists WHERE profile_id = $1 AND slug = ANY($2::text[])",
      [profileId, profile.watchlists.map((list) => list.slug)]
    );
    const watchlistIds = new Map(rows.rows.map((row) => [row.slug, Number(row.id)]));
    for (const list of profile.watchlists) {
      const watchlistId = watchlistIds.get(list.slug);
      if (watchlistId === undefined) throw new Error(`internal: watchlist "${list.slug}" was not upserted`);
      for (const [index, entry] of list.entries.entries()) {
        counters.watchlistEntriesUpserted += await countApplied(tx, UPSERT_WATCHLIST_ENTRY, [
          watchlistId,
          entry.jellyfinId,
          linkOf(entry.jellyfinId),
          index + 1,
          entry.addedAt
        ]);
      }
      const removed = await tx.query<{ jellyfin_id: string }>(REMOVE_ABSENT_WATCHLIST_ENTRIES, [
        watchlistId,
        list.entries.map((entry) => entry.jellyfinId)
      ]);
      counters.watchlistEntriesRemoved += removed.rows.length;
    }
  }
  const archivedLists = await tx.query<{ slug: string }>(ARCHIVE_ABSENT_WATCHLISTS, [
    profileId,
    profile.watchlists.map((list) => list.slug)
  ]);
  counters.watchlistsArchived += archivedLists.rows.length;

  for (const [index, row] of profile.homeRows.entries()) {
    counters.homeRowsUpserted += await countApplied(tx, UPSERT_HOME_ROW, [
      profileId,
      row.slug,
      row.kind,
      row.title,
      index + 1,
      row.enabled,
      JSON.stringify(row.config)
    ]);
  }
  const archivedRows = await tx.query<{ slug: string }>(ARCHIVE_ABSENT_HOME_ROWS, [
    profileId,
    profile.homeRows.map((row) => row.slug)
  ]);
  counters.homeRowsArchived += archivedRows.rows.length;

  for (const entry of profile.watchState) {
    counters.watchStateUpserted += await countApplied(tx, UPSERT_WATCH_STATE, [
      profileId,
      entry.jellyfinId,
      linkOf(entry.jellyfinId),
      entry.positionTicks,
      entry.durationTicks,
      entry.completed,
      entry.hiddenFromContinue,
      entry.firstPlayedAt,
      entry.lastPlayedAt
    ]);
  }
  const removedState = await tx.query<{ jellyfin_id: string }>(REMOVE_ABSENT_WATCH_STATE, [
    profileId,
    profile.watchState.map((entry) => entry.jellyfinId)
  ]);
  counters.watchStateRemoved += removedState.rows.length;

  for (const entry of profile.playbackHistory) {
    counters.historyAppended += await countApplied(tx, INSERT_HISTORY, [
      profileId,
      entry.jellyfinId,
      linkOf(entry.jellyfinId),
      entry.playedAt,
      entry.positionTicks,
      entry.durationTicks,
      entry.completed
    ]);
  }
}

export async function runHouseholdImport(
  manifest: NormalizedManifest,
  executor: HouseholdExecutor,
  options: HouseholdImportOptions = {}
): Promise<HouseholdImportResult> {
  const clock = options.clock ?? (() => new Date());
  const startedMs = Date.now();
  const startedAt = clock().toISOString();
  const counters = freshCounters();
  counters.profilesSeen = manifest.profiles.length;
  counters.conflictsSkipped = manifest.conflictsSkipped;

  const runRow = await executor.query<IdRow>(INSERT_RUN);
  const runId = Number(runRow.rows[0].id);

  try {
    if (manifest.profiles.length === 0) {
      throw new Error(ZERO_PROFILE_GUARD);
    }

    await executor.withTransaction(async (tx) => {
      const { linkByJellyfinId, unresolved } = await resolveItemLinks(tx, manifest);
      counters.unresolvedLinks = unresolved;

      const defaultSlug = manifest.profiles.find((profile) => profile.isDefault)?.slug ?? null;
      await tx.query(DEMOTE_STALE_DEFAULTS, [defaultSlug]);

      // Profile ids as of BEFORE the upserts: enough to re-own moved
      // Jellyfin accounts (profiles missing here cannot own account rows).
      const before = await tx.query<SlugIdRow>(
        "SELECT id, slug FROM household_profiles WHERE slug = ANY($1::text[])",
        [manifest.profiles.map((profile) => profile.slug)]
      );
      const beforeIds = new Map(before.rows.map((row) => [row.slug, Number(row.id)]));

      const accountPairs = manifest.profiles
        .filter((profile) => profile.jellyfinUserId !== null)
        .map((profile) => ({
          userId: profile.jellyfinUserId as string,
          assignedId: beforeIds.get(profile.slug) ?? -1
        }));
      if (accountPairs.length) {
        await tx.query(DELETE_MOVED_ACCOUNTS, [
          accountPairs.map((pair) => pair.userId),
          accountPairs.map((pair) => pair.assignedId)
        ]);
      }

      for (const profile of manifest.profiles) {
        counters.profilesUpserted += await countApplied(tx, UPSERT_PROFILE, [
          profile.slug,
          profile.name,
          profile.initials,
          profile.isDefault
        ]);
      }

      const after = await tx.query<SlugIdRow>(
        "SELECT id, slug FROM household_profiles WHERE slug = ANY($1::text[])",
        [manifest.profiles.map((profile) => profile.slug)]
      );
      const profileIds = new Map(after.rows.map((row) => [row.slug, Number(row.id)]));

      for (const profile of manifest.profiles) {
        const profileId = profileIds.get(profile.slug);
        if (profileId === undefined) throw new Error(`internal: profile "${profile.slug}" was not upserted`);
        await importProfile(tx, { profile, profileId, linkByJellyfinId, counters });
      }

      const archivedProfiles = await tx.query<{ slug: string }>(ARCHIVE_ABSENT_PROFILES, [
        manifest.profiles.map((profile) => profile.slug)
      ]);
      counters.profilesArchived += archivedProfiles.rows.length;

      for (const collection of manifest.collections) {
        counters.collectionsUpserted += await countApplied(tx, UPSERT_COLLECTION, [
          collection.slug,
          collection.name,
          collection.description
        ]);
      }
      if (manifest.collections.length) {
        const rows = await tx.query<SlugIdRow>(
          "SELECT id, slug FROM household_collections WHERE slug = ANY($1::text[])",
          [manifest.collections.map((collection) => collection.slug)]
        );
        const collectionIds = new Map(rows.rows.map((row) => [row.slug, Number(row.id)]));
        for (const collection of manifest.collections) {
          const collectionId = collectionIds.get(collection.slug);
          if (collectionId === undefined) {
            throw new Error(`internal: collection "${collection.slug}" was not upserted`);
          }
          for (const [index, entry] of collection.entries.entries()) {
            counters.collectionEntriesUpserted += await countApplied(tx, UPSERT_COLLECTION_ENTRY, [
              collectionId,
              entry.jellyfinId,
              linkByJellyfinId.get(entry.jellyfinId) ?? null,
              index + 1,
              entry.addedAt
            ]);
          }
          const removed = await tx.query<{ jellyfin_id: string }>(REMOVE_ABSENT_COLLECTION_ENTRIES, [
            collectionId,
            collection.entries.map((entry) => entry.jellyfinId)
          ]);
          counters.collectionEntriesRemoved += removed.rows.length;
        }
      }
      const archivedCollections = await tx.query<{ slug: string }>(ARCHIVE_ABSENT_COLLECTIONS, [
        manifest.collections.map((collection) => collection.slug)
      ]);
      counters.collectionsArchived += archivedCollections.rows.length;
    });

    const finishedAt = clock().toISOString();
    await executor.query(COMPLETE_RUN, [
      runId,
      "succeeded",
      ...COUNTER_FIELDS.map((field) => counters[field]),
      null
    ]);
    return {
      runId,
      status: "succeeded",
      ...counters,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs
    };
  } catch (error) {
    const detail = recordFailureDetail(error);
    await failRun(executor, runId, counters, detail);
    throw new HouseholdImportError(`Household import failed: ${detail}`, {
      runId,
      status: "failed",
      ...counters,
      errorDetail: detail
    });
  }
}
