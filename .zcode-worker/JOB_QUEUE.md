# ReelHouse — Z-Code Engineering Job Queue

The highest-priority READY job with satisfied dependencies and `AUTOMATION_ELIGIBLE: true` may be claimed. `origin/main` is authoritative.

## Ready Queue

_None._

## Waiting for imported-source baseline

These jobs are fully specified but must not be claimed until RH-0001 has verified that the existing Synology application source is present on `main`. The source now exists on the RH-0001 review branch; this gate clears when RH-0001 is accepted and merged.

| Priority | Job ID | Status | Dependency | Description |
|---:|---|---|---|---|
| 2 | RH-0002 | WAITING | RH-0001 accepted | Connect the ReelHouse server-side data layer to the existing Synology PostgreSQL 18 `reelhouse` database with safe environment/secrets handling |
| 3 | RH-0003 | WAITING | RH-0001 accepted | Add versioned PostgreSQL migrations for household profiles, preferences, watch state, favorites, watchlists, collections, Jellyfin links, and sync metadata |
| 4 | RH-0004 | WAITING | RH-0001 accepted | Build Jellyfin API to `media_catalog` synchronization with stable item identity, provenance, freshness, and idempotent reconciliation |
| 5 | RH-0005 | WAITING | RH-0003 accepted | Implement household profile, favorite, watchlist, collection, and continue-watching persistence through the ReelHouse API |
| 6 | RH-0006 | WAITING | RH-0002 + RH-0003 accepted | Harden the ReelHouse API persistence boundary, health checks, connection pooling, transactions, and bounded read/write contracts |
| 7 | RH-0007 | WAITING | RH-0002 + RH-0004 accepted | Add PostgreSQL backup/restore validation, catalog rebuild/resync, stale-data detection, and disaster-recovery runbook |

## Active Jobs

_None._

## Review Queue

| Priority | Job ID | Status | Branch | Description |
|---:|---|---|---|---|
| 1 | RH-0001 | REVIEW | `rh-0001-imported-source-baseline-reconciliation` | Imported Synology source reconciled into a verified repository baseline (inventory, deployment mapping, data authorities, PG-18 migration surface in `docs/BASELINE.md`); report in `.zcode-worker/reports/` |

## Completed / Integrated

_None._

## Queue Rules

- Claim only READY, automation-eligible work with satisfied dependencies.
- Branch/worktree existence is the lease authority.
- Successful worker output ends REVIEW.
- Workers never merge, deploy, release, restart production services, change production credentials, or modify Jellyfin's internal database.
- Maintain six genuinely unclaimed READY jobs after the source-import gate is cleared.
- Claims: 11:00–21:00 America/New_York.
