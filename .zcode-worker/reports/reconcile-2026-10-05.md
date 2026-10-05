# valiford/reelhouse — queue reconciliation, 2026-10-05

Timestamp: 2026-10-05T22:55:05Z. Audited main: `b8d068fd6763e60e7bc628327022f03062a6e96f`; tree: `230088725cb204d7a7c3741f285a8152d6acfeb2`. Control-plane metadata only, not product recertification, merge, deployment or worker restart.

## Result

1 READY candidates; 1 new full specs. Existing source PRs/branches/reports/leases remain intact. Previous waves are historical.

| Priority | Job ID | Status | Agent | Description |
|---:|---|---|---|---|
| 1 | RH-0044 | READY | ZCODE | [Household catalog and spoiler final review carrier](jobs/RH-0044-household-catalog-and-spoiler-final-review-carrier.md) |
| 2 | RH-0041 | REVIEW | ZCODE | [Household and media delivery convergence](jobs/RH-0041-household-and-media-delivery-convergence.md) |
| 3 | RH-0042 | REVIEW | ZCODE | [Unwatched-content spoiler shield](jobs/RH-0042-unwatched-content-spoiler-shield.md) |
| 4 | RH-0043 | PROPOSED | ZCODE | [Household profile switch and cached-state isolation](jobs/RH-0043-household-profile-switch-and-cached-state-isolation.md) — explicit dependency/controller gate remains |
| 5 | RH-0025 | BLOCKED | ZCODE | [PostgreSQL ReelHouse schema migrations and household-state constraints](jobs/RH-0025-postgresql-reelhouse-schema-migrations-and-household-state-constraints.md) — explicit dependency/controller gate remains |
| 6 | RH-0028 | BLOCKED | ZCODE | [PostgreSQL backup restore catalog rebuild and stale-data recovery](jobs/RH-0028-postgresql-backup-restore-catalog-rebuild-and-stale-data-recovery.md) — explicit dependency/controller gate remains |
| 7 | RH-0029 | BLOCKED | ZCODE | [TV search discovery and recommendation read models on PostgreSQL](jobs/RH-0029-tv-search-discovery-and-recommendation-read-models-on-postgresql.md) — explicit dependency/controller gate remains |
| 8 | RH-0004 | BLOCKED | ZCODE | [Jellyfin → media_catalog Synchronization](jobs/RH-0004-jellyfin-media-catalog-sync.md) — explicit dependency/controller gate remains |

## Accepted-main ancestry

No newly accepted prerequisite was used to release gated work here.

## Delivery evidence

- RH-0041: `5fe1981ac0c7880368b2074b96de639ce15a11fb`, report `.zcode-worker/reports/RH-0041.md`. Source report declares REVIEW; checks are worker evidence, not rerun/recertified by this controller.
- RH-0042: `90fdb17f867d500e361bc9e213c6fb4aacf1ef80`, report `.zcode-worker/reports/RH-0042.md`. Source report declares REVIEW; checks are worker evidence, not rerun/recertified by this controller.

## Dispositions

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

## Limits and publication checks

Remote audit cannot see local Windows worktrees/processes or production state. Claim-time lease/dependency checks remain required. A carrier preserves source ownership and requires final-head verification. Metadata structure/state checks are separate from product tests. Publication uses expected-head compare-and-swap, then readback of every changed file. No source ref changes, PR closures, merges, deploys or worker restarts occur in this reload.
