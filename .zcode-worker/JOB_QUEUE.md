# ReelHouse — Z-Code Engineering Job Queue

Origin/main is the authoritative control plane. Branch/worktree existence is lease authority. Only the newest table supplies candidate work.

## Owner acceptance — 2026-10-08 reconciliation and reload

> **Authoritative selection table.** This owner-authorized acceptance supersedes every earlier execution/READY table. Claim only READY rows here with eligible full specs, satisfied dependencies and no local/remote lease. Historical tables are nonclaimable lineage; never fall back to historical READY labels.
>
> Owner decision 2026-10-08 (in-session, America/New_York): **RH-0044 accepted and merged to main** at `59127ce` (merge `--no-ff` of carrier `eb1e6b5` onto `c465a70`; product tree byte-identical to the tested head `e95d958`). RH-0041 and RH-0042 are incorporated inside that acceptance — no separate merge. The four held twins **RH-0025 / RH-0028 / RH-0029 / RH-0004 are CLOSED as covered** by the carrier; no residual work ordered. **RH-0043's dependency is satisfied and the owner approves it READY** as the next claimable job. All other CLAIMED leases remain intact and unchanged; their disposition is a future owner action.
>
> **1 READY candidate**, subject to claim-time checks (11:00–21:00 America/New_York). Numeric reserve is conditional on useful work: do not invent filler or bypass dependency gates. Refresh main after each handoff and seek controller reconciliation after three additional REVIEW deliveries.
>
> Full worker prompt: [worker-2026-10-08.md](prompts/worker-2026-10-08.md) · Evidence: [acceptance-2026-10-08.md](reports/acceptance-2026-10-08.md).

| Priority | Job ID | Status | Agent | Description |
|---:|---|---|---|---|
| 1 | RH-0043 | READY | ZCODE | [Household profile switch and cached-state isolation](jobs/RH-0043-household-profile-switch-and-cached-state-isolation.md) — owner-approved 2026-10-08; dependency satisfied by RH-0044 acceptance |

### Delivery and ownership ledger — 2026-10-08 acceptance

| Job ID | Previous state | Reconciled state | Evidence |
|---|---|---|---|
| RH-0044 | REVIEW | COMPLETE | Owner accepted; merged to main `59127ce` (carrier `eb1e6b5`; verification per RH-0044 report: 209 hermetic / 75 integration / 43 real-browser checks) |
| RH-0041 | REVIEW | COMPLETE | Incorporated via RH-0044 carrier (merge `a42ad26` of frozen `5fe1981`); no separate merge |
| RH-0042 | REVIEW | COMPLETE | Incorporated via RH-0044 carrier (merge `bb1b2f3` of frozen `90fdb17`; 3 conflicts resolved and documented); no separate merge |
| RH-0025 | BLOCKED | CLOSED | Owner twin disposition: schema/migrations + household-state constraints delivered inside RH-0044 (migrations 0001–0010 incl. 0006 checks/uniques/tombstones); no residual work ordered |
| RH-0028 | BLOCKED | CLOSED | Owner twin disposition: backup/restore/rebuild + DR delivered inside RH-0044 (migration 0010, `scripts/dr*.ts`, `dr.int.test.ts`); no residual work ordered |
| RH-0029 | BLOCKED | CLOSED | Owner twin disposition: TV search/discovery/recommendation read models delivered inside RH-0044 (`browse`/`params`/`recommendations`, `/api/catalog/*`); no residual work ordered |
| RH-0004 | BLOCKED | CLOSED | Owner twin disposition: Jellyfin→media_catalog sync delivered inside RH-0044 (sync engine + change history + quarantine + stable identity/provenance/freshness); no residual work ordered |

## Superseded execution wave — 2026-10-05 reconciliation and reload

> **Superseded selection table; nonclaimable lineage.** Superseded by the 2026-10-08 owner acceptance above; this table no longer authorizes selection and historical READY labels are lineage only.
>
> Audited origin/main: `b8d068fd6763e60e7bc628327022f03062a6e96f`. Timestamp: 2026-10-05T22:55:05Z. Remote GitHub branches, PRs, reports and accepted-main ancestry were inspected. Local Windows worktrees/processes and production state were not observed; recheck ownership at claim time. Existing REVIEW/CLAIMED/RUNNING/ACTIVE leases remain intact. Source carriers do not acquire source leases.
>
> **1 READY candidates**, subject to claim-time checks. Numeric reserve is conditional on useful work: this owner-authorized bounded reload permits claiming candidates even below the usual reserve target. Never invent filler or release gates for depth. Refresh main after each handoff and seek controller reconciliation after three additional REVIEW deliveries.
>
> Full worker prompt: [worker-2026-10-05.md](prompts/worker-2026-10-05.md) · Evidence: [reconcile-2026-10-05.md](reports/reconcile-2026-10-05.md).

