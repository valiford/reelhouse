# RH-0040 — PostgreSQL TV read models and disaster-recovery acceptance — Worker Report

**Date:** 2026-09-25 (claimed 2:25 PM EDT, inside the 11:00–21:00 America/New_York window)
**Branch:** `rh-0040-postgresql-tv-read-models-and-disaster-recovery-acceptance` (worktree `reelhouse-rh-0040`)
**Status:** REVIEW — not merged, nothing deployed, no production credentials touched, Jellyfin's internal database untouched.

## What was delivered

The final pre-9PM reserve scope per this job's spec: bounded indexed
read models for home/search/continue-watching/collections served from
PostgreSQL over the consolidated RH-0038/0039 data path, plus
backup/restore acceptance, full-Jellyfin rebuild proof, degraded-mode
behavior, and living-room UX verification — with Jellyfin touched only
through its HTTP API (the stub), and clients never receiving database
credentials.

- **`db/migrations/0008_read_model_indexes.sql`** — two indexes only, no
  rows touched: a partial `media_items_recent_idx` (active rows, `date_created
  DESC NULLS LAST, id` — DESC spelled with NULLS LAST because PG's default
  NULLS FIRST would float undated items to the top of "recently added") and
  `media_items_name_lower_idx` (`lower(name), id`) for deterministic
  case-folded ordering and prefix searches.
- **`src/lib/readmodels/items.ts`** — pure mapping/bounding core (no I/O,
  no `server-only`, the same discipline as db/config.ts so hermetic tests
  run under plain Node): `ReadExecutor` (single read-only query surface),
  hard bounds (search limit 1–100 default 40, offset ≤ 10 000, rails 24 /
  continue 12, term ≤ 100 chars), LIKE-wildcard escaping, progress math
  (clamped 0–100, refuses null/zero durations), kind mapping, browser-facing
  image URLs (public URL + tags only — never the API key), and the shared
  catalog projection with correlated genre aggregation.
