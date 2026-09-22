# RH-0033 — Household profile preferences favorites and watch-state dataload — Worker Report

**Date:** 2026-09-22 (claimed 6:31 PM EDT, inside the 11:00–21:00 America/New_York window)
**Branch:** `rh-0033-household-profile-preferences-favorites-and-watch-state-dataload` (worktree `reelhouse-rh-0033`, stacked on `origin/rh-0032-…` at `f7a2c76`)
**Status:** REVIEW — not merged, nothing deployed, no production credentials touched, Jellyfin's internal database untouched.

## What was delivered

The household data layer: the `household_*` PostgreSQL family plus an
idempotent, provenance-preserving **snapshot import** that lands ReelHouse
household state — profiles, preferences, favorites, watchlists, curated
collections, home-row configuration, the continue-watching overlay, playback
history, and Jellyfin account/item links — into PG18 with structural profile
isolation. This is the dataload/schema job only: API persistence belongs to
the later household-persistence jobs (RH-0005/0017/0027) and read models to
RH-0034.

- `db/migrations/0007_household_state.sql` — the household family, all in
  schema `public` so migration 0001's default privileges cover the app role:
  `household_profiles` (slug identity, pinned; partial unique index enforcing
  at most one ACTIVE default; archived_at tombstone),
  `household_preferences` (key/value, registry bounded at the loader),
  `household_jellyfin_accounts` (a Jellyfin user can never drive two
  profiles), `household_favorites`, `household_watchlists` +
  `_entries`, `household_collections` + `_entries` (household-wide),
  `household_home_rows` (closed `kind` set + one bounded `config` key per
  reference kind), `household_watch_state` (position/duration ticks,
  `completed`, `hidden_from_continue` as the continue-watching overlay),
  `household_playback_history` (append-only; deterministic event identity
  `(profile, source, jellyfin_id, played_at)`), and `household_sync_runs`
  (per-import provenance with full write/remove/archive counters,
  unresolved-link and skipped-conflict counts, scrubbed error detail).
  Item-scoped rows carry `(source, jellyfin_id)` identity plus a nullable
  resolved `item_id` link into `media_items`. No cascade deletes anywhere:
  removal is a tombstone, archiving is a tombstone, history is never
  rewritten.
- `src/lib/household/manifest.ts` — pure (no I/O, no clock) fail-closed
  manifest validation/normalization: unknown fields rejected at every level
  (typo protection), enum/registry checks (preference keys, home-row kinds
  and their exact config shape), bounded sizes (≤64 profiles, ≤5000
  favorites, ≤2000 list entries, ≤20000 history events, 16 MiB file bound at
  the CLI), safe-integer tick validation, ISO-8601 timestamp
  canonicalization, and the duplicate policy: item-level duplicates collapse
  when identical and count as skipped conflicts when they differ (first
  occurrence wins) — while the ONE hard failure class is ambiguous identity
  (two names per profile/list/collection slug). Determinism: the same
  logical snapshot normalizes byte-identically (verified by test), payload
  order becomes row positions.
- `src/lib/household/load.ts` — `runHouseholdImport`: the whole mutation is
  ONE transaction (snapshots are bounded, so the transaction is bounded) —
  stale defaults demoted before the payload re-asserts its default (the
  partial unique index can never be violated mid-flight), moved Jellyfin
  accounts re-owned before upserts, profiles/preferences/favorites/
  watchlists/home-rows/watch-state/collections landed with `IS DISTINCT`-
  guarded upserts so an unchanged row is a true no-op (no write, no
  `updated_at` movement, no RETURNING row — write counters therefore report
  zero on a no-op re-import), snapshot-absent rows tombstoned/archived
  scoped to confirmed profiles, playback history appended with
  `ON CONFLICT DO NOTHING`, and set-once provenance stamps
  (`created_at`, `first_added_at`, `first_played_at`) preserved across
  removal/re-add cycles. Item links resolve against `media_items` in one
  query; unresolved references are tolerated, counted, and upgraded
  automatically on a later import (COALESCE-preserved, never silently
  unlinked). Zero-profile snapshots fail closed (refusing to reconcile the
  household to empty). Failures roll the transaction back (zero partial
  state), record a failed run with a scrubbed detail, and the retry is a
  clean recovery.
