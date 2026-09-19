# RH-0021 — PostgreSQL backup restore catalog rebuild and disaster recovery

**STATUS:** READY
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true
**WAVE:** Tomorrow priority

## Goal
Create separate backup/restore treatment for household-owned `reelhouse` state and rebuildable `media_catalog`, with disposable restore verification, checksums, freshness, full Jellyfin resync, and recovery runbook.

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
