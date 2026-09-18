# RH-0002 — PostgreSQL 18 ReelHouse Connectivity

**STATUS:** REVIEW  
**AUTOMATION_ELIGIBLE:** true  
**DEPENDENCY:** RH-0001 accepted — satisfied via PR #1 / `605ee8f`

## Goal

Connect ReelHouse's server-side data layer to the existing Synology PostgreSQL 18 database named `reelhouse`.

## Requirements

- Server-side only; no browser/mobile PostgreSQL credentials.
- Environment-driven connection configuration with secret redaction.
- Least-privilege application role assumptions.
- Connection pooling and bounded timeouts.
- Fail-closed startup/health behavior for invalid configuration.
- Local/disposable test profile distinct from the real Synology target.
- No firewall/port exposure changes.
- No production credential values committed.

## Acceptance

A tested server-side connection abstraction can target ordinary PostgreSQL 18 and is configuration-compatible with the Synology instance without contacting production during worker verification unless an explicit safe test credential is already provided in the environment.
