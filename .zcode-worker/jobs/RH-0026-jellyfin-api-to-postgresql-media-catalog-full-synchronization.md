# RH-0026 — Jellyfin API to PostgreSQL media_catalog full synchronization

**STATUS:** REVIEW
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true
**WAVE:** 2026-09-21 tomorrow priority

## Goal
Build idempotent Jellyfin API synchronization into PG18 `media_catalog` with stable identity mapping, movies/series/seasons/episodes/files/people/genres/studios/external IDs, provenance, freshness, retirement, quarantine, and rebuild.

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