- **`src/lib/readmodels/home.ts`** — `getHomePayload`: profile resolution
  (explicit slug fail-closed → default → first active; archived never
  matches), the configured `household_home_rows` as rails (or built-in
  defaults when the profile has none), per-kind rail queries that all join
  active catalog rows only (unresolved household links and tombstoned
  items are skipped in the payload; the household rows themselves are never
  touched by reads), empty/misconfigured rails dropped, hero preference
  (recently-added rail's newest backdrop item → any backdrop → first item),
  and the three non-ok outcomes as data: `empty-catalog`, `profile-not-found`.
- **`src/lib/readmodels/search.ts`** — `searchCatalog`: bounded
  case-insensitive substring search over name / original title / series
  name, deterministic order (prefix matches first, then `lower(name)`,
  then id), clamped limit/offset echoed back, blank terms short-circuit.
- **`src/lib/readmodels/diagnostics.ts`** — `catalogDiagnostics`: one
  bounded query for the operator block on `/api/health` (active
  items/libraries/profiles, quarantine occupancy, last successful sync
  time+mode, incremental watermark, last household import); any failure
  degrades to `unknown` with a bounded detail and never fails readiness.
- **`src/lib/readmodels/pg.ts`** — the one `server-only` bridge wiring the
  application pool into `ReadExecutor`; keeps the read-model modules
  double-testable and the import graph honest (a Client Component import
  fails the build, so credentials cannot reach the bundle).
- **Routes** — `/api/library` and `/api/search` serve the catalog read
  models (`source: "catalog"` in the payload) whenever a database is
  configured AND the catalog is synced; unsynced catalog or a read error
  falls back to the exact pre-RH-0040 behavior (direct Jellyfin, demo
  fallback), and an unknown explicit profile is a 404. `/api/search` keeps
  the `{ items }` contract and adds `source/limit/offset`; `/api/health`
  gains the additive `catalog` block. `/api/library` accepts
  `?profile=slug`.
- **`src/lib/types.ts` + `ReelHouseApp.tsx`** — `source` union gains
  `"catalog"`; the home source chip says "● Serving from ReelHouse
  catalog". No other UI changes — the rails render the same components.
- **`scripts/dr-verify.ts` + `npm run dr:verify`** — backup/restore
  acceptance: refuses a non-empty scratch (fail-closed), drops the
  template-inherited public schema (PG15+ pg_dump emits `CREATE SCHEMA
  public` unconditionally), dumps the source via `pg_dump` piped through
  stdout, restores into the scratch via `psql ON_ERROR_STOP` fed on stdin,
  then compares all 26 ReelHouse-owned tables (including
  `schema_migrations`) by row count + ordered row digest, failing closed on
  any drift; reports dump/restore seconds as measured RTO inputs. Tool
  commands are overridable (`DR_PG_DUMP_CMD` / `DR_PSQL_CMD`) for
  container-wrapped clients; credentials ride only in the child's `PG*`
  environment, never argv.
- **`docs/DR.md`** — the runbook: durable (household) vs rebuildable
  (media_catalog) authorities, backup policy with cadence/retention,
  `dr:verify` acceptance procedure, recovery procedures (database loss,
  catalog corruption/rebuild, stale catalog, Jellyfin-unreachable degraded
  mode), RTO/RPO notes, and post-recovery checks.
- **Docs:** DATABASE.md (migration 0008, health contract, component table),
  CATALOG.md ("Read models" section), HOUSEHOLD.md ("Serving household
  state"), README (read models + DR section).

## Design decisions worth review

- **Catalog-backed routes with legacy fallback, not new endpoints:** the
  living-room data path switches to PostgreSQL exactly when
  `DATABASE_URL` is set and the catalog has synced rows; before that (and
  on any read error) the reviewed Jellyfin/demo path answers unchanged.
  A not-yet-synced deployment must degrade to the familiar experience,
  never blank out — and the check runs BEFORE profile resolution so a
  fresh database cannot 404 on a missing default profile.
- **Empty-catalog vs zero-hits:** on a synced catalog, zero search hits is
  a legitimate empty page (no fallback); the fallback trigger is "no
  active catalog rows at all", checked with a cheap indexed existence
  probe shared by both routes.
- **Reads skip, never fail, on unresolved household→catalog links:** the
  import already tombstones nothing and links resolve as the catalog
  catches up; the payload mirrors that patience per item while profile
  isolation stays structural (every rail query filters by profile id).
- **Payload-bounded, not snapshot-consistent:** rails are separate bounded
  statements at read-committed isolation. A home payload is a
  presentation surface, not a transaction boundary.
- **`row_to_json` digests for DR:** count + md5 over ordered row texts
  detects any divergence including invisible column drift; digests are
  same-major-version stable (documented), and the tool-level bound (256
  MiB dump buffer) states plainly that dr:verify is a ReelHouse-scale
  acceptance tool, not a generic backup engine.
- **`clampInt` treats absent as default, never 0:** `Number(null)` and
  `Number("")` are both 0, which would silently clamp callers to the
  minimum — the hermetic suite caught exactly this during development.

## Branch base (same situation as RH-0039)

The job spec says "start from current `origin/main`", but `origin/main`
(b934fc7) still carries no database layer — the PG-backed data path this
job serves from exists only on the RH-0038/0039 REVIEW branches. This
branch is therefore **stacked on the RH-0039 REVIEW tip (`cbba051`)**.
Nothing on any other branch or worktree was modified. If the wave lands
as squash merges, this branch needs a rebase onto the updated `main`;
the read-model and DR work itself is independent of how the base lands.

## Verification evidence

Environment: Node v22.19.0 (native TS type-stripping), Docker 29.8.0,
`postgres:18` → disposable container `reelhouse-rh0040-pg18` bound to
127.0.0.1:5439 only (started from this worktree's
`docker/postgres-dev-init` role split, used for nothing else, removed
with its volume afterwards). Never Synology, never the shared dev
`reelhouse` database, never a live Jellyfin.

### Automated contracts

| Suite | Command | Result |
|---|---|---|
| Hermetic units (incl. new read-model matrix: term sanitization/wildcard escaping, clamp semantics incl. the null→0 trap, progress math, image-URL building, payload doubles for default rails / rail skipping / hero preference / profile guards, search bounds, diagnostics degradation) | `npm test` | **99/99 pass** |
| Integration (incl. 7 new RH-0040 cases: unsynced-catalog fallback contract, configured rails with resolved links + unresolved-link skipping + hero, profile isolation + explicit slugs + unknown-slug fail-closed, search ordering/wildcards/injection/bounds, tombstone exclusion, determinism, diagnostics freshness) | `npm run test:int` (disposable PG18) | **40/40 pass** |
| Lint | `npm run lint` | clean |
| Typecheck | `npm run typecheck` | clean |
| Production build | `npm run build` | green; routes `/`, `/api/health`, `/api/library`, `/api/search` |

The new integration suite uses its own temporary database
(`reelhouse_rh0040_tmp`, dropped before/after each case) so it cannot
collide with the db, sync, incremental, or household suites even as
parallel `node --test` processes.

### Live evidence (real `db:migrate` + `catalog:sync` + `household:import` + built app + stub)

Fresh database `reelhouse_rh0040_live` in the disposable container
(`DATABASE_MIGRATE_URL` = owner role, `DATABASE_URL` = app role; the API
key was suffixed `-SECRET` so any leak would be visible):

- `npm run db:migrate`: `applied 8 migration(s): 1…8 (app role:
  reelhouse_app)`; second run: `up to date — 8 already applied`.
- Stub (`DATASET=baseline`) + full sync: `run #1: libraries=2 items=9
  upserted=8 … changes=8 watermark=2024-01-01T00:00:00.000Z`.
- `household:import` sample: `run #1 … profiles=2/2w/0a … homeRows=9w
  watchState=3w history=4 linksUnresolved=2`; re-import: **zero writes**.
- Built app (`next start`, DATABASE_URL set, `NEXT_PUBLIC_JELLYFIN_URL`
  pointing at the stub):
  - `GET /api/health`: 200, `migrations={ok, applied 8, pending 0,
    lastVersion 8}`, `catalog={ok, activeItems 8, activeLibraries 2,
    quarantined 0, activeProfiles 2, lastSyncMode full, watermark
    2024-01-01…, lastSuccessfulImportAt …}`, DSN password masked
    (`reelhouse_app:***@…`).
  - `GET /api/library`: `source=catalog`, hero `mov-arrival` with
    primary+backdrop URLs (tag `arrival-primary`/`arrival-backdrop`), six
    rails in configured order — Continue Watching `[ep-demo-1]` (mov-bare
    is completed AND hidden: absent), Recently Added, Movies
    `[arrival, bare, blank]`, TV Shows `[ser-demo, vid-home]`, Family
    Picks `[arrival, vid-home, ser-demo]` (unresolved `mov-citizen`
    skipped), Movie Night `[ep-demo-1]` (unresolved `mov-twin` skipped).
  - `GET /api/library?profile=nicole`: her own three rails, continue
    progress 16 (240M/1500M ticks); V'Ali's progress 40; unknown
    `?profile=ghost` → **404**.
  - `GET /api/search?q=ARRIVAL`: `source=catalog`, 1 hit (case-
    insensitive); `q=arr%25val` (literal `%`): 0 hits (wildcards escaped);
    `q='; DROP TABLE media_items; --`: 0 hits and the table still reads.
- **Degraded mode:** stub killed (port re-verified free). App restarted
  with `JELLYFIN_URL` configured but dead: `/api/health` stays **200**
  with `jellyfin: unreachable` and `catalog: ok`; `/api/library` still
  serves `source=catalog` with all six rails — the home screen no longer
  depends on Jellyfin once the catalog is synced.
- **Living-room UX (browser, built app):** home renders hero + six rails
  with the "● Serving from ReelHouse catalog" chip; search panel typed
  "arr" → "1 matches" with the Arrival card; keyboard focus + Enter on a
  card opens the details dialog (rating/genres/overview) whose
  "Play in ReelHouse Engine" link targets
  `…/web/index.html#!/details?id=mov-arrival` — the catalog's stable
  Jellyfin id, playback authority untouched; letter-tile poster fallback
  renders for items without images (screenshots captured during the run).
- **DR acceptance:** `dr:verify` first refused a **non-empty** scratch
  (`refusing to restore into it`), then PASSED the real round-trip:
  `26 tables identical after dump/restore (dump 0.2s, restore 0.4s)` —
  counts and digests equal on every ReelHouse table including migration
  bookkeeping (container-wrapped clients via `DR_PG_DUMP_CMD`/`DR_PSQL_CMD`).
- **Full-Jellyfin rebuild:** fresh `reelhouse_rh0040_rebuild` → migrate →
  full sync → content digests identical to the live catalog
  (`media_items 8:cb9d6a74…`, libraries, facets, watermark all IDENTICAL;
  freshness columns excluded by design) — the catalog rebuilds from the
  Jellyfin API alone, touching no media files and no Jellyfin internals.
  The rebuild database has 0 household profiles: rebuilding never
  fabricates durable state, and the household authority is exactly what
  the dump/restore half protects.

### Process hygiene

- Stub and Next.js processes were killed by their netstat listener PIDs
  and the ports re-verified free after evidence collection (the known
  orphan-node failure mode).
- The disposable container was removed with its volume after evidence
  collection; no other container, worktree, branch, or process was
  touched.

## Boundaries respected

- Jellyfin touched only through its HTTP API (the stub); its internal
  database never read or written.
- No PostgreSQL credentials reached any client; the only new browser-
  facing URLs are image URLs built from `NEXT_PUBLIC_JELLYFIN_URL` + tags
  (the same shape the Jellyfin path already emitted); `/api/health` and
  CLI outputs redact the DSN and API key.
- `reelhouse` household state and `media_catalog` catalog state remain
  separate authorities; read models never write, and the DR story keeps
  them split (durable vs rebuildable).
- No merge to `main`, no deploy, no release, no production credential
  changes; no other worker's branch or worktree touched; no force-push.
- Claim window: claimed 2:25 PM EDT 2026-09-25, inside 11:00–21:00
  America/New_York.

## REVIEW notes

- `next@16.0.1` emits an npm deprecation warning (CVE-2025-66478);
  upgrading is RH-0008's scope (Next.js security upgrade), not this
  job's — untouched here to keep the diff on-scope.
- Playwright locator clicks against the built app timed out in this
  environment (IAB pane actionability), so the browser pass drove
  focus/click via page-side `evaluate` + real keyboard events; the
  assertions (snapshot roles, dialog content, search results, play-link
  href) are the app's real rendered behavior, not mocks.
- `media_sync_runs`/`household_sync_runs` digests include run timestamps,
  so `dr:verify` compares a backup against its own restore (identical by
  construction only if the restore is faithful — exactly the point); it
  is not a live-vs-rebuild comparison. The rebuild evidence covers the
  cross-database content comparison separately.
- Queue hygiene: `origin/main`'s queue still lists RH-0030–0039 and the
  older duplicates as READY while their branches carry REVIEW reports;
  per the dispatch bootstrap, branch/worktree existence is the lease
  authority, so none were touched. This branch is the claim record for
  RH-0040 — after it, every non-stale READY job in the wave is leased,
  and the queue needs control-plane action (acceptance/merge) before
  further genuinely new claims are possible.
