# RH-0034 — Search discovery recommendation and home-row PostgreSQL read models — Worker Report

**Date:** 2026-09-22 (claimed ~8:25 PM EDT, inside the 11:00–21:00 America/New_York window)
**Branch:** `rh-0034-search-discovery-recommendation-and-home-row-postgresql-read-models` (worktree `reelhouse-rh-0034`, stacked on `origin/rh-0033-…` at `e22dc24`)
**Status:** REVIEW — not merged, nothing deployed, no production credentials touched, Jellyfin's internal database untouched.

## What was delivered

The client-facing read half of the persistence boundary: bounded, indexed,
deterministic **read models** over `media_catalog` + `household_*` state, plus
a minimal server-side HTTP surface exposing them. Jellyfin stays the
playback/library authority via API only; nothing here writes any table —
the write paths remain the catalog sync (RH-0031/0032) and the household
import (RH-0033).

- `db/migrations/0008_read_model_indexes.sql` — four partial indexes over
  the ACTIVE catalog (`removed_at IS NULL`): title-sorted library/type
  listings (`lower(coalesce(sort_name,name))` + id), recently-added
  (`coalesce(date_created, first_seen_at)` desc), rating desc, and
  library/type/year filters. Deliberately **no extension-dependent opclasses**
  (no pg_trgm): substring search stays a bounded ILIKE scan, so the read
  models never require superuser-only extensions on Synology. Rails driven by
  the household family keep migration 0007's partial indexes.
- `src/lib/readmodels/params.ts` — pure bounded-parameter contract: page
  windows (default 24/max 100; rails 20/max 50), strict filter validation
  (closed enums, year 1850–2100, rating 0–10, dedup + ≤25 values, ≤200
  chars), numeric-string acceptance, LIKE-metacharacter escaping, typed
  `ReadModelParamError`. Unknown query keys are ignored; known keys fail
  closed.
- `src/lib/readmodels/executor.ts` — minimal `ReadExecutor` + pg adapter +
  `SqlBuilder`: every read-model query grows its text and parameter array
  through one numbered-placeholder sequence, so `$n` renumbering can never
  drift from values.
- `src/lib/readmodels/search.ts` — search/filter/pagination (filters:
  q over name/original_title/sort_name, types, libraries, genres, year
  range, min rating; sorts: title/recent/rating/year, per-key default
  direction, `id` tiebreaker in the same direction, explicit `NULLS LAST`
  for rating/year) + count query sharing the identical filter clause, +
  item detail with bounded facets (genres/studios/people ≤30, providers ≤20)
  and file/etag provenance. Active rows only, everywhere.
- `src/lib/readmodels/home.ts` — profile resolution (explicit slug → active
  default → first active by slug), home-row listing (≤12 rows), and rail
  resolution for all six kinds: continue watching (active, not completed,
  not hidden, `last_played_at` desc, progress on the card), recently added,
  favorites, library, collection, watchlist. Catalog join is by identity on
  active rows — catalog churn drops items from rails while household rows
  survive. Rails whose config names a missing library/collection/watchlist
  degrade to `resolved:false` with no items (target-existence probes);
  disabled rows render empty; an empty household fails closed with a typed
  `HouseholdEmptyError` (the API route renders it as a 200 empty-feed state).
- `src/lib/readmodels/freshness.ts` — catalog/household freshness
  (`never_synced`/`fresh`/`stale`) from the newest SUCCEEDED run vs an
  injectable clock (24h/7d windows), watermark, item counts by type,
  per-library active counts, last 5 runs (failed runs visible, never
  verdict-changing), open quarantine count.
- `src/lib/readmodels/recommendations.ts` — deterministic input buckets:
  top genres (favorites ×2 + last-100 history ×1, ties alphabetical),
  unwatched discovery (active movies/series in top genres without a
  completed watch-state row, rating→recency), one next-up card per
  in-progress series, quality-led recent (works pre-household).
