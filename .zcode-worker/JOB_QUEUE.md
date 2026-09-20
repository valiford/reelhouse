# ReelHouse — Z-Code Engineering Job Queue

The highest-priority READY job with satisfied dependencies and `AUTOMATION_ELIGIBLE: true` may be claimed. `origin/main` is authoritative.

## Ready Queue

| Priority | Job ID | Status | Agent | Description |
|---:|---|---|---|---|
| 1 | RH-0015 | READY | ZCODE | Real Synology PostgreSQL 18 ReelHouse connection and migration smoke |
| 2 | RH-0016 | READY | ZCODE | Jellyfin to PostgreSQL media_catalog synchronization |
| 3 | RH-0017 | READY | ZCODE | Household profiles preferences and watch-state persistence |
| 4 | RH-0018 | READY | ZCODE | Favorites watchlists collections and home-row persistence |
| 6 | RH-0020 | READY | ZCODE | Search library discovery and recommendation read-model enhancement |
| 7 | RH-0021 | READY | ZCODE | PostgreSQL backup restore catalog rebuild and disaster recovery |
| 1 | RH-0008 | READY | ZCODE | Next.js security upgrade and regression verification |
| 5 | RH-0012 | READY | ZCODE | Jellyfin degraded-mode and reconnection UX |
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
| 2 | RH-0009 | REVIEW | ZCODE | TV remote keyboard and focus-navigation shell (`rh-0009-tv-remote-keyboard-and-focus-navigation-shell`) |
| 3 | RH-0010 | REVIEW | ZCODE | Search filtering pagination and bounded-result contract (`rh-0010-search-filtering-pagination-and-bounded-result-contract`) |
| 4 | RH-0011 | REVIEW | ZCODE | Responsive home library presentation and poster fallback pass (`rh-0011-responsive-home-library-presentation-and-poster-fallback-pass`; carries rh-0010) |
| 5 | RH-0019 | REVIEW | ZCODE | TV remote keyboard and living-room interaction overhaul (`rh-0019-tv-remote-keyboard-and-living-room-interaction-overhaul`; integrates rh-0009 + rh-0011 chain) |
| 6 | RH-0013 | REVIEW | ZCODE | Poster image loading and performance guard (`rh-0013-poster-image-loading-and-performance-guard`; based on the rh-0019 chain integration `0e945d8`) |

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
