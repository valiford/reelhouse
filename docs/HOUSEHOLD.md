# ReelHouse household state — schema, identity, and snapshot import (RH-0033)

The household state (the `household_*` table family in the `reelhouse`
PostgreSQL 18 database) owns **ReelHouse household state**: profiles,
preferences, favorites, watchlists, curated collections, home-screen row
configuration, the continue-watching overlay, playback history, and the
Jellyfin account/item links that tie it all back to the media engine. It is
a separate authority from `media_catalog` (the normalized Jellyfin mirror,
see [CATALOG.md](CATALOG.md)) and from Jellyfin itself, which remains the
playback/library authority reached only through its API — ReelHouse never
reads or writes Jellyfin's internal database, and clients never receive
PostgreSQL credentials.

## Components

| Path | Role |
|---|---|
| `db/migrations/0007_household_state.sql` | Versioned household schema (see `docs/DATABASE.md` for the migration contract). |
| `src/lib/household/manifest.ts` | Pure manifest validation/normalization: fail-closed field, enum, bound, and identity checks; first-wins duplicate policy; deterministic payload derivation. No I/O, no clock. |
| `src/lib/household/load.ts` | Idempotent snapshot loader: guarded upserts, tombstoned removals, set-once provenance stamps, resolved catalog links, run history. |
| `src/lib/catalog/pg-executor.ts` | The shared pg Pool/Client adapter (one pinned connection per transaction). |
| `scripts/household-import.ts` | CLI: `npm run household:import -- path/to/snapshot.json`. |
| `scripts/dev/household-sample.json` | Deterministic sample snapshot for live verification against the dev database + Jellyfin stub. |

## Schema

| Table | Holds |
|---|---|
| `household_profiles` | Household members. Identity is `slug` (derived once from the display name, then pinned — renames never rewrite rows); `archived_at` is a tombstone; the partial unique index `household_profiles_default_idx` enforces at most one ACTIVE default profile. |
| `household_preferences` | Key/value preferences per profile from a known key registry (`theme`, `autoplay_next`, `reduced_motion`, `preferred_audio_language`, `preferred_subtitle_language`). A snapshot-absent key is removed (preferences are state, not history). |
| `household_jellyfin_accounts` | Which Jellyfin user drives which profile. A Jellyfin user can never drive two profiles (global unique); a link is a pointer — moving or dropping it is not history. |
| `household_favorites` | Per-profile favorite items: `(profile, source, jellyfin_id)` identity, catalog-resolved `item_id` link, payload-order `position`, set-once `first_added_at`, `removed_at` tombstone. |
| `household_watchlists` + `household_watchlist_entries` | Per-profile named lists with the same entry shape as favorites; lists absent from a confirmed profile's snapshot are archived. |
| `household_collections` + `household_collection_entries` | Household-wide curated collections (referenced by home rows), same entry shape. |
| `household_home_rows` | Per-profile home-screen rail configuration: closed `kind` set (`continue_watching`, `recently_added`, `favorites`, `library`, `collection`, `watchlist`), payload-order `position`, `enabled`, and one bounded `config` key per reference kind. |
| `household_watch_state` | ReelHouse-owned watch/continue state per profile and item: position/duration ticks, `completed`, and `hidden_from_continue` (the continue-watching overlay — hide from the rail without losing progress). `first_played_at` is set once; absent-from-snapshot state is tombstoned. |
| `household_playback_history` | Append-only playback events with the deterministic identity `(profile, source, jellyfin_id, played_at)`; watch state is the live projection, this is the record. |
| `household_sync_runs` | Append-only provenance/freshness record per import: status, counters (seen/upserted/removed/archived per surface, unresolved links, skipped conflicts), scrubbed error detail. |

## Identity, provenance, isolation

- **Profile identity:** the `slug` (lowercase `^[a-z0-9_]+$`, derived from
  the display name) is contractual. Two different names mapping to one slug
  is ambiguous household identity and fails the import closed.
- **Item identity:** every item-scoped row carries `(source, jellyfin_id)` —
  the same stable identity the catalog uses — plus a nullable resolved
  `item_id` link into `media_items` (COALESCE-preserved: an import that
  cannot resolve the link never erases a previously known one, and a later
  import links it automatically once the catalog has synced the item).
  Unresolved references are tolerated and counted (`unresolved_links`): a
  household can reference an item before the catalog has ever seen it.
