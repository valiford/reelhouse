# RH-0022 Worker Report — Household continue-watching reconciliation and profile isolation guard

- **Date:** 2026-09-19 (claimed 20:33 America/New_York, inside the 11:00–21:00 window; work completed and left in REVIEW)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0022-household-continue-watching-reconciliation-and-profile-isolation-guard`
- **Base:** `c97cc1b` (the rh-0018 tip), so the branch tip carries the whole backend wave: main + rh-0002 + rh-0003 + rh-0015 + rh-0016 + rh-0017 + rh-0018 + RH-0022

## Claim

Dispatch bootstrap ran (`git fetch origin --prune`); the queue was read from
`origin/main` per protocol (`df9b1d4`, the "pre-8PM unclaimed reserve"
reload). RH-0022 was the highest-priority (1) READY, `AUTOMATION_ELIGIBLE:
true` job with no lease: branches/worktrees exist for RH-0002/0003/0008–0013
and RH-0015–0019 (all REVIEW — never duplicated), and legacy RH-0004
duplicates the in-review RH-0016. The lease branch was created from the
rh-0018 tip and **pushed before implementation** (remote lease at
`origin/rh-0022-…`, created 20:33). No other worker's branch or worktree was
entered or modified.

## What was built

Progress hardening plus Jellyfin→ReelHouse watch-state reconciliation, on
RH-0017's kernel and RH-0018's idempotency layer. **No new migration, no new
dependency, no new environment variable** (the reconcile path reuses the
catalog sync's `JELLYFIN_URL` / `JELLYFIN_API_KEY` /
`JELLYFIN_SYNC_TIMEOUT_MS` configuration via `loadJellyfinSyncConfig`).

### 1. Stale progress handling (store kernel)

`PUT /api/profiles/{id}/watch-state` accepts an optional `playedAt` (ISO
8601; at most 5 minutes in the future → otherwise 400). The write path now
locks the overlay row (`SELECT … FOR UPDATE`), then decides:

- a **strictly older** timestamped event never regresses the overlay —
  response flags `"stale": true` — but the play is still appended to the
  append-only `playback_event` once (history is honest);
- without `playedAt` the write asserts "now" and applies unconditionally —
  the RH-0017 contract, byte-identical for existing clients (the request
  shape only gains an optional key, absent keys stay absent).

### 2. Duplicate playback events

- An **unstamped write identical to the stored overlay** is a retry: nothing
  rewritten, no history appended, `"duplicate": true` (collapses keyless
  client retry storms that `Idempotency-Key` cannot see).
- An **exact replay of a timestamped event** (same profile, item, progress,
  event time, recorder) is detected in `playback_event` and never appended
  twice — both on the stale path and the apply path.
- The idempotency fingerprint now includes `playedAt`, so a replayed request
  with a different event time is a different event, not a false replay hit.

Responses now carry `applied` / `stale` / `duplicate` beside `watchState`
(additive; `idempotentReplay` responses unchanged plus explicit flags).

### 3. Jellyfin/ReelHouse reconciliation (`POST /api/profiles/{id}/watch-state/reconcile`)

New `src/lib/household/reconcile.ts` + route. One bounded page of the linked
Jellyfin account's resumable items (default 50 / max 200, `?limit=`), fetched
API-only through the shared `jellyfinGetJson` helper (timeout-guarded, key in
header only), folded into the overlay **in one transaction**:

- **Merge rule (last writer wins by event time):** Jellyfin strictly newer
  than the overlay applies (overlay + one `playback_event`
  `recorded_by='jellyfin_import'`); strictly older is `stale`; identical is
  `duplicate`. An item **without** a Jellyfin timestamp cannot be ordered —
  it only seeds an empty overlay and never overwrites local state (fail
  closed on ambiguous recency). Items with invalid identity/progress
  (negative or overrunning ticks, missing id) are **skipped and counted**,
  never half-applied, never clamped.
- **Duplicate safety:** exact replays of already-recorded events are
  detected before any write, so re-running reconciliation is a true no-op —
  counters re-reported (`scanned/applied/stale/duplicate/skipped`), history
  never accumulates.
- **Profile isolation guard:** the 1:1 `jellyfin_account_link` keeps one
  Jellyfin identity mapped to exactly one profile (the UNIQUE constraint
  refuses a second claimer); the run re-reads the link INSIDE the apply
  transaction and aborts 409 if it changed between fetch and apply, so
  fetched items can never land under the wrong profile. All writes are
  `profile_id`-scoped; cross-profile rows are unreachable and tested.
- **Fail closed:** unknown profile → 404; unlinked profile → 409; Jellyfin
  unconfigured/invalid/unreachable → new `503 jellyfin_unavailable` (mapped
  in the single error envelope; no demo fallback). Whole run commits or
  rolls back.
- **Observability:** each run tracks the per-profile `sync_cursor` job
  `jellyfin_watch_reconcile:{profileId}` through the RH-0017 lifecycle —
  started before the fetch, succeeded with the run counters, failed with a
  bounded ≤ 2000-char error that never clears the last success.

### 4. Continue-watching aggregation

The rail read (`?mode=continue`, and `?mode=all`) gained a deterministic
tie-break (`ORDER BY last_played_at DESC, media_ref_id`), so equal-timestamp
rows order and paginate stably across reads — the aggregate is the overlay,
which reconciliation keeps faithful to Jellyfin; the read itself stays a
bounded pure-DB query (no per-request Jellyfin dependency).

### 5. Documentation

`docs/HOUSEHOLD_STATE.md` is the updated contract (progress semantics with
`playedAt`/flags, reconciliation section, `jellyfin_unavailable` code,
route table, verification matrix). README household section updated.

## Verification

| Check | Evidence |
|---|---|
| Typecheck / lint / build | `tsc --noEmit` clean; `eslint .` clean; `next build` succeeds with the new `/api/profiles/[id]/watch-state/reconcile` dynamic route |
| Unit suite (`npm test`) | **105/105 pass** — all prior suites unchanged and green, +9 RH-0022 tests (tick/date/resume-item parsing incl. malformed refusals, the full merge-rule matrix, `playedAt` validation incl. 5-minute skew) |
| Integration suite (`npm run test:db`) | **101/101 pass** across all suites — RH-0017's household cases and RH-0018's lists cases unchanged and green on their own databases; +12 new cases on `reelhouse_household_watch_test`: identical-retry collapsing, stale refusal with single history append, exact event-replay dedupe, client-timestamp recency, tied-timestamp ordering, reconciliation seeding / idempotent re-run / newer-vs-older events / untimed items / skipped items / profile isolation / fail-closed paths / per-profile sync-cursor lifecycle |
| Live HTTP smoke (built tree, disposable DB `reelhouse_household_smoke22` since dropped, port 3113) | `GET /api/health` reachable; progress PUTs observed `applied:true` → identical retry `duplicate:true` → older `playedAt` `stale:true` (overlay position preserved) → future `playedAt` 400 `played_at must not be in the future`; rail GET intact. Reconcile fail-closed matrix over HTTP: unknown profile **404**, unlinked profile **409** with actionable message, unreachable Jellyfin (fake `JELLYFIN_URL=http://127.0.0.1:9`) **503 `jellyfin_unavailable`**, and the `sync_cursor` job row left with bounded `last_error` and `last_succeeded_at` NULL |

