# RH-0012 — Jellyfin degraded-mode and reconnection UX

**STATUS:** REVIEW
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true

## Goal
Add explicit unavailable, stale, reconnecting, and recovery states when Jellyfin is slow, unreachable, or returns malformed data.

## Constraints
Use the Jellyfin API rather than its internal database. Preserve existing ReelHouse data boundaries. No deployment or credential changes. Worker stops in REVIEW.

## Acceptance
Build and targeted interaction/failure-path checks remain green and no internal Jellyfin database coupling is introduced.
