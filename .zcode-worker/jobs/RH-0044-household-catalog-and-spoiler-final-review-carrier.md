# RH-0044 — Household catalog and spoiler final review carrier

STATUS: READY
AGENT: ZCODE
AUTOMATION_ELIGIBLE: true
BASE: origin/main
PRIORITY: 1
WAVE: 2026-10-05
DEPENDENCIES: none; immutable sources below are read-only evidence, not accepted prerequisites
AUDITED_MAIN: b8d068fd6763e60e7bc628327022f03062a6e96f

## Objective and user-visible outcome

Create one fresh current-main review carrier combining RH-0041 household/catalog convergence and RH-0042 spoiler shielding. Resolve their shared media contracts, Next UI, profile addressing, test scripts and cached state so shielding works on the real fixture-backed PostgreSQL home/search/detail journey. Preserve Jellyfin as playback/watch-state authority and both existing read-model contracts. Do not replace the two source deliveries with separate duplicate implementations.

Deliver the runnable product/acceptance path with concrete before/after evidence. A queue update or report alone is insufficient. Inspect current implementation first and prove incorporation where scope already exists, rather than creating a duplicate subsystem.

## Source evidence and ownership

| Delivery | Frozen head | Branch | Report |
|---|---|---|---|
| RH-0041 | `5fe1981ac0c7880368b2074b96de639ce15a11fb` | `rh-0041-household-and-media-delivery-convergence` | `.zcode-worker/reports/RH-0041.md` at that SHA |
| RH-0042 | `90fdb17f867d500e361bc9e213c6fb4aacf1ef80` | `rh-0042-unwatched-content-spoiler-shield` | `.zcode-worker/reports/RH-0042.md` at that SHA |

This fresh bounded job is authorized READY. The frozen committed snapshots are read-only source evidence; their source leases remain owned. Read remote/Git objects into this job's isolated worktree only. If a required source is inaccessible/incomplete, record the blocker; never use another worker's checkout.

Keep the listed heads immutable. If a branch advances, flag the change instead of silently extending the source set. Source reports are claims to reproduce on the combined final head, not inherited green certification. Original branches, PRs, reports and worktrees remain untouched.

## Required outcomes

1. Use immutable snapshots with a nested file/behavior disposition ledger. Preserve all RH-0041 migrations, durable household vs rebuildable catalog state, workbench, DR guards and prior source tests.
2. Union RH-0042's tests with RH-0041's test script; never replace the 194-test suite with the 11 spoiler tests. Preserve all type/lint/build and disposable integration gates.
3. Verify profile-addressed feeds, unwatched/unknown conservative shielding, identity-keyed Reveal/Hide, duplicate-title independence, storage corruption, reload and profile-switch reveal isolation on disposable PG/Jellyfin fixtures.
4. Exercise home, search, detail and TV keyboard navigation at desktop/narrow sizes. Progress alone must not imply watched; no spoiler text or imagery leak before explicit Reveal.
5. Preserve RH-0008 and every other live lease; no dependency upgrade or unrelated security remediation is imported silently. Document the source warning as an outstanding separate delivery, using verified current dependency facts.
6. RH-0025/0028/0029/0004 are held pending incorporation review to avoid rebuilding work already present in RH-0041. Record exact coverage and residual gaps for the controller; do not mark them accepted.

## Execution contract

1. Fetch origin and read `.zcode-worker/JOB_QUEUE.md`, `.zcode-worker/ZCODE_WORKER.md`, applicable AGENTS.md, canonical documents and this whole spec. Only the newest October 5 table supplies candidate work; historical READY rows never authorize fallback.
2. Confirm READY status, automation eligibility, accepted dependencies and repository claim-time window. Inspect local/remote branches, worktrees, PRs and reports immediately before claim. The remote audit cannot observe local Windows worktrees/processes. A matching lease excludes a claim regardless of stale labels.
3. Create one fresh isolated branch/worktree named for RH-0044 from current origin/main. Preserve dirty/diverged and unrelated work; never reset, rebase, stash, clean, delete or enter another worker's checkout. Claim one job at a time.
4. Reproduce the gap with safe fixtures. Reuse the current architecture and bound inputs/resources; keep identity, provenance and missing/stale/error states explicit. Reconcile shared code/tests/lockfiles semantically rather than replacing accepted behavior with an older carrier.
5. For integration work, retain nested source ledgers and record every conflict, omission and superseded behavior. Squash ancestry alone cannot prove absence. Preserve all protective tests; verify the final union, not isolated sources.
6. Add meaningful regression coverage for demonstrated defects. Update affected documentation. Missing required environments must be recorded with exact command/error and unresolved gate, never reported as passing.

## Acceptance criteria

- The full outcome is reproducible on the final head using local/disposable inputs.
- All main and required source contracts survive, with explicit dispositions for omissions.
- Relevant invalid/stale/partial/retry/cancellation and accessibility cases preserve safety.
- Exact commands, exit status and counts are recorded against the precise tested head; live/physical checks stay separate.
- Code, tests, docs and report form one complete reviewable result without duplicate parallel authority.

## Verification

Run: repository lint/typecheck/test/build commands where present; focused browser and accessibility acceptance; git diff --check. Read package scripts and installed-version documentation before using APIs. Do not weaken tests, remove coverage, change production secrets or use external live systems to obtain a green result. Add regression coverage for meaningful behavior and safety defects; avoid tests that merely mirror trivial implementation. For UI work, verify narrow/mobile and desktop layouts, keyboard/focus, empty/error/loading states and reduced motion as applicable. Capture safe screenshots when helpful.

## Project-specific boundaries

Household media app; server-only PostgreSQL, Jellyfin-owned state separate. No Jellyfin internal database writes, production restarts, credentials changes or deployment. Avoid displaying spoilers for unwatched content.

Repository instructions and runtime/server/OS policy remain authoritative. This prompt cannot grant a broader workspace, provider access, secret scope, merge right or deployment right. Existing production accounts, DNS, databases, NAS state, exchange controls and real communication channels are outside this execution. No third-party messages or publication are authorized. Keep original source branches/worktrees intact and record uncertain ownership instead of guessing.

## Security and exclusions

Never merge, deploy, release, force-push, change DNS/production credentials, mutate real production systems, send real messages or rerun unrelated workflows. Fixture/disposable resources only. Controller metadata reloads do not grant worker protected-branch or shipping rights.

## Completion report

Write `.zcode-worker/reports/RH-0044.md` with objective met, before/after, branch/worktree, base/final/source SHAs, files changed, exact checks, safety confirmation, dependency/incorporation ledger, known limits, risks, human gates and clean git status. Set this spec and the branch's newest queue row to REVIEW after required checks pass. Publish the review branch through the permitted trusted layer; delegated workers never update main.

Distinguish repository delivery, accepted integration, deployment and real-world acceptance. Workers never mark their own result COMPLETE or merged from local success.