- **Profile isolation is structural:** every profile-scoped statement is
  parameterized by `profile_id` and scoped again in its `WHERE` clause. A
  snapshot that omits a profile archives it (tombstone) and leaves every
  row of theirs byte-identical; re-asserting the profile restores it.
- **Provenance stamps:** `created_at` / `first_added_at` / `first_played_at`
  are set once and never rewritten; re-adding a removed favorite or
  resurrecting archived state clears the tombstone and keeps the original
  stamps.

## Import algorithm (`npm run household:import`)

The manifest is a **complete household snapshot** (see
`scripts/dev/household-sample.json` for the full shape). The import:

1. Appends a `household_sync_runs` row (`running`).
2. Validates/normalizes the manifest (fail closed on unknown fields, bad
   enums, unparseable timestamps, out-of-bound sizes, ambiguous identities).
   Item-level duplicates inside one snapshot are benign when identical and
   counted as skipped conflicts when they differ (first occurrence wins).
   A snapshot with **zero profiles fails closed** — that is far more likely
   a truncated or mis-scoped export than an emptied household, and
   reconciling to it would archive everyone.
3. Resolves every referenced Jellyfin id against `media_items` in one query.
4. In ONE transaction (snapshots are bounded by the manifest limits, so the
   transaction is bounded): demotes stale defaults, re-owns moved Jellyfin
   accounts, upserts profiles/preferences/favorites/watchlists/home rows/
   watch state (all `IS DISTINCT`-guarded so an unchanged row is a true
   no-op), tombstones/archives snapshot-absent rows scoped to confirmed
   profiles, appends deduplicated playback history, and reconciles the
   household-wide collections.
5. Completes the run row with the write counters — a no-op re-import
   reports **zero writes** and leaves every table byte-identical.

A failure at any point rolls the whole transaction back (zero partial
state), records the failed run with a scrubbed detail, and the retry is a
clean recovery.

Required environment: `DATABASE_URL` (application role). The manifest path
is the CLI argument or `HOUSEHOLD_IMPORT_FILE`; the file is bounded at
16 MiB and fails closed over it. Migrations must already be applied
(`npm run db:migrate`).

## Verification

```bash
npm test         # hermetic: manifest contract matrix (no DB)
npm run test:int # adds household integration evidence (disposable local PG18)
```

Integration scenarios: migration 0007 + schema invariants (single active
default, closed run-status vocabulary, unique slugs), first import with
catalog-resolved links under the least-privilege app role, byte-identical
no-op re-import, snapshot evolution (rename/tombstone/resurrect preserving
provenance, default reassignment, Jellyfin account moves, unlinks), profile
isolation (partial snapshots archive and restore without touching other
profiles), the zero-profile guard, mid-transaction failure atomicity with a
recorded failed run and clean recovery, and app-role DDL rejection. Set
`REELHOUSE_TEST_MIGRATE_URL` / `REELHOUSE_TEST_DATABASE_URL` to a disposable
profile (`docker compose -f docker-compose.dev-db.yml up -d`) to enable
them.

Live end-to-end demonstration (dev database + Jellyfin stub catalog):

```bash
docker compose -f docker-compose.dev-db.yml up -d
npm run db:migrate
node scripts/dev/jellyfin-stub.mjs &            # DATASET=baseline default
export JELLYFIN_URL=http://127.0.0.1:8097
export JELLYFIN_API_KEY=stub-key
export DATABASE_URL=postgresql://reelhouse_app:reelhouse_app_dev@127.0.0.1:5433/reelhouse
npm run catalog:sync                            # seed the catalog the links resolve against
npm run household:import -- scripts/dev/household-sample.json
npm run household:import -- scripts/dev/household-sample.json   # re-import: zero writes
```

Every echoed error is scrubbed of the database URL.

## Serving household state (RH-0040)

Household state is read back through the bounded PostgreSQL read models:
`GET /api/library` renders the profile's configured home rows
(continue-watching with ReelHouse watch progress, recently added,
favorites, library/collection/watchlist rails), scoped strictly to the
selected profile (`?profile=slug`, default profile when absent). Entries
whose catalog link is not resolved yet are skipped in the payload — the
household rows themselves are never touched by reads. See
[CATALOG.md](CATALOG.md) "Read models" and [DR.md](DR.md) for the
durable-vs-rebuildable split behind backup policy.
