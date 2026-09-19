// ReelHouse-owned household state persistence (RH-0017).
//
// Data access for household profiles, per-profile preferences, the watch /
// continue-watching overlay, Jellyfin account links, the stable media-item
// bridge, and sync metadata — all in the PG18 `reelhouse` database, all
// reached only through this server-side layer (clients never see SQL or
// credentials, per docs/ARCHITECTURE.md).
//
// Split design mirrors src/lib/db/smoke.ts: the runner is injected, this
// module is deliberately free of `server-only` and the `@/` alias, and its pg
// import is type-only — so route handlers, the Next.js server runtime, and
// plain-Node tests (unit fixtures or a real disposable PG18) can all drive
// the same functions. Transactional callers pass a transaction-scoped runner
// via transact(); single-statement callers pass the pool or a client.

import { createHash } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import {
  HouseholdConflictError,
  HouseholdInputError,
  HouseholdNotFoundError,
  classifyPgError,
  describePgErrorKind
} from "./errors.ts";

// Anything pg Client / PoolClient / Pool satisfies structurally.
export interface SqlRunner {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<R>>;
}

export interface TransactionSource {
  connect(): Promise<SqlRunner & { release(): void }>;
}

// Runs fn atomically: COMMIT on success, ROLLBACK (best effort — the original
// error is the one that matters) and client release on failure. Pools check
// clients out per connect(); Clients are their own transaction and would
// double as both endpoints in tests.
export async function transact<R>(
  source: TransactionSource,
  fn: (tx: SqlRunner) => Promise<R>
): Promise<R> {
  const client = await source.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Surface the original failure, not the rollback's.
    }
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- rows/json