Migration posture: none needed — `playback_event.recorded_by` already
carries `'jellyfin_import'` (RH-0003), `sync_cursor`/`idempotency_record`
are reused as-is. Migrations apply from empty (10 applied) and on the
already-migrated databases untouched.

## Design decisions the reviewer should see

1. **Reconcile is explicit, not automatic.** The continue-watching rail
   stays a bounded pure-database read; reconciliation happens through the
   POST endpoint (a scheduled runner can call it per profile later). This
   keeps the read path free of a Jellyfin availability dependency and keeps
   every import atomic and observable.
2. **Equal timestamps apply; strictly older ones are stale.** Jellyfin
   re-reporting the same instant as the stored overlay is an idempotent
   replay (dedupe makes it a no-op); only strictly older events regress
   nothing. Untimed Jellyfin items never overwrite (local wins) — Jellyfin
   always stamps `LastPlayedDate` on resumable items in practice; the
   untimed path exists for tolerance and fails closed.
3. **Unstamped identical writes are treated as retries.** A genuinely new
   watch session that stops at exactly the same tick, with the same
   duration and completion flag, and sends no `playedAt`, would be
   undercounted once in history — accepted in exchange for bounding
   keyless retry storms; timestamped clients and `Idempotency-Key` clients
   are unaffected.
4. **`JELLYFIN_URL` config reuse:** the reconcile path reuses the catalog
   sync's Jellyfin configuration (same vars, same parser, same error
   class). `JELLYFIN_USER_ID` is deliberately ignored here — the resume
   query runs against the LINKED per-profile user id, which is the whole
   isolation point.
5. **Shared media refs survive profile deletion** (tested): `media_item_ref`
   is the identity bridge, not profile-owned; only the profile's overlay/
   history rows cascade. Consistent with RH-0017's contract.
6. **Leftover shared test container:** the disposable `reelhouse-pg18-test`
   container was found exited (daemon restart artifact) and was STARTED
   (not recreated/removed) for this run and left running for the next
   worker; no compose `down -v` was issued from this worktree.

## Handoff

Upon acceptance: this branch merges cleanly after RH-0018 in wave order
(its history already contains the entire backend chain); no migrations to
coordinate. The reconcile endpoint is safe to expose as-is under the
current LAN trust posture (caller-named profile, no auth — same note as
RH-0017/0018; RH-0006/auth track will tighten it). A recurring scheduler
for reconcile is future work (RH-0004/RH-0021 territory).

## Commits on the branch

1. `Harden watch progress against stale and duplicate events (RH-0022)` — store kernel (locked overlay read/write, event dedupe helpers, verdict flags), `playedAt` validation, watch-state route flags, exported `jellyfinGetJson`
2. `Add Jellyfin watch-state reconciliation API (RH-0022)` — `reconcile.ts` (resume client, merge rule, reconciler), reconcile route, `jellyfin_unavailable` mapping
3. `Cover watch reconciliation with unit and integration suites (RH-0022)` — 9 unit + 12 integration cases, suite registration
4. `Document watch-state reconciliation and hardening contract (RH-0022)` — HOUSEHOLD_STATE.md + README
5. *(this commit)* — `Mark RH-0022 REVIEW with verification report`
