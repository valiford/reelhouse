# RH-0024 — Real Synology PostgreSQL 18 ReelHouse connectivity and least-privilege role smoke

**STATUS:** REVIEW
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true
**WAVE:** 2026-09-21 tomorrow priority

## Goal
Connect the server-side ReelHouse data layer to the existing Synology PG18 `reelhouse` database using environment-only configuration, least-privilege roles, pooling/timeouts, readiness, migrations, and safe failure diagnostics.

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
