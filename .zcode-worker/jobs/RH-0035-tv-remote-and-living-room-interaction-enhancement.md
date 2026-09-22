# RH-0035 — TV remote and living-room interaction enhancement

**STATUS:** READY
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true
**WAVE:** 2026-09-22 today priority

## Goal
Complete remote/keyboard focus order, arrows/enter/back, visible focus, detail/modal escape, search entry, card density, skeleton/error states, and large-screen accessibility over the new PG-backed read models.

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
