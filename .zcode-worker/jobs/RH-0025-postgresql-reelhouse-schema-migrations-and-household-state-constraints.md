# RH-0025 — PostgreSQL ReelHouse schema migrations and household-state constraints

**STATUS:** READY
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true
**WAVE:** 2026-09-21 tomorrow priority

## Goal
Create/finish versioned migrations, indexes, uniqueness/FKs, profile isolation, watch-state, favorites, watchlists, collections, Jellyfin links, home rows, and sync metadata with deterministic apply/reapply tests.

## Constraints
- Jellyfin remains playback/library authority and is accessed through its API, never its internal SQLite schema. Clients never receive PostgreSQL credentials. `reelhouse` owns household/app state; `media_catalog` owns normalized catalog state.
- Start from current `origin/main`.
- No production secrets, deployment, restart, release, or credential changes.
- Worker ends in REVIEW.

## Acceptance
- Deterministic PostgreSQL/Jellyfin integration evidence covers success and relevant failure/recovery paths.
- Existing build/lint/typecheck/runtime safety contracts remain green.
- Migrations are versioned and diagnostics bounded/redacted.
- Report evidence and stop in REVIEW.
