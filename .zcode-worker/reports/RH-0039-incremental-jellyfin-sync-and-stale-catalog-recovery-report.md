# RH-0039 — Incremental Jellyfin sync and stale-catalog recovery — Worker Report

**Date:** 2026-09-25 (claimed 12:25 PM EDT, inside the 11:00–21:00 America/New_York window)
**Branch:** `rh-0039-incremental-jellyfin-sync-and-stale-catalog-recovery` (worktree `reelhouse-rh-0039`)
**Status:** REVIEW — not merged, nothing deployed, no production credentials touched, Jellyfin's internal database untouched.

## What was delivered

The incremental layer on top of the RH-0038 consolidated dataload, per this
job's spec: cursored incremental refresh, change history,
add/update/remove/restore handling, duplicate quarantine, freshness
thresholds, stale detection, and deterministic replay — with Jellyfin
touched only through its HTTP API and its internal SQLite never read or
written.

- **`db/migrations/0007_catalog_change_history_and_quarantine.sql`** —
  `media_item_changes` (append-only per-transition history: kind
  added/updated/removed/restored, `source_revision` = Etag else
  DateLastSaved, source-provided `observed_at`, bounded ordered
  `changed_fields` for updates), `media_sync_state` (per-source watermark,
  GREATEST-guarded so it can never rewind), `media_item_quarantine`
  (partial-unique open quarantine per identity; re-occurrence bumps
  `occurrences`; `released`/`discarded` statuses reserved for RH-0036),
  `media_sync_runs` gains the `incremental` mode plus
  `items_restored`/`items_quarantined`/`watermark` columns, and
  `media_items.source_observed_at` (COALESCE-upserted: a payload that omits
  it never erases it). Tables stay in schema `public` so migration 0001's
  default privileges cover the app role; FKs deliberately have no cascade —
  items are never deleted, so history is never orphaned.
- **`src/lib/catalog/changes.ts`** — shared change-detection core used by
  BOTH pipelines: pure `planItemChange` classification
  (added/updated/restored/unchanged) with canonicalized comparisons
  (numeric/bigint wire strings, timestamptz instants, jsonb
  key-order-stable stringify) so column rounding or key reordering never
  produces phantom updates; fixed-order `changed_fields` projection capped
  at 50; duplicate policy (identical repetition benign, any difference
  conflict); watermark window math (1-second overlap behind the watermark,
  advance-only, null-baseline epoch fallback). Plus the shared SQL for
  change rows, inferred (sweep-driven) change rows, quarantine upsert, and
  watermark advance.
- **`src/lib/catalog/incremental.ts`** — `runIncrementalCatalogSync`:
  requires a seeded baseline (fails closed with "run a full sync first"
  otherwise), then per library: a cursor-paginated `MinDateLastSaved` delta
  pass (adds/updates/delta-restores through the same normalization,
  duplicate policy, and classifier as full) and an identity-only presence
  sweep (source-absent ids tombstoned, still-present tombstones restored —
  the sweep is what makes removal/restore complete, since a vanished item
  can never appear in a saved-at delta). Watermark advances only after
  every page of every phase succeeded. Failed runs keep batch-sized durable
  progress, record the failure with a scrubbed detail, and freeze the
  watermark so the next run re-covers the window idempotently.
- **`src/lib/catalog/sync.ts`** (full mode, RH-0031 contracts preserved) —
  now writes change history via the same classifier: initial loads record
  `added`, genuine content changes `updated`, resurrections `restored`,
  sweep tombstones `removed`; unchanged payloads only refresh freshness and
  never touch history. Full runs also seed/advance the watermark, handle
  cross-library duplicates via quarantine (previously a silent
  library-overwrite), and count restored/quarantined items. Optional
  injected `clock` for deterministic history timestamps.
- **`src/lib/catalog/source.ts`** — two new adapter methods:
  `fetchChangedItemsPage` (per-library `MinDateLastSaved` delta cursor,
  DateLastSaved requested in Fields) and `fetchLibraryItemIdsPage`
  (`Fields=Id` sweep pages); same bounded-timeout, header-only-key,
  scrubbed-error contract as the existing adapter (wire-contract unit tests
  included).
- **`src/lib/catalog/normalize.ts`** — `dateLastSaved` on the normalized
  item (invalid values become NULL, never coerced).
- **`scripts/catalog-sync.ts`** — `npm run catalog:sync -- --incremental`
  (rejects unknown flags), prints mode, changes, window, and watermark.
- **`scripts/dev/jellyfin-stub.mjs`** — honors `MinDateLastSaved` and
  `Fields=Id`; items carry fixed `DateLastSaved` values; new `DATASET` env
  (`baseline` | `mutated` | `duplicates`) for deterministic add/update/
  removal/restore/quarantine demos.
