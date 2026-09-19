// Household lists persistence (RH-0018): favorites, watchlists, curated
// collections + membership, and home-row configuration over the RH-0003
// schema in the `reelhouse` database.
//
// This module sits beside store.ts (RH-0017's profiles / preferences /
// watch-state / links) and shares its primitives: the injected SqlRunner,
// transact() for atomic multi-step operations, resolveMediaRef() for the
// stable media bridge, and the typed error family mapped centrally in
// api.ts. Multi-step operations here are orchestrated by idempotency.ts,
// which runs them inside the same transaction as their idempotency claim.
//
// Semantics carried over from the RH-0018 design:
// - Profile isolation is enforced in SQL: profile-owned rows are always
//   addressed by (id, profile_id) pairs, so another profile's rows are
//   indistinguishable from absent rows (404, never a 403 existence leak).
// - Item positions need not be contiguous (RH-0003's contract): an explicit
//   position splices (neighbors shift), reads order by (position, added_at,
//   id), and reorder renumbers 1..n only when the submitted set equals the
//   current set — anything else is a conflict (409).
// - Media identity is (source, external_id) via media_item_ref; rows are
//   resolved-or-created on write and required on read. Jellyfin ids are
//   data here, never identity, and Jellyfin itself is never contacted.

import type { QueryResultRow } from "pg";
import {
  HouseholdConflictError,
  HouseholdNotFoundError
} from "./errors.ts";
import type { SqlRunner } from "./store.ts";
import { resolveMediaRef } from "./store.ts";
import type { ValidatedHomeRowSource, ValidatedMediaRef } from "./model.ts";
import { iso } from "./model.ts";

export { resolveMediaRef };

// ---- Views -----------------------------------------------------------------

export interface MediaRefView {
  mediaRefId: string;
  source: string;
  externalId: string;
}

export interface FavoriteView extends MediaRefView {
  profileId: string;
  createdAt: string;
}

