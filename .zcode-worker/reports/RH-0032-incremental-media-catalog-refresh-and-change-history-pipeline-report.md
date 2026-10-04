# RH-0032 — Incremental media_catalog refresh and change-history pipeline — Worker Report

**Date:** 2026-09-22 (claimed 4:32 PM EDT, inside the 11:00–21:00 America/New_York window)
**Branch:** `rh-0032-incremental-media-catalog-refresh-and-change-history-pipeline` (worktree `reelhouse-rh-0032`)
**Status:** REVIEW — not merged, nothing deployed, no production credentials touched, Jellyfin's internal database untouched.

## What was delivered

The incremental layer on top of RH-0031's full-library sync: cursored
delta refresh, an advance-only source watermark, append-only change
history with source revisions and observed-at provenance, non-destructive
retirement/restore, duplicate-identity quarantine, and deterministic
replay.

- `db/migrations/0006_catalog_change_history_and_quarantine.sql` —
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
- `src/lib/catalog/changes.ts` — shared change-detection core used by BOTH
  pipelines: pure `planItemChange` classification (added/updated/restored/
  unchanged) with canonicalized comparisons (numeric/bigint wire strings,
  timestamptz instants, jsonb key-order-stable stringify) so column
  rounding or key reordering never produces phantom updates; fixed-order
  `changed_fields` projection capped at 50; duplicate policy (identical
  repetition benign, any difference conflict); watermark window math
  (1-second overlap behind the watermark, advance-only, null-baseline
  epoch fallback). Plus the shared SQL for change rows, inferred
  (sweep-driven) change rows, quarantine upsert, and watermark advance.
- `src/lib/catalog/incremental.ts` — `runIncrementalCatalogSync`: requires
  a seeded baseline (fails closed with "run a full sync first" otherwise),
  then per library: a cursor-paginated `MinDateLastSaved` delta pass
  (adds/updates/delta-restores through the same normalization, duplicate
  policy, and classifier as full) and an identity-only presence sweep
  (source-absent ids tombstoned, still-present tombstones restored — the
  sweep is what makes removal/restore complete, since a vanished item can
  never appear in a saved-at delta). Watermark advances only after every
  page of every phase succeeded. Failed runs keep batch-sized durable
  progress, record the failure with a scrubbed detail, and freeze the
  watermark so the next run re-covers the window idempotently.
- `src/lib/catalog/sync.ts` (full mode, RH-0031 contracts preserved) — now
  writes change history via the same classifier: initial loads record
  `added`, genuine content changes `updated`, resurrections `restored`,
  sweep tombstones `removed`; unchanged payloads only refresh freshness and
  never touch history. Full runs also seed/advance the watermark, handle
  cross-library duplicates via quarantine (previously a silent
  library-overwrite), and count restored/quarantined items. Optional
  injected `clock` for deterministic history timestamps.
- `src/lib/catalog/source.ts` — two new adapter methods:
  `fetchChangedItemsPage` (per-library `MinDateLastSaved` delta cursor,
  DateLastSaved requested in Fields) and `fetchLibraryItemIdsPage`
  (`Fields=Id` sweep pages); same bounded-timeout, header-only-key,
  scrubbed-error contract as the existing adapter (wire-contract unit
  tests included).
- `src/lib/catalog/normalize.ts` — `dateLastSaved` on the normalized item
  (invalid values become NULL, never coerced).
- `scripts/catalog-sync.ts` — `npm run catalog:sync -- --incremental`
  (rejects unknown flags), prints mode, changes, window, and watermark.
- `scripts/dev/jellyfin-stub.mjs` — honors `MinDateLastSaved` and
  `Fields=Id`; items carry fixed `DateLastSaved` values; new `DATASET` env
  (`baseline` | `mutated` | `duplicates`) for deterministic add/update/
  removal/restore/quarantine demos.
- Docs: `docs/CATALOG.md` (new incremental section, schema table, updated
  runbook with the DATASET demo sequence), README catalog section.
