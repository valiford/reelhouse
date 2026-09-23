# RH-0036 — PostgreSQL media identity conflict quarantine and repair workbench — Worker Report

**Date:** 2026-09-23 (claimed ~2:30 PM EDT, inside the 11:00–21:00 America/New_York window)
**Branch:** `rh-0036-postgresql-media-identity-conflict-quarantine-and-repair-workbench` (worktree `reelhouse-rh-0036`, stacked on `origin/rh-0034-…` at `57dee98`)
**Status:** REVIEW — not merged, nothing deployed, no production credentials touched, Jellyfin's internal database untouched.

## What was delivered

The operator side of the catalog's conflict story. The sync pipelines
(RH-0031/0032) quarantine ambiguous source identities as they see them
(`duplicate_identity`) and explicitly reserved the `released`/`discarded`
statuses "for the RH-0036 repair workbench" — this job fills that contract:

- `db/migrations/0009_media_identity_workbench.sql` — extends
  `media_item_quarantine.reason` with three scan-detected conflict classes
  (`duplicate_file`, `moved_media`, `missing_external_id`); adds
  `media_identity_scans` (the workbench's own append-only run history,
  mirroring `media_sync_runs` conventions) and `media_identity_repairs`
  (append-only audit: action, operator, note, bounded evidence); and gives
  each quarantine exactly one provable origin — the sync run that saw it
  (`run_id`) or the scan that found it (`scan_id`) — enforced by
  `media_item_quarantine_origin_check` (`(run_id IS NULL) <>
  (scan_id IS NULL)`). Default privileges from 0001 cover all new tables;
  no extra grants.
- `src/lib/catalog/workbench.ts` — the core module, app-role only:
  - **scan**: three read-only detectors over the ACTIVE catalog in one
    snapshot-consistent transaction — duplicate files (≥2 active items on
    one exact `file_path`), moved media (an active item claiming a file a
    tombstoned identity owned), missing external IDs (active movies/series
    with zero `media_item_provider_ids`; episodes/seasons exempt). Findings
    land in quarantine with the sync's own bump-not-duplicate semantics
    (one open row per `(identity, reason)`; first-recorded evidence payload
    preserved; `occurrences`/`last_seen_at` advance). Bounded: 200 findings
    per detector per scan (hitting the cap marks the scan `truncated`), ≤10
    item projections per evidence payload. A failing detector aborts the
    whole scan atomically (nothing recorded) and the scan row records the
    failure like a failed sync run. Scans never auto-close rows —
    "no longer detected" is not "explained".
  - **list/describe**: bounded inspection — open rows first, closed enums
    for filters, `show` bundles the quarantine with its evidence payload,
    involved item projections (active + tombstoned), those items' most
    recent change-history rows (≤20), and the repair audit trail.
  - **release/discard/remap**: resolution with mandatory audit.
    `release`/`discard` close an open row and append exactly one audit row
    (operator + bounded before/after evidence). `remap` is the one bounded
    catalog write, `duplicate_identity`-only: it re-points the quarantined
    item's library placement to the operator-chosen ACTIVE library, closes
    the row as `released`, and appends a `remapped` audit entry carrying
    the from/to placement — read, write, resolve, and audit share one
    transaction. Fail-closed everywhere: repairs require an operator
    identity (`REELHOUSE_OPERATOR`) because audit without an actor is not
    audit; resolved rows never resolve again; remap refuses unknown target
    libraries, target-equals-current (use release to confirm), tombstoned
    items, resolved rows, and other reasons. Placement stays
    Jellyfin-owned: the next sync reconciles against the live source and
    re-quarantines if an operator's choice disagrees with it.
- `scripts/catalog-workbench.ts` — operator CLI
  (`npm run catalog:workbench -- scan|list|show|release|discard|remap`),
  strict flag parsing (`--flag=value` and `--flag value`), fail-closed
  env handling, `redactError`-scrubbed output. Needs only `DATABASE_URL`
  (no `JELLYFIN_*`: detection is pure PostgreSQL over mirrored state).
