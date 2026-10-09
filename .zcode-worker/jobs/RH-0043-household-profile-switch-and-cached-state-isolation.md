# RH-0043 — Household profile switch and cached-state isolation

STATUS: COMPLETE (owner-accepted 2026-10-09; merged to main at `f7526c4` from REVIEW head `1648eca`; report: `.zcode-worker/reports/RH-0043.md`)
AGENT: ZCODE
AUTOMATION_ELIGIBLE: true
BASE: origin/main
PRIORITY: 1
WAVE: 2026-10-08 (owner-approved; original assignment 2026-10-04, reconciled 2026-10-05)
DEPENDENCIES: SATISFIED 2026-10-08 — RH-0041 incorporated via the RH-0044 carrier accepted onto origin/main (acceptance merge `59127ce`)
AUDITED_MAIN: b8d068fd6763e60e7bc628327022f03062a6e96f

## Objective and user-visible outcome

After RH-0041 is accepted, protect profile switching/logout from stale cached watchlists, continue-watching rows, spoiler-reveal state and late in-flight responses. Ensure identity-bound requests and cache keys, explicit cancellation/generation handling, and bounded state cleanup. Use disposable profile/session fixtures to prove that one profile's state cannot render in another's view. Never access production profiles or modify Jellyfin authority.

Deliver the complete bounded outcome, including its usable interface or runnable acceptance path. A queue/status report alone is not completion. Inspect actual current implementation before deciding what must change; reuse compatible existing modules. If the feature already exists, demonstrate the remaining concrete gap or produce incorporation evidence and stop without inventing a redundant implementation.

## Scope and implementation contract

1. Fetch origin, read `.zcode-worker/JOB_QUEUE.md`, `.zcode-worker/ZCODE_WORKER.md`, applicable AGENTS.md and current canonical project docs from origin/main. The 2026-10-05 execution wave controls selection; historical tables are lineage only.
2. Check local and remote branches, worktrees, open PRs and matching source reports. Existing leases remain owned. Work from one fresh isolated branch/worktree named for RH-0043; never enter, reset, rebase, stash, delete or take over another session's worktree.
3. Record exact base and source SHAs. For convergence jobs, use immutable committed snapshots only after confirming permitted source access; preserve original branches and reports. Build an additive carrier with a file/behavior disposition ledger. Do not declare squash-merged work absent merely because commit ancestry differs.
4. Reproduce the target gap using safe fixtures or the current local product. Establish concrete before/after behavior and the smallest coherent implementation. Keep changes within this assignment.
5. Handle unavailable, ambiguous, stale, partial and failed inputs explicitly. Bound resources, validate inputs and keep secrets and real private data out of code, logs, screenshots and reports.
6. Update directly affected documentation to reflect verified behavior, with repository delivery kept separate from hosted activation. No production state is inferred from source or green tests.

## Dependency and ownership gate

Do not claim this job until RH-0041 accepted onto origin/main. Confirm the prerequisite's accepted behavior and required files on then-current origin/main. A REVIEW branch or green PR is not accepted integration. This job is intentionally dependency-gated; do not promote it just to maintain reserve depth.

**Owner update 2026-10-08:** the gate is satisfied — RH-0041 was incorporated into the RH-0044 carrier, which the owner accepted onto origin/main at merge `59127ce` — and the owner approved this job READY. Claim per the newest authoritative table in `.zcode-worker/JOB_QUEUE.md` (11:00–21:00 America/New_York) with the usual lease checks.

Remote audit cannot see local Windows leases or processes. Recheck ownership immediately before claim. One active claim per job, one job per worker at a time. New claims honor the repository's Eastern-time window; where the existing protocol has no time restriction, do not invent one.

## Acceptance criteria

- The stated outcome works from an independently reproducible local/disposable setup on the final branch head.
- Demonstrated baseline gaps are fixed, or exact incorporation evidence proves no implementation is needed; no duplicate parallel subsystem is introduced.
- Relevant error, cancellation, stale-data, retry and accessibility cases behave honestly and preserve existing safety contracts.
- Convergence work retains all accepted main behavior and source protective tests, with explicit omissions and semantic conflict decisions.
- Verification results record actual commands, exit status and test counts when reported; unrun checks and external/physical-device gates remain visibly unverified.
- Deliverable code, relevant docs and the report are coherent and reviewable. Work ends REVIEW; only an authorized reviewer may accept or merge it.

## Verification

Run: repository lint/typecheck/test/build commands where present; focused browser and accessibility acceptance; git diff --check. Read package scripts and installed-version documentation before using APIs. Do not weaken tests, remove coverage, change production secrets or use external live systems to obtain a green result. Add regression coverage for meaningful behavior and safety defects; avoid tests that merely mirror trivial implementation. For UI work, verify narrow/mobile and desktop layouts, keyboard/focus, empty/error/loading states and reduced motion as applicable. Capture safe screenshots when helpful.

## Security and exclusions

Household media app; server-only PostgreSQL, Jellyfin-owned state separate. No Jellyfin internal database writes, production restarts, credentials changes or deployment. Avoid displaying spoilers for unwatched content.
Never merge, deploy, release, publish, change DNS, alter production databases, send real messages or rerun unrelated workflows. Do not fabricate credentials, provider configuration, runtime success, client data or business claims. The controller's queue reload does not grant a delegated worker protected-branch or shipping rights.

## Completion report

Write `.zcode-worker/reports/RH-0043.md` with: objective met; visible before/after; branch/worktree; base/final/source SHAs; modules changed; exact tests and evidence; safety boundary confirmation; dependency/incorporation ledger; known limits; remaining human gates; clean git status; PR URL if permitted. Set spec/branch queue status to REVIEW only after required checks pass. Publish the review branch/report only through the trusted layer allowed by repository policy; Ask-GLM delegated workers must hand artifacts to the trusted orchestrator instead of pushing.

The final response must distinguish repository delivery, integration, deployment and real-world acceptance. Do not report COMPLETE, merged, deployed, live-connected or physically verified from a local test.
