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
| `db/migrations/0002–0005_media_catalog_*.sql` | Versioned catalog schema (see `docs/DATABASE.md` for the migration contract). |
| `src/lib/catalog/source.ts` | Jellyfin HTTP API adapter (`CatalogSource`); bounded requests, key only in the `X-Emby-Token` header, redacted errors. |
| `src/lib/catalog/normalize.ts` | Pure Jellyfin-payload → catalog-row normalization; identity fails closed, invalid optionals become NULL. |
| `src/lib/catalog/sync.ts` | Full-library reconciliation: upserts, bounded batch transactions, tombstoning, run history. |
| `src/lib/catalog/pg-executor.ts` | pg Pool/Client adapter pinning one connection per transaction. |
| `scripts/catalog-sync.ts` | CLI: `npm run catalog:sync`. |
| `scripts/dev/jellyfin-stub.mjs` | Deterministic local Jellyfin double for verification and demos. |

## Schema

| Table | Holds |
|---|---|
| `media_libraries` | Jellyfin libraries (virtual folders) with collection type. |
| `media_items` | Every library item — movies, series, seasons, episodes (and Jellyfin `Video` home content, normalized as movies) — with metadata, hierarchy references, and file state (path, container, size, first media source's streams). |
| `media_genres`, `media_studios`, `media_people` | Shared facet records; people keep Jellyfin's person GUID as provenance when provided, with the name as the contractual identity. |
| `media_item_genres`, `media_item_studios`, `media_item_people`, `media_item_provider_ids` | Per-item joins (genres/studios/people incl. `person_type`, `role_name`, `list_order`; external provider IDs like Imdb/Tmdb/Tvdb). |
| `media_sync_runs` | Append-only history: when each run ran, what it confirmed/removed/skipped, why it failed. |

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
   a mid-run failure leaves batch-sized durable progress.
4. Tombstone, in one transaction: items in confirmed libraries that the run
   did not see, plus libraries that no longer exist. Items of libraries the
   run did not confirm are never touched.
5. Complete the run row (`succeeded` with counters, or `failed` with a
   scrubbed error detail) and append history.

Items of an out-of-scope Jellyfin type (e.g. `PhotoAlbum`) are skipped and
counted in `items_skipped`. An item without a stable Id/Name is an
ambiguous media identity and fails the run.

Required environment: `DATABASE_URL` (application role), `JELLYFIN_URL`,
`JELLYFIN_API_KEY` (sent only in request headers, never echoed). Optional
bounded tuning: `CATALOG_SYNC_HTTP_TIMEOUT_MS` (1000–300000, default
30000), `CATALOG_SYNC_BATCH_SIZE` (50–1000, default 500). Invalid values
fail closed. Apply migrations first (`npm run db:migrate`).

## Verification

```bash
npm test         # hermetic: normalization matrix + source adapter contract (injected fetch)
npm run test:int # adds catalog integration evidence (disposable local PG18, fake source)
```

Integration scenarios: schema creation + idempotent re-apply, first full
sync under the least-privilege app role (rows, facets, file state, run
history), idempotent re-run (no new rows, `first_seen_at` preserved),
rename/remove/add reconciliation + resurrection, mid-run source failure
with committed progress and recorded failure followed by a clean recovery
run, the zero-library guard, and tombstone scoping to confirmed libraries
only. Set `REELHOUSE_TEST_MIGRATE_URL` / `REELHOUSE_TEST_DATABASE_URL` to a
disposable profile (`docker compose -f docker-compose.dev-db.yml up -d`) to
enable them.

Live end-to-end demonstration without a real Jellyfin server:

```bash
docker compose -f docker-compose.dev-db.yml up -d
npm run db:migrate
node scripts/dev/jellyfin-stub.mjs &            # FAULT_MODE for failure paths
export JELLYFIN_URL=http://127.0.0.1:8097
export JELLYFIN_API_KEY=stub-key
export DATABASE_URL=postgresql://reelhouse_app:reelhouse_app_dev@127.0.0.1:5433/reelhouse
npm run catalog:sync    # run twice: second run is a no-op upsert with zero tombstones
```

`FAULT_MODE=error500-second-page` deterministically demonstrates the
mid-run failure path (failed run recorded, earlier page committed), and a
subsequent run with `FAULT_MODE=none` demonstrates recovery.