export interface ProfileJson {
  id: string;
  displayName: string;
  isActive: boolean;
  preferences: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ProfileRow extends QueryResultRow {
  id: string;
  display_name: string;
  is_active: boolean;
  preferences: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export function toProfileJson(row: ProfileRow): ProfileJson {
  return {
    id: row.id,
    displayName: row.display_name,
    isActive: row.is_active,
    preferences: row.preferences ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export interface WatchStateJson {
  profileId: string;
  source: string;
  externalId: string;
  positionTicks: number;
  durationTicks: number | null;
  completed: boolean;
  lastPlayedAt: string;
  updatedAt: string;
}

interface WatchStateRow extends QueryResultRow {
  profile_id: string;
  source: string;
  external_id: string;
  position_ticks: string | number;
  duration_ticks: string | number | null;
  completed: boolean;
  last_played_at: Date;
  updated_at: Date;
}

// bigint columns arrive as strings from pg; every value we write was already
// validated <= Number.MAX_SAFE_INTEGER, so Number() is lossless here.
export function ticksFromDb(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === "number" ? value : Number(value);
}

export function toWatchStateJson(row: WatchStateRow): WatchStateJson {
  return {
    profileId: row.profile_id,
    source: row.source,
    externalId: row.external_id,
    positionTicks: ticksFromDb(row.position_ticks) ?? 0,
    durationTicks: ticksFromDb(row.duration_ticks),
    completed: row.completed,
    lastPlayedAt: row.last_played_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export interface JellyfinLinkJson {
  profileId: string;
  jellyfinUserId: string;
  createdAt: string;
  updatedAt: string;
}

interface LinkRow extends QueryResultRow {
  profile_id: string;
  jellyfin_user_id: string;
  created_at: Date;
  updated_at: Date;
}

export function toJellyfinLinkJson(row: LinkRow): JellyfinLinkJson {
  return {
    profileId: row.profile_id,
    jellyfinUserId: row.jellyfin_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export interface SyncCursorJson {
  job: string;
  cursor: Record<string, unknown>;
  lastStartedAt: string | null;
  lastSucceededAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

interface SyncCursorRow extends QueryResultRow {
  job: string;
  cursor: Record<string, unknown>;
  last_started_at: Date | null;
  last_succeeded_at: Date | null;
  last_error: string | null;
  updated_at: Date;
}

export function toSyncCursorJson(row: SyncCursorRow): SyncCursorJson {
  return {
    job: row.job,
    cursor: row.cursor ?? {},
    lastStartedAt: row.last_started_at?.toISOString() ?? null,
    lastSucceededAt: row.last_succeeded_at?.toISOString() ?? null,
    lastError: row.last_error,
    updatedAt: row.updated_at.toISOString()
  };
}

// Raises the classified categories the HTTP layer maps to responses; used
// where the store itself knows better than the constraint (absent rows).
export function storeProblemFromPgError(error: unknown): Error {
  const classification = classifyPgError(error);
  if (!classification) return error instanceof Error ? error : new Error(String(error));
  const message = `household store rejected by database constraint (${describePgErrorKind(classification)})`;
  switch (classification.kind) {
    case "conflict":
      return new HouseholdConflictError(message);
    case "missing-reference":
      return new HouseholdNotFoundError(message);
    case "input":
      return new HouseholdInputError(message);
    case "storage":
      return error instanceof Error ? error : new Error(String(error));
  }
}

// ----------------------------------------------------------------- profiles

export interface ListProfilesOptions {
  includeInactive?: boolean;
  limit: number;
}

export async function listProfiles(runner: SqlRunner, options: ListProfilesOptions): Promise<ProfileJson[]> {
  const result = await runner.query<ProfileRow>(
    `SELECT p.id, p.display_name, p.is_active, p.created_at, p.updated_at, pp.preferences
       FROM household_profile p
       LEFT JOIN profile_preferences pp ON pp.profile_id = p.id
      WHERE $1 OR p.is_active
      ORDER BY lower(p.display_name), p.id
      LIMIT $2`,
    [options.includeInactive === true, options.limit]
  );
  return result.rows.map(toProfileJson);
}

export interface CreateProfileInput {
  displayName: string;
  preferences?: Record<string, unknown>;
}

export async function createProfile(runner: SqlRunner, input: CreateProfileInput): Promise<ProfileJson> {
  try {
    const result = await runner.query<ProfileRow>(
      `WITH new_profile AS (
         INSERT INTO household_profile (display_name)
         VALUES ($1)
         RETURNING id, display_name, is_active, created_at, updated_at
       ), new_preferences AS (
         INSERT INTO profile_preferences (profile_id, preferences)
         SELECT id, $2::jsonb FROM new_profile
         RETURNING profile_id, preferences
       )
       SELECT np.*, npp.preferences
         FROM new_profile np
         LEFT JOIN new_preferences npp ON npp.profile_id = np.id`,
      [input.displayName, JSON.stringify(input.preferences ?? {})]
    );
    const row = result.rows[0];
    if (!row) throw new Error("household store: profile insert returned no row");
    return toProfileJson(row);
  } catch (error) {
    throw storeProblemFromPgError(error);
  }
}

export async function getProfile(runner: SqlRunner, profileId: string): Promise<ProfileJson | null> {
  const result = await runner.query<ProfileRow>(
    `SELECT p.id, p.display_name, p.is_active, p.created_at, p.updated_at, pp.preferences
       FROM household_profile p
       LEFT JOIN profile_preferences pp ON pp.profile_id = p.id
      WHERE p.id = $1`,
    [profileId]
  );
  const row = result.rows[0];
  return row ? toProfileJson(row) : null;
}

export async function updateProfile(
  runner: SqlRunner,
  profileId: string,
  patch: { displayName?: string; isActive?: boolean }
): Promise<ProfileJson | null> {
  try {
    const result = await runner.query<ProfileRow>(
      `WITH updated AS (
         UPDATE household_profile
            SET display_name = COALESCE($2, display_name),
                is_active    = COALESCE($3, is_active)
          WHERE id = $1
         RETURNING id, display_name, is_active, created_at, updated_at
       )
       SELECT u.*, pp.preferences
         FROM updated u
         LEFT JOIN profile_preferences pp ON pp.profile_id = u.id`,
      [profileId, patch.displayName ?? null, patch.isActive ?? null]
    );
    const row = result.rows[0];
    return row ? toProfileJson(row) : null;
  } catch (error) {
    throw storeProblemFromPgError(error);
  }
}

/** True when the profile existed; deletion cascades to all owned state. */
export async function deleteProfile(runner: SqlRunner, profileId: string): Promise<boolean> {
  const result = await runner.query(
    "DELETE FROM household_profile WHERE id = $1",
    [profileId]
  );
  return (result.rowCount ?? 0) > 0;
}

// -------------------------------------------------------------- preferences

export async function replacePreferences(
  runner: SqlRunner,
  profileId: string,
  preferences: Record<string, unknown>
): Promise<ProfileJson | null> {
  try {
    const result = await runner.query<ProfileRow>(
      `WITH upserted AS (
         INSERT INTO profile_preferences (profile_id, preferences)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (profile_id) DO UPDATE
            SET preferences = EXCLUDED.preferences
         RETURNING profile_id, preferences
       )
       SELECT p.id, p.display_name, p.is_active, p.created_at, p.updated_at, up.preferences
         FROM upserted up
         JOIN household_profile p ON p.id = up.profile_id`,
      [profileId, JSON.stringify(preferences)]
    );
    const row = result.rows[0];
    return row ? toProfileJson(row) : null;
  } catch (error) {
    throw storeProblemFromPgError(error);
  }
}

// ------------------------------------------------------------ jellyfin link

export async function getJellyfinLink(runner: SqlRunner, profileId: string): Promise<JellyfinLinkJson | null> {
  const result = await runner.query<LinkRow>(
    `SELECT profile_id, jellyfin_user_id, created_at, updated_at
       FROM jellyfin_account_link
      WHERE profile_id = $1`,
    [profileId]
  );
  const row = result.rows[0];
  return row ? toJellyfinLinkJson(row) : null;
}

export async function putJellyfinLink(
  runner: SqlRunner,
  profileId: string,
  jellyfinUserId: string
): Promise<JellyfinLinkJson> {
  try {
    const result = await runner.query<LinkRow>(
      `INSERT INTO jellyfin_account_link (profile_id, jellyfin_user_id)
       VALUES ($1, $2)
       ON CONFLICT (profile_id) DO UPDATE
          SET jellyfin_user_id = EXCLUDED.jellyfin_user_id
       RETURNING profile_id, jellyfin_user_id, created_at, updated_at`,
      [profileId, jellyfinUserId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("household store: jellyfin link upsert returned no row");
    return toJellyfinLinkJson(row);
  } catch (error) {
    throw storeProblemFromPgError(error);
  }
}

export async function deleteJellyfinLink(runner: SqlRunner, profileId: string): Promise<boolean> {
  const result = await runner.query(
    "DELETE FROM jellyfin_account_link WHERE profile_id = $1",
    [profileId]
  );
  return (result.rowCount ?? 0) > 0;
}

// ------------------------------------------------------------- media refs

// The stable bridge: (source, external_id) in, ReelHouse uuid out. Creation
// is idempotent and race-safe (the UNIQUE pair is the authority); a lost
// insert re-reads the winner's id.
export async function resolveMediaRef(runner: SqlRunner, source: string, externalId: string): Promise<string> {
  const existing = await runner.query<{ id: string }>(
    "SELECT id FROM media_item_ref WHERE source = $1 AND external_id = $2",
    [source, externalId]
  );
  const found = existing.rows[0];
  if (found) return found.id;

  const inserted = await runner.query<{ id: string }>(
    `INSERT INTO media_item_ref (source, external_id)
     VALUES ($1, $2)
     ON CONFLICT (source, external_id) DO NOTHING
     RETURNING id`,
    [source, externalId]
  );
  const created = inserted.rows[0];
  if (created) return created.id;

  const winner = await runner.query<{ id: string }>(
    "SELECT id FROM media_item_ref WHERE source = $1 AND external_id = $2",
    [source, externalId]
  );
  const raced = winner.rows[0];
  if (!raced) throw new Error("household store: media_item_ref resolution failed without a database error");
  return raced.id;
}

// ------------------------------------------------------------- watch state

export interface WatchProgressRecord {
  profileId: string;
  source: "jellyfin";
  externalId: string;
  positionTicks: number;
  durationTicks?: number;
  completed: boolean;
}

// Atomic progress write, inside the caller's transaction: resolve the stable
// media ref, upsert the overlay row, and append the history event. playback_event
// is append-only by design — corrections rewrite watch_state, never history.
export async function recordWatchProgress(tx: SqlRunner, input: WatchProgressRecord): Promise<WatchStateJson> {
  try {
    const mediaRefId = await resolveMediaRef(tx, input.source, input.externalId);
    const result = await tx.query<WatchStateRow>(
      `INSERT INTO watch_state (profile_id, media_ref_id, position_ticks, duration_ticks, completed, last_played_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (profile_id, media_ref_id) DO UPDATE
          SET position_ticks = EXCLUDED.position_ticks,
              duration_ticks = EXCLUDED.duration_ticks,
              completed      = EXCLUDED.completed,
              last_played_at = now()
       RETURNING profile_id, position_ticks, duration_ticks, completed, last_played_at, updated_at,
                 (SELECT source FROM media_item_ref WHERE id = $2) AS source,
                 (SELECT external_id FROM media_item_ref WHERE id = $2) AS external_id`,
      [
        input.profileId,
        mediaRefId,
        input.positionTicks,
        input.durationTicks ?? null,
        input.completed
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("household store: watch state upsert returned no row");

    await tx.query(
      `INSERT INTO playback_event (profile_id, media_ref_id, position_ticks, duration_ticks, completed, recorded_by)
       VALUES ($1, $2, $3, $4, $5, 'reelhouse')`,
      [input.profileId, mediaRefId, input.positionTicks, input.durationTicks ?? null, input.completed]
    );
    return toWatchStateJson(row);
  } catch (error) {
    throw storeProblemFromPgError(error);
  }
}

export async function getWatchState(
  runner: SqlRunner,
  profileId: string,
  source: string,
  externalId: string
): Promise<WatchStateJson | null> {
  const result = await runner.query<WatchStateRow>(
    `SELECT ws.profile_id, r.source, r.external_id, ws.position_ticks, ws.duration_ticks,
            ws.completed, ws.last_played_at, ws.updated_at
       FROM watch_state ws
       JOIN media_item_ref r ON r.id = ws.media_ref_id
      WHERE ws.profile_id = $1 AND r.source = $2 AND r.external_id = $3`,
    [profileId, source, externalId]
  );
  const row = result.rows[0];
  return row ? toWatchStateJson(row) : null;
}

export interface ListWatchOptions {
  limit: number;
}

// Everything this profile has state for, newest activity first.
export async function listWatchState(
  runner: SqlRunner,
  profileId: string,
  options: ListWatchOptions
): Promise<WatchStateJson[]> {
  const result = await runner.query<WatchStateRow>(
    `SELECT ws.profile_id, r.source, r.external_id, ws.position_ticks, ws.duration_ticks,
            ws.completed, ws.last_played_at, ws.updated_at
       FROM watch_state ws
       JOIN media_item_ref r ON r.id = ws.media_ref_id
      WHERE ws.profile_id = $1
      ORDER BY ws.last_played_at DESC
      LIMIT $2`,
    [profileId, options.limit]
  );
  return result.rows.map(toWatchStateJson);
}

// The Continue Watching query — deliberately the exact shape of the
// watch_state_resume_idx partial index (completed = false AND position > 0),
// newest activity first, bounded by the caller's limit.
export async function listContinueWatching(
  runner: SqlRunner,
  profileId: string,
  options: ListWatchOptions
): Promise<WatchStateJson[]> {
  const result = await runner.query<WatchStateRow>(
    `SELECT ws.profile_id, r.source, r.external_id, ws.position_ticks, ws.duration_ticks,
            ws.completed, ws.last_played_at, ws.updated_at
       FROM watch_state ws
       JOIN media_item_ref r ON r.id = ws.media_ref_id
      WHERE ws.profile_id = $1
        AND ws.completed = false
        AND ws.position_ticks > 0
      ORDER BY ws.last_played_at DESC
      LIMIT $2`,
    [profileId, options.limit]
  );
  return result.rows.map(toWatchStateJson);
}

// ----------------------------------------------------------- sync metadata

const SYNC_ERROR_MAX_CHARS = 2000;

export function truncateSyncError(message: string): string {
  return message.length <= SYNC_ERROR_MAX_CHARS ? message : `${message.slice(0, SYNC_ERROR_MAX_CHARS)}…`;
}

export interface SyncCursorUpdate {
  job: string;
  cursor?: Record<string, unknown>;
}

// Upserts the job row and stamps started. An explicit cursor replaces the
// stored one; an absent one preserves it (a runner that does not know the
// position must not erase the previous run's). The newest run owns the answer.
export async function markSyncStarted(
  runner: SqlRunner,
  update: SyncCursorUpdate,
  at: Date
): Promise<SyncCursorJson> {
  try {
    const result = await runner.query<SyncCursorRow>(
      `INSERT INTO sync_cursor (job, cursor, last_started_at)
       VALUES ($1, COALESCE($2::jsonb, '{}'::jsonb), $3)
       ON CONFLICT (job) DO UPDATE
          SET cursor = COALESCE($2::jsonb, sync_cursor.cursor),
              last_started_at = $3
       RETURNING job, cursor, last_started_at, last_succeeded_at, last_error, updated_at`,
      [update.job, update.cursor ? JSON.stringify(update.cursor) : null, at]
    );
    const row = result.rows[0];
    if (!row) throw new Error("household store: sync cursor upsert returned no row");
    return toSyncCursorJson(row);
  } catch (error) {
    throw storeProblemFromPgError(error);
  }
}

export async function markSyncSucceeded(
  runner: SqlRunner,
  job: string,
  at: Date,
  cursor?: Record<string, unknown>
): Promise<SyncCursorJson | null> {
  try {
    const result = await runner.query<SyncCursorRow>(
      `UPDATE sync_cursor
          SET last_succeeded_at = $2,
              last_error = NULL
              ${cursor ? ", cursor = $3::jsonb" : ""}
        WHERE job = $1
       RETURNING job, cursor, last_started_at, last_succeeded_at, last_error, updated_at`,
      cursor ? [job, at, JSON.stringify(cursor)] : [job, at]
    );
    const row = result.rows[0];
    return row ? toSyncCursorJson(row) : null;
  } catch (error) {
    throw storeProblemFromPgError(error);
  }
}

// Failures never clear last_succeeded_at: the cursor keeps telling the truth
// about the last good run while carrying the bounded error that explains the
// latest one. Only a registered job (one that marked itself started) can be
// marked failed; there is no cursor row to heal otherwise.
export async function markSyncFailed(
  runner: SqlRunner,
  job: string,
  message: string
): Promise<SyncCursorJson | null> {
  try {
    const result = await runner.query<SyncCursorRow>(
      `UPDATE sync_cursor
          SET last_error = $2
        WHERE job = $1
       RETURNING job, cursor, last_started_at, last_succeeded_at, last_error, updated_at`,
      [job, truncateSyncError(message)]
    );
    const row = result.rows[0];
    return row ? toSyncCursorJson(row) : null;
  } catch (error) {
    throw storeProblemFromPgError(error);
  }
}

// ------------------------------------------------------- idempotency keys

export const WATCH_PROGRESS_IDEMPOTENCY_SCOPE = "watch_progress";

export type IdempotencyClaim = "claimed" | { replay: true };

// Inserts-or-loses: the UNIQUE (scope, key) pair decides. A replay with the
// same fingerprint returns { replay: true } so the caller can skip the
// non-idempotent part of the write (the history append); a replay with a
// different fingerprint under the same key is a client bug and conflicts.
export async function claimIdempotencyKey(
  runner: SqlRunner,
  scope: string,
  key: string,
  fingerprint: string | undefined
): Promise<IdempotencyClaim> {
  try {
    const insert = await runner.query<{ id: string }>(
      `INSERT INTO idempotency_record (scope, idempotency_key, fingerprint)
       VALUES ($1, $2, $3)
       ON CONFLICT (scope, idempotency_key) DO NOTHING
       RETURNING id`,
      [scope, key, fingerprint ?? null]
    );
    if ((insert.rowCount ?? 0) > 0) return "claimed";

    const existing = await runner.query<{ fingerprint: string | null }>(
      "SELECT fingerprint FROM idempotency_record WHERE scope = $1 AND idempotency_key = $2",
      [scope, key]
    );
    const row = existing.rows[0];
    if (!row) throw new Error("household store: idempotency claim vanished between insert and select");
    if ((row.fingerprint ?? null) === (fingerprint ?? null)) return { replay: true };
    throw new HouseholdConflictError("idempotency key was already used for a different request");
  } catch (error) {
    if (error instanceof HouseholdConflictError) throw error;
    throw storeProblemFromPgError(error);
  }
}

// Canonical fingerprint over the semantic input (the canonical key order of
// the parsed object is the construction order, which the parser fixes), so a
// replayed request with reformatted whitespace still counts as the same write.
export function fingerprintWatchProgress(input: WatchProgressRecord): string {
  const canonical = JSON.stringify({
    completed: input.completed,
    durationTicks: input.durationTicks ?? null,
    externalId: input.externalId,
    positionTicks: input.positionTicks,
    source: input.source
  });
  return createHash("sha256").update(canonical).digest("hex");
}