- Docs: `docs/WORKBENCH.md` (conflict classes, commands, resolution
  semantics, audit model, live demo), `docs/CATALOG.md` + `docs/DATABASE.md`
  + README sections, migration 0009 entry.
- `package.json` — `catalog:workbench` script; the two new suites in
  `test`/`test:int`.

## Design decisions worth review

- **Resolution, not repair-rewrites.** Jellyfin is the authority, so
  wholesale catalog surgery would be futile (the next sync rewrites it).
  The workbench resolves conflicts with evidence and allows exactly one
  bounded write (duplicate_identity placement remap) whose wrongness is
  self-healing (next sync re-quarantines). Supplying provider IDs or
  renaming items would violate the facet mirror contract and get erased by
  the next sync — deliberately not offered.
- **`identity` is the conflict key, not always an item id.** For
  `duplicate_file`/`moved_media` the file path IS the conflicting identity;
  the existing partial unique index `(source, identity, reason) WHERE
  status='quarantined'` then gives one-open-row-per-conflict for free.
  Documented in the migration and WORKBENCH.md.
- **Operator actions write a new audit table, not `media_item_changes`.**
  That history is Jellyfin-sourced provenance (source revisions, observation
  times); mixing operator events into it would corrupt its semantics.
  `media_identity_repairs` keeps the two authorities separate.
- **Scans are atomic** (one transaction: detectors + quarantine writes on
  one snapshot), unlike sync's batched durability — conflict detection is
  bounded and fast, and half-recorded evidence would be worse than none.
- **Stacking on rh-0034.** The workbench quarantines rows the RH-0031/0032
  pipelines produce and extends migration 0006's schema — none of which is
  on `main` yet. The branch stacks on `origin/rh-0034-…` (`57dee98`) like
  the rest of the wave; if any squash-merges, this branch rebases onto the
  successor (no force-push).

## Verification evidence

All commands run in `reelhouse-rh-0036` against the disposable loopback
PG18 profile (`docker-compose.dev-db.yml`, `127.0.0.1:5433`) — never
Synology; the "Jellyfin" was the deterministic stub
(`scripts/dev/jellyfin-stub.mjs`).

- `npm run lint` — clean. `npm run typecheck` — clean.
- `npm test` — **142/142 pass** (113 pre-existing + 29 new hermetic tests:
  payload/detail builders, repair-input/id/library/list-filter fail-closed
  matrices, evidence-id extraction bounds, evidence projections, the
  mechanical `$n` placeholder↔param-count invariant for all 19 fixed SQL
  statements, and a migration↔enum drift guard reading the 0009 file).
- `npm run test:int` — **58/58 pass** (50 pre-existing + 8 new integration
  tests under the least-privilege app role): migration 0009's reason/origin/
  status/audit constraint surface on a fresh temp DB (`reelhouse_rh0036_tmp`);
  duplicate_file/moved_media/missing_external_id detection grown from REAL
  sync runs (incl. the restore that settles a moved-media finding and the
  provider-anchored/episodic exemptions); bump-not-duplicate with
  first-evidence preservation across a rename; atomic scan failure via a
  revoked detector grant (zero rows recorded, scan marked failed) with clean
  recovery; release/discard with audit trail, never-resolve-twice, and
  operator-required rules; the remap happy path on a real sync-produced
  duplicate_identity quarantine plus the full failure matrix (unknown
  library, same-library no-op, no operator, wrong reason, tombstoned item,
  resolved row — every rejection leaving state untouched); deterministic
  scan replay onto a second fresh database.

Live end-to-end matrix (dev DB + stub, real CLI):

