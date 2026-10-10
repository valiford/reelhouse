# RH-0047 — Household write API: profiles, preferences, and the idempotency kernel

STATUS: READY
AGENT: ZCODE
AUTOMATION_ELIGIBLE: true
BASE: origin/main (fetch at claim time; audited at the 2026-10-10 reload)
PRIORITY: 1
WAVE: 2026-10-10-B (owner-ordered reload)
DEPENDENCIES: none — the household schema is already accepted on main (migration `0006_household_state.sql`)

## Objective and user-visible outcome

The household data model has been on main since the carrier acceptance (migration 0006: profiles, preferences, favorites, watchlists, collections, home rows, watch state, playback history), but nothing can write to it except the offline import script — the 2026-10-09 resolution of RH-0005/0006 explicitly reserved the missing **household write API** and its **write-path idempotency** as the next owner-ordered job. Deliver that kernel: profile management and per-profile preferences through a hardened, idempotent HTTP surface on the accepted read-model discipline, so profiles can be created, renamed, deactivated and re-configured in place (RH-0048's UI work gates on this).

Deliver the complete bounded outcome, including its usable interface or runnable acceptance path. A queue/status report alone is not completion. Inspect actual current implementation before deciding what must change; reuse compatible existing modules (the read-model executor pattern, error envelopes, `MAX_PROFILE_ROSTER` bounds). Do not invent a parallel subsystem next to the delivered read models.

## Scope and implementation contract

1. Fetch origin, read `.zcode-worker/JOB_QUEUE.md`, `.zcode-worker/ZCODE_WORKER.md`, applicable AGENTS.md and current canonical project docs from origin/main. The 2026-10-10-B wave controls selection; historical tables are lineage only.
2. Check local and remote branches, worktrees, open PRs and matching source reports. Existing leases remain owned. Work from one fresh isolated branch/worktree named for RH-0047; never enter, reset, rebase, stash, delete or take over another session's worktree.
3. Record exact base and source SHAs. New forward-only migration(s) continue the accepted 0001–0010 series (next number 0011+); never mutate applied history; the migrator's checksum discipline holds.
4. **Write-API surface (server-only, never client-facing SQL):**
   - `POST /api/profiles` (create; slug generation + uniqueness → 409 on conflict), `GET /api/profiles` (already delivered by RH-0046 — extend only if a contract gap emerges, with recorded rationale), `GET/PATCH/DELETE /api/profiles/[id]` (rename display name, activate/deactivate as the soft path; DELETE is the documented hard cascade — 0006's FKs already cascade household-owned rows).
   - `PUT /api/profiles/[id]/preferences` (full-replace; validate against 0006's CHECK semantics: bounded size/depth, fail-closed 400 on violation).
   - Every route: bounded payloads, typed errors → the delivered envelope codes (`invalid_request` / `not_found` / `conflict` / `database_unavailable` / `internal_error`), SQLSTATE mapping (23505→409, 23503→404, 23514/22P02→400), redacted messages with a hard length cap, fail-closed 503 when the database is unconfigured or unreachable, `force-dynamic`.
   - Least privilege: requests execute under the app role (DML granted to owner-created tables by migration 0001's default privileges — verify, and if a needed grant is missing, the migration that creates the table must grant it; never broaden the app role interactively).
5. **Idempotency kernel (the RH-0006 residual, carried into the delivered generation):** a persisted `idempotency_record` (new migration) keyed by profile scope + `Idempotency-Key` header with stored-response replay: first write executes and stores `{response_status, response_body}` (success-only, bounded size); replay of the same key+fingerprint returns the stored response byte-identically with an `Idempotency-Replayed` header and never re-executes; same key with a different fingerprint → 409. Replay must be race-safe under concurrent duplicates (unique constraint + insert-first discipline). Apply it to every non-idempotent route above (POST/PATCH/DELETE/PUT).
6. **Transactions:** each write executes in one transaction with its bookkeeping; profile delete cascades atomically; verify no partial state on failure (the integration suite must prove it).
7. Handle unavailable, ambiguous, stale, partial and failed inputs explicitly. Bound resources, validate inputs and keep secrets and real private data out of code, logs, screenshots and reports.
8. Update directly affected documentation (`docs/HOUSEHOLD.md` serving section, `docs/READMODELS.md` endpoint records, README) to reflect verified behavior, with repository delivery kept separate from hosted activation. No production state is inferred from source or green tests.

## Dependency and ownership gate

No external dependency: the schema and read models are accepted main. Remote audit cannot see local Windows leases or processes; recheck ownership immediately before claim. One active claim per job, one job per worker at a time. New claims honor the repository's Eastern-time window (11:00–21:00 America/New_York).

## Acceptance criteria

- The stated outcome works from an independently reproducible local/disposable setup on the final branch head: the full CRUD + preferences surface exercised over real HTTP against disposable PostgreSQL 18 under the app role.
- Idempotent replay is proven byte-identical (including concurrent duplicate delivery), and fingerprint mismatch → 409.
- Profile isolation and cascade behavior are proven: no other profile's rows are reachable or affected; DELETE cascades household-owned rows and leaves the media catalog untouched.
- Failure injection covers unavailable DB, constraint violations, duplicate requests, and mid-transaction failure without corrupting durable state.
- Existing read paths, the switcher (RH-0046) and session-isolation contracts (RH-0043) keep passing unchanged; no test weakened or removed.
- Deliverable code, relevant docs and the report are coherent and reviewable. Work ends REVIEW; only an authorized reviewer may accept or merge it.

## Verification

Run: repository lint/typecheck/hermetic suite/integration suite/production build; `git diff --check`; live HTTP matrix over the new surface (create → duplicate 409 → rename → deactivate → preferences replace/replay → delete-cascade → 404 after); record actual commands, exit status and test counts. Do not weaken tests, remove coverage, change production secrets or use external live systems to obtain a green result. Add regression coverage for meaningful behavior and safety defects; avoid tests that merely mirror trivial implementation.

## Security and exclusions

Household media app; server-only PostgreSQL, Jellyfin-owned state separate. The API never exposes credentials, account links, or internal ids beyond the documented contract. No Jellyfin internal database writes, production restarts, credentials changes or deployment. Never merge, deploy, release, publish, change DNS, alter production databases, send real messages or rerun unrelated workflows. Do not fabricate credentials, provider configuration, runtime success, client data or business claims. The controller's queue reload does not grant a delegated worker protected-branch or shipping rights.

## Completion report

Write `.zcode-worker/reports/RH-0047.md` with: objective met; visible before/after; branch/worktree; base/final SHAs; modules changed; migration ledger; the idempotency contract as implemented; exact tests and evidence; safety boundary confirmation; known limits; remaining human gates; clean git status. Set spec/branch queue status to REVIEW only after required checks pass.

The final response must distinguish repository delivery, integration, deployment and real-world acceptance. Do not report COMPLETE, merged, deployed, live-connected or production-verified from a local test.
