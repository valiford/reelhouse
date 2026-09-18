# RH-0005 — Household State Persistence

**STATUS:** WAITING  
**AUTOMATION_ELIGIBLE:** true  
**DEPENDENCY:** RH-0003 accepted

## Goal

Move household-facing ReelHouse state behind the server API and PostgreSQL rather than scattering durable state across browser/local files.

## Scope

Profiles, preferences, favorites, watchlists, curated collections, home-row choices, continue-watching overlay, and other existing ReelHouse-owned state discovered by RH-0001.

## Requirements

Preserve existing UX behavior, provide deterministic ownership rules, prevent cross-profile leakage, support idempotent retries, and retain an offline/degraded read behavior where the current product supports it.

## Acceptance

Repository tests prove profile isolation and durable round trips through the API/data layer.
