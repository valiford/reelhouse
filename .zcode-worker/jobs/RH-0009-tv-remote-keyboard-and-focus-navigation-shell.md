# RH-0009 — TV remote keyboard and focus-navigation shell

**STATUS:** READY
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true

## Goal
Add deterministic focus order, arrow/enter/back behavior, visible focus, modal escape, and remote-friendly navigation across home, search, rows, cards, and detail surfaces.

## Constraints
- Jellyfin remains the playback/library authority; use its API, not its internal SQLite schema.
- Browser/mobile/TV clients never receive PostgreSQL credentials or connect directly to PostgreSQL.
- Preserve the ReelHouse/media_catalog authority split and existing demo-safe behavior.
- No production deployment, Synology restart, credential changes, or media deletion.
- Worker ends in REVIEW.

## Acceptance
Build/lint/typecheck and targeted route/interaction tests remain green; failure/degraded paths are explicit and no internal Jellyfin DB coupling is introduced.