export interface WatchlistSummary {
  id: string;
  profileId: string;
  name: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WatchlistItemView extends MediaRefView {
  position: number;
  addedAt: string;
}

export interface WatchlistDetail {
  id: string;
  profileId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  items: WatchlistItemView[];
}

export interface CollectionSummary {
  id: string;
  name: string;
  description: string;
  itemCount: number;
  createdByProfileId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionDetail {
  id: string;
  name: string;
  description: string;
  createdByProfileId: string | null;
  createdAt: string;
  updatedAt: string;
  items: WatchlistItemView[];
}

export interface HomeRowView {
  id: string;
  rowKey: string;
  title: string;
  sourceKind: string;
  sourceKey: string | null;
  collectionId: string | null;
  position: number;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---- Profiles and media identity -------------------------------------------

// Fail closed on unknown profiles: every profile-scoped operation validates
// existence first so stale clients get a clean 404 instead of FK errors.
export async function requireProfile(runner: SqlRunner, profileId: string): Promise<void> {
  const result = await runner.query("SELECT 1 FROM household_profile WHERE id = $1", [profileId]);
  if ((result.rowCount ?? 0) === 0) throw new HouseholdNotFoundError("profile does not exist");
}

// Read-side counterpart of resolveMediaRef: a favorite/watchlist/collection
// cannot be expected to reference media ReelHouse has never seen.
export async function requireMediaRef(runner: SqlRunner, media: ValidatedMediaRef): Promise<string> {
  const result = await runner.query<{ id: string }>(
    "SELECT id FROM media_item_ref WHERE source = $1 AND external_id = $2",
    [media.source, media.externalId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new HouseholdNotFoundError("media item is not known to ReelHouse");
  }
  return result.rows[0].id;
}

async function mediaRefById(runner: SqlRunner, mediaRefId: string): Promise<MediaRefView> {
  const result = await runner.query<{ id: string; source: string; external_id: string }>(
    "SELECT id, source, external_id FROM media_item_ref WHERE id = $1",
    [mediaRefId]
  );
  const row = result.rows[0];
  return { mediaRefId: row.id, source: row.source, externalId: row.external_id };
}

// ---- Favorites --------------------------------------------------------------

export async function addFavorite(
  runner: SqlRunner,
  profileId: string,
  mediaRefId: string
): Promise<{ favorite: FavoriteView; created: boolean }> {
  const inserted = await runner.query<{ created_at: Date }>(
    "INSERT INTO favorite (profile_id, media_ref_id) VALUES ($1, $2) ON CONFLICT (profile_id, media_ref_id) DO NOTHING RETURNING created_at",
    [profileId, mediaRefId]
  );
  const media = await mediaRefById(runner, mediaRefId);
  if ((inserted.rowCount ?? 0) === 1) {
    return {
      created: true,
      favorite: { profileId, ...media, createdAt: iso(inserted.rows[0].created_at) }
    };
  }
  const existing = await runner.query<{ created_at: Date }>(
    "SELECT created_at FROM favorite WHERE profile_id = $1 AND media_ref_id = $2",
    [profileId, mediaRefId]
  );
  return {
    created: false,
    favorite: { profileId, ...media, createdAt: iso(existing.rows[0].created_at) }
  };
}

export async function removeFavorite(
  runner: SqlRunner,
  profileId: string,
  mediaRefId: string
): Promise<{ removed: boolean }> {
  const result = await runner.query("DELETE FROM favorite WHERE profile_id = $1 AND media_ref_id = $2", [
    profileId,
    mediaRefId
  ]);
  return { removed: (result.rowCount ?? 0) === 1 };
}

export async function listFavorites(runner: SqlRunner, profileId: string, limit: number): Promise<FavoriteView[]> {
  const result = await runner.query<{
    media_ref_id: string;
    source: string;
    external_id: string;
    created_at: Date;
  }>(
    `SELECT f.media_ref_id, m.source, m.external_id, f.created_at
       FROM favorite f JOIN media_item_ref m ON m.id = f.media_ref_id
      WHERE f.profile_id = $1
      ORDER BY f.created_at, f.media_ref_id
      LIMIT $2`,
    [profileId, limit]
  );
  return result.rows.map((row) => ({
    profileId,
    mediaRefId: row.media_ref_id,
    source: row.source,
    externalId: row.external_id,
    createdAt: iso(row.created_at)
  }));
}

// ---- Watchlists ---------------------------------------------------------------

const WATCHLIST_SUMMARY_SQL = `
  SELECT w.id, w.profile_id, w.name, w.created_at, w.updated_at,
         (SELECT count(*) FROM watchlist_item i WHERE i.watchlist_id = w.id) AS item_count
    FROM watchlist w`;

interface WatchlistSummaryRow extends QueryResultRow {
  id: string;
  profile_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  item_count: string;
}

function mapWatchlistSummary(row: WatchlistSummaryRow): WatchlistSummary {
  return {
    id: row.id,
    profileId: row.profile_id,
    name: row.name,
    itemCount: Number(row.item_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

// Tolerant create: the unique (profile, lower(name)) index makes a repeated
// create (double-tap, replay without a key) return the existing list.
export async function createWatchlist(
  runner: SqlRunner,
  profileId: string,
  name: string
): Promise<{ watchlist: WatchlistSummary; created: boolean }> {
  const result = await runner.query<{ id: string }>(
    "INSERT INTO watchlist (profile_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id",
    [profileId, name]
  );
  const id =
    (result.rowCount ?? 0) === 1
      ? result.rows[0].id
      : (
          await runner.query<{ id: string }>(
            "SELECT id FROM watchlist WHERE profile_id = $1 AND lower(name) = lower($2)",
            [profileId, name]
          )
        ).rows[0].id;
  return { watchlist: await requireWatchlistSummary(runner, id), created: (result.rowCount ?? 0) === 1 };
}

async function requireWatchlistSummary(runner: SqlRunner, watchlistId: string): Promise<WatchlistSummary> {
  const result = await runner.query<WatchlistSummaryRow>(`${WATCHLIST_SUMMARY_SQL} WHERE w.id = $1`, [watchlistId]);
  if ((result.rowCount ?? 0) === 0) {
    throw new HouseholdNotFoundError("watchlist does not exist for this profile");
  }
  return mapWatchlistSummary(result.rows[0]);
}

export async function listWatchlists(runner: SqlRunner, profileId: string): Promise<WatchlistSummary[]> {
  const result = await runner.query<WatchlistSummaryRow>(
    `${WATCHLIST_SUMMARY_SQL} WHERE w.profile_id = $1 ORDER BY w.created_at, w.id`,
    [profileId]
  );
  return result.rows.map(mapWatchlistSummary);
}

// Isolation: profile_id in the WHERE clause makes a foreign watchlist look
// exactly like a missing one.
export async function getWatchlist(runner: SqlRunner, profileId: string, watchlistId: string): Promise<WatchlistDetail> {
  const summary = await requireOwnedWatchlistSummary(runner, profileId, watchlistId);
  const items = await listOrderedItems(runner, WATCHLIST_ITEMS, summary.id);
  return {
    id: summary.id,
    profileId: summary.profileId,
    name: summary.name,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    items
  };
}

async function requireOwnedWatchlistSummary(
  runner: SqlRunner,
  profileId: string,
  watchlistId: string
): Promise<WatchlistSummary> {
  const result = await runner.query<WatchlistSummaryRow>(
    `${WATCHLIST_SUMMARY_SQL} WHERE w.id = $1 AND w.profile_id = $2`,
    [watchlistId, profileId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new HouseholdNotFoundError("watchlist does not exist for this profile");
  }
  return mapWatchlistSummary(result.rows[0]);
}

export async function renameWatchlist(
  runner: SqlRunner,
  profileId: string,
  watchlistId: string,
  name: string
): Promise<WatchlistDetail> {
  await requireOwnedWatchlistSummary(runner, profileId, watchlistId);
  // Pre-check the collision for a clean message; a race would surface as a
  // raw unique violation, which api.ts classifies as a 409 anyway.
  const clash = await runner.query<{ id: string }>(
    "SELECT id FROM watchlist WHERE profile_id = $1 AND lower(name) = lower($2) AND id <> $3",
    [profileId, name, watchlistId]
  );
  if ((clash.rowCount ?? 0) > 0) {
    throw new HouseholdConflictError("another watchlist already has this name");
  }
  await runner.query("UPDATE watchlist SET name = $1 WHERE id = $2", [name, watchlistId]);
  return getWatchlist(runner, profileId, watchlistId);
}

export async function deleteWatchlist(
  runner: SqlRunner,
  profileId: string,
  watchlistId: string
): Promise<{ deleted: boolean }> {
  const result = await runner.query("DELETE FROM watchlist WHERE id = $1 AND profile_id = $2", [
    watchlistId,
    profileId
  ]);
  if ((result.rowCount ?? 0) === 0) {
    throw new HouseholdNotFoundError("watchlist does not exist for this profile");
  }
  return { deleted: true };
}

// ---- Ordered items (watchlist_item / collection_item share one shape) ---------

const ITEM_VIEW_SQL = (table: string, ownerColumn: string) => `
  SELECT i.media_ref_id, m.source, m.external_id, i.position, i.added_at
    FROM ${table} i JOIN media_item_ref m ON m.id = i.media_ref_id
   WHERE i.${ownerColumn} = $1
   ORDER BY i.position, i.added_at, i.media_ref_id`;

interface ItemRow extends QueryResultRow {
  media_ref_id: string;
  source: string;
  external_id: string;
  position: number;
  added_at: Date;
}

function mapItem(row: ItemRow): WatchlistItemView {
  return {
    mediaRefId: row.media_ref_id,
    source: row.source,
    externalId: row.external_id,
    position: Number(row.position),
    addedAt: iso(row.added_at)
  };
}

async function listOrderedItems(runner: SqlRunner, items: PositionedTable, ownerId: string): Promise<WatchlistItemView[]> {
  const result = await runner.query<ItemRow>(ITEM_VIEW_SQL(items.table, items.ownerColumn), [ownerId]);
  return result.rows.map(mapItem);
}

// Table and column names are compile-time constants below — never user
// input — so the interpolations are safe.
export interface PositionedTable {
  table: "watchlist_item" | "collection_item";
  ownerColumn: "watchlist_id" | "collection_id";
}

export const WATCHLIST_ITEMS: PositionedTable = { table: "watchlist_item", ownerColumn: "watchlist_id" };
export const COLLECTION_ITEMS: PositionedTable = { table: "collection_item", ownerColumn: "collection_id" };

// Add-or-move one positioned item. Absent position = append (or no-op move
// for an existing member); explicit position splices the neighbors so the
// submitted order is the order readers see.
export async function upsertPositionedItem(
  runner: SqlRunner,
  items: PositionedTable,
  ownerId: string,
  mediaRefId: string,
  position: number | undefined
): Promise<{ created: boolean; position: number }> {
  const current = await runner.query<{ position: number }>(
    `SELECT position FROM ${items.table} WHERE ${items.ownerColumn} = $1 AND media_ref_id = $2`,
    [ownerId, mediaRefId]
  );
  const maxResult = await runner.query<{ max: number | null }>(
    `SELECT max(position) AS max FROM ${items.table} WHERE ${items.ownerColumn} = $1`,
    [ownerId]
  );
  const maxPosition = maxResult.rows[0].max === null ? 0 : Number(maxResult.rows[0].max);

  // Existing member without an explicit position: replay/no-op.
  if ((current.rowCount ?? 0) === 1 && position === undefined) {
    return { created: false, position: Number(current.rows[0].position) };
  }

  const target = position ?? maxPosition + 1;

  if ((current.rowCount ?? 0) === 1) {
    const from = Number(current.rows[0].position);
    if (from !== target) {
      if (from < target) {
        await runner.query(
          `UPDATE ${items.table} SET position = position - 1
            WHERE ${items.ownerColumn} = $1 AND position > $2 AND position <= $3`,
          [ownerId, from, target]
        );
      } else {
        await runner.query(
          `UPDATE ${items.table} SET position = position + 1
            WHERE ${items.ownerColumn} = $1 AND position >= $2 AND position < $3`,
          [ownerId, target, from]
        );
      }
      await runner.query(
        `UPDATE ${items.table} SET position = $1 WHERE ${items.ownerColumn} = $2 AND media_ref_id = $3`,
        [target, ownerId, mediaRefId]
      );
    }
    return { created: false, position: target };
  }

  if (position !== undefined && position <= maxPosition) {
    await runner.query(
      `UPDATE ${items.table} SET position = position + 1
        WHERE ${items.ownerColumn} = $1 AND position >= $2`,
      [ownerId, position]
    );
  }
  await runner.query(
    `INSERT INTO ${items.table} (${items.ownerColumn}, media_ref_id, position) VALUES ($1, $2, $3)`,
    [ownerId, mediaRefId, target]
  );
  return { created: true, position: target };
}

export async function removePositionedItem(
  runner: SqlRunner,
  items: PositionedTable,
  ownerId: string,
  mediaRefId: string
): Promise<{ removed: boolean }> {
  const result = await runner.query(
    `DELETE FROM ${items.table} WHERE ${items.ownerColumn} = $1 AND media_ref_id = $2`,
    [ownerId, mediaRefId]
  );
  return { removed: (result.rowCount ?? 0) === 1 };
}

// Reorder is atomic and stale-proof: the submitted set must equal the
// current membership set, else conflict (409). Positions are then
// renumbered 1..n in the submitted order.
export async function reorderPositionedItems(
  runner: SqlRunner,
  items: PositionedTable,
  ownerId: string,
  orderedMediaRefIds: string[]
): Promise<WatchlistItemView[]> {
  const current = await runner.query<{ media_ref_id: string }>(
    `SELECT media_ref_id FROM ${items.table} WHERE ${items.ownerColumn} = $1`,
    [ownerId]
  );
  const currentIds = current.rows.map((row) => row.media_ref_id).sort();
  const submittedIds = [...orderedMediaRefIds].sort();
  const sameSet =
    currentIds.length === submittedIds.length && currentIds.every((id, index) => id === submittedIds[index]);
  if (!sameSet) {
    throw new HouseholdConflictError(
      `submitted item set does not match the current membership (current=${currentIds.length}, submitted=${submittedIds.length}); reload and retry`
    );
  }
  for (let index = 0; index < orderedMediaRefIds.length; index++) {
    await runner.query(
      `UPDATE ${items.table} SET position = $1 WHERE ${items.ownerColumn} = $2 AND media_ref_id = $3`,
      [index + 1, ownerId, orderedMediaRefIds[index]]
    );
  }
  return listOrderedItems(runner, items, ownerId);
}

// ---- Watchlist item operations (ownership-checked) -----------------------------

export async function addWatchlistItem(
  runner: SqlRunner,
  profileId: string,
  watchlistId: string,
  mediaRefId: string,
  position: number | undefined
): Promise<{ item: WatchlistItemView; created: boolean }> {
  const watchlist = await requireOwnedWatchlistSummary(runner, profileId, watchlistId);
  const result = await upsertPositionedItem(runner, WATCHLIST_ITEMS, watchlist.id, mediaRefId, position);
  const items = await listOrderedItems(runner, WATCHLIST_ITEMS, watchlist.id);
  const item = items.find((entry) => entry.mediaRefId === mediaRefId);
  if (!item) throw new Error("household lists: item vanished during write"); // unreachable
  return { item, created: result.created };
}

export async function removeWatchlistItem(
  runner: SqlRunner,
  profileId: string,
  watchlistId: string,
  mediaRefId: string
): Promise<{ removed: boolean }> {
  const watchlist = await requireOwnedWatchlistSummary(runner, profileId, watchlistId);
  return removePositionedItem(runner, WATCHLIST_ITEMS, watchlist.id, mediaRefId);
}

export async function reorderWatchlistItems(
  runner: SqlRunner,
  profileId: string,
  watchlistId: string,
  orderedMediaRefIds: string[]
): Promise<WatchlistItemView[]> {
  const watchlist = await requireOwnedWatchlistSummary(runner, profileId, watchlistId);
  return reorderPositionedItems(runner, WATCHLIST_ITEMS, watchlist.id, orderedMediaRefIds);
}

// ---- Collections (household-level curation) ------------------------------------

const COLLECTION_SUMMARY_SQL = `
  SELECT c.id, c.name, c.description, c.created_by_profile_id, c.created_at, c.updated_at,
         (SELECT count(*) FROM collection_item i WHERE i.collection_id = c.id) AS item_count
    FROM collection c`;

interface CollectionSummaryRow extends QueryResultRow {
  id: string;
  name: string;
  description: string;
  created_by_profile_id: string | null;
  created_at: Date;
  updated_at: Date;
  item_count: string;
}

function mapCollectionSummary(row: CollectionSummaryRow): CollectionSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    itemCount: Number(row.item_count),
    createdByProfileId: row.created_by_profile_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

async function requireCollectionSummary(runner: SqlRunner, collectionId: string): Promise<CollectionSummary> {
  const result = await runner.query<CollectionSummaryRow>(`${COLLECTION_SUMMARY_SQL} WHERE c.id = $1`, [collectionId]);
  if ((result.rowCount ?? 0) === 0) throw new HouseholdNotFoundError("collection does not exist");
  return mapCollectionSummary(result.rows[0]);
}

export async function createCollection(
  runner: SqlRunner,
  input: { name: string; description?: string; createdByProfileId?: string }
): Promise<{ collection: CollectionSummary; created: boolean }> {
  const result = await runner.query<{ id: string }>(
    "INSERT INTO collection (name, description, created_by_profile_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id",
    [input.name, input.description ?? "", input.createdByProfileId ?? null]
  );
  const id =
    (result.rowCount ?? 0) === 1
      ? result.rows[0].id
      : (
          await runner.query<{ id: string }>("SELECT id FROM collection WHERE lower(name) = lower($1)", [input.name])
        ).rows[0].id;
  return { collection: await requireCollectionSummary(runner, id), created: (result.rowCount ?? 0) === 1 };
}

export async function listCollections(runner: SqlRunner): Promise<CollectionSummary[]> {
  const result = await runner.query<CollectionSummaryRow>(`${COLLECTION_SUMMARY_SQL} ORDER BY c.created_at, c.id`);
  return result.rows.map(mapCollectionSummary);
}

export async function getCollection(runner: SqlRunner, collectionId: string): Promise<CollectionDetail> {
  const summary = await requireCollectionSummary(runner, collectionId);
  const items = await listOrderedItems(runner, COLLECTION_ITEMS, summary.id);
  return {
    id: summary.id,
    name: summary.name,
    description: summary.description,
    createdByProfileId: summary.createdByProfileId,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    items
  };
}

// Strict rename: the id was addressed explicitly, so a name collision is a
// real conflict (unlike create, which tolerates repeats).
export async function updateCollection(
  runner: SqlRunner,
  collectionId: string,
  input: { name?: string; description?: string }
): Promise<CollectionDetail> {
  await requireCollectionSummary(runner, collectionId);
  const current = await runner.query<{ name: string; description: string }>(
    "SELECT name, description FROM collection WHERE id = $1",
    [collectionId]
  );
  const name = input.name ?? current.rows[0].name;
  const description = input.description ?? current.rows[0].description;
  const clash =
    input.name === undefined
      ? { rowCount: 0 }
      : await runner.query<{ id: string }>(
          "SELECT id FROM collection WHERE lower(name) = lower($1) AND id <> $2",
          [name, collectionId]
        );
  if ((clash.rowCount ?? 0) > 0) {
    throw new HouseholdConflictError("another collection already has this name");
  }
  await runner.query("UPDATE collection SET name = $1, description = $2 WHERE id = $3", [
    name,
    description,
    collectionId
  ]);
  return getCollection(runner, collectionId);
}

// Cascades collection items; home rows sourced from the collection cascade
// too (RH-0003 design: a home row may not dangle).
export async function deleteCollection(runner: SqlRunner, collectionId: string): Promise<{ deleted: boolean }> {
  const result = await runner.query("DELETE FROM collection WHERE id = $1", [collectionId]);
  if ((result.rowCount ?? 0) === 0) throw new HouseholdNotFoundError("collection does not exist");
  return { deleted: true };
}

export async function addCollectionItem(
  runner: SqlRunner,
  collectionId: string,
  mediaRefId: string,
  position: number | undefined
): Promise<{ item: WatchlistItemView; created: boolean }> {
  await requireCollectionSummary(runner, collectionId);
  const result = await upsertPositionedItem(runner, COLLECTION_ITEMS, collectionId, mediaRefId, position);
  const items = await listOrderedItems(runner, COLLECTION_ITEMS, collectionId);
  const item = items.find((entry) => entry.mediaRefId === mediaRefId);
  if (!item) throw new Error("household lists: item vanished during write"); // unreachable
  return { item, created: result.created };
}

export async function removeCollectionItem(
  runner: SqlRunner,
  collectionId: string,
  mediaRefId: string
): Promise<{ removed: boolean }> {
  return removePositionedItem(runner, COLLECTION_ITEMS, collectionId, mediaRefId);
}

export async function reorderCollectionItems(
  runner: SqlRunner,
  collectionId: string,
  orderedMediaRefIds: string[]
): Promise<WatchlistItemView[]> {
  await requireCollectionSummary(runner, collectionId);
  return reorderPositionedItems(runner, COLLECTION_ITEMS, collectionId, orderedMediaRefIds);
}

// ---- Home rows ------------------------------------------------------------------

interface HomeRowDbRow extends QueryResultRow {
  id: string;
  row_key: string;
  title: string;
  source_kind: string;
  source_key: string | null;
  collection_id: string | null;
  position: number;
  is_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

function mapHomeRow(row: HomeRowDbRow): HomeRowView {
  return {
    id: row.id,
    rowKey: row.row_key,
    title: row.title,
    sourceKind: row.source_kind,
    sourceKey: row.source_key,
    collectionId: row.collection_id,
    position: Number(row.position),
    isEnabled: row.is_enabled,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

const HOME_ROW_SQL = `
  SELECT id, row_key, title, source_kind, source_key, collection_id, position, is_enabled, created_at, updated_at
    FROM home_row`;

export async function listHomeRows(runner: SqlRunner): Promise<HomeRowView[]> {
  const result = await runner.query<HomeRowDbRow>(`${HOME_ROW_SQL} ORDER BY position, id`, []);
  return result.rows.map(mapHomeRow);
}

// A collection-sourced row requires a live collection (the FK alone would
// create it, but the 404 must fire before the write so the client learns
// which part of the payload was stale).
async function requireCollectionForSource(runner: SqlRunner, source: ValidatedHomeRowSource): Promise<void> {
  if (source.kind === "collection") await requireCollectionSummary(runner, source.collectionId);
}

function sourceParams(source: ValidatedHomeRowSource): {
  sourceKind: string;
  sourceKey: string | null;
  collectionId: string | null;
} {
  return source.kind === "collection"
    ? { sourceKind: "collection", sourceKey: null, collectionId: source.collectionId }
    : { sourceKind: "jellyfin_section", sourceKey: source.sourceKey, collectionId: null };
}

export async function createHomeRow(
  runner: SqlRunner,
  input: {
    rowKey: string;
    title: string;
    source: ValidatedHomeRowSource;
    position?: number;
  }
): Promise<{ row: HomeRowView; created: boolean }> {
  await requireCollectionForSource(runner, input.source);
  const { sourceKind, sourceKey, collectionId } = sourceParams(input.source);
  // Absent position appends; an explicit position splices (rows at or after
  // it shift up first so the target slot is vacated).
  const next = await runner.query<{ next: number }>("SELECT COALESCE(max(position), 0) + 1 AS next FROM home_row", []);
  const target = input.position ?? Number(next.rows[0].next);
  if (input.position !== undefined && input.position <= Number(next.rows[0].next) - 1) {
    await runner.query("UPDATE home_row SET position = position + 1 WHERE position >= $1", [target]);
  }
  const inserted = await runner.query<{ id: string }>(
    `INSERT INTO home_row (row_key, title, source_kind, source_key, collection_id, position)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (row_key) DO NOTHING RETURNING id`,
    [input.rowKey, input.title, sourceKind, sourceKey, collectionId, target]
  );
  if ((inserted.rowCount ?? 0) === 1) {
    return { row: await requireHomeRow(runner, inserted.rows[0].id), created: true };
  }
  // Lost the row_key race (or a replay): surface the existing row untouched.
  const existing = await runner.query<{ id: string }>("SELECT id FROM home_row WHERE row_key = $1", [input.rowKey]);
  return { row: await requireHomeRow(runner, existing.rows[0].id), created: false };
}

export async function requireHomeRow(runner: SqlRunner, rowId: string): Promise<HomeRowView> {
  const result = await runner.query<HomeRowDbRow>(`${HOME_ROW_SQL} WHERE id = $1`, [rowId]);
  if ((result.rowCount ?? 0) === 0) throw new HouseholdNotFoundError("home row does not exist");
  return mapHomeRow(result.rows[0]);
}

export async function updateHomeRow(
  runner: SqlRunner,
  rowId: string,
  input: { title?: string; isEnabled?: boolean; source?: ValidatedHomeRowSource }
): Promise<HomeRowView> {
  const current = await requireHomeRow(runner, rowId);
  const source = input.source ?? sourceFromRow(current);
  await requireCollectionForSource(runner, source);
  const { sourceKind, sourceKey, collectionId } = sourceParams(source);
  await runner.query(
    `UPDATE home_row
        SET title = $1, is_enabled = $2, source_kind = $3, source_key = $4, collection_id = $5
      WHERE id = $6`,
    [input.title ?? current.title, input.isEnabled ?? current.isEnabled, sourceKind, sourceKey, collectionId, rowId]
  );
  return requireHomeRow(runner, rowId);
}

function sourceFromRow(row: HomeRowView): ValidatedHomeRowSource {
  return row.sourceKind === "collection"
    ? { kind: "collection", collectionId: row.collectionId ?? "" }
    : { kind: "jellyfin_section", sourceKey: row.sourceKey ?? "" };
}

export async function deleteHomeRow(runner: SqlRunner, rowId: string): Promise<{ deleted: boolean }> {
  const result = await runner.query("DELETE FROM home_row WHERE id = $1", [rowId]);
  if ((result.rowCount ?? 0) === 0) throw new HouseholdNotFoundError("home row does not exist");
  return { deleted: true };
}

export async function reorderHomeRows(runner: SqlRunner, orderedRowIds: string[]): Promise<HomeRowView[]> {
  const current = await runner.query<{ id: string }>("SELECT id FROM home_row", []);
  const currentIds = current.rows.map((row) => row.id).sort();
  const submittedIds = [...orderedRowIds].sort();
  const sameSet =
    currentIds.length === submittedIds.length && currentIds.every((id, index) => id === submittedIds[index]);
  if (!sameSet) {
    throw new HouseholdConflictError(
      `submitted row set does not match the current home rows (current=${currentIds.length}, submitted=${submittedIds.length}); reload and retry`
    );
  }
  for (let index = 0; index < orderedRowIds.length; index++) {
    await runner.query("UPDATE home_row SET position = $1 WHERE id = $2", [index + 1, orderedRowIds[index]]);
  }
  return listHomeRows(runner);
}
