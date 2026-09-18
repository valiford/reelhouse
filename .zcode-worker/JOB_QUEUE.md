# ReelHouse — Z-Code Engineering Job Queue

The highest-priority READY job with satisfied dependencies and `AUTOMATION_ELIGIBLE: true` may be claimed. `origin/main` is authoritative.

## Ready Queue

| Priority | Job ID | Status | Agent | Description |
|---:|---|---|---|---|
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

| Priority | Job ID | Status | Agent | Description |
|---:|---|---|---|---|
| 2 | RH-0002 | REVIEW | ZCODE | Connect the ReelHouse server-side data layer to the existing Synology PostgreSQL 18 `reelhouse` database with safe environment/secrets handling |

## Completed / Integrated

| Job ID | Status | Integration |
|---|---|---|
| RH-0001 | COMPLETE | Imported Synology ReelHouse source baseline accepted and squash-merged through PR #1 at `605ee8f`; baseline inventory, deployment mapping, data authorities, and PostgreSQL 18 migration surface are now on `main` |

## Queue Rules

- Claim only READY, automation-eligible work with satisfied dependencies.
- Branch/worktree existence is the lease authority.
- Successful worker output ends REVIEW.
- Workers never merge, deploy, release, restart production services, change production credentials, or modify Jellyfin's internal database.
- Maintain at least six genuinely unclaimed READY jobs whenever feasible without bypassing dependency gates.
- Claims: 11:00–21:00 America/New_York.
