# RH-0004 — Jellyfin → media_catalog Synchronization

**STATUS:** WAITING  
**AUTOMATION_ELIGIBLE:** true  
**DEPENDENCY:** RH-0001 accepted

## Goal

Synchronize authoritative Jellyfin library metadata into the existing PostgreSQL 18 `media_catalog` database without coupling to Jellyfin's internal SQLite schema.

## Requirements

- Jellyfin API only.
- Stable external mapping between ReelHouse/media_catalog IDs and Jellyfin item IDs.
- Movies, series, seasons, episodes, libraries, files/locations where available, genres, people, studios, external IDs.
- Idempotent upsert/reconciliation.
- Explicit provenance, observed-at time, source revision/freshness where available.
- Non-destructive retirement for missing items until policy threshold is met.
- Duplicate/ambiguous identity must quarantine rather than silently merge.
- Incremental sync plus safe full rebuild path.

## Acceptance

Fixture-backed synchronization proves create/update/no-change/missing/duplicate behavior and can rebuild catalog state without modifying Jellyfin.
