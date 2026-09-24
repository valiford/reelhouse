# RH-0039 — Incremental Jellyfin sync and stale-catalog recovery

**STATUS:** READY
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true
**WAVE:** Pre-9PM reserve 2026-09-24

## Goal
Add cursored incremental refresh, change history, add/update/remove/restore handling, duplicate quarantine, freshness thresholds, stale detection, and deterministic replay without touching Jellyfin internal SQLite.

## Constraints
- Maximize PG18 data load while preserving boundaries: Jellyfin remains playback/library authority via API only; clients never receive DB credentials; `reelhouse` owns household state and `media_catalog` owns normalized catalog state.
- Start from current `origin/main`; branch/worktree existence is lease authority.
- Preserve review evidence and do not force stale branches.
- No production deploy/release/credential change.
- Worker ends in REVIEW.

## Acceptance
- Current-main implementation with deterministic regression/integration evidence.
- Relevant dataload/migrations are idempotent and provenance-preserving.
- Existing safety/build/test/accessibility guards remain green.
- Report evidence and stop in REVIEW.