- `src/lib/db/integration.int.test.ts` and `src/lib/catalog/sync.int.test.ts`
  — minimal, contract-preserving adaptations (details below).

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
RH-0031 REVIEW branch, which is itself stacked on RH-0030. Rebuilding them
would have duplicated in-review files and guaranteed conflicts. This
branch is therefore **stacked on the RH-0031 REVIEW tip (`4513a73`)**,
exactly as RH-0031 stacked on RH-0030 (whose report explicitly invited
follow-up jobs to build on the layer). If RH-0030/RH-0031 land as squash
merges, this branch will need a rebase onto the updated `main`; the
incremental work itself (migration 0006, `changes.ts`, `incremental.ts`,
CLI flag, stub) is independent of how the base lands.

## Verification evidence

Environment: Node v22.19.0 (native TS type-stripping), Docker 29.8.0,
`postgres:18` → disposable container `reelhouse-rh0032-pg18` on
127.0.0.1:5437 (other workers' containers `reelhouse-postgres-dev` :5433
and `reelhouse-pg18-test` :55433 untouched; container removed afterwards).

### Automated contracts

| Suite | Command | Result |
|---|---|---|
| Hermetic units (incl. new change-detection matrix: wire-representation invariance, column-rounding equality, fixed-order diffs, duplicate policy, watermark math, delta/id-sweep wire contracts) | `npm test` | 70/70 pass |
| Integration: 8 new RH-0032 cases (migration 0006 + mode CHECK, no-baseline fail-closed guard, baseline seeding + silent no-op incrementals, delta provenance, sweep removal/restore, watermark freeze on mid-run failure + recovery re-coverage, duplicate quarantine + occurrence bump, deterministic replay onto a second fresh DB) + 7 RH-0031 catalog cases + 9 RH-0030 connectivity cases | `npm run test:int` (disposable PG18.6) | 24/24 pass |
| Lint | `npm run lint` | clean |
| Typecheck | `npm run typecheck` | clean |
| Production build | `npm run build` | green; `/api/health` dynamic (ƒ), shell static |

The new suite uses its own temporary database (`reelhouse_rh0032_tmp`,
dropped before/after each case) so it cannot collide with the RH-0030/RH-0031
suites even when `node --test` runs all three files as parallel processes.

### Deterministic replay evidence

The replay integration test runs the same scripted source evolution
(S0 full → S1 add+rename → S2 removal → S3 restore) against two
independent fresh databases and asserts byte-identical change history —
including `observed_at`/`recorded_at` (source save times plus the injected
fixed clock) and run sequence. The recorded evolution is exactly
add/add/add/add/remove/restore, with no phantom rows.

### Live CLI evidence (real `db:migrate` + `catalog:sync` + stub server)

Fresh database `reelhouse_rh0032_live` in the disposable container:

- `npm run db:migrate`: `applied 6 migration(s): 1, 2, 3, 4, 5, 6 (app
  role: reelhouse_app)`; second run: `up to date — 6 migration(s) already
  applied`.
