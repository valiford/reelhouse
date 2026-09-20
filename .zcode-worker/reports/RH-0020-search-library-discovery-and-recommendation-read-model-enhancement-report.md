# RH-0020 Worker Report — Search library discovery and recommendation read-model enhancement

- **Date:** 2026-09-20 (claimed 15:29 America/New_York, inside the 11:00–21:00 window; work completed and left in REVIEW)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0020-search-library-discovery-and-recommendation-read-model-enhancement`
- **Base:** `319c308` (the rh-0022 tip), so the branch tip carries the whole backend wave: main + rh-0002 + rh-0003 + rh-0015 + rh-0016 + rh-0017 + rh-0018 + RH-0022 + RH-0020

## Claim

Dispatch bootstrap ran (`git fetch origin --prune`); the queue was read from
`origin/main` per protocol. RH-0020 was the highest-priority (6) READY,
`AUTOMATION_ELIGIBLE: true` job with no lease: branches/worktrees exist for
RH-0002/0003/0008–0013/0015–0019/0022/0023 (all in REVIEW — never
duplicated), legacy RH-0004 duplicates the in-review RH-0016, leaving
RH-0020 (6), RH-0021 (7), RH-0014 (7) unclaimed. The lease branch was
created from the rh-0022 tip and **pushed before implementation** (remote
lease at `origin/rh-0020-…`). No other worker's branch or worktree was
entered or modified.

## What was built

A **read-only catalog read model** over `media_catalog`, plus explicit
degradation for every Jellyfin fallback path. **No new migration, no new
dependency, one new bounded environment variable**
(`MEDIA_CATALOG_STALE_HOURS`, default 24, parsed/tested like every other
catalog variable). The sync engine (RH-0016) still owns every catalog write;
request-time reads cost zero Jellyfin availability.

### 1. Bounded search/filter/pagination (`GET /api/search`, catalog mode)

`q` (≤200 chars, case-insensitive across name/sort name/original title,
with `%`/`_`/`\` escaped so `100%` finds a literal percent), `kind`
(comma-list from the known domain, default `movie,series`), `genre` (folded
to the catalog's `name_key`), `year` (1000–2999), `sort`
(`name`/`rating`/`recent`/`year`), `limit` (1–100, default 24). Every input
is **refused, never clamped** (400 with value-free bounded messages).

### 2. Stale-response ordering (keyset pagination)

Each sort is a deterministic total order — sort key, then the unique
`external_id` — walked by an opaque, validated base64url cursor instead of an
offset. An offset page silently shifts when rows are inserted or removed
between requests; a keyset page always starts exactly where the previous one
ended, so clients can merge cached (stale) and fresh pages across a sync
without duplicates or gaps. `rating`/`recent`/`year` are `DESC NULLS LAST`
and the cursor carries an explicit null marker so the NULLS LAST zone
paginates continuously (integration-tested across that boundary). `total`
is the live count and may drift; the ordering cannot.

### 3. Explicit degraded states (everywhere)

- Catalog mode responses carry `catalog: { state: fresh | stale | empty,
  lastSucceededAt }` from `catalog_sync_state`; **stale is served but
  labelled** (read-only data is never disguised and never refused).
- When the catalog is unconfigured, unreachable, or empty, search and
  library fall back to the live Jellyfin API / demo library — and say so:
  `source: "jellyfin"`, `catalog.state: "unconfigured" | "unavailable"`
  (with a redacted, ≤2000-char detail) or the sync state for an empty
  catalog, and `degraded: "jellyfin_unconfigured" | "jellyfin_unreachable"`.
  The old silent `catch { return [] }` and console-only demo fallback are
  gone.
- `GET /api/catalog/recommendations` (new) is catalog-only and **fails
  closed** with `503 catalog_unconfigured` / `catalog_unavailable` — no
  fabricated demo recommendations.

### 4. Recommendation rails and library browse

`GET /api/catalog/recommendations?genre=&limit=` returns `top_rated`,
`recently_added`, and (with `genre`) a genre rail — bounded (1–50, default
12), deterministic, **art-first** (items with art lead; art-less items follow,
still included and flagged). `GET /api/library` in catalog mode builds the
legacy payload shape from bounded read-model queries (Recently Added / Top
Rated rails, alphabetical Movies / Shows, 12 each) with a hero chosen as the
newest item that actually has art. Empty catalog falls back to Jellyfin with
the honest sync state attached.

### 5. Missing-art handling

Catalog items carry `hasArt` (primary image tag present) and the API never
fabricates an image URL without one; URLs are composed server-side from
`NEXT_PUBLIC_JELLYFIN_URL`/`JELLYFIN_URL` + the stored tag. Items missing
from the latest full scan stay visible with `missing: true` (retired rows are
invisible, per the sync's reader contract). The frontend source chip now
speaks truthfully for catalog mode; UI items keep the household `MediaItem`
contract (the catalog external id IS the Jellyfin item id, so
`media_item_ref` links keep working) with `hasArt`/`missing` as additive
fields.

## Verification

| Check | Evidence |
|---|---|
| Typecheck / lint / build | `tsc --noEmit` clean; `eslint .` clean; `next build` succeeds with the new `/api/catalog/recommendations` route |
| Unit suite (`npm test`) | **117/117 pass** — all prior suites unchanged and green; +12 RH-0020 tests (query bounding/refusal, cursor codec round-trip and forgery rejection, sort/cursor mismatch, LIKE escaping, image composition, MediaItem mapping, rail bounds, freshness policy) |
| Integration suite (`npm run test:db`) | **113/113 pass** across all suites on the disposable PG18 — +12 new read-model cases on `reelhouse_catalog_read_test`: keyset walks with no gaps/duplicates for all four sorts (including across the NULLS LAST boundary), page stability when a row is inserted mid-walk (the stale-response ordering property), filter combinations, `100%` wildcard escaping, retired invisibility + `missing` flagging, missing-art facts, art-first rails ordering, artful-hero browse, freshness states (empty/fresh/stale + policy override), redacted fail-closed against a dead database, and invalid-policy refusal |
| Live HTTP smoke (built tree, port 3113, disposable DB `reelhouse_catalog_smoke20` since dropped) | `GET /api/health` 200; `GET /api/search?q=star` → `source: "catalog"`, item with composed imageUrl and `catalog.state: "fresh"`; `?q=100%25` matches the literal-percent title; rating-sort pagination walked by cursor with no overlap (`[m-b,m-star,s-z]` → `[m-a,m-pct,m-miss]`); `limit=999` and forged cursor → 400; `GET /api/library` → catalog source, artful hero, 4 bounded sections; `GET /api/catalog/recommendations?genre=sci-fi` → 3 rails incl. genre rail; bad limit → 400 |
| Live HTTP smoke — degradation matrix (ports 3114/3115) | No `MEDIA_CATALOG_DATABASE_URL` → search/library fall back with `catalog.state: "unconfigured"` + `degraded: "jellyfin_unconfigured"` (demo library), recommendations → `503 catalog_unconfigured`; unreachable catalog (dead port, secret-bearing URL) → `catalog.state: "unavailable"`, recommendations → `503 catalog_unavailable`, and **no credential appears in any response body** (asserted) |

Migration posture: none — the read model reads the RH-0016 schema as-is.
Migrations apply from empty (3 catalog migrations verified during smoke
setup) and existing databases are untouched.

## Design decisions the reviewer should see

1. **Reads are a separate resident pool** (`reelhouse-catalog-read`, fixed
   max 4, 10 s statement timeout), not the sync's batch pool — the sync is a
   CLI job, the read model lives in the Next.js server; both fail closed on
   unconfigured/invalid `MEDIA_CATALOG_DATABASE_URL`.
2. **Stale data is served but labelled; only availability fails closed.**
   The worker rule "fail closed on stale catalog state" is interpreted here
   as *never present stale data as current*: every response carries the sync
   state, and the recommendations endpoint — the only one with no honest
   fallback — refuses entirely without a catalog. Refusing all reads on a
   lagging sync would defeat "resilient library browsing".
3. **Keyset pagination, not offsets**, is the stale-response ordering
   answer: offsets drift under inserts, cursors do not. The tradeoff is one
   extra empty-page request when a result set is an exact multiple of the
   limit (documented).
4. **`total` is informational** (a second bounded COUNT query); it may drift
   between pages — the ordering contract is what guarantees correctness.
5. **Art-first rails** are a presentation policy, not a filter: no-art items
   remain in every rail (flagged), so rails stay honest while rendering
   well. The hero likewise prefers artful items but never fabricates one.
6. **The frontend contract is preserved, not upgraded**: catalog-backed
   endpoints emit the household `MediaItem` shape with additive
   `hasArt`/`missing` fields, so the existing UI (and any RH-0009–0014
   frontend work in REVIEW) keeps working unchanged; richer degradation UX
   remains RH-0012's territory.
7. **`jellyfin.ts` now returns `{ value, degraded }`** instead of silently
   substituting demo data / `[]`; its only consumers are the two upgraded
   routes (verified by grep), and the demo-fallback product behavior itself
   is unchanged.
8. **Leftover shared test container:** the disposable `reelhouse-pg18-test`
   container was found running (healthy) and was used for the integration
   suites and smoke, then left running for the next worker; the smoke
   database `reelhouse_catalog_smoke20` was created for the smoke and
   **dropped** afterwards. No compose `down -v` was issued.

## Handoff

Upon acceptance: this branch merges cleanly after RH-0022 in wave order (its
history already contains the entire backend chain); no migrations to
coordinate. The one new environment variable
(`MEDIA_CATALOG_STALE_HOURS`) is optional with a 24-hour default; operators
who set `MEDIA_CATALOG_DATABASE_URL` get catalog-backed search/browse
immediately, everyone else keeps today's Jellyfin behavior with better
degradation reporting. Personalized recommendations (household watch-state /
favorites evidence) are future work — this job deliberately ships the
impersonal read-model rails only. RH-0021 (backup/restore DR) and RH-0014
(accessibility) remain the unclaimed READY jobs.

## Commits on the branch

1. `Add bounded catalog read model with keyset search and rails (RH-0020)` — `read-model.ts` (pool, freshness, search + keyset cursors, rails, browse, MediaItem mapping), freshness policy in `config.ts` + config tests, read-model unit tests
2. `Serve search, library, and recommendations from the catalog read model (RH-0020)` — upgraded `/api/search` + `/api/library`, new `/api/catalog/recommendations`, `jellyfin.ts` explicit degradation, additive `types.ts` fields, truthful source chip
3. `Cover catalog read model with unit and integration suites (RH-0020)` — 12-case integration suite on the disposable PG18, package.json suite registration
4. `Document catalog read model contract (RH-0020)` — `docs/CATALOG_READ_MODEL.md` + README section
5. *(this commit)* — `Mark RH-0020 REVIEW with verification report`