| Priority | Job ID | Status | Agent | Description |
|---:|---|---|---|---|
| 1 | RH-0044 | REVIEW | ZCODE | [Household catalog and spoiler final review carrier](jobs/RH-0044-household-catalog-and-spoiler-final-review-carrier.md) |
| 2 | RH-0041 | REVIEW | ZCODE | [Household and media delivery convergence](jobs/RH-0041-household-and-media-delivery-convergence.md) |
| 3 | RH-0042 | REVIEW | ZCODE | [Unwatched-content spoiler shield](jobs/RH-0042-unwatched-content-spoiler-shield.md) |
| 4 | RH-0043 | PROPOSED | ZCODE | [Household profile switch and cached-state isolation](jobs/RH-0043-household-profile-switch-and-cached-state-isolation.md) — explicit dependency/controller gate remains |
| 5 | RH-0025 | BLOCKED | ZCODE | [PostgreSQL ReelHouse schema migrations and household-state constraints](jobs/RH-0025-postgresql-reelhouse-schema-migrations-and-household-state-constraints.md) — explicit dependency/controller gate remains |
| 6 | RH-0028 | BLOCKED | ZCODE | [PostgreSQL backup restore catalog rebuild and stale-data recovery](jobs/RH-0028-postgresql-backup-restore-catalog-rebuild-and-stale-data-recovery.md) — explicit dependency/controller gate remains |
| 7 | RH-0029 | BLOCKED | ZCODE | [TV search discovery and recommendation read models on PostgreSQL](jobs/RH-0029-tv-search-discovery-and-recommendation-read-models-on-postgresql.md) — explicit dependency/controller gate remains |
| 8 | RH-0004 | BLOCKED | ZCODE | [Jellyfin → media_catalog Synchronization](jobs/RH-0004-jellyfin-media-catalog-sync.md) — explicit dependency/controller gate remains |

### Delivery and ownership ledger — current reconciliation

| Job ID | Previous state | Reconciled state | Evidence |
|---|---|---|---|
| RH-0038 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0039 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0040 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0030 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0031 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0032 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0033 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0034 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0035 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0036 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0037 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0024 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0026 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0027 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0022 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0023 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0015 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0016 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0017 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0018 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0019 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0020 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0021 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0008 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0009 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0010 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0011 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0012 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0013 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0014 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0002 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0003 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0005 | WAITING | WAITING | prior authoritative status; local ownership unobserved |
| RH-0006 | WAITING | WAITING | prior authoritative status; local ownership unobserved |
| RH-0007 | WAITING | WAITING | prior authoritative status; local ownership unobserved |
| RH-0001 | COMPLETE | COMPLETE | merged #1 |
| RH-0041 | READY | REVIEW | Completion report on frozen remote branch head declares REVIEW. Engineering evidence is worker-reported, not independently recertified or accepted. Preserve original lease. |
| RH-0042 | READY | REVIEW | Completion report on frozen remote branch head declares REVIEW. Engineering evidence is worker-reported, not independently recertified or accepted. Preserve original lease. |
| RH-0025 | READY | BLOCKED | Overlapping schema/sync/DR/read-model scope is delivered inside RH-0041. Hold separate implementation pending RH-0041/RH-0044 acceptance and exact residual-gap disposition; REVIEW is not accepted completion. |
| RH-0028 | READY | BLOCKED | Overlapping schema/sync/DR/read-model scope is delivered inside RH-0041. Hold separate implementation pending RH-0041/RH-0044 acceptance and exact residual-gap disposition; REVIEW is not accepted completion. |
| RH-0029 | READY | BLOCKED | Overlapping schema/sync/DR/read-model scope is delivered inside RH-0041. Hold separate implementation pending RH-0041/RH-0044 acceptance and exact residual-gap disposition; REVIEW is not accepted completion. |
| RH-0004 | READY | BLOCKED | Overlapping schema/sync/DR/read-model scope is delivered inside RH-0041. Hold separate implementation pending RH-0041/RH-0044 acceptance and exact residual-gap disposition; REVIEW is not accepted completion. |

## Historical snapshots — nonclaimable

Prior definitions and observations below never override the October 5 table/current specs. All prior selection instructions are superseded.

### ReelHouse — Z-Code Engineering Job Queue

