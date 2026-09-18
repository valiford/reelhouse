# ReelHouse Z-Code Worker Protocol

## Dispatch bootstrap — mandatory

Before reading queue state or deciding whether work is available:

1. Run `git fetch origin --prune`.
2. Treat **`origin/main`**, not the current checkout branch, as the authoritative control plane.
3. Read the queue from `origin/main:.zcode-worker/JOB_QUEUE.md` (for example, `git show origin/main:.zcode-worker/JOB_QUEUE.md`) or switch/update to `main` before inspecting it.
4. Never conclude "NO READY JOBS" from a REVIEW/job branch's copy of the queue.
5. Check remote branches and local worktrees for the candidate job ID before claiming; either one is a temporary lease.

## Worker rules

1. Claim only jobs marked `READY` with `AUTOMATION_ELIGIBLE: true` and satisfied dependencies.
2. An existing matching branch or worktree is a temporary lease. Skip leased work; never duplicate a claim.
3. Create one branch/worktree per claimed job.
4. Never enter or modify another job's worktree.
5. Successful engineering work ends in `REVIEW`, never `COMPLETE`.
6. Workers never merge to `main`, deploy, release, restart production services, or change production credentials.
7. Never expose PostgreSQL directly to browser/mobile clients.
8. Never replace or modify Jellyfin's internal database as part of ReelHouse work.
9. Preserve source provenance: ReelHouse-owned state, media catalog state, and Jellyfin state are separate authorities.
10. Fail closed on missing credentials, stale catalog state, ambiguous media identity, or migration uncertainty.
11. Maintain at least six genuinely unclaimed READY jobs whenever feasible without bypassing dependency gates.
12. New claims are allowed only 11:00–21:00 America/New_York.
13. No force-push.

## Source-import gate

RH-0001 has been accepted and squash-merged through PR #1 at `605ee8f`. The source-import gate is cleared. Follow current `origin/main` queue state for downstream eligibility.
