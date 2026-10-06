// Shared change-detection and quarantine core for the catalog sync (RH-0039).
//
// Both the full reconciliation (sync.ts) and the incremental refresh
// (incremental.ts) classify every observed item against the row already in
// the catalog and record genuine state transitions — and only those — into
// the append-only media_item_changes history. Classification is pure and
// deterministic: the same (existing row, payload) pair always yields the
// same plan, with changed_fields in a fixed field order, so a scripted
// source sequence replays to an identical history.
//
// Comparison canonicalizes PostgreSQL's wire representations back to the
// normalized shapes (numeric → number, bigint → number, timestamptz → epoch,
// jsonb with sorted-key canonical JSON) so a stored value that only differs
// by column rounding or key order never produces a phantom 'updated'.

import type { QueryResultRow } from "pg";
import type { NormalizedItem } from "./normalize.ts";

// Append-only change history: one row per genuine state transition, written
// inside the same transaction as the item mutation.
export const INSERT_ITEM_CHANGE = `INSERT INTO media_item_changes
  (run_id, item_id, source, jellyfin_id, library_id, change_kind,
   source_revision, observed_at, recorded_at, changed_fields)
  VALUES ($1, $2, 'jellyfin', $3, $4, $5, $6, $7, $8, $9::jsonb)`;

// Set-based companion for inferred transitions (presence-sweep
// removals/restores): the source never reports these, so observed_at is the
// run's inference time, and there is no source revision.
export const INSERT_INFERRED_CHANGES = `INSERT INTO media_item_changes
  (run_id, item_id, source, jellyfin_id, library_id, change_kind,
   source_revision, observed_at, recorded_at, changed_fields)
  SELECT $1, f.item_id, 'jellyfin', f.jellyfin_id, f.library_id, $2,
         NULL, $3, $3, '[]'::jsonb
  FROM unnest($4::bigint[], $5::text[], $6::bigint[])
    AS f(item_id, jellyfin_id, library_id)`;

// Open-quarantine upsert: the first conflicting occurrence records the
// evidence payload; a later run that sees the same conflict again only bumps
// occurrences/last_seen_at (the first payload stays as recorded evidence).
export const QUARANTINE_DUPLICATE = `INSERT INTO media_item_quarantine
  (source, reason, identity, run_id, payload, detail, occurrences, status, first_seen_at, last_seen_at)
  VALUES ('jellyfin', 'duplicate_identity', $1, $2, $3::jsonb, $4, 1, 'quarantined', $5, $5)
  ON CONFLICT (source, identity, reason) WHERE status = 'quarantined' DO UPDATE SET
    occurrences = media_item_quarantine.occurrences + 1,
    last_seen_at = EXCLUDED.last_seen_at,
    run_id = EXCLUDED.run_id,
    detail = EXCLUDED.detail`;

// Advance-only watermark: GREATEST keeps coverage from ever rewinding, no
// matter which run's advance lands last. Full runs seed the row; incremental
// runs always find it (they require the baseline before they start).
export const ADVANCE_WATERMARK = `INSERT INTO media_sync_state (source, watermark, last_run_id)
  VALUES ('jellyfin', $1, $2)
  ON CONFLICT (source) DO UPDATE SET
    watermark = GREATEST(media_sync_state.watermark, EXCLUDED.watermark),
    last_run_id = EXCLUDED.last_run_id,
    updated_at = now()`;

export interface WatermarkRow extends QueryResultRow {
  watermark: Date;
}

export type ChangeKind = "added" | "updated" | "removed" | "restored";

// The catalog content projection an 'updated' row diffs, in the fixed order
// used for changed_fields. Freshness columns (synced_at/last_seen_at/
// source_observed_at) and tombstone state are deliberately excluded: they
// move without the content moving.
export const ITEM_CONTENT_FIELDS = [
  "name",
  "originalTitle",
  "sortName",
  "overview",
  "productionYear",
  "premiereDate",
  "communityRating",
  "officialRating",
  "runtimeTicks",
  "container",
  "filePath",
  "fileSizeBytes",
  "mediaStreams",
  "primaryImageTag",
  "backdropImageTag",
  "etag",
  "dateCreated",
  "parentJellyfinId",
  "seriesJellyfinId",
  "seriesName",
  "seasonJellyfinId",
  "seasonNumber",
  "episodeNumber"
] as const;

