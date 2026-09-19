# RH-0018 Worker Report — Favorites watchlists collections and home-row persistence

- **Date:** 2026-09-19 (claimed 14:29 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0018-favorites-watchlists-collections-and-home-row-persistence`
- **Base:** `73d7983` — the rh-0016 tip (the wave stack: main + rh-0002 + rh-0003 + rh-0015 + rh-0016), so this branch carries the full connection → migrator → schema → catalog lineage this job builds on

## Claim

Dispatch bootstrap ran (`git fetch origin --prune`); the queue was read from
`origin/main` per protocol. Lease check before claiming: branches/worktrees
exist for RH-0002, 0003, 0008, 0009, 0010, 0015, 0016, and — new since the
last dispatch — RH-0017 (worktree at the rh-0016 tip, no commits yet: leased
but just started). `origin/main`'s queue copy is stale (empty Review Queue);
the queue state on the wave branches was used as context only. RH-0018 is
the highest-priority READY, `AUTOMATION_ELIGIBLE: true`, dependency-free,
UNLEASED job in the current wave (legacy RH-0004 duplicates the in-review
RH-0016; RH-0011+ are the deprioritized legacy wave). The lease branch was
created and pushed before implementation.

## What was built

Durable household state over the RH-0003 schema: favorites, watchlists,
curated collections + membership, home-screen row configuration, enforced
profile isolation, and idempotent API operations. No schema beyond one
additive migration; no new env vars; no new dependencies.

### 1. Persistence library (`src/lib/household/`)

- `model.ts` (pure, unit-tested) — one copy of every input rule: uuid/name/
  description/external-id bounds, media identity `{source, id}` with source
  mirroring the DB CHECK, home-row source pairing (section XOR collection),
  idempotency-key rules, body cap (64 KiB), list bounds, and canonical-JSON
  request fingerprints (key-order independent, so formatting can never fork
  a key but semantics always collide).
- `store.ts` — every function takes a `QueryExecutor` (pg Pool or
  in-transaction client), so multi-step ops compose under `withTransaction()`.
  Isolation is enforced in SQL: profile-owned rows are addressed by
  `(id, profile_id)`, making foreign rows indistinguishable from absent
  (404, never a 403 existence leak, never a write). Items order by
  `(position, added_at, id)` per RH-0003's contract; explicit positions
  splice, duplicates converge (no-op or move), and reorder is a
  set-checked full permutation (`stale_order_set` 409 on mismatch, then
  renumber 1..n). Media refs resolve-or-create on writes, require on reads.
- `idempotency.ts` — `Idempotency-Key` machinery. The claim row
  (scope, key, fingerprint, stored response) commits in the SAME transaction
  as the mutation: crashes can never orphan one side of the pair, failed
  attempts free the key, replays return the original status+body
  byte-for-byte (+ `Idempotency-Replayed: true`), and key reuse with a
  different fingerprint is 409. Scopes keep unrelated ops from colliding.
- `errors.ts` / `http.ts` — bounded error contract: HouseholdErrors keep
  their code; anything else collapses to 503 `database_unavailable` with a
  generic message, the concrete error logged server-side through the
  RH-0002 redaction helpers.

### 2. API surface (9 route files, all `force-dynamic`)

`/api/favorites`, `/api/watchlists` (+`/{id}`, `/{id}/items`),
`/api/collections` (+`/{id}`, `/{id}/items`), `/api/home-rows`
(+`/{id}`, `/order`). GETs are bounded deterministic reads; mutations run
through the idempotency layer; favorites/watchlists/collections carry
`created`/`removed`/`deleted` flags so tolerant replays are honest.

### 3. Migration `0010_idempotency_responses.sql` (additive)

`response_status`/`response_body` on `idempotency_record`, with a CHECK
pinning stored responses to success-only, JSON-object, ≤ 8 KiB — the
bounded-replay contract enforced by the database, not convention. History
is extended, never mutated (migrator applies it like any pending file).

### 4. Documentation

`docs/HOUSEHOLD_STATE.md` (endpoint reference, ordering semantics,
isolation model, idempotency contract, error table, bounds, trust-model
note) + README section linking it.

## Verification

| Check | Evidence |
|---|---|
| Unit suite (`npm test`) | **72/72 pass** (14 new model tests: bounds, pairing, keys, fingerprints, error mapping) |
| Integration suite (`npm run test:db`) | **67/67 pass** — incl. 20 new household cases on a disposable PG18 in the suite's OWN database (created on demand, catalog-suite pattern): durability across connections, duplicate creates, splice/move/reorder, stale-set rejection, isolation, profile-delete cascades, collection→home-row cascade, replay byte-equality, fingerprint-reuse 409, mid-transaction rollback + key recovery, 8 KiB CHECK |
| Migrator compatibility | 0010 applies cleanly to the previously-migrated disposable DB; apply-from-empty applies all 10 |
| Lint / typecheck / build | clean; `next build` shows all 9 routes as dynamic server routes |
| Live HTTP smoke (disposable DB, port 3111) | health reachable (redacted summary); unknown profile → 404; favorite add 201 → same-key replay 201 + `Idempotency-Replayed: true` with identical body; same key different body → 409; watchlist create/add; stale reorder → 409 with counts; profile B sees empty + foreign watchlist 404; home rows create/append/list/reorder; malformed rowKey / missing field / 70 KB body → 400s |

Fail closed everywhere: unknown profile/media/row → 404, ambiguous
idempotency state → 500 (never re-execute), unknown errors → 503 with
redacted logging. Jellyfin is never contacted by this layer; credentials
stay in `pool.ts` behind `server-only`.

## Findings the controller should see

1. **One legacy test was adapted, minimally and intent-preserving:**
   `migrations.int.test.ts` hard-coded `0009_sync_cursors_and_idempotency.sql`
   as "the NEWEST applied migration" for its missing-file refusal test;
   migration 0010's existence created a contiguity gap and a different
   refusal message. The test now drops the newest file computed from the
   tree (same refusal path exercised: "is missing from the local migrations
   directory"). No migrator code changed. RH-0003's suite remains green.
2. **Merge order matters (unchanged from RH-0016's handoff, now extended):**
   this branch sits at the tip of the stack — rh-0002 → rh-0003 → rh-0015 →
   rh-0016 → rh-0018. Merging in that order (or this branch last) preserves
   everything; other orders re-surface queue/package.json conflicts. Note
   RH-0017's in-flight work (profiles/watch-state) will overlap
   `package.json` test-script lines and possibly route/module names with
   this branch — expect small conflicts to resolve at merge time.
3. **Trust model:** the household API has no authentication yet; the acting
   profile is caller-named, matching the current LAN posture. The
   SQL-level isolation here is the layer future authorization hardening
   (RH-0006 / security track) will tighten, not replace. Documented in
   HOUSEHOLD_STATE.md §"Trust model note".
4. **Idempotency record growth:** records accumulate (one per accepted
   keyed mutation, with ≤ 8 KiB stored response). Fine at household scale;
   pruning policy is a natural RH-0006 hardening item.
5. **Profile CRUD is deliberately absent** (RH-0017's lease): this layer
   only validates profile existence. Once RH-0017 lands, its profile
   creation is the single entry point this layer's 404s assume.

## Handoff

Upon acceptance: controller merges per finding 2. Remaining unclaimed READY
after this claim: RH-0019–0021 (current wave) plus the legacy wave — still
six genuinely unclaimed READY jobs, so the queue-maintenance rule holds.

## Commits on the branch

1. `Add household state persistence library and API (RH-0018)` — lib, routes, migration 0010, test wiring
2. `Cover household state semantics with unit and integration suites (RH-0018)` — both suites + the migrations-suite adaptation
3. `Document household state persistence and API (RH-0018)` — HOUSEHOLD_STATE.md + README
4. *(this commit)* — Job spec → REVIEW, queue updated (RH-0018 → Review Queue), this report.
