# RH-0045 — Next.js security upgrade integration carrier

STATUS: REVIEW (worker-delivered 2026-10-09; report: `.zcode-worker/reports/RH-0045.md` — only the owner accepts and merges)
AGENT: ZCODE
AUTOMATION_ELIGIBLE: true
BASE: origin/main (fetch at claim time; audited at the 2026-10-09 reload)
PRIORITY: 1
WAVE: 2026-10-09 (owner-ordered reload)
DEPENDENCIES: none — the frozen source branch is read-only evidence
SOURCE: frozen branch `rh-0008-next-js-security-upgrade-and-regression-verification` tip `4440f99` (based on the old main `f2cde50`; delivered REVIEW 2026-09-18, never integrated). The source branch is the declared source of this job and nothing else.

## Objective and user-visible outcome

Current main pins `next` 16.0.1 / `eslint-config-next` 16.0.1 and carries known vulnerable transitive dependencies (the RH-0044 report recorded `npm audit` 9 advisories — 8 high, 1 critical: braces/sharp/source-map-js et al.). RH-0008 delivered, on its own frozen branch and never integrated: exact-pin upgrades to Next 16.3.5 + eslint-config-next 16.3.5, a regression suite (`tests/regression.test.mjs`, 9 tests / 3 scenarios — demo mode, degraded fallback, fake-Jellyfin success path including the API key staying server-side), and `docs/SECURITY_UPGRADE.md`. Integrate that delivery onto current main as an additive carrier so the shipped app runs on the patched toolchain with audit findings resolved or explicitly dispositioned, and no product behavior change.

Deliver the complete bounded outcome, including its usable interface or runnable acceptance path. A queue/status report alone is not completion. Inspect actual current implementation before deciding what must change; reuse compatible existing modules. Where source content is stale relative to accepted main, take only what is current-relevant and record the disposition of everything else.

## Scope and implementation contract

1. Fetch origin, read `.zcode-worker/JOB_QUEUE.md`, `.zcode-worker/ZCODE_WORKER.md`, applicable AGENTS.md and current canonical project docs from origin/main. The 2026-10-09 execution wave controls selection; historical tables are lineage only.
2. Check local and remote branches, worktrees, open PRs and matching source reports. Existing leases remain owned. Work from one fresh isolated branch/worktree named for RH-0045; never enter, reset, rebase, stash, delete or take over another session's worktree.
3. Record exact base and source SHAs. The source branch predates the entire PostgreSQL/catalog/TV-UI generation: take ONLY its current-relevant content — the dependency exact pins, the regression suite, and the security documentation — and hold an explicit file/behavior disposition ledger for every source file considered. Never re-import stale rh-0008 application code over accepted main; never treat the frozen branch as a general merge base.
4. Upgrade `next` + `eslint-config-next` to the frozen branch's exact pins (16.3.5). If a newer 16.x patch release resolves the same advisories, prefer the frozen pins unless the report records concrete justification for departing; never change the major line. Lockfile changes only via real installs, committed.
5. Record `npm audit` before and after at the final head. Advisories the upgrade does not clear: evaluate minimal, behavior-preserving remediation (e.g. targeted `overrides` with regression evidence) and otherwise list them in the report as accepted residual risk for owner visibility. Never weaken or remove tests to obtain a green result.
6. Reconcile `package.json` scripts: merge the regression suite into the existing hermetic `test` union without dropping any current file; keep `test:int` intact.
7. Re-verify the RH-0043 session-isolation contract on the upgraded toolchain: live `history.pushState` in-session profile switch honored via `useSearchParams`, generation-bound detail/load-more race behavior, and slug-keyed spoiler-shield storage with display-name migration. The router/searchParams integration is exactly what a minor upgrade can perturb.
8. Handle unavailable, ambiguous, stale, partial and failed inputs explicitly. Bound resources, validate inputs and keep secrets and real private data out of code, logs, screenshots and reports.
9. Update directly affected documentation (README dependency notes, `docs/SECURITY_UPGRADE.md` integrated-state section) to reflect verified behavior, with repository delivery kept separate from hosted activation. No production state is inferred from source or green tests.

## Dependency and ownership gate

No external dependency: current main is the baseline and the frozen source branch is evidence. Remote audit cannot see local Windows leases or processes; recheck ownership immediately before claim. One active claim per job, one job per worker at a time. New claims honor the repository's Eastern-time window.

## Acceptance criteria

- The stated outcome works from an independently reproducible local/disposable setup on the final branch head.
- Audit before/after is recorded with exact counts; every remaining advisory is either fixed with evidence or explicitly dispositioned as accepted residual risk.
- The regression suite passes on the integrated head alongside the full inherited hermetic and integration suites, unchanged in coverage.
- The RH-0043 session-isolation contract is re-proven on the upgraded toolchain through the real built app.
- Relevant error, cancellation, stale-data, retry and accessibility cases behave honestly and preserve existing safety contracts.
- Deliverable code, relevant docs and the report are coherent and reviewable. Work ends REVIEW; only an authorized reviewer may accept or merge it.

## Verification

Run: repository lint/typecheck/hermetic suite/integration suite/production build; `git diff --check`; focused real-browser acceptance including the profile-switch race contract; record actual commands, exit status and test counts. Do not weaken tests, remove coverage, change production secrets or use external live systems to obtain a green result. For UI changes, verify narrow/mobile and desktop layouts, keyboard/focus, empty/error/loading states and reduced motion as applicable.

## Security and exclusions

Household media app; server-only PostgreSQL, Jellyfin-owned state separate. No Jellyfin internal database writes, production restarts, credentials changes or deployment. Never merge, deploy, release, publish, change DNS, alter production databases, send real messages or rerun unrelated workflows. Do not fabricate credentials, provider configuration, runtime success, client data or business claims. The controller's queue reload does not grant a delegated worker protected-branch or shipping rights.

## Completion report

Write `.zcode-worker/reports/RH-0045.md` with: objective met; visible before/after (pins + audit counts); branch/worktree; base/final/source SHAs; file/behavior disposition ledger for the source branch; exact tests and evidence incl. audit before/after; safety boundary confirmation; known limits; remaining human gates; clean git status. Set spec/branch queue status to REVIEW only after required checks pass.

The final response must distinguish repository delivery, integration, deployment and real-world acceptance. Do not report COMPLETE, merged, deployed, live-connected or production-verified from a local test.
