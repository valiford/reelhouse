# RH-0046 — In-app household profile switcher

STATUS: READY
AGENT: ZCODE
AUTOMATION_ELIGIBLE: true
BASE: origin/main (fetch at claim time; audited at the 2026-10-09 reload)
PRIORITY: 2
WAVE: 2026-10-09 (owner-ordered reload)
DEPENDENCIES: SATISFIED — RH-0043 accepted onto origin/main (merge `f7526c4`): the live `?profile=` URL identity, bounded switch cleanup and generation-bound requests are the contract a switcher calls

## Objective and user-visible outcome

A living-room user cannot switch household profiles. Identity is URL-driven (`?profile=<slug>`), there is no in-app switcher (RH-0035 removed the old hover menu), and RH-0043's delivered session-isolation contract is exercised only through raw URL manipulation. Build the missing surface: a switcher reachable from the existing profile pill by remote/keyboard focus and pointer, listing household profiles (display name, active one marked), where activating an entry navigates to `/?profile=<slug>` so the accepted RH-0043 contract performs the session re-boot. One profile's state must never render in another's view — through the switcher as much as through any other path.

Deliver the complete bounded outcome, including its usable interface or runnable acceptance path. A queue/status report alone is not completion. Inspect actual current implementation before deciding what must change; reuse compatible existing modules (focus engine, viewmodel, session helpers). Do not duplicate the isolation contract: the switcher only navigates; it must not hand-clear caches, generations or reveal state.

## Scope and implementation contract

1. Fetch origin, read `.zcode-worker/JOB_QUEUE.md`, `.zcode-worker/ZCODE_WORKER.md`, applicable AGENTS.md and current canonical project docs from origin/main. The 2026-10-09 execution wave controls selection; historical tables are lineage only.
2. Check local and remote branches, worktrees, open PRs and matching source reports. Existing leases remain owned. Work from one fresh isolated branch/worktree named for RH-0046; never enter, reset, rebase, stash, delete or take over another session's worktree.
3. Record exact base and source SHAs. Inspect actual current implementation before deciding what must change; reuse compatible existing modules. If a feature already exists, demonstrate the remaining concrete gap or produce incorporation evidence and stop without inventing a redundant implementation.
4. Profile roster source: the UI currently knows only the active profile. Add a bounded, read-only roster read — a new `/api/profiles` route or an extension of an existing payload, chosen with recorded rationale — reusing the delivered read-model discipline: same executor/pool pattern, `SELECT slug, display_name` (and active flag) from `household_profiles`, bounded row cap, fail-closed (database unavailable or empty household → honest error/empty state, never fabricated profiles), no new tables, no writes, never exposed to the client as raw SQL.
5. Switcher surface in `ReelHouseApp`: named dialog/listbox semantics for assistive tech, registered with the focus engine as a proper spot/band (roving arrows, Enter activates, Escape cancels and restores focus to the invoker), pointer parity, active profile visually indicated. Opening it on an unknown/`ghost` slug must not break the current session.
6. Switch mechanics: navigate to the target slug URL via the same mechanism the RH-0043 contract verifies (router/`history.pushState` — verify which the current integration actually surfaces; no synthetic popstate hacks). Opening the switcher, cancelling, or re-selecting the CURRENT profile must not reboot the session or drop cached state.
7. Failure/edge behavior: roster fetch failure keeps the current session fully usable with an honest retry state; entries without a server identity are never rendered switchable; reduced-motion, narrow 390px and keyboard-only behavior follow the delivered accessibility contract.
8. Demo mode: the switcher lists the demo/default profile(s) from the existing fixture path; storage keys follow the delivered slug rules.
9. Handle unavailable, ambiguous, stale, partial and failed inputs explicitly. Bound resources, validate inputs and keep secrets and real private data out of code, logs, screenshots and reports.
10. Update directly affected documentation (e.g. `docs/TV_REMOTE.md` profile session section) to reflect verified behavior, with repository delivery kept separate from hosted activation. No production state is inferred from source or green tests.

## Dependency and ownership gate

The dependency (RH-0043 accepted) is satisfied at merge `f7526c4`. Remote audit cannot see local Windows leases or processes; recheck ownership immediately before claim. One active claim per job, one job per worker at a time. New claims honor the repository's Eastern-time window.

## Acceptance criteria

- The stated outcome works from an independently reproducible local/disposable setup on the final branch head.
- Switching between two disposable profiles through the switcher re-proves the RH-0043 guarantees (stale/late responses never render across the switch; reveals and scoped caches drop) — including at least one deterministic parked-response race staged through the switcher path.
- Cancelling or re-selecting the current profile demonstrably preserves the session.
- Roster failure and empty/unknown-profile paths behave honestly and fail closed.
- Keyboard, focus, reduced-motion and narrow-layout verification pass per the delivered accessibility contract.
- Relevant error, cancellation, stale-data, retry and accessibility cases behave honestly and preserve existing safety contracts. Add regression coverage for meaningful behavior and safety defects; avoid tests that merely mirror trivial implementation.
- Deliverable code, relevant docs and the report are coherent and reviewable. Work ends REVIEW; only an authorized reviewer may accept or merge it.

## Verification

Run: repository lint/typecheck/hermetic suite/integration suite/production build; `git diff --check`; focused real-browser acceptance (built app, disposable profile fixtures) covering the switcher flows above; record actual commands, exit status and test counts when reported; unrun checks and external/physical-device gates remain visibly unverified. Do not weaken tests, remove coverage, change production secrets or use external live systems to obtain a green result.

## Security and exclusions

Household media app; server-only PostgreSQL, Jellyfin-owned state separate. The roster endpoint exposes at most slug/display name/active flag — never emails, account links or credentials. No Jellyfin internal database writes, production restarts, credentials changes or deployment. Avoid displaying spoilers for unwatched content. Never merge, deploy, release, publish, change DNS, alter production databases, send real messages or rerun unrelated workflows. Do not fabricate credentials, provider configuration, runtime success, client data or business claims. The controller's queue reload does not grant a delegated worker protected-branch or shipping rights.

## Completion report

Write `.zcode-worker/reports/RH-0046.md` with: objective met; visible before/after; branch/worktree; base/final SHAs; modules changed; roster-source design decision and rationale; exact tests and evidence; safety boundary confirmation; known limits; remaining human gates; clean git status. Set spec/branch queue status to REVIEW only after required checks pass. Capture safe screenshots when helpful.

The final response must distinguish repository delivery, integration, deployment and real-world acceptance. Do not report COMPLETE, merged, deployed, live-connected or production-verified from a local test.
