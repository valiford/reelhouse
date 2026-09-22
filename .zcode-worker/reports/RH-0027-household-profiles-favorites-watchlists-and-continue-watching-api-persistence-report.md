# RH-0027 Worker Report — Household Profiles, Favorites, Watchlists, and Continue-Watching API Persistence

- **Date:** 2026-09-21 (claimed 20:25 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0027-household-profiles-favorites-watchlists-and-continue-watching-api-persistence`
- **Base:** `1cf280c` (rh-0026 REVIEW tip; which stacks on rh-0024's REVIEW tip `c66e222`)

## Claim

Bootstrap followed the protocol: `git fetch origin --prune`, queue read from
`origin/main:.zcode-worker/JOB_QUEUE.md` (`f9a630e`; the local checkout is
the rh-0002 REVIEW branch, whose queue copy is not authoritative). Lease
check across remote branches and local worktrees: every READY job in the
queue is leased by an existing branch/worktree **except RH-0027, RH-0028,
RH-0029** (and RH-0004, which duplicates leased RH-0016's scope and was
never a candidate). RH-0027 is the highest-priority genuinely unleased READY
job (priority 4 in the 2026-09-21 wave, after leased 0024/0025/0026). Spec
verified `AUTOMATION_ELIGIBLE: true`, `STATUS: READY`. Worktree created at
`E:/Users/valif-c/OneDrive/Documents/GitHub/reelhouse-rh-0027`; no other
worker's worktree entered or modified.

**Base rationale:** the spec says "start from current `origin/main`"
(`f9a630e`, queue-only commits above the RH-0001 baseline). Household API
persistence consumes the reviewed connectivity/migrator layer (rh-0024) and
the media-identity model the catalog sync established (rh-0026) — building
on bare `main` would have duplicated leased jobs' deliverables, which rule 2
forbids. So this branch stacks on `1cf280c`, following the repo's
established later-jobs-stack-predecessors convention (rh-0026 stacked on
rh-0024's tip the same way). Expected merge order: **rh-0024 → rh-0026 →
rh-0027**; expected textual conflicts: `package.json` test-script rows,
`db/migrations/` numbering vs rh-0025's household DDL (see Risk note),
queue/doc files.

## What was built

ReelHouse-owned household state persisted to PG18 `reelhouse` behind a
bounded, profile-isolated API: profiles, per-profile preferences, favorites,
watchlists, curated collections, the continue-watching overlay, the
append-only playback-history overlay, and Jellyfin item/account links.
Jellyfin remains playback/library authority and is never contacted by this
layer; `media_catalog` is never touched; clients never receive PostgreSQL
credentials.

| Path | Role |
|---|---|
| `db/migrations/0002–0008` | Household schema: `reelhouse_set_updated_at` trigger; `household_profile` (unique case-insensitive names) + `profile_preferences` (jsonb object); `media_item_ref` `(source, external_id)` identity bridge + 1:1 `jellyfin_account_link` (ids, never tokens); `favorite`; `watchlist`/`watchlist_item`; `collection`/`collection_item` (creator = `ON DELETE SET NULL` provenance); `watch_state` (partial index matching the rail query) + append-only `playback_event`; `idempotency_record` |
| `src/lib/household/errors.ts` | Typed errors + SQLSTATE classification (unique→409, FK→404, CHECK/not-null→400, else storage) |
| `src/lib/household/validate.ts` | Pure profile/preferences/watch-state request validation (400 before PostgreSQL; value-free bounded messages) |
| `src/lib/household/model.ts` | Pure list-request model: names, media refs, positions, limits, 64 KiB body framing, canonical fingerprints |
| `src/lib/household/store.ts` | Injected-runner data access: profiles, preferences, links, media refs, watch state, idempotency claims; `transact()` for atomic multi-step writes |
| `src/lib/household/lists.ts` | Favorites, watchlists, collections; positioned items with splice/move and stale-proof atomic reorder (409 on set mismatch) |
| `src/lib/household/api.ts` | The single error exit: bounded, value-free; 503 fail-closed when the database is unconfigured (no demo fallback) |
| `src/lib/household/http.ts` | `householdHandler` wrapper, bounded JSON body reads, atomic `runWrite` |
| `src/app/api/profiles/**`, `favorites`, `watchlists/**`, `collections/**` | 12 route files exposing the surface (see `docs/HOUSEHOLD_API.md`) |
| `docs/HOUSEHOLD_API.md`, `docs/DATABASE.md`, `README.md` | Endpoint contracts, isolation/idempotency rules, migration list, cross-links |

## Key design decisions

1. **Isolation in SQL, not middleware.** Profile-owned rows are always
   addressed by `(id, profile_id)` pairs; a foreign row is indistinguishable
   from a missing one (404, never a 403 existence leak). `requireProfile`
   guards the routes; FK constraints are the defense in depth.
2. **Media identity is a durable anchor.** Household rows reference
   `(source, external_id)` via `media_item_ref`, deliberately NOT validated
   against `media_catalog` on write — the catalog is a rebuildable mirror in
   a separate database; favorites survive its rebuilds and retirement.
3. **Idempotent progress.** `PUT watch-state` with an `Idempotency-Key`
   claims `(scope, key, fingerprint)` and appends history in ONE
   transaction: same-payload replays return the stored overlay with
   `idempotentReplay: true` and append nothing; different payloads under the
   same key are 409. History stays honest.
4. **Positions without rewrite walls.** Explicit positions splice
   (neighbors shift by one UPDATE); reads order by
   `(position, added_at, media_ref_id)`; reorder renumbers 1..n only when
   the submitted set equals current membership, else 409.
5. **Tolerant creates, strict updates.** Duplicate-create replays return the
   existing row (`created: false`); explicit-id renames conflict loudly.

## Verification evidence

- `npm run lint` — clean. `npm run typecheck` — clean.
  `npm run build` — production build green (all new routes present as
  dynamic server routes).
- `npm test` — **92/92 pass** (hermetic; includes the new household unit
  matrix: validation bounds, SQLSTATE classification, row mappers,
  fingerprints, canonical JSON ordering).
- `npm run test:int` — **51/51 pass** against the disposable loopback PG18
  (`docker-compose.dev-db.yml`), including:
  - `household.int.test.ts` (14): migrations 0001–0008 apply + idempotent
    re-apply; bookkeeping read-only for the app role; profile CRUD,
    case-insensitive conflict, cascade delete; preferences replacement;
    1:1 link + cross-profile user conflict; watch-state overlay with
    exactly-one-history-row-per-write; replay without duplicate append;
    same-key-different-payload 409; continue-watching filtering
    (completed/zero-position exit the rail) and newest-first ordering;
    cross-profile isolation; app role stays DML-only.
  - `lists.int.test.ts` (10): favorites idempotence with original
    timestamps; watchlist tolerant create, rename conflicts, foreign-list
    404; splice/move/remove position semantics pinned exactly; stale
    reorder 409; collections provenance survival after creator deletion;
    case-sensitive external-id identity.
  - `db/integration.int.test.ts` (8, adapted — see Risk note): RH-0024's
    role/least-privilege/migrator evidence stays green with eight
    migrations.
- **Live end-to-end:** production server started against the dev database
  (`DATABASE_URL` = app role). `GET /api/health` → database reachable;
  profile create (201), duplicate 409, preferences PUT, jellyfin-link PUT,
  watch-state PUT + `Idempotency-Key` replay (`idempotentReplay: true`,
  `playback_event` count stayed 1 — proven via SQL), continue-watching rail
  with profile 2 seeing nothing, favorites add/re-add/remove, watchlist
  splice to position 1, foreign watchlist 404, stale reorder 409,
  collection create + membership + unknown-id 404, malformed payloads 400.
- **Browser:** app loaded in the in-app browser at `/` — shell, profile
  chip, and all sections render with the database configured (library stays
  demo/Jellyfin-backed by design; household UI consumption belongs to the
  frontend wave).

## Risk note for the reviewer

- **Shared dev database drift.** The persistent dev container's `reelhouse`
  database contained bookkeeping-less household tables from an earlier
  experiment (schema_migrations recorded only version 1), which made a
  naive re-apply fail closed with `relation "household_profile" already
  exists`. `db/integration.int.test.ts` now resets the full branch
  migration footprint (`resetPublicBaseline`) before fresh-apply evidence,
  and its one-migration count assertions were updated to eight. No
  production (Synology) target was ever touched.
- **rh-0025 overlap.** RH-0025 (household DDL owner) is leased with no
  commits; RH-0027 cannot persist anything without schema, so this branch
  authors migrations 0002–0008 following the reviewed old-chain design
  (rh-0003's household migrations, renumbered after this lineage's
  `0001_app_role_grants_baseline`, home rows and sync cursors excluded as
  out of RH-0027 scope). If rh-0025 lands its own DDL, expect textual
  conflicts in `db/migrations/` to reconcile at squash time — table/column
  names here match the old-chain canonical naming to minimize that.
- **Known bug class check.** Every ported parameterized statement was
  re-audited for parameter-index drift (the class flagged in rh-0016's
  `upsertLibrary`); the integration suite pins exact round-trip values
  (positions, ticks, timestamps, counts) which would catch any shift.

## Handoff

Branch `rh-0027-household-profiles-favorites-watchlists-and-continue-watching-api-persistence`
(5 commits + this report commit) is pushed to origin; worktree
`reelhouse-rh-0027` remains the lease. Status left **REVIEW**. Nothing
merged, deployed, released, or restarted; no production credentials or
Jellyfin internals touched. Remaining unclaimed READY work for the next
dispatch: **RH-0028, RH-0029** (RH-0004 remains a duplicate of leased
RH-0016 and must never be claimed).