// changed_fields is bounded so one pathological payload cannot dominate a
// history row; the field list itself is fixed, so the cap only ever bites on
// a genuinely near-total rewrite.
export const MAX_CHANGED_FIELDS = 50;

export interface ExistingItemRow extends QueryResultRow {
  id: string | number;
  library_id: string | number;
  removed_at: Date | null;
  name: string;
  original_title: string | null;
  sort_name: string | null;
  overview: string | null;
  production_year: number | null;
  premiere_date: Date | null;
  community_rating: string | null;
  official_rating: string | null;
  runtime_ticks: string | null;
  container: string | null;
  file_path: string | null;
  file_size_bytes: string | null;
  media_streams: unknown;
  primary_image_tag: string | null;
  backdrop_image_tag: string | null;
  etag: string | null;
  date_created: Date | null;
  parent_jellyfin_id: string | null;
  series_jellyfin_id: string | null;
  series_name: string | null;
  season_jellyfin_id: string | null;
  season_number: number | null;
  episode_number: number | null;
}

export const SELECT_ITEM_PROJECTION = `SELECT id, library_id, removed_at, name, original_title,
    sort_name, overview, production_year, premiere_date, community_rating,
    official_rating, runtime_ticks, container, file_path, file_size_bytes,
    media_streams, primary_image_tag, backdrop_image_tag, etag, date_created,
    parent_jellyfin_id, series_jellyfin_id, series_name, season_jellyfin_id,
    season_number, episode_number
  FROM media_items WHERE source = 'jellyfin' AND jellyfin_id = $1`;

export interface ItemChangePlan {
  kind: "added" | "updated" | "restored" | "unchanged";
  changedFields: string[];
}

// Pure classification of an observed payload against the stored row (null
// when the item is new). A tombstoned item seen again is a restore; content
// equality suppresses the change entirely (freshness timestamps still
// advance at the caller).
export function planItemChange(
  existing: ExistingItemRow | null,
  item: NormalizedItem,
  libraryId: number
): ItemChangePlan {
  if (!existing) return { kind: "added", changedFields: [] };
  const changedFields = diffItemContent(existing, item, libraryId);
  if (existing.removed_at !== null) {
    return { kind: "restored", changedFields: [] };
  }
  if (changedFields.length > 0) {
    return { kind: "updated", changedFields };
  }
  return { kind: "unchanged", changedFields: [] };
}

function diffItemContent(
  existing: ExistingItemRow,
  item: NormalizedItem,
  libraryId: number
): string[] {
  const changed: string[] = [];
  if (Number(existing.library_id) !== libraryId) changed.push("library");

  const different: Record<string, boolean> = {
    name: existing.name !== item.name,
    originalTitle: existing.original_title !== item.originalTitle,
    sortName: existing.sort_name !== item.sortName,
    overview: existing.overview !== item.overview,
    productionYear: (existing.production_year ?? null) !== item.productionYear,
    premiereDate: !sameTimestamp(existing.premiere_date, item.premiereDate),
    communityRating: !sameNumber(existing.community_rating, item.communityRating, 1),
    officialRating: existing.official_rating !== item.officialRating,
    runtimeTicks: !sameNumber(existing.runtime_ticks, item.runtimeTicks, 0),
    container: existing.container !== item.container,
    filePath: existing.file_path !== item.filePath,
    fileSizeBytes: !sameNumber(existing.file_size_bytes, item.fileSizeBytes, 0),
    mediaStreams: stableStringify(existing.media_streams ?? []) !== stableStringify(item.mediaStreams),
    primaryImageTag: existing.primary_image_tag !== item.primaryImageTag,
    backdropImageTag: existing.backdrop_image_tag !== item.backdropImageTag,
    etag: existing.etag !== item.etag,
    dateCreated: !sameTimestamp(existing.date_created, item.dateCreated),
    parentJellyfinId: existing.parent_jellyfin_id !== item.parentJellyfinId,
    seriesJellyfinId: existing.series_jellyfin_id !== item.seriesJellyfinId,
    seriesName: existing.series_name !== item.seriesName,
    seasonJellyfinId: existing.season_jellyfin_id !== item.seasonJellyfinId,
    seasonNumber: (existing.season_number ?? null) !== item.seasonNumber,
    episodeNumber: (existing.episode_number ?? null) !== item.episodeNumber
  };
  for (const field of ITEM_CONTENT_FIELDS) {
    if (different[field]) changed.push(field);
    if (changed.length >= MAX_CHANGED_FIELDS) return changed;
  }
  return changed;
}