- Baseline stub, run #1 full: `succeeded — libraries=2 items=9 upserted=8
  … changes=8 watermark=2024-01-01T00:00:00.000Z` (the 9th item is the
  out-of-scope PhotoAlbum; history holds the 8 initial adds).
- Run #2 incremental (unchanged): `upserted=8 changes=0` with
  `window=2023-12-31T23:59:59.000Z` — the documented 1-second overlap; only
  silence.
- `DATASET=mutated` stub, run #3: `changes=3` —
  `updated mov-arrival ["name","communityRating","etag"]` (the remaster,
  `source_revision=etag-arrival-rmx`, `observed_at=2025-06-01T12:00Z`),
  `added mov-citizen`, `removed mov-bare` (inferred: NULL
  `source_revision`); watermark advanced to `2025-06-02T09:30:00.000Z`.
- `DATASET=baseline` stub, run #4: `items=0 restored=1 tombstoned=1
  changes=2` — the sweep alone restored `mov-bare` (`first_seen_at`
  preserved, `last_seen_at` advanced) and retired `mov-citizen` (absent
  from this dataset — the source says it is gone); watermark unchanged
  (sweep-only runs do not advance it).
- `DATASET=duplicates` stub, run #5: the same id under both libraries →
  `quarantined=1 changes=1`, first occurrence wins
  (`mov-twin` lives under `lib-movies` as "Twin (Movies)"), quarantine row
  `duplicate_identity` with the conflicting library in its payload; run
  **succeeded**. Run #6 re-saw the conflict: `occurrences` bumped 1→2 on
  the same single row, `changes=0`.
- `FAULT_MODE=error500` stub, run #7: `failed` with error detail `Jellyfin
  API responded HTTP 500 for Items` — no URL, no API key anywhere in the
  output (key was deliberately suffixed `-SECRET` for the check);
  `media_sync_state.watermark` frozen at `2025-07-01`. Healthy recovery
  run #8: `succeeded, changes=0` — re-covered the same window
  idempotently. Run history: `full:succeeded, incremental:succeeded ×6,
  incremental:failed, incremental:succeeded` — append-only.
- `GET /api/health` (built app, curl): 200 with
  `migrations={state:ok, applied:6, pending:0, lastVersion:6}` and the
  DSN password masked; `GET /` 200.

### Caught and fixed during verification (why the suites earn their keep)

- The rewritten full-sync tombstone statement referenced `$2` with no `$1`
  anywhere (leftover from a renumber) — PostgreSQL rejects non-sequential
  parameter placeholders ("could not determine data type of parameter $1").
  Caught by the RH-0031 suite's very first sync case; fixed and re-run.
- First comparator draft compared incoming rating values directly against
  the stored numeric string, so `numeric(3,1)` rounding (7.99 stored as
  8.0) would have produced an eternal 'updated' loop. The comparator now
  canonicalizes the incoming value to the column scale before comparing.
- Three of my own integration assertions initially forgot that the full
  sync legitimately seeds the change history with `added` rows for the
  initial load — the failures were assertion bugs, and the corrected
  assertions now pin the exact full history sequence.

## Notes for reviewers

- **Adapted suites (no contract weakened):** `sync.int.test.ts`'s first
  case asserted exactly five migrations and an exact table list; both now
  derive from the on-disk migration directory (`loadMigrationFiles`) and
  assert the media_catalog tables as a subset, so they express the same
  contract independent of history length (the same treatment RH-0031 gave
  the RH-0030 suite). Its `FakeCatalogSource` gained the two new interface
  methods (its fixtures carry no `DateLastSaved`, so delta windows stay
  empty and every scenario behaves exactly as before — 7/7 still green).
- **`itemContent` deep-equal in RH-0031's idempotence case** selects only
  content columns, so the new `source_observed_at` column does not disturb
  it; the unchanged-source incremental also now provably writes zero
  change rows, strengthening that case's "creates no new rows" claim.
- Full-sync tombstones still stamp `removed_at = now()` in SQL (RH-0031
  semantics untouched); the injected clock feeds only change-history
  timestamps. CLI/wall-clock history is therefore not replay-identical by
  design — the injected-clock path is what the replay evidence covers.
- Within one library's presence sweep, a repeated id is deduplicated
  silently (an id-only listing carries no conflicting content to preserve);
  cross-library or content conflicts are what quarantine is for.
- Process hygiene during live verification hit the known "orphan node on
  reused port" failure mode again (my first stub kill targeted the
  backgrounded subshell, not node); all later steps killed the listener by
  its netstat PID and re-verified the port was free before the next
  dataset, so the recorded evidence reflects the real stubs.
- Worker-rule note: the queue's six-READY-jobs floor holds — after this
  claim, RH-0033–0037, RH-0028/0029 and RH-0004 remain genuinely
  unclaimed (RH-0004 duplicates RH-0016 and should never be claimed; both
  are leased anyway).

## Worker state

- Implementation commit, then REVIEW bookkeeping (queue row move, job spec
  `STATUS: REVIEW`, this report) on the job branch; pushed to origin.
- No other worker's branch, worktree, container, or process was touched.
- Time of last claim-window check: 2026-09-22, inside 11:00–21:00 EDT.