```text
db:migrate            → up to date — 9 migration(s) applied (app role: reelhouse_app)
catalog:sync (full)   → run #1: libraries=2 items=9 upserted=8 changes=8
catalog:workbench scan→ scan #1: duplicate_file=0 moved_media=0
                        missing_external_id=3; opened=3 bumped=0
catalog:workbench list→ #1–#3 [quarantined] missing_external_id
                        (mov-bare, mov-blank, vid-home) with detail lines
stub → DATASET=duplicates; catalog:sync
                      → run #2: quarantined=1 (mov-twin, both libraries)
catalog:workbench scan→ scan #2: opened=1 bumped=3 (bump semantics live)
list --reason=…       → #4 duplicate_identity mov-twin
show 4                → origin: sync run #2; evidence payload (etag, placement,
                        providerIds); item projection (Twin (Movies), lib-movies);
                        change history; repairs: none
remap 4 --library lib-tv --note "…"
                      → item "mov-twin" moved lib-movies → lib-tv;
                        quarantine #4 resolved as released; audit row #1
release 1 --note "…"  → #1 released; audit row #2
discard 2 --note "…"  → #2 discarded; audit row #3
Failure paths (live):
  release without REELHOUSE_OPERATOR
                      → rejected: operator identity is required …
  release 4 (again)   → failed: already resolved (status "released") —
                        resolved rows never resolve again
  remap on missing_external_id row
                      → failed: remap applies only to duplicate_identity …
  release 999         → failed: does not exist
  show abc            → rejected: quarantine id must be a positive integer
  DATABASE_URL to dead port (127.0.0.1:5999)
                      → failed: connect ECONNREFUSED 127.0.0.1:5999 —
                        URL/credentials never echoed
show 4 after repairs  → repair remapped by rh0036-operator … evidence:
                        {"action":"remapped","item":{…},"placement":
                        {"from":{lib-movies},"to":{lib-tv}}, …}
```

After the live matrix the catalog demonstrably holds every lifecycle state
at once (open/re-occurring, released, discarded, remapped) with a complete
audit trail.

## Boundaries respected

- Jellyfin touched only through its HTTP API (the stub); its internal SQLite
  never read or written. The workbench makes no Jellyfin connections at all.
- No PostgreSQL credentials reached any client; the CLI has no HTTP surface;
  every echoed error is scrubbed of `DATABASE_URL`.
- `reelhouse` household state and `media_catalog` catalog state remain
  separate authorities; the workbench only ever touches catalog-side and
  workbench-owned tables.
- No merge to `main`, no deploy, no release, no credential changes; other
  workers' branches and worktrees untouched (the stack parent rh-0034 is
  read-only from this worktree's perspective).
- Claim window: claimed ~2:30 PM EDT, inside 11:00–21:00 America/New_York.

## REVIEW notes

- Three real bugs were caught by the new suites before any commit: the
  missing `LIMIT $2` on the shared item-projection query (hermetic
  placeholder invariant — a bind-count error no database ever saw), the
  remap auditing as `released` instead of `remapped` (integration
  assertion), and the CLI flag parser dropping space-separated flag values
  (found live, fixed, covered by strict parsing that fails closed). All
  three are fixed and the full gate set re-run green afterwards.
- Stale queue rows: `origin/main`'s queue still lists everything READY while
  branches carry REVIEW reports. This branch's queue copy moves
  RH-0033/0034/0036 to REVIEW (their branches carry review reports);
  RH-0035 keeps its READY row here although a local worktree
  (`reelhouse-rh-0035`, still at rh-0034's base commit) already exists —
  per the protocol that worktree is a lease, so RH-0035 was skipped, not
  claimed.
- Genuinely unclaimed READY in the current wave after this claim:
  RH-0037, plus RH-0035's row if its lease is stale. Older-wave rows
  RH-0028/0029 have no branches/worktrees; RH-0004 duplicates RH-0016 and
  should never be claimed. The six-unclaimed-READY guideline remains
  unmet by live rows — flagging for the maintainer.
- After RH-0036: RH-0037 (backup/restore/DR acceptance) is the natural
  next claim; RH-0035 (TV interaction) needs its lease clarified first.
