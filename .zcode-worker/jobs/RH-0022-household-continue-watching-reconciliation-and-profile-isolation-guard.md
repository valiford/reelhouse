# RH-0022 — Household continue-watching reconciliation and profile isolation guard

**STATUS:** READY
**AGENT:** ZCODE
**AUTOMATION_ELIGIBLE:** true
**WAVE:** Pre-8PM reserve

## Goal
Harden continue-watching aggregation, Jellyfin/ReelHouse state reconciliation, profile isolation, stale progress handling, and duplicate playback events through the server API.

## Constraints
- Preserve current-main authority, safety, privacy, and data-boundary rules.
- No production deploy/release/credential changes.
- Worker ends in REVIEW.

## Acceptance
Targeted deterministic regression evidence covers the changed behavior, existing gates remain green, and the worker reports evidence then stops in REVIEW.
