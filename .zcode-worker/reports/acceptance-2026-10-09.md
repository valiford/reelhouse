# Owner acceptance — 2026-10-09 — evidence

Decision: owner approved in-session, 2026-10-09 (~17:45–18:05 EDT, America/New_York):

1. **Accept RH-0043** (household profile switch and cached-state isolation).
2. **Resolve RH-0005 / RH-0006 / RH-0007** (the three long-WAITING dependency jobs).
3. **Reload the queue for work** (October 9 wave: RH-0045, RH-0046) and continue the worker cycle.

## What was merged

| Item | Value |
|---|---|
| Review head accepted | `1648eca` — branch `rh-0043-household-profile-switch-and-cached-state-isolation`, pushed 2026-10-08 13:34 EDT |
| Prior main | `3f78a8e` (October 8 reload; unchanged since — remote re-verified by `git ls-remote` immediately before merging) |
| Acceptance merge on main | `f7526c4` — `git merge --no-ff 1648eca` from `3f78a8e` |
| Product tree vs tested head | **byte-identical** (`git diff 1648eca^{tree} f7526c4^{tree}` empty) — the accepted tree is exactly the tree verified on 2026-10-08 |
| Contents | 14 files, +655/−51: `src/lib/session/profile-session.ts` (+6 hermetic tests), spoiler-shield slug re-keying + display-name migration (+5 tests), `ReelHouseApp` live URL identity + bounded switch cleanup + generation-bound requests, `src/app/page.tsx` Suspense boundary, `docs/TV_REMOTE.md` "Profile session isolation (RH-0043)" section, delivery report + 4 screenshots |

## Verification basis

Worker-executed at `9fa626b`, recorded in `.zcode-worker/reports/RH-0043.md`: typecheck/lint clean; **220/220 hermetic** (209 inherited + 11 new); **75/75 integration** on disposable PostgreSQL 18 under the least-privilege app role (container removed after evidence); production build green (9 routes); migrations 10/10; **21/21 real-browser acceptance** checks (playwright-core + system Edge, including deterministic parked-response races across in-session profile switches); **4/4 independent visual-judge pass** on 4 fixture-only screenshots. This repository has no CI; the branch report is the verification record. Suites were **not re-run at acceptance**, per the 2026-10-08 acceptance precedent — tree byte-identity plus the report is the corroboration standard. File-level corroboration at acceptance time: merge stat matches the report's module list (client-side + pure helpers only; no server-surface changes, matching the report's "server surface needed no change" statement).

No local cleanup was performed. The `rh-0043` remote branch and local worktree remain in place (no deletion without explicit owner order).

## Resolutions — RH-0005 / RH-0006 / RH-0007 (owner-ordered, evidence-based)

Survey basis: post-merge main `f7526c4` — API routes (`src/app/api/*`), libraries (`src/lib/*`), scripts, migrations 0001–0010, docs, `package.json`, and the delivered reports on main.

**RH-0005 (Household State Persistence) — CLOSED, superseded by the delivered household contract.**
The household state model is fully on main: migration `0006_household_state.sql` creates `household_profiles`, `household_preferences`, `household_jellyfin_accounts`, `household_favorites`, `household_watchlists`(+entries), `household_collections`(+entries), `household_home_rows`, `household_watch_state`, `household_playback_history`, `household_sync_runs`. Durable writes are PostgreSQL-backed and idempotent (`scripts/household-import.ts`; zero-write re-import proven in RH-0033/0038 evidence). Reads are profile-scoped and fail closed through the server API (`/api/home`, `/api/catalog/search`, `/api/catalog/items/[id]` with `?profile=`; unknown slug → 404; unscoped reads carry no cross-profile state), with structural isolation proven by the accepted plumbing (RH-0044) and session races (RH-0043: 21/21 browser checks). **Residual named, not ordered:** the 2025 spec's API *write* surface (profiles/favorites/watchlists/collections CRUD with idempotent retries) was part of the old A-generation chain (rh-0017/0018) that was superseded before integration and is NOT on main; it is not part of the shipped UX (identity is URL-driven, shield preference is client-side by design). Any future household write API is a new owner-ordered job building on the delivered schema.

**RH-0006 (API Persistence Hardening) — CLOSED, covered for the delivered API surface.**
On main: bounded pool (`src/lib/db/pool.ts`); redacted, fail-closed configuration and error envelopes (`src/lib/db/config.ts`, catalog/readmodel error paths — dead-URL secrets leak nothing, messages capped); bounded and keyset-paginated reads (search limit/offset bounds, cursor plans); `/api/health` with database + jellyfin diagnostics, graceful outage (503/degraded semantics) and stale-dependency behavior (`MEDIA_CATALOG_STALE_HOURS`, dead-Jellyfin degraded mode); transactional boundaries in the migrator, per-page sync transactions and DR restore dry-run (whole import replayed in one rolled-back transaction); failure-injection integration suites on main (75/75: unavailable DB, cancellation probe, rollback/commit/abort, tamper fail-closed, wrong-password redaction). **Residual named, not ordered:** write-path request idempotency (the old chain's `idempotency_record` machinery) has no subject on main — the shipped API is read-only GET plus idempotent operational CLIs — and must be carried into any future write API (see RH-0005 residual).

**RH-0007 (Backup, Restore, Resync, DR) — CLOSED, fully covered.**
On main: `src/lib/dr/{artifact,backup,restore,rebuild,status}.ts`, `scripts/dr.ts` (`dr backup|restore|rebuild|status`) + `scripts/dr-verify.ts`, migration `0010_disaster_recovery_ledgers.sql`, `docs/DR.md` + `docs/DISASTER_RECOVERY.md` (RTO/RPO; household-as-durable vs catalog-as-rebuildable separation; checksums recorded outside the DB), sha256 envelope/manifest verification metadata, disposable dry-run restore rehearsal plus 26-table digest comparison (`dr:verify` refuses non-empty scratch), catalog rebuild bound to the real sync engine with `dr_rebuild_runs` ledgers, staleness verdicts (backup age, never-rehearsed). Its stated dependencies are themselves delivered on main: RH-0002 scope = `src/lib/db/{config,pool,migrator}.ts` + migrations; RH-0004 scope = the catalog sync family (`src/lib/catalog/*`, `scripts/catalog-sync.ts`, change history, quarantine workbench).

## Reload

October 9 wave ordered by the owner: **RH-0045 (P1) — Next.js security upgrade integration carrier** (integrates frozen rh-0008 `4440f99`; main's head carries `npm audit` 9 advisories — 8 high, 1 critical) and **RH-0046 (P2) — in-app household profile switcher** (grounded in RH-0043's documented known-limits: no in-app switcher exists; the contract awaits exactly this surface). The six-job numeric reserve is intentionally unmet: only grounded work was ordered, per queue rules. The worker was directed to claim and continue in the same session.

## Not done (remains open)

- Deployment/hosted activation: none performed; this is repository integration only.
- Disposition of the 32 remaining CLAIMED branches: unchanged, future owner action. (2026-10-09 reconciliation finding: the 11 September-wave branches rh-0030–rh-0040 are provably ancestors of main via the RH-0041 convergence chain — batch COMPLETE-by-incorporation candidates; the 21 early-wave branches are unmerged and superseded — close-as-covered/abandon + prune candidates.)
- OneDrive exclusion/relocation of the repository and worktrees: recommended, not performed (two leases have previously dissolved spontaneously under the synced path).
- rh-0041 local branch still tracks `origin/main` instead of its own remote (cosmetic; untouched).
