# RH-0048 — Favorites, watchlists, collections, and home rows: write API and TV UI

STATUS: READY
AGENT: ZCODE
AUTOMATION_ELIGIBLE: true
BASE: origin/main (fetch at claim time; audited at the 2026-10-10 reload)
PRIORITY: 2
WAVE: 2026-10-10-B (owner-ordered reload)
DEPENDENCIES: RH-0047 accepted onto origin/main — its idempotency kernel, error envelope and profile-scoping discipline are this job's foundation. A REVIEW branch is not accepted integration; do not promote this job to keep the reserve deep.

## Objective and user-visible outcome

The household schema's list layer (favorites, watchlists + entries, collections + entries, home rows) has been accepted on main since migration 0006 but has no API and no surface: a viewer cannot favorite a title, curate a list, or choose their home rows. Deliver the write routes for that layer on RH-0047's kernel and make the first, bounded slice of it visible in the living-room UI: a favorite/unfavorite action on cards and the detail dialog, and list management (create/rename/delete a watchlist or collection, add/remove entries) reachable from the focus engine like the profile switcher is.

Deliver the complete bounded outcome, including its usable interface or runnable acceptance path. A queue/status report alone is not completion. Inspect actual current implementation before deciding what must change; reuse compatible existing modules (roster/dialog pattern from RH-0046, focus-engine spots, session contracts from RH-0043). Do not invent a parallel subsystem.

## Scope and implementation contract

1. Fetch origin, read `.zcode-worker/JOB_QUEUE.md`, `.zcode-worker/ZCODE_WORKER.md`, applicable AGENTS.md and current canonical project docs from origin/main, and **confirm RH-0047 is accepted on origin/main** (merged, ledger COMPLETE) before claiming. The 2026-10-10-B wave controls selection; historical tables are lineage only.
2. Check local and remote branches, worktrees, open PRs and matching source reports. Existing leases remain owned. Work from one fresh isolated branch/worktree named for RH-0048; never enter, reset, rebase, stash, delete or take over another session's worktree.
3. Record exact base and source SHAs. New forward-only migration(s) only if 0006's constraints prove insufficient (e.g. a missing uniqueness angle); never mutate applied history.
4. **Write API (profile-scoped, identity-bound):** `GET/PUT/DELETE /api/favorites…`, `/api/watchlists…` (+ entry add/remove/reorder), `/api/collections…` (+ entries), `/api/home-rows…` — SQL-enforced profile isolation (`(id, profile_id)` addressing so a foreign profile's rows 404 rather than leak), positions with set-checked reorder → 409 on drift, RH-0047's `Idempotency-Key` replay on every write, the same typed-error envelope and fail-closed discipline.
5. **TV UI (bounded first slice):** favorite toggle on media cards + detail dialog (registered focus-engine spots, aria-pressed, shield-state interplay preserved — favoriting an unwatched spoiler-protected item never reveals content); a lists management dialog following the RH-0046 invoker-dialog pattern (named dialog semantics, focus trap, Escape restores invoker, roving arrows); list entries render as honest empty/loaded/error states. Server is the authority: after each write the UI reflects the server's response (choose optimistic-vs-server with recorded rationale and prove the chosen behavior under a parked-response race).
6. Identity boundaries: writes carry the live `?profile=` identity via the delivered choke points; a mid-session identity switch aborts in-flight writes (generation contract) and the new session never renders the old profile's list state; unknown slug stays fail-closed.
7. Handle unavailable, ambiguous, stale, partial and failed inputs explicitly. Bound resources, validate inputs and keep secrets and real private data out of code, logs, screenshots and reports.
8. Update directly affected documentation (`docs/HOUSEHOLD.md`, `docs/TV_REMOTE.md`, `docs/READMODELS.md`, README) to reflect verified behavior, with repository delivery kept separate from hosted activation. No production state is inferred from source or green tests.

## Dependency and ownership gate

Claim only after RH-0047 is accepted onto origin/main. Remote audit cannot see local Windows leases or processes; recheck ownership immediately before claim. One active claim per job, one job per worker at a time. New claims honor the repository's Eastern-time window (11:00–21:00 America/New_York).

## Acceptance criteria

- The stated outcome works from an independently reproducible local/disposable setup on the final branch head: the list layer exercised over real HTTP (create → add entries → reorder → conflict 409 → delete) with disposable profile fixtures, and the UI slice driven in a real browser.
- Profile isolation is proven end-to-end: one profile's favorites/lists never render in or get written from another's view, including across in-session switches with parked in-flight writes.
- Idempotent replay, reorder-conflict, and failure paths behave honestly and preserve existing safety contracts; the spoiler shield's protections are demonstrably intact.
- Keyboard, focus, reduced-motion and narrow-layout verification pass per the delivered accessibility contract; demo mode degrades honestly (no fabricated persistence).
- Existing contracts (RH-0043 session isolation, RH-0046 switcher, read models) keep passing unchanged; no test weakened or removed.
- Deliverable code, relevant docs and the report are coherent and reviewable. Work ends REVIEW; only an authorized reviewer may accept or merge it.

## Verification

Run: repository lint/typecheck/hermetic suite/integration suite/production build; `git diff --check`; real-browser acceptance of the UI slice (built app, disposable profile fixtures) including at least one deterministic parked-response race through a write path and across an identity switch; record actual commands, exit status and test counts. Do not weaken tests, remove coverage, change production secrets or use external live systems to obtain a green result. Capture safe screenshots when helpful.

## Security and exclusions

Household media app; server-only PostgreSQL, Jellyfin-owned state separate. List/favorite state is ReelHouse-owned; playback and watch-progress authority remain Jellyfin's — this job must not write playback progress or Jellyfin state. No Jellyfin internal database writes, production restarts, credentials changes or deployment. Avoid displaying spoilers for unwatched content. Never merge, deploy, release, publish, change DNS, alter production databases, send real messages or rerun unrelated workflows. Do not fabricate credentials, provider configuration, runtime success, client data or business claims. The controller's queue reload does not grant a delegated worker protected-branch or shipping rights.

## Completion report

Write `.zcode-worker/reports/RH-0048.md` with: objective met; visible before/after; branch/worktree; base/final SHAs; modules changed; exact tests and evidence; the write-authority boundary confirmation (ReelHouse state vs Jellyfin authority); safety boundary confirmation; known limits; remaining human gates; clean git status. Set spec/branch queue status to REVIEW only after required checks pass. Screenshots (safe fixtures only) into `.zcode-worker/reports/RH-0048-screens/`.

The final response must distinguish repository delivery, integration, deployment and real-world acceptance. Do not report COMPLETE, merged, deployed, live-connected or production-verified from a local test.
