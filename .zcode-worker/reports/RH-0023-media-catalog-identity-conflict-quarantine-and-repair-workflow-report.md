# RH-0023 Worker Report — Media catalog identity conflict quarantine and repair workflow

- **Date:** 2026-09-20 (claimed 14:39 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0023-media-catalog-identity-conflict-quarantine-and-repair-workflow`
- **Base:** `origin/rh-0016-jellyfin-to-postgresql-media-catalog-synchronization` @ `73d7983` (the backend chain: rh-0002 connection layer → rh-0003 migrator/schema → rh-0015 smoke → rh-0016 media_catalog sync engine), merged with `origin/main` @ `df9b1d4` for the current control plane (merge commit `9b8edf2`; the only conflicts were queue-file bookkeeping, resolved in favor of `origin/main` as the authoritative copy)

## Claim

Dispatch bootstrap ran (`git fetch origin --prune`); the queue was read from
`origin/main` per protocol (this checkout's own queue copy is stale and not
authoritative). `origin/main` lists 19 READY jobs; 14 are leased via
remote branches and/or local worktrees (RH-0001/0002/0003/0008–0013/
0015–0019/0022, verified with `git branch -r` + `git worktree list` before
claiming). RH-0004 has no lease but duplicates leased RH-0016's scope, so it
was skipped rather than duplicated. Among genuinely unclaimed READY jobs
(RH-0023 p2, RH-0020 p6, RH-0014 p7, RH-0021 p7), **RH-0023 is the
highest-priority job with `AUTOMATION_ELIGIBLE: true`**. Its spec declares
no dependency gate and `origin/main` lists it READY. No `rh-0023*` branch or
worktree existed — claim uncontested; the lease was pushed to origin before
implementation commits.

## What was built

The operator-side half of the quarantine workflow. RH-0016 already detects
ambiguous identities at sync time and lands them in `catalog_quarantine`;
nothing existed to review them, nothing detected catalog-level conflicts
(no single sync page can see them), and no safe remap path existed. This
job adds those, reading/writing **only the `media_catalog` database** — the
tool never contacts Jellyfin and never touches the `reelhouse` database.

### 1. Migration `db/migrations-catalog/0004_catalog_identity_review.sql`

- Wider quarantine vocabulary: `duplicate_path` (two live items sharing one
  file path) and `renamed_identity` (a missing/retired item whose path
  reappeared under a different id) join the five sync-owned reasons in the
  `catalog_quarantine_reason_check` constraint. Reason lists are disjoint
  per owner (enforced by unit test) so ownership of a row is always
  derivable.
- Operator resolution columns `resolution_action` / `resolution_note` /
  `resolved_by`, with a shape constraint: operator resolutions carry action
  + who (note optional but non-empty); automatic closes carry neither, so
  `resolved_at` without an action always means an automatic close.
- `catalog_identity_override` — durable operator identity decisions with
  kind-specific shapes (`provider_claim`: (provider, value) → canonical
  item; `library_pin`: item → canonical library), one decision per
  contested identity via partial unique indexes, a no-self-pin guard, and
  bounded reason/by text. Rows reference source ids **as text, no FKs, on
  purpose**: they are human judgments and must survive rebuilds (the
  sync's rebuild TRUNCATE list deliberately omits this table).
- `catalog_item(path)` index for the detectors.

### 2. Review module (`src/lib/catalog/review.ts`)

Same style as the sync engine: pure helpers unit-tested without a database,
DB operations taking a pool, env-driven fail-closed configuration reusing
the catalog config/policy loaders, redaction at the boundary.

- **Detectors** — `planDuplicatePathFindings` (incumbent = earliest
  observation, ties by id; missing/retired rows excluded so a replaced file
  is a rename candidate, not a duplicate) and `planRenamedIdentityFindings`
  (old id reported with successor evidence, never rewritten). `runDetectors`
  **reconciles** detector-owned rows with catalog reality: records new or
  changed findings, re-opens re-detected conflicts, closes stale ones. Two
  honesty guards: a `dismissed` finding is a durable operator verdict and is
  never resurrected; when either detector hits its 500-finding bound the
  close step is skipped for that run, so an unlisted finding is never
  mistaken for a healed one.
- **Review surface** — bounded `listQuarantine` (open/resolved/all, reason
  filter validated fail-closed, limit clamped 1–500), `getQuarantine` with
  the verbatim payload snapshot, `listWeakIdentity` (live movies/series with
  zero provider ids — identity resting solely on the Jellyfin item id;
  report-only advice, seasons/episodes inherit identity and are excluded).
- **Resolution** — `resolveQuarantine` with actions `dismissed` /
  `source_fixed` / `discarded` (the `remapped` action is reserved for the
  remap flows). Re-detection by sync or detectors re-opens entries and
  clears operator columns: a verdict never masquerades as health.
- **Safe remapping** — `remapProviderClaim` and `pinLibrary`, transactional
  and fail-closed (canonical item/library must exist in the catalog), which
  upsert the override and close matching open entries as `remapped`;
  `listOverrides` / `removeOverride` to audit or retract decisions.

### 3. Sync engine integration (`src/lib/catalog/sync.ts`)

- Overrides decide, heuristics fall back: `classifyAmbiguity` consults
  provider-claim overrides before first-writer-wins (challengers quarantine
  with `heldBy` + `viaOverride: true` evidence, deterministically regardless
  of scan order) and library pins before the same-library check — a scan
  from the pinned library is the sanctioned answer and applies the move.
- The unchanged-content upsert path now moves `library_id` too, so a
  sanctioned library move applies even when content did not change.
- Auto-resolution is scoped to the five sync-owned reasons: a successful
  sync can no longer silently close detector findings it does not own.
- Re-detection upserts (both quarantine paths) clear the resolution columns
  when they re-open a row.
- `catalog_identity_override` added to the schema preflight (fail-closed
  with the `catalog:migrate` hint); rebuild keeps overrides and says so.

### 4. CLI (`scripts/catalog-review.ts`, `npm run catalog:review`)

`list` / `show` / `detect` / `weak-identity` / `resolve` / `remap-provider`
/ `pin-library` / `overrides` / `remove-override`. Environment-only
configuration (no Jellyfin credentials needed at all), per-command
allowlisted flags (unknown flags fail loudly), strict integer `--limit`,
uuid validation for ids, default `--by operator` for accountability,
bounded output, and the shared redaction helper — the database URL is never
printed. Exit 0 only on success; every failure path exits 1 with a bounded
message (verified directly, including bogus command and invalid flag values).

### 5. Tests

- `review.test.ts` (unit, 15 tests): reason ownership disjointness (and
  that the union matches the migration's constraint vocabulary), resolve
  actions vs. the reserved `remapped`, resolution-state naming
  (`open`/`auto_sync`/`auto_detect`/action), normalization fail-closed paths
  (unknown actions, oversized/missing fields, self-pins, non-uuids), listing
  clamps, and deterministic detector planning (incumbent selection,
  missing/retired exclusion, successor pairing, truncation flags).
- `review.int.test.ts` (integration, 12 tests, disposable PG18
  `reelhouse_catalog_review_test`, fixture Jellyfin, real sync engine):
  duplicate-path detection records only the later claimant; sync never
  auto-closes detector rows; dismissal durability across re-runs and after
  healing; stale-finding closure when the catalog heals; rename detection
  with full evidence detail; re-open + column clearing when a "fixed"
  conflict is still real; provider remap enforced deterministically across
  scans and surviving a rebuild; a dismissed sync-owned row still re-opening
  (the deliberate asymmetry vs. detector rows); library pin sanctioning a
  move, then quarantining the old library with pin evidence, then reverting
  to sync judgment after `remove-override`; rebuild preserving overrides
  while wiping quarantine; weak-identity kind filtering; fail-closed
  rejections (unknown quarantine id / canonical item / library / override,
  invalid reason filter); schema guards for both new constraints and the
  partial unique indexes.
- Shared fixture (`test-fixtures.ts`) extracted from `catalog.int.test.ts`
  (no behavior change there; its reset now also clears the override table).

### 6. Docs

`docs/CATALOG_REVIEW.md` (new): vocabulary/ownership table, resolution
semantics and the honesty rule, override semantics incl. rebuild survival,
weak-identity report, command reference, suggested post-sync loop, and the
boundary statement (no Jellyfin access, no reelhouse-database effects).
`docs/CATALOG_SYNC.md`: layout/migration range, rebuild row, and the
quarantine section now describe overrides and link the review doc.
`README.md`: catalog section lists `catalog:review`.

## Safety and boundaries

- Jellyfin: never contacted by the review workflow, never written by the
  sync change — its internal database remains untouched (protocol rule 8).
- Data authorities preserved: catalog content and review state live in
  `media_catalog` only; no cross-database keys; `reelhouse` untouched.
- No secrets: no new environment variables; the catalog URL is redacted
  from every thrown error via the shared helper and never logged.
- Fail closed: unknown ids/references, invalid filters/flags, oversized
  input, and missing schema all reject with bounded messages.
- Workers never merge/deploy/release: this branch ends in REVIEW; the
  queue was not modified on `origin/main`.

## Verification evidence (all run in the worktree)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | clean |
| Lint | `npm run lint` | clean |
| Unit suites | `npm test` | **77/77 pass** (incl. 15 new review unit tests) |
| Production build | `npm run build` | succeeds; routes unchanged |
| Integration suites | `npm run test:db` (disposable PostgreSQL 18.6 via the shared `reelhouse-pg18-test` container, which was already up and healthy — reused, not recreated) | **61/61 pass** (13 pre-existing catalog-sync tests green = no regressions; 12 new review tests; db/smoke suites untouched and green) |
| CLI smoke | `catalog-review list / detect / weak-identity` against the disposable DB | bounded output, redacted target line, exit 0; `bogus` command and invalid flag values exit 1 |

Deterministic regression evidence for the changed behavior is exactly the
new unit + integration material above; existing gates (typecheck, lint,
build, prior suites) remained green throughout.

## Notes for the reviewer

- Migration `0004` was edited once during this session (a CHECK predicate
  written inverted) **before any merge or external application** — the file
  was never applied outside throwaway test schemas that are dropped and
  re-migrated per run, so forward-only history is clean.
- The sync's `providerOwners`/override precedence is deliberately
  override-wins: a legacy catalog row that already holds a remapped provider
  id is not silently rewritten; instead its holder quarantines on its next
  sighting with `viaOverride` evidence, which the review flow surfaces.
- Deliberate asymmetry worth review attention: `dismissed` is durable for
  detector findings (the operator's own tool re-detects them) but never for
  sync-owned reasons (the sync cannot know what a dismissal meant and keeps
  reporting until reality changes). Both directions are pinned by tests.
- Queue hygiene for the control-plane owner: `origin/main` still lists
  RH-0002/0003/0008–0013/0015–0019/0022 as READY although each holds a
  branch/worktree lease (several with REVIEW reports); RH-0004 duplicates
  leased RH-0016's scope. Not modified by this worker — flagging only.

## Handoff

Worker stops here per protocol: **REVIEW**, lease held by
`origin/rh-0023-media-catalog-identity-conflict-quarantine-and-repair-workflow`
(worktree `E:/Users/valif-c/OneDrive/Documents/GitHub/reelhouse-rh-0023`).
No merge to `main`, no deployment, no release, no queue rewrite.
