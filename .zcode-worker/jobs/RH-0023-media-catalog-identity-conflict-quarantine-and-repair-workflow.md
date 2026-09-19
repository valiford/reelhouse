# RH-0023 — Media catalog identity conflict quarantine and repair workflow

**STATUS:** READY
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true
**WAVE:** Pre-8PM reserve

## Goal
Add explicit quarantine/review tooling for ambiguous Jellyfin-to-media_catalog identity matches, duplicate files, renamed items, missing external IDs, and safe remapping without modifying Jellyfin's internal database.

## Constraints
- Preserve current-main authority, safety, privacy, and data-boundary rules.
- No production deploy/release/credential changes.
- Worker ends in REVIEW.

## Acceptance
Targeted deterministic regression evidence covers the changed behavior, existing gates remain green, and the worker reports evidence then stops in REVIEW.
