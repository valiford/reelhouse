# RH-0007 — Backup, Restore, Resync, and Disaster Recovery

**STATUS:** WAITING  
**AUTOMATION_ELIGIBLE:** true  
**DEPENDENCY:** RH-0002 and RH-0004 accepted

## Goal

Prove ReelHouse can recover from database loss/corruption and can rebuild catalog-derived data from Jellyfin/media sources.

## Requirements

- Separate backup treatment for `reelhouse` household-owned state vs rebuildable `media_catalog`.
- Automated backup verification metadata.
- Disposable restore rehearsal.
- Catalog full-resync/rebuild procedure.
- Freshness/staleness indicators.
- Recovery-time and recovery-point assumptions documented.
- Never overwrite production during automated tests.

## Acceptance

A documented, repeatable disposable restore + catalog rebuild exercise succeeds and detects intentionally bad/incomplete backup artifacts.