- **Docs:** `docs/CATALOG.md` (new incremental section, schema table,
  updated runbook with the DATASET demo sequence), `docs/DATABASE.md`
  migration list entry 4, README catalog section.

## Design decisions worth review

- **Per-library delta cursor** (not a global one): library attribution then
  comes from the query's `ParentId`, exactly like the full sync — real
  Jellyfin delta payloads do not reliably carry their virtual-folder id,
  and episodes/seasons would need ancestry walks.
- **Change history records only genuine transitions**: a save with
  unchanged content refreshes freshness (`synced_at`/`last_seen_at`/
  `source_observed_at`) but writes no history — this is what makes
  re-covered windows and full/incremental interplay idempotent.
- **Restores report no `changed_fields`** even if content also moved with
  the payload: the restore is the headline transition; content rides along.
- **Removal/restore are inferred** (no source revision, `observed_at` =
  run time): the source never reports deletions. Delta-driven restores
  keep the source's save time as `observed_at`.
- **First occurrence wins** on duplicates, deterministically by pagination
  order; the conflicting occurrence's bounded evidence projection
  (identity, placement, revision markers, file path, provider ids) is
  quarantined — never a raw payload dump, and the run still succeeds.
- **1-second watermark overlap**: a boundary item can never fall between
  two runs; re-covered items are no-ops. Items without `DateLastSaved`
  never advance the watermark (conservative re-coverage next run).

## Branch base (important for reviewers)

The job spec says "start from current `origin/main`", but the media
catalog this job extends (schema, sync, adapter) exists only on the
RH-0038 REVIEW branch — `origin/main` (`b934fc7`) still carries no
database layer. Rebuilding it would have duplicated in-review files and
guaranteed conflicts. This branch is therefore **stacked on the RH-0038
REVIEW tip (`5eac0c0`)**, exactly as RH-0038 consolidated RH-0030/0031/0033
onto main. Nothing on the RH-0038 branch or worktree was modified. If
RH-0038 lands as a squash merge, this branch needs a rebase onto the
updated `main`; the incremental work itself (migration 0007, `changes.ts`,
`incremental.ts`, CLI flag, stub, suites) is independent of how the base
lands.

Provenance note: the incremental design and its suites were first built
for the RH-0032 review branch (stacked on RH-0031 before the household
work existed). This branch re-lands that scope against the consolidated
RH-0038 tree: the migration is renumbered `0006`→`0007` (household owns
`0006` here), the two new suites join the package.json lists alongside the
household suites, `sync.int.test.ts`'s FakeCatalogSource gained the two new
interface methods, and all in-tree references cite RH-0039. The rh-0032
branch and worktree were read via git as input only and are untouched.

## Verification evidence

Environment: Node v22.19.0 (native TS type-stripping), Docker 29.8.0,
`postgres:18` → disposable container `reelhouse-rh0039-pg18` bound to
127.0.0.1:5439 only (started from this worktree's
`docker/postgres-dev-init` role split, used for nothing else, removed with
its volume afterwards). Never Synology, never a live Jellyfin, never the
shared `reelhouse` production database.

### Automated contracts

| Suite | Command | Result |
|---|---|---|
| Hermetic units (incl. new change-detection matrix: wire-representation invariance, column-rounding equality, fixed-order diffs, duplicate policy, watermark math, delta/id-sweep wire contracts) | `npm test` | **86/86 pass** |
| Integration (incl. 8 new RH-0039 cases: migration 0007 + mode CHECK, no-baseline fail-closed guard, baseline seeding + silent no-op incrementals, delta provenance, sweep removal/restore, watermark freeze on mid-run failure + recovery re-coverage, duplicate quarantine + occurrence bump, deterministic replay onto a second fresh DB) | `npm run test:int` (disposable PG18) | **33/33 pass** |
| Lint | `npm run lint` | clean |
| Typecheck | `npm run typecheck` | clean |
| Production build | `npm run build` | green; routes unchanged (`/`, `/api/health`, `/api/library`, `/api/search`) |

The new suite uses its own temporary database (`reelhouse_rh0039_tmp`,
dropped before/after each case) so it cannot collide with the db,
full-sync, and household suites even when `node --test` runs all four
files as parallel processes.

### Deterministic replay evidence

The replay integration test runs the same scripted source evolution
(S0 full → S1 add+rename → S2 removal → S3 restore) against two
independent fresh databases and asserts byte-identical change history —
including `observed_at`/`recorded_at` (source save times plus the injected
fixed clock) and run sequence. The recorded evolution is exactly
add/add/add/add/remove/restore, with no phantom rows.

### Live CLI evidence (real `db:migrate` + `catalog:sync` + stub server)

