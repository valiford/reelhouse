// Jellyfin → ReelHouse watch-state reconciliation (RH-0022).
//
// Jellyfin is the playback authority (docs/ARCHITECTURE.md): this module
// pulls a bounded page of a linked profile's resumable items through the
// Jellyfin API and folds them into the ReelHouse-owned watch_state overlay —
// never the reverse, and never Jellyfin's internal database. The overlay is
// a projection with one deterministic merge rule per item:
//
// - Jellyfin event strictly older than the stored overlay  → local wins;
// - Jellyfin state identical to the stored overlay          → already applied;
// - otherwise (newer event, or nothing stored yet)          → Jellyfin wins.
//
// An item Jellyfin reports WITHOUT an event timestamp cannot be ordered, so
// it only ever seeds an empty overlay and never overwrites local state —
// fail-closed on ambiguous recency. Every applied item appends one
// playback_event (recorded_by 'jellyfin_import'); exact replays are detected
// and suppressed, so re-running a reconciliation is a no-op, never a
// duplicate history.
//
// Split like the rest of the household layer: the resume client is an
// interface (fixtures in tests), the store takes an injected runner, and the
// same functions serve the API route and the integration suites.

import { loadJellyfinSyncConfig, type JellyfinSyncConfig } from "../catalog/config.ts";
import { jellyfinGetJson, JellyfinSyncError } from "../catalog/jellyfin-client.ts";
import { HouseholdConflictError, HouseholdNotFoundError } from "./errors.ts";
import {
  appendPlaybackEvent,
  getJellyfinLink,
  getProfile,
  lockWatchState,
  markSyncFailed,
  markSyncStarted,
  markSyncSucceeded,
  playbackEventExists,
  resolveMediaRef,
  transact,
  upsertWatchState,
  type PlaybackEventKey,
  type SqlRunner,
  type SyncCursorJson,
  type TransactionSource,
  type WatchStateJson
} from "./store.ts";

// The reconciliation feeds the Continue Watching rail, not the archive: one
// bounded page per run. The route refuses anything beyond this contract.
export const RECONCILE_LIMIT_DEFAULT = 50;
export const RECONCILE_LIMIT_MAX = 200;

export const WATCH_RECONCILE_JOB_PREFIX = "jellyfin_watch_reconcile";

// The Jellyfin side is unreachable, unconfigured, or misconfigured. Maps to
// 503 in src/lib/household/api.ts — availability, never a client's fault,
// and never demo-fallback data (fails closed).
export class JellyfinUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JellyfinUnavailableError";
  }
}

export interface JellyfinResumeItem {
  externalId: string;
  positionTicks: number;
  durationTicks: number | null;
  completed: boolean;
  // Jellyfin's own "when was this last played"; null when the server does
  // not say (the item then only seeds an empty overlay — see module header).
  playedAt: Date | null;
}

export interface JellyfinResumePage {
  items: JellyfinResumeItem[];
  // Items present in the response but unusable (missing identity, negative
  // or overrunning progress). Skipped, never half-applied, always counted.
  skipped: number;
}

export interface JellyfinResumeClient {
  listResumeItems(userId: string, limit: number): Promise<JellyfinResumePage>;
}

interface JellyfinUserData {
  PlaybackPositionTicks?: unknown;
  Played?: unknown;
  LastPlayedDate?: unknown;
}

interface JellyfinResumeRawItem {
  Id?: unknown;
  RunTimeTicks?: unknown;
  UserData?: JellyfinUserData;
}

interface JellyfinResumeResponse {
  Items?: JellyfinResumeRawItem[];
}

