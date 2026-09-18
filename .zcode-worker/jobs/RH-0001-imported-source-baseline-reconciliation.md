# RH-0001 — Imported Source Baseline Reconciliation

**STATUS:** COMPLETE — accepted and squash-merged via PR #1 at `605ee8f` on 2026-09-18  
**AUTOMATION_ELIGIBLE:** true  
**PRIORITY:** 1

## Goal

Once the existing Synology ReelHouse source is present in this checkout, establish a trustworthy current-main baseline without changing production.

## Work

- Inventory framework/runtime, package manager, build system, Docker/Compose files, API boundaries, Jellyfin integration, persistence, tests, generated assets, and deployment-only files.
- Confirm secrets and runtime data are excluded from Git.
- Add or repair deterministic local verification commands.
- Document how the current Synology deployment maps to repository paths.
- Identify persistence currently owned by Jellyfin, ReelHouse, flat files, browser storage, or other stores.
- Record the exact migration surface for PostgreSQL 18 follow-on jobs.
- Reconcile existing source into the architecture documented in `docs/ARCHITECTURE.md` without rewriting working product behavior merely for cleanliness.

## Acceptance

- Existing application source is present and build/test/runtime verification is documented.
- No secrets, media files, databases, caches, or generated runtime state are committed.
- Current data authorities and Jellyfin boundaries are explicit.
- Follow-on RH-0002–RH-0007 can be safely activated.
- No deploy/restart/release.

## Integration

Accepted by the controller and squash-merged through PR #1. The source-import gate is cleared.
