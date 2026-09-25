# RH-0038 — PostgreSQL household and media dataload consolidation — Worker Report

**Date:** 2026-09-24 (claimed 8:26 PM EDT, inside the 11:00–21:00 America/New_York window)
**Branch:** `rh-0038-postgresql-household-and-media-dataload-consolidation` (worktree `reelhouse-rh-0038`, based on `origin/main` at `b934fc7`)
**Status:** REVIEW — not merged, nothing deployed, no production credentials touched, Jellyfin's internal database untouched.

## What was delivered

Current-`main` PG18 ingestion for ReelHouse, consolidated onto the baseline
(`main` carried **no database layer at all** — only the RH-0001 demo
baseline — because the earlier wave has been living in review branches).
This job lands the connection layer, the versioned idempotent migration
surface for household + catalog state, the Jellyfin full-library
`media_catalog` dataload, and the household snapshot dataload as one
coherent current-main implementation:

- **Connection layer** — server-side PostgreSQL 18 pool + fail-closed
  config (`src/lib/db/pool.ts`, `config.ts`), least-privilege role split
  (`reelhouse_owner` migrates, `reelhouse_app` is DML-only), secrets
  env-only and scrubbed from every error path, database readiness exposed
  through `GET /api/health` (reachable/unconfigured/invalid/unreachable
  contract with a redacted `configSummary`).
- **Migrations 0001–0006** (`db/migrations/`) — role grants baseline; the
  `media_*` catalog family (libraries, items, facets, sync runs); the
  `household_*` family (profiles with the one-active-default partial
  unique index, preferences, Jellyfin account links, favorites, watchlists
  + entries, collections + entries, home rows, watch state, append-only
  playback history, per-import sync-run ledger). Forward-only, checksummed,
  re-apply is a no-op, app-role DDL rejected.
- **Jellyfin → `media_catalog` full dataload** (`src/lib/catalog/`,
  `npm run catalog:sync`) — stable `(source, jellyfin_id)` identity,
  provenance stamps (`first_seen_at` set-once, `last_seen_at`/`synced_at`
  freshness), guarded upserts (unchanged content is not rewritten),
  tombstone-not-delete for churn, per-run provenance in `media_sync_runs`,
  zero-library fail-closed guard, Jellyfin touched via HTTP API only
  (`X-Emby-Token`, never logged).
- **Household snapshot dataload** (`src/lib/household/`,
  `npm run household:import`) — fail-closed manifest validation
  (`manifest.ts`: unknown fields rejected, bounded sizes, ISO-8601
  canonicalization, deterministic normalization, ambiguity fails /
  conflicts count), one-transaction idempotent import (`load.ts`):
  `IS DISTINCT`-guarded upserts make an unchanged re-import a true no-op
  (zero writes, `updated_at` never moves), snapshot-absent rows
  tombstoned/archived, set-once provenance preserved across
  removal/re-add, unresolved catalog links tolerated/counted and
  auto-upgraded on later imports, zero-profile snapshots refused,
  failures roll back atomically and record a scrubbed failed run.
- **Docs & env** — `docs/DATABASE.md`, `docs/CATALOG.md`,
  `docs/HOUSEHOLD.md`, README sections, `.env.example`, disposable
  loopback PG18 profile (`docker-compose.dev-db.yml`, binds 127.0.0.1
  only) and the dev Jellyfin stub.

## Consolidation decisions worth review

- **Cherry-picked provenance, then reconciled.** The three source commits
  are the review-branch implementations (`rh-0030` connection layer,
  `rh-0031` catalog dataload, `rh-0033` household dataload), replayed
  onto `origin/main` `b934fc7`. The rh-0032 incremental-sync commit was
  deliberately **excluded** — it belongs to the RH-0039 reserve job — so
  the household commit required reconciliation:
  - `0007_household_state.sql` renumbered to `0006_household_state.sql`
    (rh-0032's `0006_catalog_change_history_and_quarantine.sql` is not in
    this tree; the migration references no rh-0032 tables).
  - `package.json` test lists drop the two rh-0032 incremental suites.
  - `docs/DATABASE.md` migration ranges corrected (catalog `0002`–`0005`,
    household `0006`).
  - The catalog integration suite's fresh-database helper and bookkeeping
    assertion hardcoded the rh-0031 five-migration surface; both now
    derive expected versions from `db/migrations` on disk (same pattern
    the household suite already used), and the household suite's
    migration references say 0006.
- **Scope discipline.** Read models/TV (RH-0034/0040), incremental sync +
  stale-catalog recovery (RH-0039/0032), quarantine workbench
  (RH-0036/0023) and DR tooling (RH-0037/0028/0021) are NOT here. The
  tombstone model and provenance links were kept, so later waves can
  build on this branch without schema breaks.
- **Review branches preserved.** Nothing was rebased, forced, or deleted;
  all wave branches/worktrees are untouched. Their unmerged code was read
  (fetched from origin) as consolidation input only.