export function parseJellyfinTicks(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export function parseJellyfinDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// One malformed item is skipped, not fatal — but it is never silently
// applied either: the count surfaces in the response and the sync cursor.
export function parseJellyfinResumeItem(raw: unknown): JellyfinResumeItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as JellyfinResumeRawItem;
  const externalId = typeof record.Id === "string" ? record.Id.trim() : "";
  if (externalId === "" || externalId.length > 200) return null;

  const userData: JellyfinUserData =
    typeof record.UserData === "object" && record.UserData !== null ? record.UserData : {};

  // Absent runtime means unknown duration; present-but-invalid runtime is
  // garbage from the authority — refuse rather than guess.
  let durationTicks: number | null = null;
  if (record.RunTimeTicks !== undefined) {
    const runtimeTicks = parseJellyfinTicks(record.RunTimeTicks);
    if (runtimeTicks === null) return null;
    if (runtimeTicks > 0) durationTicks = runtimeTicks;
  }

  // Absent progress means zero; present-but-invalid progress is garbage from
  // the authority — refuse the item rather than guess.
  let positionTicks = 0;
  if (userData.PlaybackPositionTicks !== undefined) {
    const parsed = parseJellyfinTicks(userData.PlaybackPositionTicks);
    if (parsed === null) return null;
    positionTicks = parsed;
  }
  // An item claiming to sit past its own runtime is ambiguous identity —
  // refuse the item rather than guess a clamp.
  if (durationTicks !== null && positionTicks > durationTicks) return null;

  return {
    externalId,
    positionTicks,
    durationTicks,
    completed: userData.Played === true,
    playedAt: parseJellyfinDate(userData.LastPlayedDate)
  };
}

export function createHttpJellyfinResumeClient(
  config: JellyfinSyncConfig,
  fetchImpl: typeof fetch = fetch
): JellyfinResumeClient {
  return {
    async listResumeItems(userId: string, limit: number): Promise<JellyfinResumePage> {
      // Same user-scoped endpoint the baseline library client uses; the API
      // key travels in the header only, and the page is hard-bounded.
      const body = await jellyfinGetJson<JellyfinResumeResponse>(
        config,
        `/Users/${encodeURIComponent(userId)}/Items`,
        {
          IsResumable: "true",
          IncludeItemTypes: "Movie,Episode,Video",
          SortBy: "DatePlayed",
          SortOrder: "Descending",
          Limit: String(limit),
          Recursive: "true"
        },
        fetchImpl
      );
      const items: JellyfinResumeItem[] = [];
      let skipped = 0;
      for (const raw of body.Items ?? []) {
        const item = parseJellyfinResumeItem(raw);
        if (item === null) skipped += 1;
        else items.push(item);
      }
      return { items, skipped };
    }
  };
}

export type ReconcileAction = "apply" | "stale" | "duplicate";

// The whole merge rule, pure and unit-tested. `now` is the run's stamp for
// items without a Jellyfin timestamp (only ever used on an empty overlay).
export function planJellyfinEntry(current: WatchStateJson | null, item: JellyfinResumeItem): ReconcileAction {
  if (current === null) return "apply";
  if (item.playedAt !== null) {
    return item.playedAt.getTime() < new Date(current.lastPlayedAt).getTime() ? "stale" : "apply";
  }
  const identical =
    current.positionTicks === item.positionTicks &&
    (current.durationTicks ?? null) === item.durationTicks &&
    current.completed === item.completed;
  return identical ? "duplicate" : "stale";
}

export interface ReconcileOutcome {
  profileId: string;
  jellyfinUserId: string;
  scanned: number;
  applied: number;
  stale: number;
  duplicate: number;
  skipped: number;
  cursor: SyncCursorJson;
}

export interface ReconcileOptions {
  // The ReelHouse database source: query-capable (single statements: profile,
  // link, cursor lifecycle) and connect-capable (the apply transaction). The
  // pg Pool in production; the same object in the integration suites.
  source: TransactionSource & SqlRunner;
  profileId: string;
  client: JellyfinResumeClient;
  limit?: number;
  // Injectable clock for deterministic tests; defaults to the wall clock.
  now?: Date;
}

