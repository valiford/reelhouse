# ReelHouse — Z-Code Engineering Job Queue

The highest-priority READY job with satisfied dependencies and `AUTOMATION_ELIGIBLE: true` may be claimed. `origin/main` is authoritative.

## Ready Queue

| Priority | Job ID | Status | Agent | Description |
|---:|---|---|---|---|
| 6 | RH-0035 | READY | ZCODE | TV remote and living-room interaction enhancement |
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

| Priority | Job ID | Status | Agent | Description |
|---:|---|---|---|---|
| 1 | RH-0030 | REVIEW | ZCODE | Synology PostgreSQL 18 ReelHouse production connectivity completion |
| 2 | RH-0031 | REVIEW | ZCODE | Jellyfin full-library dataload into PostgreSQL media_catalog |
| 3 | RH-0032 | REVIEW | ZCODE | Incremental media_catalog refresh and change-history pipeline |
| 4 | RH-0033 | REVIEW | ZCODE | Household profile preferences favorites and watch-state dataload |
| 5 | RH-0034 | REVIEW | ZCODE | Search discovery recommendation and home-row PostgreSQL read models |
| 7 | RH-0036 | REVIEW | ZCODE | PostgreSQL media identity conflict quarantine and repair workbench |
| 8 | RH-0037 | REVIEW | ZCODE | PostgreSQL backup restore catalog rebuild and disaster-recovery acceptance |

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