// Numeric columns come back as strings. The comparison canonicalizes the
// incoming value to what the column will actually store — numeric(3,1)
// keeps one decimal, bigint keeps an integer — so column rounding (e.g.
// 7.99 stored as 8.0) is treated as equality, not as an eternal update loop.
function sameNumber(stored: string | null, incoming: number | null, scale: number): boolean {
  if (stored === null || incoming === null) return stored === null && incoming === null;
  const factor = 10 ** scale;
  const canonical = Math.round(incoming * factor) / factor;
  const parsed = Number(stored);
  return Number.isFinite(parsed) && parsed === canonical;
}

function sameTimestamp(stored: Date | null, incomingIso: string | null): boolean {
  if (stored === null || incomingIso === null) return stored === null && incomingIso === null;
  return stored.getTime() === Date.parse(incomingIso);
}

// jsonb does not preserve object key order, so naive JSON.stringify would
// report phantom stream diffs. Canonical form: sorted object keys, arrays in
// order (list order is meaningful for streams/people).
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// The source revision a change is attributed to: Jellyfin's Etag when the
// payload carries one, else the payload's own save time; null when the
// source provides neither.
export function sourceRevisionOf(item: NormalizedItem): string | null {
  return item.etag ?? item.dateLastSaved ?? null;
}

// Deterministic duplicate handling: the source reporting the same Jellyfin
// id twice in one run. Identical repetition (same library, same content
// projection) is a benign overlap — skip it; any difference (placement or
// content) is an ambiguous media identity that must not silently overwrite
// the first occurrence, so the later one is quarantined instead.
export type DuplicateVerdict = "benign" | "conflict";

export function classifyDuplicateOccurrence(
  first: { libraryJellyfinId: string; name: string; itemType: string; etag: string | null },
  second: { libraryJellyfinId: string; name: string; itemType: string; etag: string | null }
): DuplicateVerdict {
  const same =
    first.libraryJellyfinId === second.libraryJellyfinId &&
    first.name === second.name &&
    first.itemType === second.itemType &&
    first.etag === second.etag;
  return same ? "benign" : "conflict";
}

// Bounded quarantine payload: identity, placement, and revision markers —
// evidence enough to repair (RH-0036) without dumping whole payloads.
export function quarantinePayloadOf(
  item: NormalizedItem,
  libraryJellyfinId: string
): Record<string, unknown> {
  return {
    jellyfinId: item.jellyfinId,
    itemType: item.itemType,
    name: item.name,
    libraryJellyfinId,
    etag: item.etag,
    dateLastSaved: item.dateLastSaved,
    filePath: item.filePath,
    providerIds: item.providerIds.map((provider) => ({ name: provider.name, value: provider.value }))
  };
}

// Watermark windowing: the delta query re-covers one second behind the
// stored watermark so a boundary item can never fall between two runs — a
// re-covered item is an idempotent no-op, a missed one is silent loss.
export const WATERMARK_OVERLAP_MS = 1_000;

export function deltaWindowStart(watermark: Date): string {
  return new Date(watermark.getTime() - WATERMARK_OVERLAP_MS).toISOString();
}

// Advance-only watermark: the next window starts at the newest source
// timestamp this run actually observed. Items without DateLastSaved do not
// advance it (they are re-covered next run — idempotent), and the result is
// never earlier than the stored watermark. A null current (a full run
// seeding the baseline) falls back to the epoch, so a first run without any
// observed save time covers everything next time — never less.
export function nextWatermark(current: Date | null, observedDates: (Date | null)[]): Date {
  let latest = current === null ? 0 : current.getTime();
  for (const observed of observedDates) {
    if (observed !== null && observed.getTime() > latest) latest = observed.getTime();
  }
  return new Date(latest);
}