- `scripts/household-import.ts` — `npm run household:import --
  path/to/snapshot.json` (or `HOUSEHOLD_IMPORT_FILE`): fail-closed env and
  manifest handling, bounded file size, counter-rich success line, run-aware
  failure line, every echoed error scrubbed of `DATABASE_URL`.
- `scripts/dev/household-sample.json` — deterministic sample snapshot
  (V'Ali + Nicole mirroring the imported baseline's hardcoded profiles) for
  live verification against the dev database + Jellyfin stub catalog.
- Docs: `docs/HOUSEHOLD.md` (schema table, identity/provenance/isolation
  model, import algorithm, verification runbook), `docs/DATABASE.md`
  migration list, README household section, `.env.example`.
- `package.json` — `household:import` script; hermetic `test` and
  `test:int` include the new suites.

## Design decisions worth review

- **Complete-snapshot semantics (full mode only).** Like the catalog's full
  sync, the manifest is the whole truth for what it covers: a profile absent
  from the snapshot is archived, a favorite/watch-state entry absent for a
  confirmed profile is tombstoned, an absent preference key is removed.
  This is what makes the import a *reconciliation* (idempotent, converging)
  rather than an append. Preferences are deliberately hard-deleted when
  absent (state, not history; the run row records the import that removed
  them) — flagged here since it is the one surface without a tombstone.
- **Structural profile isolation.** Every profile-scoped statement is
  parameterized by `profile_id` AND re-scoped in its `WHERE` clause; there
  is no household read path that is not profile-scoped. An absent profile is
  archived and its rows stay byte-identical; re-asserting the profile
  restores it without touching anyone else's rows (proven by test).
- **Guards over freshness.** Unlike the catalog (where freshness timestamps
  advance per confirmed row), household `updated_at` moves only when content
  actually changes: `IS DISTINCT` guards turn value-identical re-imports
  into true no-ops. Byte-identical full-database dumps after a no-op re-import
  are the idempotency evidence.
- **Ambiguity fails, conflicts count.** Two different display names mapping
  to one slug is an identity collision (import aborts); two conflicting
  favorites for the same item is a data conflict (first wins, counted, run
  proceeds) — mirroring the catalog's quarantine philosophy without
  importing its quarantine machinery (household repair tooling is not in
  scope for RH-0033).
- **Unresolved catalog links are legal.** A household snapshot may reference
  Jellyfin items the catalog has not synced yet; rows land with `item_id`
  NULL, `unresolved_links` is counted, and the link upgrades automatically
  on a later import once the catalog catches up (demonstrated live end-to-end
  below). Household references survive catalog churn because catalog items
  are tombstoned, never deleted.
- **Stacking on rh-0032.** The household family depends on the connection
  layer (RH-0030), the migrator/roles (RH-0030), and `media_items` for link
  resolution (RH-0031) — none of which are on `main` yet. The branch stacks
  on `origin/rh-0032-…` (`f7a2c76`) exactly like rh-0031 stacks on rh-0030
  and rh-0032 on rh-0031; if any predecessor squash-merges, this branch
  rebases onto the successor (no force-push to the leased branches
  themselves).

## Verification evidence

All commands run in `reelhouse-rh-0033` on Node v22.19.0 against the
disposable loopback PG18 profile (`docker-compose.dev-db.yml`,
`127.0.0.1:5433`) — never Synology, never a live Jellyfin.

- `npm run lint` — clean.
- `npm run typecheck` — clean.
- `npm test` — **86/86 pass** (70 pre-existing + 16 new hermetic manifest
  tests: determinism, slug policy including `V’Ali → v_ali`, ambiguous
  identity fail-closed, unknown-field/preference-enum/home-row-config
  matrices, duplicate collapse + conflict counting, multi-default
  reconciliation, timestamp canonicalization, tick/bounds fail-closed,
  empty manifest, list/collection identity collisions, history dedupe).
