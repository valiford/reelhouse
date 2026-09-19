# RH-0017 Worker Report — Household profiles preferences and watch-state persistence

- **Date:** 2026-09-19 (claimed 13:40 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0017-household-profiles-preferences-and-watch-state-persistence`
- **Base:** `origin/rh-0016-jellyfin-to-postgresql-media-catalog-synchronization` @ `73d7983` — the chain tip that already integrates rh-0002 (connection layer) + rh-0003 (migrator + reelhouse schema) + rh-0015 (smoke) + rh-0016 (catalog sync + multi-database parameterization), matching the merge order recorded in RH-0016's handoff (`0002→0003→0015→0016`, this branch last)

## Claim

Dispatch bootstrap ran (`git fetch origin --prune`); the queue was read from
`origin/main` per protocol (the local checkout sits on the rh-0002 REVIEW
branch, whose queue copy is not authoritative). The `origin/main` wave lists
RH-0015 (p1) and RH-0016 (p2) above this job, but both are leased (branches +
worktrees, checked before claiming), as are rh-0002/0003/0008/0009/0010.
RH-0017 is the highest-priority unclaimed READY job with
`AUTOMATION_ELIGIBLE: true` and no dependency gate. No `rh-0017*` branch or
worktree existed — claim uncontested; the lease branch was pushed to origin
before implementation started.

## What was built

The ReelHouse-owned household persistence surface: profiles, per-profile
preferences, the watch/continue-watching overlay, Jellyfin account links,
the stable media-item bridge, and sync metadata — all in the PG18
`reelhouse` database, reached only through the server API (clients never
see SQL or credentials; the routes never fall back to demo data and fail
closed with `503 database_unavailable`).

### 1. Household library (`src/lib/household/`)

- `validate.ts` (pure) — every request rule checked before PostgreSQL:
  UUID ids, bounded display names / external ids / Jellyfin user ids,
  tick integers capped at `Number.MAX_SAFE_INTEGER` with the
  position-≤-duration rule mirrored from the schema CHECK, preferences as
  a JSON object with a hard 16 KB / depth-32 walk, limit params refused
  (never silently clamped) outside 1..max. Error messages are value-free
  and bounded — request bodies are never echoed into diagnostics.
- `errors.ts` (pure) — typed store errors (`Input/NotFound/Conflict`) plus
  SQLSTATE classification: `23505`→conflict, `23503`→missing-reference
  (404), `23514`/`23502`/`22P02`/`22003`→input, else storage. pg CHECK /
  unique messages carry constraint names but not values, so responses stay
  value-free by construction.
- `store.ts` — all SQL, with an injected runner (no `server-only`, no `@/`
  alias, type-only pg import — the smoke.ts pattern) so routes and
  plain-Node tests drive identical functions. Highlights:
  - `transact()` — checked-out client with BEGIN/COMMIT, best-effort
    ROLLBACK that never masks the original error, guaranteed release.
  - `createProfile` — profile + initial preferences in one CTE.
  - `resolveMediaRef` — the `(source, external_id)` bridge; creation is
    idempotent and race-safe (UNIQUE pair decides, lost insert re-reads).
  - `recordWatchProgress` (transactional) — resolve ref → overlay upsert →
    append-only `playback_event`, atomically; corrections rewrite
    `watch_state`, never history.
  - `listContinueWatching` — deliberately the exact shape of the
    `watch_state_resume_idx` partial index (in-progress, newest first).
  - `markSyncStarted/Succeeded/Failed` — cursor lifecycle where an absent
    cursor preserves the stored one, success clears the error, failure is
    bounded to 2000 chars and never erases `last_succeeded_at`.
  - `claimIdempotencyKey` — claim-or-replay on UNIQUE `(scope, key)`;
    same-fingerprint replay skips the history append, different
    fingerprint conflicts.
- `api.ts` — one error→response mapper for every route (codes:
  `invalid_request`/`not_found`/`conflict`/`database_unavailable`/
  `internal_error`) and `readBoundedJson()` (64 KB cap) so an oversized
  body can never balloon the server process; `DATABASE_URL` is scrubbed
  from anything echoed via `redactError`.

### 2. HTTP API (`src/app/api/profiles/**`, all `force-dynamic`)

- `GET/POST /api/profiles` — bounded list (`?includeInactive=1`, limit
  ≤ 200); create → 201, case-insensitive duplicate → 409.
- `GET/PATCH/DELETE /api/profiles/{id}` — read / rename+activate / hard
  delete (204; cascades to preferences, watch state, playback history,
  link — ReelHouse-owned rows only; Jellyfin and `media_catalog` are
  untouched).
- `GET/PUT /api/profiles/{id}/preferences` — full-replacement semantics
  (no merge guessing).
- `GET/PUT /api/profiles/{id}/watch-state` — `?mode=continue` answers the
  Continue Watching rail; PUT records progress with optional
  `Idempotency-Key` retries (replay → `idempotentReplay: true` without
  duplicate history; same key + different payload → 409).
- `GET/PUT/DELETE /api/profiles/{id}/jellyfin-link` — the 1:1 account
  link; user ids are data, never credentials; a stolen user id → 409.

### 3. Sync metadata

`sync_cursor` / `idempotency_record` are persisted through the store for
reconciliation jobs (library-level, deliberately no HTTP: clients have no
business touching operational state). The watch-progress idempotency is
their first in-API consumer. This realizes RH-0003's "operational state"
tables on the household side, complementing RH-0016's catalog-side choice.

### 4. Docs

`docs/HOUSEHOLD_STATE.md` (full contract: authorities, routes, progress
semantics, idempotency, sync metadata, roles) plus a README section.

## Acceptance criteria

| Criterion | Result |
|---|---|
| Deterministic tests cover success, stale/duplicate/failure/recovery paths | ✅ Unit 24/24 (validation, classification, mapping, scripted-runner store paths, transact commit/rollback, fingerprint, truncation) + integration 22/22 (below) |
| Duplicate / identity paths | ✅ Case-insensitive profile-name conflict; stable `(source, external_id)` re-resolution; 1:1 link uniqueness (stolen Jellyfin user id → 409); idempotency claim → replay (no duplicate history) → payload-change conflict |
| Stale / failure / recovery paths | ✅ Sync start→succeed→fail→recover keeps `last_succeeded_at` through failure and clears the bounded error on recovery; rolled-back progress write leaves no overlay row, no event, **no media ref**; missing-profile write maps to 404 with no orphan ref |
| Existing build/lint/typecheck/runtime suites green | ✅ lint clean, typecheck clean, build succeeds, 84/84 unit, 69/69 integration (migrations 27, smoke 6, catalog 14, household 22) |
| Diagnostics bounded and redacted | ✅ Value-free messages, 300-char response cap, 2000-char sync-error cap, `redactError` on every echo; integration suite asserts the disposable credential pair never appears in a store error |
| No production contact, no deploy/merge | ✅ Only the disposable local Docker PG18 (tmpfs, discarded) was touched; nothing merged; no credentials added to source |

## Verification evidence (2026-09-19, Node 22.19.0 / Docker, disposable PostgreSQL 18.6 only)

- `npm run lint` — clean. `npm run typecheck` — clean.
- `npm test` — **84/84** unit (was 60 before this branch; +24 household).
- `npm run test:db:up` → disposable `postgres:18` healthy on 127.0.0.1:55433.
- `npm run test:db` — **69/69** (migrations 27, smoke 6, catalog 14,
  **household 22** — own `reelhouse_household_test` database inside the
  shared container, migrations applied fresh, tables truncated per test).
- `npm run build` — succeeds; route surface grows exactly by the five new
  dynamic routes (`/api/profiles`, `/api/profiles/[id]`,
  `/api/profiles/[id]/preferences`, `/api/profiles/[id]/watch-state`,
  `/api/profiles/[id]/jellyfin-link`).
- **Live end-to-end pass** (`next start` against the disposable database,
  HTTP-level): health reports `reachable` with redacted config summary;
  create 201 → duplicate 409 → blank name 400; progress PUT 200 → same
  `Idempotency-Key` replay 200 with `idempotentReplay: true` (no extra
  history row) → same key different payload 409; `?mode=continue` returns
  exactly the in-progress row; preferences PUT 200, array 400; link
  PUT/GET 200, second profile claiming the same user id 409; unknown
  profile 404, malformed UUID 400, position>duration 400; DELETE 204 →
  cascaded reads 404 and the profile gone from the list.
- Disposable container discarded (`test:db:down`); the `next start` server
  was stopped by its exact listening PID only.

## Findings the controller should see

1. **Route-level 503 for unconfigured DB is deliberate.** `/api/health`
   treats "unconfigured" as ok (demo mode), but the household endpoints
   have no demo household state, so they fail closed with
   `503 database_unavailable`. This asymmetry is documented in
   `docs/HOUSEHOLD_STATE.md`.
2. **Deletion is a hard cascade.** `DELETE /api/profiles/{id}` removes the
   profile and every owned row (the schema was designed for it). If the
   controller prefers a soft-deactivate-only UX, that is a product
   decision for RH-0018+/UI work; the API also exposes `PATCH …isActive`
   for soft state.
3. **Idempotency records have no TTL.** `idempotency_record` rows are kept
   forever by design (schema has no expiry). Fine at household volume;
   if replay protection ever needs a retention window, that belongs with
   RH-0021's operational work, not an ad-hoc delete here.
4. **DML grants still open (carried from RH-0015/RH-0016 findings).** The
   runtime role needs DML on the household tables + SELECT/INSERT on
   `media_item_ref`; provisioning remains the documented operator task for
   RH-0006.
5. **`playback_event` is write-only for now.** Progress writes append
   history; no HTTP read of the raw event history was added — the
   overlay (`watch_state`) serves the client use cases. A bounded history
   read belongs to RH-0020's read-model work if wanted.
6. **Merge order unchanged.** This branch is a descendant of rh-0016;
   merging `0002→0003→0015→0016→0017` (or this branch last) preserves all
   resolutions. `package.json` test scripts and README were appended to on
   this base only.

## Handoff

Upon acceptance: controller merges this branch after RH-0016 (order in
finding 6). RH-0018 (favorites/watchlists/collections/home rows) should
reuse this exact surface — `resolveMediaRef` + `transact` + the
validation/error plumbing are its building blocks. Review queue after
integration: RH-0017.

## Commits on the branch

1. Lease (`rh-0017-…` pushed to origin before implementation started).
2. *(implementation)* — Household persistence library, API routes, unit +
   integration suites, `package.json` test registration.
3. *(docs)* — `docs/HOUSEHOLD_STATE.md`, README household section.
4. *(this commit)* — Job spec → REVIEW, queue updated (RH-0017 → Review
   Queue), this report.
