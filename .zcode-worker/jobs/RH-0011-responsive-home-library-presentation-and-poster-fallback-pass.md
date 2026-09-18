# RH-0011 — Responsive home library presentation and poster fallback pass

**STATUS:** READY
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true

## Goal
Improve home rows, poster sizing, responsive density, loading states, missing-art fallbacks, and layout stability without changing Jellyfin authority.

## Constraints
Use the Jellyfin API rather than its internal database. Preserve existing ReelHouse data boundaries. No deployment or credential changes. Worker stops in REVIEW.

## Acceptance
Build and targeted interaction/failure-path checks remain green and no internal Jellyfin database coupling is introduced.