// Reconciles one linked profile's watch-state overlay from Jellyfin.
//
// Fail-closed order of operations: profile must exist, the 1:1 Jellyfin link
// must exist (no link → conflict: there is no identity to reconcile from),
// then the fetch, then ONE transaction applies every planned entry. The
// profile-isolation guard re-reads the link INSIDE that transaction and
// aborts if the link changed between fetch and apply — the fetched items
// belong to exactly the linked identity, and a mid-flight re-link would make
// that ambiguous. All counters land in the per-profile sync_cursor job row;
// a failed run records a bounded error and never clears the last success.
export async function reconcileProfileWatchState(options: ReconcileOptions): Promise<ReconcileOutcome> {
  const limit = Math.min(Math.max(options.limit ?? RECONCILE_LIMIT_DEFAULT, 1), RECONCILE_LIMIT_MAX);
  const now = options.now ?? new Date();
  const job = `${WATCH_RECONCILE_JOB_PREFIX}:${options.profileId}`;

  const profile = await getProfile(options.source, options.profileId);
  if (!profile) throw new HouseholdNotFoundError("profile not found");
  const link = await getJellyfinLink(options.source, options.profileId);
  if (!link) {
    throw new HouseholdConflictError("profile has no Jellyfin account link to reconcile from");
  }

  await markSyncStarted(options.source, { job }, now);

  let page: JellyfinResumePage;
  try {
    page = await options.client.listResumeItems(link.jellyfinUserId, limit);
  } catch (error) {
    const message =
      error instanceof JellyfinSyncError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    await markSyncFailed(options.source, job, message);
    throw new JellyfinUnavailableError(`Jellyfin reconciliation could not read resumable items: ${message}`);
  }

  const counts = { applied: 0, stale: 0, duplicate: 0, skipped: page.skipped };
  try {
    await transact(options.source, async (tx: SqlRunner) => {
      // Profile-isolation guard: fetched items belong to the identity this
      // profile was linked to when the fetch happened; a changed link makes
      // that ambiguous and the whole run fails closed.
      const linkNow = await getJellyfinLink(tx, options.profileId);
      if (!linkNow || linkNow.jellyfinUserId !== link.jellyfinUserId) {
        throw new HouseholdConflictError("the profile's Jellyfin link changed during reconciliation");
      }

      for (const item of page.items) {
        const mediaRefId = await resolveMediaRef(tx, "jellyfin", item.externalId);
        const current = await lockWatchState(tx, options.profileId, mediaRefId);
        const action = planJellyfinEntry(current, item);
        if (action === "stale") {
          counts.stale += 1;
          continue;
        }
        if (action === "duplicate") {
          counts.duplicate += 1;
          continue;
        }

        const eventKey: PlaybackEventKey = {
          profileId: options.profileId,
          mediaRefId,
          positionTicks: item.positionTicks,
          durationTicks: item.durationTicks ?? undefined,
          completed: item.completed,
          playedAt: item.playedAt,
          recordedBy: "jellyfin_import"
        };
        // An exact replay of an event this run (or a previous one) already
        // recorded is a duplicate: counted, never written twice. The only
        // repair taken is re-seeding an overlay row that lost its event.
        if (await playbackEventExists(tx, eventKey)) {
          if (current === null) {
            await upsertWatchState(tx, options.profileId, mediaRefId, item, item.playedAt ?? now);
          }
          counts.duplicate += 1;
          continue;
        }

        await upsertWatchState(tx, options.profileId, mediaRefId, item, item.playedAt ?? now);
        await appendPlaybackEvent(tx, eventKey);
        counts.applied += 1;
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markSyncFailed(options.source, job, message);
    throw error;
  }

  const cursor = await markSyncSucceeded(options.source, job, new Date(), {
    scanned: page.items.length,
    applied: counts.applied,
    stale: counts.stale,
    duplicate: counts.duplicate,
    skipped: counts.skipped,
    limit
  });
  if (!cursor) throw new Error("household reconcile: cursor vanished between start and success");

  return {
    profileId: options.profileId,
    jellyfinUserId: link.jellyfinUserId,
    scanned: page.items.length,
    applied: counts.applied,
    stale: counts.stale,
    duplicate: counts.duplicate,
    skipped: counts.skipped,
    cursor
  };
}

// Route-edge helper: loads and validates the Jellyfin sync configuration, or
// fails closed with the availability error the API layer maps to 503.
export function loadReconcileJellyfinConfig(
  env: Record<string, string | undefined>
): JellyfinSyncConfig {
  const result = loadJellyfinSyncConfig(env);
  if (result.kind === "unconfigured") {
    throw new JellyfinUnavailableError("Jellyfin integration is not configured");
  }
  if (result.kind === "invalid") {
    throw new JellyfinUnavailableError("Jellyfin integration configuration is invalid");
  }
  return result.config;
}
