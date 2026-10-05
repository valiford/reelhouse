# RH-0025 — PostgreSQL ReelHouse schema migrations and household-state constraints

**STATUS:** BLOCKED
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

## Controller reconciliation — 2026-10-05

Overlapping schema/sync/DR/read-model scope is delivered inside RH-0041. Hold separate implementation pending RH-0041/RH-0044 acceptance and exact residual-gap disposition; REVIEW is not accepted completion.

Authoritative on origin/main; original source branches/reports/worktrees remain intact. Only READY rows in the newest execution table may be claimed.

UNBLOCK_CONDITION: Accepted-main incorporation ledger for RH-0041, directly or through RH-0044, identifies residual scope; controller narrows and explicitly releases that gap.
