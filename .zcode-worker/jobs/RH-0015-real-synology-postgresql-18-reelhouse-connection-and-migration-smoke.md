# RH-0015 — Real Synology PostgreSQL 18 ReelHouse connection and migration smoke

**STATUS:** REVIEW  
**AGENT:** ZCODE  
**AUTOMATION_ELIGIBLE:** true  
**DEPENDENCY:** RH-0002 + RH-0003 layers integrated on this branch (both in REVIEW); real-Synology leg pending operator-provisioned environment credentials — see report

## Goal
Wire the server-side ReelHouse data layer to the existing Synology PostgreSQL 18 `reelhouse` database using environment-only credentials, verify migrations, pooling, transactions, readiness, and safe failure diagnostics.

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