The highest-priority READY job with satisfied dependencies and `AUTOMATION_ELIGIBLE: true` may be claimed. `origin/main` is authoritative.


### Superseded execution wave — 2026-10-04 reload

> **Superseded selection table; nonclaimable.** This owner-authorized restock supersedes every earlier execution/READY table below. Claim only READY jobs in this table, with full-spec dependencies satisfied and no local/remote branch/worktree lease. Historical tables never provide fallback authorization.
>
> Audited origin/main: `b934fc7f77f3022d16c16d1c1a7f92253fa3019f`. This remote audit observed GitHub branches and PRs; local worktrees/processes and live deployment state were not observed. Recheck ownership at claim time. After three additional jobs reach REVIEW, refresh main and review delivery evidence before proceeding. Numeric reserve is conditional on useful independent work; do not create duplicates or bypass dependency gates.
>
> Full worker prompt: [worker-2026-10-04.md](prompts/worker-2026-10-04.md) · Reload evidence: [reload-2026-10-04.md](reports/reload-2026-10-04.md).

| Priority | Job ID | Status | Agent | Description |
|---:|---|---|---|---|
| 1 | RH-0041 | READY | ZCODE | Household and media delivery convergence |
| 2 | RH-0042 | READY | ZCODE | Unwatched-content spoiler shield |
| 3 | RH-0043 | PROPOSED | ZCODE | Household profile switch and cached-state isolation — waits for RH-0041 accepted onto origin/main |
| 10 | RH-0025 | READY | ZCODE | Existing approved scope; inspect full spec and local leases before claim |
| 11 | RH-0028 | READY | ZCODE | Existing approved scope; inspect full spec and local leases before claim |
| 12 | RH-0029 | READY | ZCODE | Existing approved scope; inspect full spec and local leases before claim |
| 13 | RH-0004 | READY | ZCODE | Existing approved scope; inspect full spec and local leases before claim |

### Existing delivery ledger — remote reconciliation

| Job ID | Prior state | Observed state | Evidence |
|---|---|---|---|
| RH-0038 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0039 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0040 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0030 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0031 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0032 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0033 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0034 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0035 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0036 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0037 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0024 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0026 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0027 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0022 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0023 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0015 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0016 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0017 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0018 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0019 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0020 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0021 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0008 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0009 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0010 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0011 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0012 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0013 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0014 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0002 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0003 | READY | CLAIMED | remote branch lease; completion not re-certified |
| RH-0005 | WAITING | WAITING | prior authoritative status; local ownership unobserved |
| RH-0006 | WAITING | WAITING | prior authoritative status; local ownership unobserved |
| RH-0007 | WAITING | WAITING | prior authoritative status; local ownership unobserved |
| RH-0001 | COMPLETE | COMPLETE | merged #1 |


## Historical Ready Queue