- `npm run test:int` — **33/33 pass** (24 pre-existing + 9 new household
  integration tests under the least-privilege app role: migration 0007 +
  schema invariants incl. the one-active-default partial index; first import
  with catalog-resolved links and an unresolved ghost; byte-identical
  zero-write re-import across ALL household tables; snapshot evolution
  (tombstone → resurrect preserving `first_added_at`, rename-safe slugs,
  default reassignment, Jellyfin account move + unlink, history append);
  profile isolation incl. archive/restore of an absent profile;
  zero-profile guard preserving prior state; mid-transaction failure
  atomicity (zero partial state) + failed-run record + clean recovery;
  app-role DDL rejection on the household schema).
- `npm run build` — Next.js production build succeeds; routes unchanged.

Live CLI matrix (dev DB + `jellyfin-stub.mjs`, `DATASET=baseline` then
`DATASET=mutated`):

```text
db:migrate            → 7 migration(s) already applied (app role: reelhouse_app)
catalog:sync (full)   → run #1: libraries=2 items=9 upserted=8 … changes=8
household:import      → run #1 in 833ms: profiles=2/2w/0a prefs=5w favs=4w/0r
  (sample snapshot)     lists=3w/0a listEntries=4w/0r colls=2w/0a
                        collEntries=6w/0r homeRows=9w/0a watchState=3w/0r
                        history=4 linksUnresolved=2 conflictsSkipped=0
household:import      → run #2 in 188ms: ALL write counters 0 (no-op
  (identical)          re-import; full-table dumps byte-identical)
catalog:sync --inc    → run #2: changes=3 (mov-citizen added, mov-bare
  (DATASET=mutated)     tombstoned, Arrival remastered), watermark advanced
household:import      → run #3: favs=1w collEntries=1w — exactly the two
  (after catalog)       mov-citizen links upgraded NULL→resolved;
                        linksUnresolved 2→1 (mov-twin exists only in the
                        duplicates dataset); history still 0
household:import      → run #4 (evolved temp snapshot: Nicole dropped,
  (evolution)          theme→light, mov-citizen favorite removed):
                        profiles=1/0w/1a prefs=1w favs=1w/1r — Nicole
                        archived with her rows intact, the tombstoned
                        favorite preserved, ser-demo written only because
                        its position shifted
household:import      → run #5: profiles=1w/0a prefs=1w favs=2w/0r — the
  (original restore)   full snapshot restores Nicole and undoes the
                        evolution cleanly
```

Live SQL spot-checks after the mutated sync: `media_items.mov_bare.removed_at`
is set (catalog churn) while the household `watch_state`/`playback_history`
rows referencing it keep their resolved `item_id` (references survive
churn); `household_favorites.mov_citizen.item_id = 11` (auto-upgraded link);
exactly one active default profile (`v_ali`).

## Boundaries respected

- Jellyfin touched only through its HTTP API (the catalog sync against the
  stub); its internal SQLite was never read or written.
- No PostgreSQL credentials reached any client; the CLI and library are
  server-side only, errors scrubbed of `DATABASE_URL`.
- `reelhouse` household state and `media_catalog` catalog state remain
  separate authorities; household rows reference the catalog only through
  the nullable provenance link.
- No merge to `main`, no deploy, no release, no credential changes; other
  workers' branches and worktrees untouched (the stack parent is read-only
  from this worktree's perspective).
- Claim window: claimed ~6:31 PM EDT, inside 11:00–21:00 America/New_York.

## REVIEW notes

- The three entry upserts initially lacked `RETURNING` clauses and the
  membership upserts lacked guards — caught by the integration counters
  (write counts came back 0, then a no-op re-import reported writes) and
  fixed; the final SQL has guards on every surface, which is what makes the
  zero-write no-op evidence meaningful.
- `DELETE_MOVED_ACCOUNTS` originally used an `<> ALL(payload profile ids)`
  predicate that would keep a moved account's old row when its owner was
  also present in the snapshot (a unique violation); replaced with the
  per-user assignee comparison. Covered by the account-move integration
  scenario.
- Stale queue rows: `origin/main`'s queue still lists RH-0030–0032 as READY
  while their branches carry REVIEW reports; per the dispatch bootstrap the
  branch/worktree is the lease authority, and RH-0033's branch here is the
  claim record for this job.
- After RH-0033: RH-0034–0037 remain genuinely unclaimed READY in the new
  wave (six total unclaimed READY across waves including RH-0028/0029).
