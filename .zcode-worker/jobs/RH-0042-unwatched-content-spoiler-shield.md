# RH-0042 — Unwatched-content spoiler shield

STATUS: REVIEW
AGENT: ZCODE
AUTOMATION_ELIGIBLE: true
BASE: origin/main
PRIORITY: 3
WAVE: 2026-10-05 (reconciled; original assignment 2026-10-04)
DEPENDENCIES: none; implement only against current main or immutable committed source evidence verified below
AUDITED_MAIN: b8d068fd6763e60e7bc628327022f03062a6e96f

## Objective and user-visible outcome

Add an explicit household preference shielding plot synopses, episode thumbnails, previews and outcome-like description text for unwatched content. Default conservatively and allow deliberate Reveal for this item with a clear reversible action. Use available watch-state contracts; unknown watch state stays protected. Test profile switches, search results, detail pages, home rows and cached content. Do not derive watched status from playback starts alone or expose real sports outcomes in fixtures.

Deliver the complete bounded outcome, including its usable interface or runnable acceptance path. A queue/status report alone is not completion. Inspect actual current implementation before deciding what must change; reuse compatible existing modules. If the feature already exists, demonstrate the remaining concrete gap or produce incorporation evidence and stop without inventing a redundant implementation.

## Scope and implementation contract

1. Fetch origin, read `.zcode-worker/JOB_QUEUE.md`, `.zcode-worker/ZCODE_WORKER.md`, applicable AGENTS.md and current canonical project docs from origin/main. The 2026-10-05 execution wave controls selection; historical tables are lineage only.
2. Check local and remote branches, worktrees, open PRs and matching source reports. Existing leases remain owned. Work from one fresh isolated branch/worktree named for RH-0042; never enter, reset, rebase, stash, delete or take over another session's worktree.
3. Record exact base and source SHAs. For convergence jobs, use immutable committed snapshots only after confirming permitted source access; preserve original branches and reports. Build an additive carrier with a file/behavior disposition ledger. Do not declare squash-merged work absent merely because commit ancestry differs.
4. Reproduce the target gap using safe fixtures or the current local product. Establish concrete before/after behavior and the smallest coherent implementation. Keep changes within this assignment.
5. Handle unavailable, ambiguous, stale, partial and failed inputs explicitly. Bound resources, validate inputs and keep secrets and real private data out of code, logs, screenshots and reports.
6. Update directly affected documentation to reflect verified behavior, with repository delivery kept separate from hosted activation. No production state is inferred from source or green tests.

## Dependency and ownership gate

This assignment may be claimed without accepting another new-wave job. If inspection proves a missing integration prerequisite, narrow to an independent fixture-proven boundary only when that still satisfies the stated outcome; otherwise report the exact dependency and remain BLOCKED. Do not silently stack on an unaccepted branch.

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

Write `.zcode-worker/reports/RH-0042.md` with: objective met; visible before/after; branch/worktree; base/final/source SHAs; modules changed; exact tests and evidence; safety boundary confirmation; dependency/incorporation ledger; known limits; remaining human gates; clean git status; PR URL if permitted. Set spec/branch queue status to REVIEW only after required checks pass. Publish the review branch/report only through the trusted layer allowed by repository policy; Ask-GLM delegated workers must hand artifacts to the trusted orchestrator instead of pushing.

The final response must distinguish repository delivery, integration, deployment and real-world acceptance. Do not report COMPLETE, merged, deployed, live-connected or physically verified from a local test.

## Controller reconciliation — 2026-10-05

Completion report on frozen remote branch head declares REVIEW. Engineering evidence is worker-reported, not independently recertified or accepted. Preserve original lease.

Authoritative on origin/main; original source branches/reports/worktrees remain intact. Only READY rows in the newest execution table may be claimed.
