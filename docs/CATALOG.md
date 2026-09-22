# ReelHouse media catalog — schema, identity, and full-library sync (RH-0031)

The media catalog (the `media_*` table family in the `reelhouse` PostgreSQL
18 database) owns **normalized catalog state** synchronized FROM Jellyfin
through its HTTP API. Jellyfin remains the playback/library authority: it is
only ever reached through its API — never through its internal database —
and every sync runs server-side, so clients never receive PostgreSQL
credentials. `reelhouse`-owned state (household profiles, favorites,
watch state) is a separate authority and never derived from these tables.

## Components

| Path | Role |
|---|---|
| `db/migrations/0002–0006_media_catalog_*.sql` | Versioned catalog schema (see `docs/DATABASE.md` for the migration contract). |
| `src/lib/catalog/source.ts` | Jellyfin HTTP API adapter (`CatalogSource`); bounded requests, key only in the `X-Emby-Token` header, redacted errors. |
| `src/lib/catalog/normalize.ts` | Pure Jellyfin-payload → catalog-row normalization; identity fails closed, invalid optionals become NULL. |
| `src/lib/catalog/changes.ts` | Shared change-detection core (RH-0032): content diffing against stored rows, transition planning, duplicate policy, watermark math. |
| `src/lib/catalog/sync.ts` | Full-library reconciliation: upserts, bounded batch transactions, tombstoning, run history, change history. |
| `src/lib/catalog/incremental.ts` | Incremental refresh (RH-0032): watermark-windowed deltas plus presence sweeps. |
| `src/lib/catalog/pg-executor.ts` | pg Pool/Client adapter pinning one connection per transaction. |
| `scripts/catalog-sync.ts` | CLI: `npm run catalog:sync` (full) and `npm run catalog:sync -- --incremental`. |
| `scripts/dev/jellyfin-stub.mjs` | Deterministic local Jellyfin double for verification and demos. |

## Schema

