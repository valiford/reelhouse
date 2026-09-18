# ReelHouse Z-Code Worker Protocol

1. `origin/main` is the authoritative control plane.
2. Claim only jobs marked `READY` with `AUTOMATION_ELIGIBLE: true` and satisfied dependencies.
3. An existing matching branch or worktree is a temporary lease. Skip leased work; never duplicate a claim.
4. Create one branch/worktree per claimed job.
5. Never enter or modify another job's worktree.
6. Successful engineering work ends in `REVIEW`, never `COMPLETE`.
7. Workers never merge to `main`, deploy, release, restart production services, or change production credentials.
8. Never expose PostgreSQL directly to browser/mobile clients.
9. Never replace or modify Jellyfin's internal database as part of ReelHouse work.
10. Preserve source provenance: ReelHouse-owned state, media catalog state, and Jellyfin state are separate authorities.
11. Fail closed on missing credentials, stale catalog state, ambiguous media identity, or migration uncertainty.
12. Maintain at least six genuinely unclaimed READY jobs whenever feasible after the imported source baseline is accepted.
13. New claims are allowed only 11:00–21:00 America/New_York.
14. No force-push.

## Source-import gate

Until the existing Synology ReelHouse application source has been imported to `main`, only RH-0001 may be claimed. RH-0002 through RH-0007 must remain waiting.
