# RH-0030 — Synology PostgreSQL 18 ReelHouse production connectivity completion

**STATUS:** READY
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true
**WAVE:** 2026-09-22 today priority

## Goal
Complete server-side connection to the existing Synology PG18 `reelhouse` database with env-only secrets, least-privilege roles, pooling/timeouts, migrations, health/readiness, and safe degraded behavior.

## Constraints
- Maximize PG18 data load while preserving boundaries: Jellyfin remains playback/library authority via API only; never modify Jellyfin internal SQLite. Clients never receive PostgreSQL credentials. `reelhouse` owns household state; `media_catalog` owns normalized catalog state.
- Start from current `origin/main`; branch/worktree existence is the lease authority.
- Preserve review evidence; do not force stale branches.
- No production deployment/release/credential changes.
- Worker ends in REVIEW.

## Acceptance
- Deterministic PostgreSQL/Jellyfin integration evidence covers success and relevant failure/recovery paths.
- Migrations/imports are idempotent and provenance-preserving.
- Existing build/lint/typecheck/runtime safety contracts remain green.
- Report evidence and stop in REVIEW.