| Priority | Job ID | Status | Agent | Description |
|---:|---|---|---|---|
| 1 | RH-0038 | READY | ZCODE | PostgreSQL household and media dataload consolidation |
| 2 | RH-0039 | READY | ZCODE | Incremental Jellyfin sync and stale-catalog recovery |
| 3 | RH-0040 | READY | ZCODE | PostgreSQL TV read models and disaster-recovery acceptance |
| 1 | RH-0030 | READY | ZCODE | Synology PostgreSQL 18 ReelHouse production connectivity completion |
| 2 | RH-0031 | READY | ZCODE | Jellyfin full-library dataload into PostgreSQL media_catalog |
| 3 | RH-0032 | READY | ZCODE | Incremental media_catalog refresh and change-history pipeline |
| 4 | RH-0033 | READY | ZCODE | Household profile preferences favorites and watch-state dataload |
| 5 | RH-0034 | READY | ZCODE | Search discovery recommendation and home-row PostgreSQL read models |
| 6 | RH-0035 | READY | ZCODE | TV remote and living-room interaction enhancement |
| 7 | RH-0036 | READY | ZCODE | PostgreSQL media identity conflict quarantine and repair workbench |
| 8 | RH-0037 | READY | ZCODE | PostgreSQL backup restore catalog rebuild and disaster-recovery acceptance |
| 1 | RH-0024 | READY | ZCODE | Real Synology PostgreSQL 18 ReelHouse connectivity and least-privilege role smoke |
| 2 | RH-0025 | READY | ZCODE | PostgreSQL ReelHouse schema migrations and household-state constraints |
| 3 | RH-0026 | READY | ZCODE | Jellyfin API to PostgreSQL media_catalog full synchronization |
| 4 | RH-0027 | READY | ZCODE | Household profiles favorites watchlists and continue-watching API persistence |
| 5 | RH-0028 | READY | ZCODE | PostgreSQL backup restore catalog rebuild and stale-data recovery |
| 6 | RH-0029 | READY | ZCODE | TV search discovery and recommendation read models on PostgreSQL |
| 1 | RH-0022 | READY | ZCODE | Household continue-watching reconciliation and profile isolation guard |
| 2 | RH-0023 | READY | ZCODE | Media catalog identity conflict quarantine and repair workflow |
| 1 | RH-0015 | READY | ZCODE | Real Synology PostgreSQL 18 ReelHouse connection and migration smoke |
| 2 | RH-0016 | READY | ZCODE | Jellyfin to PostgreSQL media_catalog synchronization |
| 3 | RH-0017 | READY | ZCODE | Household profiles preferences and watch-state persistence |
| 4 | RH-0018 | READY | ZCODE | Favorites watchlists collections and home-row persistence |
| 5 | RH-0019 | READY | ZCODE | TV remote keyboard and living-room interaction overhaul |
| 6 | RH-0020 | READY | ZCODE | Search library discovery and recommendation read-model enhancement |
| 7 | RH-0021 | READY | ZCODE | PostgreSQL backup restore catalog rebuild and disaster recovery |
| 1 | RH-0008 | READY | ZCODE | Next.js security upgrade and regression verification |
| 2 | RH-0009 | READY | ZCODE | TV remote keyboard and focus-navigation shell |
| 3 | RH-0010 | READY | ZCODE | Search filtering pagination and bounded-result contract |
| 4 | RH-0011 | READY | ZCODE | Responsive home library presentation and poster fallback pass |
| 5 | RH-0012 | READY | ZCODE | Jellyfin degraded-mode and reconnection UX |
| 6 | RH-0013 | READY | ZCODE | Poster image loading and performance guard |
| 7 | RH-0014 | READY | ZCODE | Accessibility and reduced-motion regression suite |
| 2 | RH-0002 | READY | ZCODE | Connect the ReelHouse server-side data layer to the existing Synology PostgreSQL 18 `reelhouse` database with safe environment/secrets handling |
| 3 | RH-0003 | READY | ZCODE | Add versioned PostgreSQL migrations for household profiles, preferences, watch state, favorites, watchlists, collections, Jellyfin links, and sync metadata |
| 4 | RH-0004 | READY | ZCODE | Build Jellyfin API to `media_catalog` synchronization with stable item identity, provenance, freshness, and idempotent reconciliation |

## Waiting for dependencies

| Priority | Job ID | Status | Dependency | Description |
|---:|---|---|---|---|
| 5 | RH-0005 | WAITING | RH-0003 accepted | Implement household profile, favorite, watchlist, collection, and continue-watching persistence through the ReelHouse API |
| 6 | RH-0006 | WAITING | RH-0002 + RH-0003 accepted | Harden the ReelHouse API persistence boundary, health checks, connection pooling, transactions, and bounded read/write contracts |
| 7 | RH-0007 | WAITING | RH-0002 + RH-0004 accepted | Add PostgreSQL backup/restore validation, catalog rebuild/resync, stale-data detection, and disaster-recovery runbook |

## Active Jobs

_None._

## Review Queue

_None._

## Completed / Integrated

| Job ID | Status | Integration |
|---|---|---|
| RH-0001 | COMPLETE | Imported Synology ReelHouse source baseline accepted and squash-merged through PR #1 at `605ee8f`; baseline inventory, deployment mapping, data authorities, and PostgreSQL 18 migration surface are now on `main` |
| RH-0044 | COMPLETE | Owner-accepted 2026-10-08; household-catalog and spoiler final review carrier merged to `main` at `59127ce` (136 files, +26,556/−136; includes RH-0041 + RH-0042 + per-profile watch-state plumbing and all delivery reports/screens) |
| RH-0041 | COMPLETE | Incorporated inside the RH-0044 acceptance (frozen `5fe1981`, merged clean) |
| RH-0042 | COMPLETE | Incorporated inside the RH-0044 acceptance (frozen `90fdb17`, 3 conflicts resolved and documented) |

## Queue Rules

- Claim only READY, automation-eligible work with satisfied dependencies.
- Branch/worktree existence is the lease authority.
- Successful worker output ends REVIEW.
- Workers never merge, deploy, release, restart production services, change production credentials, or modify Jellyfin's internal database.
- Maintain at least six genuinely unclaimed READY jobs whenever feasible without bypassing dependency gates.
- Claims: 11:00–21:00 America/New_York.
