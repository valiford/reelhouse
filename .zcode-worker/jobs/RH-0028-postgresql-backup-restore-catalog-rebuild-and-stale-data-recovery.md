# RH-0028 — PostgreSQL backup restore catalog rebuild and stale-data recovery

**STATUS:** READY
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true
**WAVE:** 2026-09-21 tomorrow priority

## Goal
Separate durable household-state backup from rebuildable catalog state; add disposable restore verification, Jellyfin full resync, stale-data detection, checksums, and disaster-recovery runbook.

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