- `src/lib/readmodels/api.ts` + `src/app/api/catalog/{search,items/[id],status}`
  + `src/app/api/home` — the HTTP surface: always-live (`force-dynamic`),
  400 invalid_request / 404 not_found / 503 database_unavailable with
  `redactError`-scrubbed details; successful bodies are plain data. The
  existing demo-mode routes (`/api/library`, `/api/search`) and the UI are
  untouched — switching the TV UI over these models belongs to RH-0035.
- Docs: `docs/READMODELS.md` (endpoints, bounds, semantics, runbook),
  `docs/DATABASE.md` component row + migration 0008 entry, README section.
- `package.json` — `test`/`test:int` include the four new suites.

## Design decisions worth review

- **Read models as a library + thin routes, not a UI rewrite.** The goal says
  "for TV/browser/mobile clients"; the routes are the client boundary, and
  RH-0035 builds the living-room UX "over the new PG-backed read models".
  Demo-mode behavior for unconfigured deployments is preserved; DB-backed
  routes return 503 (not demo data) so clients can render degraded states.
- **One SqlBuilder per query, caller-owned.** The filter clause and
  LIMIT/OFFSET share a single placeholder sequence. My first draft used two
  builders and the hermetic placeholder-consistency test caught the
  collision ($1/$2 reused) before any database ever saw it — exactly the
  failure class that has bitten previous sessions.
- **NULLS LAST is explicit on quality-led sorts.** PostgreSQL's DESC default
  is NULLS FIRST; without the clause, unrated items would lead rating-sorted
  rails. Found by the integration rating-sort assertion.
- **Degradation is data, fail-closed is for identity.** Missing editorial
  targets (library/collection/watchlist in home-row config) render flagged
  empty rails; an unknown profile is 404; a zero-profile household is a
  legitimate pre-import state rendered as an empty feed; an unconfigured or
  unreachable database is 503. Preferences/manifests remain fail-closed at
  the write boundary.
- **"Unresolved config" vs "empty rail"** is a real distinction (target
  exists with no items vs target gone) and costs one bounded existence probe
  per reference rail.
- **Stacking on rh-0033.** Read models depend on the connection layer
  (RH-0030), catalog schema/sync (RH-0031/0032), and household state
  (RH-0033) — none on `main` yet. The branch stacks on
  `origin/rh-0033-…` (`e22dc24`) like every predecessor in this wave; if any
  squash-merges, this branch rebases onto the successor (no force-push).

## Verification evidence

All commands run in `reelhouse-rh-0034` against the disposable loopback PG18
profile (`docker-compose.dev-db.yml`, `127.0.0.1:5433`) — never Synology;
the "Jellyfin" was the deterministic stub (`scripts/dev/jellyfin-stub.mjs`,
DATASET=baseline).

- `npm run lint` — clean. `npm run typecheck` — clean.
- `npm test` — **113/113 pass** (97 pre-existing + 16 new hermetic tests:
  the bounded-page/clamp matrix, filter normalization + fail-closed matrix,
  LIKE escaping, identifier bounds, and mechanical SQL placeholder/value
  consistency + fixed-ORDER-BY + active-only-predicate assertions for every
  filter combination).
- `npm run test:int` — **50/50 pass** (33 pre-existing + 17 new integration
  tests under the least-privilege app role): migrations 0001–0008 on a fresh
  database incl. the 0008 indexes + no-op re-run; search through the REAL
  sync runner (every filter axis, four sorts with tie determinism, ILIKE
  metacharacters literal, pagination stability/dup-free walk, honest
  totals/hasMore, byte-identical repeats); detail facets + 404; catalog
  churn leaving search/detail; freshness never_synced → fresh → stale with
  injectable clock and the bounded run list; home rails for all six kinds
  with completed/hidden exclusions, profile isolation, determinism
  (byte-identical feed), unresolved-config and disabled-row semantics, rail
  bounds; recommendation buckets incl. genre weighting from favorites +
  bounded history, completed-item exclusion, one-next-up-per-series, and
  cross-profile taste differences; churn removal + restoration recovery;
  empty-household fail-closed.
