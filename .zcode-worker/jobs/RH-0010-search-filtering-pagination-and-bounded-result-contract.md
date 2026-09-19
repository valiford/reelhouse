# RH-0010 — Search filtering pagination and bounded-result contract

**STATUS:** REVIEW
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true

## Goal
Harden ReelHouse search/library APIs and UI for bounded pagination, filters, empty/error states, request cancellation, stale response ordering, and deterministic result identity.

## Constraints
- Jellyfin remains the playback/library authority; use its API, not its internal SQLite schema.
- Browser/mobile/TV clients never receive PostgreSQL credentials or connect directly to PostgreSQL.
- Preserve the ReelHouse/media_catalog authority split and existing demo-safe behavior.
- No production deployment, Synology restart, credential changes, or media deletion.
- Worker ends in REVIEW.

## Acceptance
Build/lint/typecheck and targeted route/interaction tests remain green; failure/degraded paths are explicit and no internal Jellyfin DB coupling is introduced.
