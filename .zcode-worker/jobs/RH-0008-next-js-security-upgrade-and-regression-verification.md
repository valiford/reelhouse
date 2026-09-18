# RH-0008 — Next.js security upgrade and regression verification

**STATUS:** READY
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true

## Goal
Upgrade the current vulnerable Next.js baseline to a patched supported release, preserve ReelHouse behavior, and add regression evidence for build, library/search routes, and demo fallback.

## Constraints
- Jellyfin remains the playback/library authority; use its API, not its internal SQLite schema.
- Browser/mobile/TV clients never receive PostgreSQL credentials or connect directly to PostgreSQL.
- Preserve the ReelHouse/media_catalog authority split and existing demo-safe behavior.
- No production deployment, Synology restart, credential changes, or media deletion.
- Worker ends in REVIEW.

## Acceptance
Build/lint/typecheck and targeted route/interaction tests remain green; failure/degraded paths are explicit and no internal Jellyfin DB coupling is introduced.