- `npm run build` — production build succeeds; routes: the four new
  endpoints registered as dynamic, existing routes unchanged.

Live end-to-end matrix (dev DB + stub, then `npm start` + curl):

```text
db:migrate            → up to date — 8 migration(s) applied (app role: reelhouse_app)
catalog:sync (full)   → run #1: libraries=2 items=9 upserted=8 changes=8
                        watermark=2024-01-01T00:00:00.000Z
household:import      → run #1: profiles=2/2w prefs=5w favs=4w/0r lists=3w
  (sample snapshot)     listEntries=4w colls=2w collEntries=6w homeRows=9w
                        watchState=3w history=4 linksUnresolved=2
GET /api/catalog/search?limit=3
                      → filters echoed; items[] title-asc; total/hasMore set
GET /api/catalog/search?q=a&types=movie&sort=rating&limit=3&offset=1
                      → rating desc, offset honored, hasMore consistent
GET /api/catalog/search?sort=vibes
                      → 400 {"error":"invalid_request","detail":"sort must be
                        one of title, recent, rating, year …"}
GET /api/catalog/items/mov-arrival
                      → Arrival, genres [Drama, Science fiction], people
                        (director first), provider ids Imdb/Tmdb
GET /api/catalog/items/mov-nope
                      → 404 {"error":"not_found"}
GET /api/catalog/status
                      → fresh, counts byType {movie:4, series:1, season:1,
                        episode:2}, watermark present, household fresh,
                        openQuarantines 0
GET /api/home         → default profile v_ali; continue_watching=[ep-demo-1]
                        (completed+hidden mov-bare correctly absent),
                        recently_added (8), library rails, family_picks,
                        movie_night — all resolved:true
GET /api/home?profile=nicole
                      → her continue_watching=[ep-demo-2], her favorites
                        [vid-home], the shared collection — zero leakage of
                        v_ali's rails
GET /api/home?profile=ghost
                      → 404 {"error":"not_found"}
GET /api/home?limit=1 → perRailLimit=1; no rail exceeds 1 item
DATABASE_URL pointed at a dead port (127.0.0.1:5999):
  /api/catalog/search, /api/home, /api/catalog/status
                      → all 503 {"error":"database_unavailable",
                        "detail":"connect ECONNREFUSED 127.0.0.1:5999"} —
                        connection URL/credentials never echoed
```

## Boundaries respected

- Jellyfin touched only through its HTTP API (the stub); its internal SQLite
  never read or written.
- No PostgreSQL credentials reached any client; routes fail closed and every
  echoed error is scrubbed of `DATABASE_URL`.
- `reelhouse` household state and `media_catalog` catalog state remain
  separate authorities; rails join by identity on active rows only, so
  household references never resurrect tombstoned catalog items.
- Read models never write; no schema surface beyond indexes was added.
- No merge to `main`, no deploy, no release, no credential changes; other
  workers' branches and worktrees untouched (the stack parent rh-0033 is
  read-only from this worktree's perspective).
- Claim window: claimed ~8:25 PM EDT, inside 11:00–21:00 America/New_York.

## REVIEW notes

- Two real bugs were caught by the new suites before any commit: the
  two-SqlBuilder placeholder collision (hermetic invariant test) and
  DESC/NULLS FIRST ordering on rating rails (integration assertion). A third
  (missing params array on the next-up query) was caught by the integration
  run and fixed. All three are covered by tests that now pass.
- Stale queue rows: `origin/main`'s queue still lists RH-0030–0033 as READY
  while their branches carry REVIEW reports (and rh-0033 now has a worktree
  + origin branch — leased). Per the dispatch bootstrap the branch/worktree
  is the lease authority; this branch is the claim record for RH-0034.
- Remaining genuinely unclaimed READY in the current wave: RH-0035–0037
  (three), plus older-wave rows RH-0028/0029 without branches — the
  six-unclaimed-READY queue guideline is not met by the current wave alone;
  flagging for the maintainer.
- After RH-0034: RH-0035 (TV interaction) is the natural next claim and will
  consume these read models through the UI.
