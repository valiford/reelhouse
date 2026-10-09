# RH-0006 — API Persistence Hardening

**STATUS:** CLOSED (resolved by owner decision 2026-10-09 — covered for the delivered read-only API surface; see `.zcode-worker/reports/acceptance-2026-10-09.md`)  
**AUTOMATION_ELIGIBLE:** true  
**DEPENDENCY:** RH-0002 and RH-0003 accepted

## Goal

Make PostgreSQL-backed ReelHouse API operations production-safe.

## Scope

- bounded pool sizing
- transaction boundaries
- request idempotency where writes can retry
- pagination/limits for catalog and history reads
- health/readiness distinction
- database error redaction
- stale dependency behavior
- metrics/logging without credentials or sensitive household data
- graceful database outage behavior

## Acceptance

Failure-injection tests cover unavailable DB, timeout, duplicate request, partial transaction, and recovery without corrupting durable state.
