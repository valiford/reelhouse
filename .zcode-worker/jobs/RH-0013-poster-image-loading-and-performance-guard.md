# RH-0013 — Poster image loading and performance guard

**STATUS:** READY
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true

## Goal
Add responsive image sizing, loading policy, layout-shift protection, fallbacks, and representative library performance checks.

## Constraints
Use the Jellyfin API rather than its internal database. Preserve existing ReelHouse data boundaries. No deployment or credential changes. Worker stops in REVIEW.

## Acceptance
Build and targeted interaction/failure-path checks remain green and no internal Jellyfin database coupling is introduced.