| Table | Holds |
|---|---|
| `media_libraries` | Jellyfin libraries (virtual folders) with collection type. |
| `media_items` | Every library item — movies, series, seasons, episodes (and Jellyfin `Video` home content, normalized as movies) — with metadata, hierarchy references, and file state (path, container, size, first media source's streams). `source_observed_at` is the source's own last-saved time when provided. |
| `media_genres`, `media_studios`, `media_people` | Shared facet records; people keep Jellyfin's person GUID as provenance when provided, with the name as the contractual identity. |
| `media_item_genres`, `media_item_studios`, `media_item_people`, `media_item_provider_ids` | Per-item joins (genres/studios/people incl. `person_type`, `role_name`, `list_order`; external provider IDs like Imdb/Tmdb/Tvdb). |
| `media_sync_runs` | Append-only history: when each run ran (`full` or `incremental`), what it confirmed/removed/restored/quarantined/skipped, the watermark it covered, why it failed. |
| `media_item_changes` (RH-0032) | Append-only change history: one row per genuine state transition (`added`/`updated`/`removed`/`restored`) with the source revision (Etag, else DateLastSaved), the source-provided `observed_at`, and — for updates — a bounded, deterministically ordered `changed_fields` list. |
| `media_sync_state` (RH-0032) | The incremental watermark per source: the newest source `DateLastSaved` a successful run has fully covered. Advances only on success and only forward (`GREATEST`). |
| `media_item_quarantine` (RH-0032) | Conflicting source identities (one Jellyfin id reported with differing placement/content), isolated non-destructively for the repair workbench (RH-0036). At most one open quarantine per identity; re-occurrences bump `occurrences`. |

## Identity, provenance, freshness

- **Identity:** `(source, jellyfin_id)` — Jellyfin GUIDs are stable, so a
  re-run upserts the same rows and never duplicates. ReelHouse internal
  bigint IDs are generated and never exposed to Jellyfin.
- **Provenance:** every row carries its `source`; `first_seen_at` is set
  once and never rewritten; facet joins always mirror exactly what Jellyfin
  reported for that item at `synced_at`; a later payload that omits a
  person's GUID never erases a previously known one.
- **Freshness:** `synced_at`/`last_seen_at` advance only when a run
  confirms the row against Jellyfin.
- **Removal:** items that a confirmed library no longer reports are
  tombstoned (`removed_at`), never deleted — history and future household
  references survive. A resurrected item clears its tombstone and keeps its
  original `first_seen_at`.

## Sync algorithm (`npm run catalog:sync`)

1. Append a `media_sync_runs` row (`full`, `running`).
2. List libraries from Jellyfin. **Zero libraries fails closed** — that is
   far more likely a permission/URL misconfiguration than an emptied
   server, and reconciling to it would tombstone the whole catalog.
3. Upsert each library; page through its items (`CATALOG_SYNC_BATCH_SIZE`,
   50–1000, default 500). Each page commits in one bounded transaction, so
   a mid-run failure leaves batch-sized durable progress. Every item is
   classified against the stored row (shared classifier): genuine
   transitions append change-history rows in the same transaction, while
   content-identical payloads only refresh freshness.
4. Tombstone, in one transaction: items in confirmed libraries that the run
   did not see, plus libraries that no longer exist. Items of libraries the
   run did not confirm are never touched.
5. Advance the incremental watermark to the newest observed source
   `DateLastSaved` (a full pass sees everything, so it re-seeds coverage).
6. Complete the run row (`succeeded` with counters, or `failed` with a
   scrubbed error detail) and append history.

Items of an out-of-scope Jellyfin type (e.g. `PhotoAlbum`) are skipped and
counted in `items_skipped`. An item without a stable Id/Name is an
ambiguous media identity and fails the run.

Required environment: `DATABASE_URL` (application role), `JELLYFIN_URL`,
`JELLYFIN_API_KEY` (sent only in request headers, never echoed). Optional
bounded tuning: `CATALOG_SYNC_HTTP_TIMEOUT_MS` (1000–300000, default
30000), `CATALOG_SYNC_BATCH_SIZE` (50–1000, default 500). Invalid values
fail closed. Apply migrations first (`npm run db:migrate`).

## Incremental refresh (`npm run catalog:sync -- --incremental`, RH-0032)

The incremental mode covers the same contract with a fraction of the work
once a full sync has seeded the baseline:

1. **Baseline required.** Without a `media_sync_state` watermark the run
   fails closed (a delta without a baseline is not incremental, it is
   blind) — run a full sync first.
2. **Delta pass**, per library: cursor-paginated
   `/Items?MinDateLastSaved=<watermark − 1s overlap>`. The one-second
   overlap means a boundary item can never fall between two runs; a
   re-covered item is an idempotent no-op. Adds, updates, and
   re-appearing tombstones go through the same normalization, duplicate
   policy, and change classification as a full run, with `observed_at`
   taken from the source's own save time.
3. **Presence sweep**, per library: identity-only cursor pages answer
   "which ids does this library contain right now". Source-absent ids are
   retired (tombstone + `removed` history), still-present tombstones are
   restored (`restored` history). The sweep is what makes removal and
   restore complete — a vanished item can never appear in a saved-at delta.
4. **Watermark advance** only after every delta and sweep page of every
   library succeeded, and only forward. A failed run freezes the watermark,
   so the next run re-covers the whole window idempotently.

Determinism: change rows take `observed_at` from the source payload and
`recorded_at` from an injected clock, so replaying the same sequence of
source states reproduces an identical history — verified by an integration
test that replays a scripted evolution onto a second fresh database.

Duplicate policy (both modes): the same Jellyfin id reported twice in one
run is benign when identical (skipped) and quarantined otherwise — the
first occurrence wins deterministically, the run still succeeds, and the
conflict lands in `media_item_quarantine` (bounded evidence projection:
identity, placement, revision markers) for RH-0036's repair workbench.
Re-seeing the same conflict bumps `occurrences` on the existing row.

## Verification

```bash
npm test         # hermetic: normalization matrix + source adapter contract + change-detection core (injected fetch, no DB)
npm run test:int # adds catalog integration evidence (disposable local PG18, scripted source)
```

Integration scenarios: schema creation + idempotent re-apply, first full
sync under the least-privilege app role (rows, facets, file state, run
history), idempotent re-run (no new rows, `first_seen_at` preserved),
rename/remove/add reconciliation + resurrection, mid-run source failure
with committed progress and recorded failure followed by a clean recovery
run, the zero-library guard, and tombstone scoping to confirmed libraries
only — plus the RH-0032 suite: migration 0006, the no-baseline fail-closed
guard, baseline seeding + silent no-op incrementals, delta add/update with
source-provenanced history, sweep removal/restore, watermark freeze on
mid-run failure + recovery re-coverage, duplicate-identity quarantine
(including occurrence bumping), and deterministic replay onto a second
fresh database. Set `REELHOUSE_TEST_MIGRATE_URL` /
`REELHOUSE_TEST_DATABASE_URL` to a disposable profile
(`docker compose -f docker-compose.dev-db.yml up -d`) to enable them.

Live end-to-end demonstration without a real Jellyfin server:

```bash
docker compose -f docker-compose.dev-db.yml up -d
npm run db:migrate
node scripts/dev/jellyfin-stub.mjs &            # DATASET=baseline default
export JELLYFIN_URL=http://127.0.0.1:8097
export JELLYFIN_API_KEY=stub-key
export DATABASE_URL=postgresql://reelhouse_app:reelhouse_app_dev@127.0.0.1:5433/reelhouse
npm run catalog:sync                    # full: seeds the catalog + watermark
npm run catalog:sync -- --incremental   # unchanged source: zero change rows
```

Then restart the stub with a mutated dataset to watch the incremental
pipeline do its job:

```bash
DATASET=mutated node scripts/dev/jellyfin-stub.mjs &    # remaster + new item + removal
npm run catalog:sync -- --incremental                   # updated/added/removed, watermark advances
DATASET=baseline node scripts/dev/jellyfin-stub.mjs &   # the removed item returns
npm run catalog:sync -- --incremental                   # sweep-only restore
DATASET=duplicates node scripts/dev/jellyfin-stub.mjs & # same id, two libraries
npm run catalog:sync -- --incremental                   # quarantined, run still succeeds
FAULT_MODE=error500 node scripts/dev/jellyfin-stub.mjs &
npm run catalog:sync -- --incremental                   # failed run, watermark frozen
```

`FAULT_MODE=error500-second-page` deterministically demonstrates the
mid-run failure path (failed run recorded, earlier page committed), and a
subsequent run with `FAULT_MODE=none` demonstrates recovery. Every echoed
error is scrubbed of the server URL and API key.
