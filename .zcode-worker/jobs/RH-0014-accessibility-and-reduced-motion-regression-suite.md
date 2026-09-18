# RH-0014 — Accessibility and reduced-motion regression suite

**STATUS:** READY
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true

## Goal
Add keyboard, focus, semantic, contrast, reduced-motion, and responsive interaction coverage for ReelHouse UI surfaces.

## Constraints
Use the Jellyfin API rather than its internal database. Preserve existing ReelHouse data boundaries. No deployment or credential changes. Worker stops in REVIEW.

## Acceptance
Build and targeted interaction/failure-path checks remain green and no internal Jellyfin database coupling is introduced.
