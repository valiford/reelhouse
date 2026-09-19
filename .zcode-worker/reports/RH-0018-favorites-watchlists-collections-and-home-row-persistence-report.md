# RH-0018 Worker Report — Favorites watchlists collections and home-row persistence

- **Date:** 2026-09-19 (claimed 14:29 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0018-favorites-watchlists-collections-and-home-row-persistence`
- **Base:** `73d7983` (the rh-0016 tip) — and the branch now also **contains rh-0017 (`bb13706`)** via an integration merge, so the branch tip carries the whole wave: main + rh-0002 + rh-0003 + rh-0015 + rh-0016 + rh-0017 + rh-0018

## Claim

Dispatch bootstrap ran (`git fetch origin --prune`); the queue was read from
`origin/main` per protocol. Lease check before claiming: branches/worktrees
existed for RH-0002, 0003, 0008, 0009, 0010, 0015, 0016, and RH-0017 (the
rh-0017 worktree sat at the rh-0016 tip with **no commits yet** — leased but
work not started). RH-0018 was the highest-priority READY,
`AUTOMATION_ELIGIBLE: true`, dependency-free, UNLEASED job (legacy RH-0004
duplicates the in-review RH-0016; RH-0011+ are the deprioritized legacy
wave). The lease branch was created and pushed before implementation.

**Concurrent-claim collision, found and resolved:** the RH-0017 worker
(leased at 13:40) was running in parallel with this dispatch and pushed its
commits (`f2cd3d6`…`bb13706`) while this job was in flight. Both branches
had independently created `src/lib/household/` and
`docs/HOUSEHOLD_STATE.md` from the same base. Per this wave's established
pattern (rh-0015 merged the parallel rh-0002/rh-0003 branches into its own
branch), this branch merged `bb13706` and was INTEGRATED: RH-0017's kernel
is now the foundation, and this job's lists layer was adapted onto it. No
force-push was used; rh-0017's commits enter this branch's history intact,
so wave-order merges stay conflict-free.

## What was built

Durable household lists state over the RH-0003 schema: favorites,
watchlists, curated collections + membership, home-screen row
configuration, SQL-enforced profile isolation, and idempotent API
operations — all on RH-0017's shared kernel. One additive migration; no new
env vars; no new dependencies.

### 1. Kernel reuse (from RH-0017, unmodified)

`errors.ts` (typed `HouseholdInputError` / `HouseholdNotFoundError` /
`HouseholdConflictError` + SQLSTATE classification), `api.ts` (the single
error→response mapper: 400 `invalid_request` / 404 `not_found` / 409
`conflict` / 503 `database_unavailable` / 500 `internal_error`, bounded
value-free messages), `store.ts` (`transact()`, `resolveMediaRef()`,
`claimIdempotencyKey()`, sync metadata). RH-0017's routes and tests pass
unchanged.

### 2. Lists layer (`src/lib/household/lists.ts` + friends)

- `model.ts` (pure, unit-tested) — one copy of every RH-0018 input rule:
  bounds (names 200, descriptions 2000, external ids/keys 200, positions
  ≤ 1,000,000, bodies 64 KiB, lists ≤ 500), media identity `{source, id}`
  mirroring the DB CHECK, home-row source pairing (section XOR collection),
  and canonical-JSON request fingerprints (key-order independent, so
  formatting can never fork a key but semantics always collide).
- `lists.ts` — domain SQL taking RH-0017's injected `SqlRunner`:
  favorites, watchlists (+items), collections (+membership), home rows.
  Isolation is enforced in SQL (`WHERE id = $1 AND profile_id = $2`) so
  foreign rows read as 404, never a 403 existence leak. Items order by
  `(position, added_at, id)`; explicit positions splice, duplicate adds
  converge (no-op or move), reorder is a set-checked full permutation
  (mismatch → conflict 409 with counts, then renumber 1..n). Media refs
  resolve-or-create on writes, require on reads.
- `idempotency.ts` — `runIdempotentMutation()` on top of RH-0017's
  `claimIdempotencyKey()`: the claim row commits in the SAME transaction as
  the mutation (a crash can never orphan one side; a failed attempt frees
  the key); same-key/same-fingerprint replays return the ORIGINAL
  status+body byte-for-byte plus `Idempotency-Replayed: true`;
  same-key/different-fingerprint is a 409 via the shared conflict class.
- `http.ts` — thin route wrapper funnelling every escape into RH-0017's
  single `householdErrorResponse` exit.

### 3. API surface (9 route files, all `force-dynamic`)

`/api/favorites`, `/api/watchlists` (+`/{id}`, `/{id}/items`),
`/api/collections` (+`/{id}`, `/{id}/items`), `/api/home-rows`
(+`/{id}`, `/order`). GETs are bounded deterministic reads; every mutation
runs through the idempotency layer; creates carry `created` flags so
tolerant replays are honest.

### 4. Migration `0010_idempotency_responses.sql` (additive)

`response_status`/`response_body` on `idempotency_record`, with a CHECK
pinning stored responses to success-only, JSON-object, ≤ 8 KiB — the
bounded-replay contract enforced by the database, not convention. History
is extended, never mutated.

### 5. Documentation

`docs/HOUSEHOLD_STATE.md` rewritten as the ONE contract for both surfaces
(route tables for profiles/preferences/watch-state/links AND
favorites/watchlists/collections/home-rows, ordering semantics, isolation
model, both idempotency shapes, unified error envelope, bounds,
trust-model note). README section merged accordingly.

## Verification

| Check | Evidence |
|---|---|
| Unit suite (`npm test`) | **96/96 pass** — RH-0017's 58 household tests unchanged, +14 RH-0018 model tests (bounds, pairing, keys, fingerprints, error-family contract), + prior suites |
| Integration suite (`npm run test:db`) | **89/89 pass** — RH-0017's 28 household cases unchanged + 20 RH-0018 lists cases on their OWN database (`reelhouse_household_lists_test`, created on demand): durability, duplicate creates, splice/move/reorder, stale-set rejection, isolation, profile-delete cascades, collection→home-row cascade, replay byte-equality, key-reuse conflict, mid-transaction rollback + key recovery, 8 KiB CHECK |
| Migrator compatibility | 0010 applies cleanly to previously-migrated disposable DBs; apply-from-empty applies all 10 |
| Lint / typecheck / build | clean; `next build` shows all 14 household+profiles+catalog routes as dynamic server routes |
| Live HTTP smoke (integrated tree, disposable DB, port 3112) | health reachable; profile created via RH-0017's `/api/profiles`; favorite added via RH-0018's `/api/favorites` for that SAME profile (shared kernel in production wiring); watch progress recorded against the same media bridge; unified error codes observed (`not_found` unknown profile/media, `Idempotency-Replayed: true` byte-identical replay) |

Fail closed everywhere: unknown profile/media/row → 404, ambiguous
idempotency state → 500 (never re-execute), unknown errors → bounded
log-only 500/503 per the shared mapper. Jellyfin is never contacted;
credentials stay in `pool.ts` behind `server-only`.

## Findings the controller should see

1. **Concurrent RH-0017/RH-0018 execution happened and is resolved here.**
   Both jobs were leased simultaneously (RH-0017's commits landed while
   this branch was in flight). This branch contains rh-0017 (`bb13706`) via
   merge `ab9e26b` with the layers integrated — RH-0017's kernel untouched,
   RH-0018 adapted onto it, both test suites green. Merge order for
   acceptance remains wave order: rh-0002 → rh-0003 → rh-0015 → rh-0016 →
   rh-0017 → rh-0018 (merging this branch last is conflict-free; its
   history already includes rh-0017).
2. **One legacy test was adapted, minimally and intent-preserving:**
   `migrations.int.test.ts` hard-coded `0009_…sql` as "the NEWEST applied
   migration" for its missing-file refusal test; migration 0010 created a
   contiguity gap and a different refusal message. The test now drops the
   newest file computed from the tree (same refusal path exercised). No
   migrator code changed; RH-0003's suite remains green.
3. **Two idempotency replay shapes coexist, deliberately:** RH-0017's
   watch-progress documents a body-flag (`"idempotentReplay": true`,
   history-append skip); RH-0018 endpoints use the stored-response pattern
   (byte-identical replay + `Idempotency-Replayed` header), which is
   canonical going forward. Both share `idempotency_record` and its
   conflict semantics; a future pass can migrate watch-progress to the
   stored-response shape if desired.
4. **Trust model:** the household API has no authentication yet; the acting
   profile is caller-named, matching the current LAN posture. The
   SQL-level isolation here is the layer future authorization hardening
   (RH-0006 / security track) will tighten, not replace.
5. **Idempotency record growth:** records accumulate (one per accepted
   keyed mutation, ≤ 8 KiB stored response). Fine at household scale;
   retention/pruning belongs to RH-0021 (backup/DR) or RH-0006.
6. **DML grants gap still open** (carried from RH-0015/RH-0017 findings):
   `reelhouse_app` still needs DML on the household tables before any
   production run; provisioning is an operator task.

## Handoff

Upon acceptance: controller merges per finding 1. Remaining unclaimed READY
after this claim: RH-0019–0021 (current wave) plus the legacy wave — still
six genuinely unclaimed READY jobs, so the queue-maintenance rule holds.

## Commits on the branch

1. `Add household state persistence library and API (RH-0018)` — lib, routes, migration 0010 (pre-integration shape)
2. `Cover household state semantics with unit and integration suites (RH-0018)` — suites + migrations-suite adaptation
3. `Document household state persistence and API (RH-0018)` — HOUSEHOLD_STATE.md + README
4. `Mark RH-0018 REVIEW with verification report` — control plane (pre-integration)
5. `Integrate RH-0017 household kernel with RH-0018 lists layer` — merge of `bb13706` + adaptation: lists layer onto the shared kernel, unified error contract, both suites green, merged docs
6. *(this commit)* — report updated for the integration; queue keeps both RH-0017 and RH-0018 in Review Queue.
