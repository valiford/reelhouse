# RH-0017 — Household profiles preferences and watch-state persistence

**STATUS:** READY
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true
**WAVE:** Tomorrow priority

## Goal
Persist ReelHouse-owned household profiles, preferences, continue-watching overlay, watch state, Jellyfin account/item mappings, and sync metadata in the PG18 `reelhouse` database through the server API.

## Constraints
- Jellyfin remains playback/library authority and is accessed through its API, never its internal SQLite schema. PostgreSQL 18 is server-side only; clients never receive DB credentials. `reelhouse` stores household/app state and `media_catalog` stores normalized catalog data. No production restart, credential change, or media deletion.
- Preserve current-main safety, privacy, compatibility, and data-authority boundaries.
- No production secrets or environment-specific credentials in source.
- Worker ends in REVIEW; never merge, deploy, publish, or release.

## Acceptance
- Deterministic tests/regression evidence cover success and relevant stale/duplicate/failure/recovery paths.
- Existing build/lint/typecheck/runtime safety suites remain green.
- Diagnostics are bounded and redacted.
- Report evidence and stop in REVIEW.
