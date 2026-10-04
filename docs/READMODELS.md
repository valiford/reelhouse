# ReelHouse read models — search, home rails, freshness, recommendations (RH-0034)

Bounded, indexed, deterministic **read** paths over the ReelHouse PostgreSQL 18
state for TV/browser/mobile clients. The read models are the client-facing
half of the persistence boundary: `media_catalog` supplies what is
discoverable, `household_*` supplies who is asking and what they care about,
and Jellyfin stays the playback/library authority behind its HTTP API. Every
function here is read-only, every result set is capped, every order is
deterministic, and every identity is validated before SQL ever sees it.

## Components

| Path | Role |
|---|---|
| `db/migrations/0008_read_model_indexes.sql` | Partial indexes for title/recency/rating/year reads over the active catalog. |
| `src/lib/readmodels/params.ts` | Pure bounded-parameter contract: page windows, filter validation, LIKE escaping. Fails closed with `ReadModelParamError`. |
| `src/lib/readmodels/executor.ts` | Minimal `ReadExecutor` interface + pg adapter + `SqlBuilder` (one numbered-placeholder sequence per query). |
| `src/lib/readmodels/search.ts` | Catalog search/filter/pagination, count, and item detail with bounded facets. |
| `src/lib/readmodels/home.ts` | Profile resolution, home-row listing, rail resolution for all six row kinds, and the composed home feed. |
| `src/lib/readmodels/freshness.ts` | Catalog/household freshness and degraded-state surface (`never_synced` / `fresh` / `stale`). |
| `src/lib/readmodels/recommendations.ts` | Deterministic recommendation-input buckets (top genres, unwatched discovery, next up per series, quality-led recent). |
| `src/lib/readmodels/api.ts` | Shared route error mapping: 400 invalid / 404 unknown / 503 database, redacted. |
| `src/app/api/catalog/*`, `src/app/api/home` | The HTTP surface (below). |

## HTTP surface

All routes are `force-dynamic` (always live, never cached), server-only, and
never echo database credentials.

| Route | Meaning |
|---|---|
| `GET /api/catalog/search` | Bounded search/filter/pagination. Query params: `q`, `types` (CSV/repeated: movie,series,season,episode), `libraries`, `genres`, `yearMin`, `yearMax`, `minRating`, `sort` (title,recent,rating,year), `dir` (asc,desc; defaults: title→asc, others→desc), `limit` (1–100, default 24), `offset`. Returns `{filters, page:{items,total,limit,offset,hasMore}}`. |
| `GET /api/catalog/items/{jellyfinId}` | Item detail: card fields + overview/file state/etag + bounded facets (genres ≤30, studios ≤30, people ≤30, provider ids ≤20). 404 when unknown or tombstoned. |
| `GET /api/catalog/status` | Catalog freshness: state, watermark, item counts by type, per-library active counts, last 5 sync runs, open quarantines, household freshness. Compose with `/api/health`'s Jellyfin probe for degraded banners. |
| `GET /api/home` | The caller's home feed. `profile=<slug>` picks a profile; without it the active default is used. `limit` caps each rail (1–50, default 20). Returns the profile plus its home rows resolved into rails. An empty (pre-import) household renders `{profile:null, rows:[], emptyHousehold:true}` with 200. |

Error contract: malformed parameters → `400 {error:"invalid_request"}`;
unknown profile/item → `404 {error:"not_found"}`; database
unconfigured/invalid/unreachable → `503 {error:"database_unavailable"}` with
a redacted detail. Successful bodies are plain data.

## Bounded by construction

- Page: default 24, max 100 rows; rails/buckets: default 20, max 50; a feed
  renders at most 12 home rows; facet lists and the status run list are
  individually capped.
- Every ORDER BY ends in `id` (same direction), so pagination never
  duplicates or skips a row; rating/year sorts push NULLs last explicitly
  (PostgreSQL's DESC default would lead rails with unrated items).
- All orders/expressions are fixed per sort key — client input can only pick
  from a closed list, never shape SQL text. Query text and parameter arrays
  are produced together through `SqlBuilder`, and `query.test.ts` asserts
  placeholder/value consistency mechanically for every filter combination.

## Determinism and semantics

- **Active-only**: every catalog read filters `removed_at IS NULL` (and
  active libraries); household rails join catalog items by
  `(source, jellyfin_id)` on active rows. Catalog churn (tombstones) removes
  items from search and rails on the next read while household rows survive;
  a restored item reappears. This is the provenance boundary: ReelHouse
  household references never resurrect catalog state.
- **Profile isolation**: home/recommendation reads are parameterized by
  `profile_id`; there is no household read path that is not profile-scoped.
  Curated collections are household-scoped by design.
- **Continue watching** = active watch state, not completed, not
  `hidden_from_continue`, ordered by `last_played_at DESC`; progress ticks
  ride the card. **Next up** = one card per in-progress series (the most
  recently played episode).
- **Degradation is data**: a home row whose config names a missing
  library/collection/watchlist renders `resolved:false` with no items —
  distinct from a live target with no items. Unknown editorial config never
  fails a feed.
- **Freshness** compares the newest SUCCEEDED sync run against a window
  (catalog 24h, household 7d) with an injectable clock; failed runs are
  visible in history but never change the verdict.
- **Recommendation inputs** are explainable buckets, not a scorer: top genres
  weight favorites ×2 + last 100 history events ×1 (ties alphabetical);
  unwatched = active movies/series in top genres without a completed
  watch-state row (rating, then recency); quality-led recent works before any
  household state exists.

## Search semantics

`q` matches `name`, `original_title`, and `sort_name` (ILIKE substring;
metacharacters `% _ \` are escaped and match literally). Genre filters match
the item's own facets exactly (episodes do not inherit series genres). All
filters compose; the count and the page always agree because they share one
filter clause.

Substring search is a bounded ILIKE scan by design — the statement timeout
bounds the scan and LIMIT bounds the result, so no superuser-only extension
(pg_trgm) is required on the Synology instance. Migration 0008's partial
indexes cover the indexed paths (library/type listings by title, recently
added, rating, year filters).

## Verification runbook

```sh
docker compose -f docker-compose.dev-db.yml up -d
export DATABASE_URL='postgresql://reelhouse_app:reelhouse_app_dev@127.0.0.1:5433/reelhouse'
export DATABASE_MIGRATE_URL='postgresql://reelhouse_owner:reelhouse_owner_dev@127.0.0.1:5433/reelhouse'
npm run db:migrate
node scripts/dev/jellyfin-stub.mjs &            # JELLYFIN_URL=http://127.0.0.1:8097
JELLYFIN_URL=http://127.0.0.1:8097 JELLYFIN_API_KEY=stub npm run catalog:sync
npm run household:import -- scripts/dev/household-sample.json
npm start                                        # then curl the routes above
```

Hermetic: `npm test` (parameter contract + SQL/placeholder consistency).
Integration (loopback PG18, never Synology):
`REELHOUSE_TEST_MIGRATE_URL`/`REELHOUSE_TEST_DATABASE_URL` set → `npm run
test:int` runs the search/detail/freshness and home/recommendation suites
under the least-privilege application role.

Read models never write. The write paths (catalog sync, household import)
keep their own docs: [CATALOG.md](CATALOG.md), [HOUSEHOLD.md](HOUSEHOLD.md).