## Verification evidence

All commands run in `reelhouse-rh-0038` against the disposable loopback
PG18 profile (`docker-compose.dev-db.yml`, `127.0.0.1:5433`, fresh
volume) and the local `jellyfin-stub.mjs` — never Synology, never a live
Jellyfin, never the shared `reelhouse` production database.

- `npm run lint` — clean.
- `npm run typecheck` — clean.
- `npm test` (hermetic) — **72/72 pass** (db config, migrator, Jellyfin
  health, catalog normalize/source, household manifest determinism,
  bounds, slug policy, duplicate/conflict policy).
- `npm run test:int` — **25/25 pass** against loopback PG18 under the
  least-privilege app role: migrations apply idempotently on fresh
  databases, checksum tamper fails closed, first full catalog sync under
  the app role, unchanged re-run rewrites nothing, rename/tombstone/
  resurrect reconciliation, mid-run source failure with committed
  progress + failed-run record + clean recovery, zero-library guard,
  tombstone scoping, app-role DDL rejection, household family invariants
  (incl. the one-active-default partial index), one-transaction atomicity,
  zero-write byte-identical re-import, profile isolation, link upgrade,
  account move, zero-profile guard.
- `npm run build` — Next.js production build succeeds; routes unchanged
  (`/`, `/api/health`, `/api/library`, `/api/search`).

Live CLI matrix (fresh `reelhouse` database, stub catalog):

```text
db:migrate (fresh)        → applied 6 migration(s): 1, 2, 3, 4, 5, 6
db:migrate (re-run)       → up to date — 6 migration(s) already applied
catalog:sync (full) #1    → run #1: libraries=2 items=9 upserted=8
                            tombstoned=0 skipped=1 pages=2
catalog:sync #2, #3       → same counters; content columns, facets,
  (unchanged)               first_seen_at, removed_at byte-identical
                            across re-syncs (only synced_at/last_seen_at
                            freshness advance — by design); every run
                            recorded in media_sync_runs
household:import #1       → run #1 in 2.7s: profiles=2/2w/0a prefs=5w
  (sample snapshot)         favs=4w/0r lists=3w/0a listEntries=4w/0r
                            colls=2w/0a collEntries=6w/0r homeRows=9w/0a
                            watchState=3w/0r history=4 linksUnresolved=2
                            conflictsSkipped=0
household:import #2       → run #2 in 0.5s: ALL write counters 0 (true
  (identical)               no-op re-import); full pg_dump of all state
                            tables byte-identical to the pre-re-import
                            dump (only pg_dump's random \restrict session
                            tokens and identity-sequence setvals differ —
                            the no-op upserts consume nextval before the
                            conflict path; no data row changed)
/api/health (configured)  → {"status":"ok","database":{"state":"reachable",
                            "configSummary":"postgresql://reelhouse_app:***@…"},
                            "migrations":{"state":"ok","applied":6,
                            "pending":0,"lastVersion":6}}
/api/health (blank URL)   → {"database":{"state":"unconfigured"},
                            "migrations":{"state":"unknown"}} — demo mode
```

SQL spot-checks after the matrix: exactly one active default profile
(`v_ali`; `nicole` present, non-default, not archived); unresolved
favorite link preserved with `item_id` NULL; `household_sync_runs` #1/#2
both `succeeded` with full counters.

## Boundaries respected

- Jellyfin touched only through its HTTP API (the stub); its internal
  database never read or written.
- No PostgreSQL credentials reached any client; `configSummary` and CLI
  errors redact `DATABASE_URL`.
- `reelhouse` household state and `media_catalog` catalog state remain
  separate authorities; household rows reference the catalog only through
  the nullable provenance link.
- No merge to `main`, no deploy, no release, no production credential
  changes; no other worker's branch or worktree touched; no force-push.
- Claim window: claimed 8:26 PM EDT 2026-09-24, inside 11:00–21:00
  America/New_York.

## REVIEW notes

- The consolidation's only code changes versus the reviewed wave commits
  are the migration renumber (0007→0006), the two suite assertions that
  now derive the migration surface from disk instead of hardcoding five,
  and doc ranges — all forced by excluding rh-0032 from this tree.
- `catalog:sync`'s `upserted` counter counts upsert statements executed,
  including value-identical ones (the guard keeps content unchanged);
  re-rewrite-free behavior is proven by content dumps, not the counter.
  This matches the reviewed rh-0031 semantics and its integration suite.
- Queue hygiene: `origin/main`'s queue lists RH-0030–0037 (and older
  duplicates) as READY while their branches carry REVIEW reports; per the
  dispatch bootstrap, branch/worktree existence is the lease authority,
  so none were touched. This branch is the claim record for RH-0038.
- After RH-0038: RH-0039 and RH-0040 remain genuinely unclaimed READY
  reserve jobs.