Fresh database `reelhouse_rh0039_live` in the disposable container
(`DATABASE_MIGRATE_URL` = owner role, `DATABASE_URL` = app role; the API
key was deliberately suffixed `-SECRET` so any leak would be visible):

- `npm run db:migrate`: `applied 7 migration(s): 1, 2, 3, 4, 5, 6, 7 (app
  role: reelhouse_app)`; second run: `up to date — 7 migration(s) already
  applied`. (First attempt with the app-role URL failed closed with
  `permission denied for schema public` — the DML-only boundary holding.)
- Baseline stub, run #1 full: `run #1: libraries=2 items=9 upserted=8
  tombstoned=0 restored=0 quarantined=0 pages=2 changes=8
  watermark=2024-01-01T00:00:00.000Z` (the 9th item is the out-of-scope
  PhotoAlbum; history holds the 8 initial adds).
- Run #2/#3 incremental (unchanged): `changes=0` with
  `window=2023-12-31T23:59:59.000Z` — the documented 1-second overlap.
- `DATASET=mutated` stub, run #4: `changes=3` — `updated mov-arrival
  ["name","communityRating","etag"]` (`source_revision=etag-arrival-rmx`,
  `observed_at=2025-06-01T12:00Z`), `added mov-citizen`, `removed mov-bare`
  (inferred: NULL `source_revision`); watermark advanced to
  `2025-06-02T09:30:00.000Z`. `media_item_changes` spot-check confirmed the
  exact 11-row sequence (8 adds + updated/added/removed).
- `DATASET=baseline` stub, run #5: `items=0 restored=1 tombstoned=1
  changes=2` — the sweep alone restored `mov-bare` and retired
  `mov-citizen`; watermark unchanged (sweep-only runs do not advance it).
- `DATASET=duplicates` stub, run #6: the same id under both libraries →
  `quarantined=1 changes=1`, first occurrence wins, quarantine row
  `duplicate_identity` with the conflicting library (`lib-tv`) in its
  payload; run **succeeded**. Run #7 re-saw the conflict: `occurrences`
  bumped 1→2 on the same single row, `changes=0`.
- `FAULT_MODE=error500` stub, run #8: `failed` with error detail `Jellyfin
  API responded HTTP 500 for Items` — no URL, no API key anywhere in CLI
  output or in the stored `media_sync_runs.error_detail`;
  `media_sync_state.watermark` frozen at `2025-07-01`. Healthy recovery
  run #9: `succeeded, changes=0` — re-covered the same window
  idempotently. Run history: `full:succeeded, incremental:succeeded ×6,
  incremental:failed, incremental:succeeded` — append-only.
- `GET /api/health` (built app): unconfigured env → demo mode
  (`database.state=unconfigured`); configured env → 200 with
  `migrations={state:ok, applied:7, pending:0, lastVersion:7}` and the DSN
  password masked (`reelhouse_app:***@…`).

### Process hygiene

- Stub processes were killed by their netstat listener PIDs and the port
  re-verified free between datasets (the known orphan-node failure mode),
  so each recorded run talked to the intended dataset.
- The disposable container was removed with its anonymous volume after
  evidence collection; no other container, worktree, branch, or process
  was touched.

## Boundaries respected

- Jellyfin touched only through its HTTP API (the stub); its internal
  database never read or written.
- No PostgreSQL credentials reached any client; CLI/health outputs redact
  `DATABASE_URL` and the API key.
- `reelhouse` household state and `media_catalog` catalog state remain
  separate authorities; the incremental layer writes only `media_*` tables.
- No merge to `main`, no deploy, no release, no production credential
  changes; no other worker's branch or worktree touched; no force-push.
- Claim window: claimed 12:25 PM EDT 2026-09-25, inside 11:00–21:00
  America/New_York.

## REVIEW notes

- Full-sync tombstones still stamp `removed_at = now()` in SQL (RH-0031
  semantics untouched); the injected clock feeds only change-history
  timestamps. CLI/wall-clock history is therefore not replay-identical by
  design — the injected-clock path is what the replay evidence covers.
- `catalog:sync`'s `upserted` counter counts upsert statements executed,
  including value-identical ones (the guard keeps content unchanged);
  change-free re-runs are proven by `changes=0` and content state, not the
  counter.
- Within one library's presence sweep, a repeated id is deduplicated
  silently (an id-only listing carries no conflicting content to preserve);
  cross-library or content conflicts are what quarantine is for.
- Queue hygiene: `origin/main`'s queue still lists RH-0030–0037 and older
  duplicates as READY while their branches carry REVIEW reports; per the
  dispatch bootstrap, branch/worktree existence is the lease authority, so
  none were touched. This branch is the claim record for RH-0039. After
  this claim, RH-0040 is the remaining genuinely unclaimed READY reserve
  job (plus the stale duplicates that must never be claimed while their
  counterparts are leased).
