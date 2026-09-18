# RH-0003 — ReelHouse Schema and Versioned Migrations

**STATUS:** READY  
**AUTOMATION_ELIGIBLE:** true  
**DEPENDENCY:** RH-0001 accepted — satisfied via PR #1 / `605ee8f`

## Goal

Create a portable PostgreSQL 18 schema and forward-only migration system for ReelHouse-owned state.

## Core entities

- household users/profiles
- profile preferences
- favorites
- watchlists + items
- curated collections + items
- watch/continue state
- playback-history overlay where ReelHouse owns it
- Jellyfin account/item links
- home-row configuration
- sync cursors / idempotency metadata
- operational timestamps/provenance

## Requirements

Use stable application identities independent of Jellyfin internal row IDs. Add appropriate uniqueness, FK, check, and indexing rules. Migrations must be deterministic, versioned, idempotently recorded, and refuse mutated history.

## Acceptance

Apply-from-empty, repeat-run, constraint, and rollback/recovery documentation all pass against disposable PostgreSQL 18.
