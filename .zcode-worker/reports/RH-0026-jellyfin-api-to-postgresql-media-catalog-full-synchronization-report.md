# RH-0026 Worker Report — Jellyfin API to PostgreSQL media_catalog Full Synchronization

- **Date:** 2026-09-21 (claimed 18:26 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0026-jellyfin-api-to-postgresql-media-catalog-full-synchronization`
- **Base:** `c66e222` (rh-0024 REVIEW tip; itself a clean re-derivation of `origin/main` @ `f9a630e`)

## Claim

Bootstrap followed the protocol: `git fetch origin --prune`, queue read from
`origin/main:.zcode-worker/JOB_QUEUE.md` (local checkout is the rh-0002
REVIEW branch; its queue copy is not authoritative). RH-0026 was the
highest-priority genuinely unclaimable-free READY job: RH-0024 (priority 1)
is leased/in REVIEW, and **RH-0025 (priority 2) became leased between
15:10 and 18:26 EDT** — a `reelhouse-rh-0025` worktree on branch
`rh-0025-postgresql-reelhouse-schema-migrations-and-household-state-constraints`
existed at claim time (not yet pushed), so per rule 2 it was skipped, never
touched. No `rh-0026*` branch or worktree existed anywhere; claim
uncontested. Spec verified `AUTOMATION_ELIGIBLE: true`, no dependency
field, `STATUS: READY`.

**Base rationale:** the spec says "start from current `origin/main`"
(`f9a630e`). I stacked on `c66e222` — one commit ahead, containing only
rh-0024's REVIEW output — following the repo's established
later-jobs-stack-predecessors convention (rh-0016 stacked on rh-0015's tip;
the rh-0025 worker made the identical choice on `c66e222` the same day).
This reuses the reviewed connectivity/config/migrator layer and keeps the
acceptance merge order linear: **rh-0024 → rh-0025 → rh-0026** (rh-0025 and
rh-0026 are siblings off `c66e222`; expected textual conflicts: package.json
script rows, possibly queue/doc files).

## What was built

Idempotent Jellyfin API → `media_catalog` synchronization: libraries;
movies/series/seasons/episodes with file facts (path/container/size/
date-created); provider ids (imdb/tmdb/tvdb/…); normalized genres, studios,
people (+ per-item joins); provenance (`observed_at`/`last_seen_at`/
`source_revision`); freshness (`catalog_scan` audit, per-library incremental
cursor); non-destructive two-phase retirement; identity quarantine; and
rebuild. Jellyfin is read API-only; the `reelhouse` database is never
touched.

| Path | Role |
|---|---|
| `db/migrations-catalog/0001_catalog_grants_baseline.sql` | `{{app_role}}` grants baseline: DML default privileges for the sync role, no DDL; closes the grants gap for the catalog DB using the RH-0024 pattern |
| `db/migrations-catalog/0002–0004` | Libraries/items/provider ids (`(source, external_id)` identity, FK-enforced parent hierarchy, retirement state-machine CHECKs); taxonomies (name_key-folded genres/studios/people); sync operational state (scan audit, cursor, quarantine) |
| `src/lib/catalog/config.ts` | Pure config: catalog credentials from `MEDIA_CATALOG_DATABASE_URL` (remapped onto the shared `loadDatabaseConfig` rules — **no fallback to `DATABASE_URL` by design**), `MEDIA_CATALOG_MIGRATE_URL`, Jellyfin sync config, bounded sync policy |
| `src/lib/catalog/model.ts` | Payload → model mapping + canonical sha256 content fingerprint (ETag excluded, taxonomies sorted, people in billing order) |
| `src/lib/catalog/jellyfin-client.ts` | API-only client; per-request timeout; API key only in the `X-Emby-Token` header; interface fixture-injectable |
| `src/lib/catalog/sync.ts` | The engine: full/incremental/rebuild, kind passes (roots→seasons→episodes), per-page transactions, first-writer-wins provider claims, quarantine + auto-resolve, two-phase retirement, bounded caps, redacted failure bookkeeping |
| `scripts/catalog-migrate.ts` | `npm run catalog:migrate` (catalog DB's own `schema_migrations`) |
| `scripts/catalog-sync.ts` | `npm run catalog:sync[:full|:rebuild]`; fail-closed, redacted, exit 1 |
| `docs/CATALOG_SYNC.md` | Full runbook: authorities, identity, env, roles, modes, quarantine semantics, retirement, ops SQL, verification |
| `.env.example`, `README.md`, `docs/DATABASE.md`, `package.json` | Catalog env vars, docs section + cross-link, test/CLI script rows |

## Key design decisions

1. **Rebuild is DML-only.** The sync role is DML-only by design (this wave's
   least-privilege posture), and `TRUNCATE` is not a DML privilege — so
   rebuild clears content with plain `DELETE` (FK cascades do the rest,
   quarantine/taxonomies explicitly). Every sync mode now runs as the
   least-privilege role; verified live (rebuild succeeded as
   `reelhouse_app` with `can_truncate=false`).
2. **Catalog credentials never fall back to `DATABASE_URL`.** A blank
   `MEDIA_CATALOG_DATABASE_URL` is `unconfigured` even when the household
   URL is set; the sync refuses. This keeps the data-authority boundary
   mechanical, not conventional. Unit-test pinned.
3. **The catalog migrator is RH-0024's runner, reused unmodified** with a
   different directory (`db/migrations-catalog/`) — the bookkeeping table
   lives in the catalog database, so histories are independent by
   construction. Grants baseline is catalog migration 0001 (default
   privileges are per-database; the reelhouse baseline does not carry over).
4. **Quarantine auto-resolution is scoped:** an open record closes when *its
   own* external id next writes successfully (orphan repaired, provider id
   made unique). Re-seening the *winner* never closes the challenger's
   record — the engine cannot know a disappearance means "fixed". Manual
   repair tooling remains future scope (cf. RH-0023's workflow on the old
   chain).

## Evidence

All commands run in the worktree; the disposable PG18 profile
(`docker-compose.dev-db.yml`, loopback :5433) that the rh-0024 session left
running was reused — no production system contacted, no real credentials
exist in this environment (rule 10 fail-closed; the runbook's Synology
section is the operator procedure).

- **Hermetic:** `npm test` → **59/59 pass** (33 carried + 26 new: catalog
  config 10, model/fingerprint 9, HTTP client 5, plus the carried db
  config/migrator/health suites).
- **Typecheck/lint/build:** `tsc --noEmit` clean, `eslint .` clean,
  `next build` compiles (5 routes).
- **Integration:** `npm run test:int` → **27/27 pass** (8 carried RH-0024
  DB-evidence cases + 19 catalog cases), each against its own freshly
  provisioned `reelhouse_rh0026_catalog` database on the disposable
  container, fixture Jellyfin in-process. Coverage: migration
  apply/idempotence/history; least-privilege role evidence (DML yes;
  DDL/TRUNCATE/bookkeeping-writes no; no superuser/createdb/createrole);
  schema preflight fail-closed on an unmigrated database; full-sync
  normalization end to end (kinds, hierarchy, file facts, taxonomies,
  people with billing order, provider ids, scan row, cursor); idempotent
  repeat (content unchanged, freshness only); changed-content upsert with
  relation rewrite; incremental cursor (only changed items fetched,
  never retires); two-phase retirement with in-place restoration (items
  **and** libraries); quarantine for duplicate_provider_id (with heldBy
  evidence), invalid_item, orphan_parent (with self-heal), library_conflict
  (winner's row untouched); repaired-identity auto-close; 1001-item
  multi-page pagination; rebuild identity turnover with scan history kept;
  failed-scan bounded redacted bookkeeping + recovery; unconfigured/invalid
  config/policy fail-closed.
- **Live CLI (real HTTP + real PG18):** local fake Jellyfin on loopback;
  `catalog:migrate` applied 4 migrations as owner with `(sync role:
  reelhouse_app)`; `catalog:sync:full` → 2 upserted; `catalog:sync`
  incremental → 0 upserted, and the captured request log proves
  `MinDateLastSaved=<stored cursor>` was sent on every `/Items` request;
  `catalog:sync:rebuild` → content cleared and re-imported as the
  DML-only role. Fail-closed: unconfigured sync (exit 1, names the var),
  unconfigured migrate (exit 1), unreachable Jellyfin (exit 1, failed scan
  recorded with key-free bounded error, `last_error` set, later success
  clears it), bad scheme (exit 1). No credential or URL with password ever
  appeared in any output. Scaffolding (fake server, scratch DB) removed
  after evidence collection.
- **Browser verification:** N/A — no HTTP/UI surface was added (CLI batch
  job only, per scope). The existing app routes are untouched.

## Defect found and fixed during live verification

`upsertLibrary`'s **update** branch (library content changed, or library
restored from missing/retired) passed a 6-element parameter array against
SQL referencing `$2..$7` — a param-shift that PostgreSQL rejects with
`could not determine data type of parameter $1`. The insert and
quiet-refresh branches were correct, and no prior test changed library
content, so the defect was latent. **Caught live** when the second fake
server returned a library whose image tag differed from the stored one;
fixed by renumbering placeholders to `$1..$6` and pinned by a new
integration test ("library content changes upsert in place and restore
retired libraries") that exercises both the content-change and the
restore paths.

⚠️ **Controller note:** this same defect exists verbatim in the rh-0016
REVIEW branch (`src/lib/catalog/sync.ts`, `upsertLibrary`), whose tests
never vary library content either. Recommend the same one-line fix (or
cherry-pick of this file's version) when that branch is processed.

## Test-count accounting and merge order

- Base (`c66e222`): 33 hermetic unit + 8 integration.
- This branch: 59 unit + 27 integration, all green.
- Acceptance merge order: **rh-0024 → rh-0025 → rh-0026** (siblings 0025/
  0026 in either order; disjoint file sets except package.json rows and
  docs cross-links). This branch adds the `test` list entries
  `src/lib/catalog/config.test.ts|model.test.ts|client.test.ts`, the
  `test:int` entry `src/lib/catalog/catalog.int.test.ts`, and the
  `catalog:migrate` / `catalog:sync` / `catalog:sync:full` /
  `catalog:sync:rebuild` script rows.

## Scope discipline

No `main` merge, no deploy, no release, no production credential change, no
Jellyfin modification (API reads only), no client-exposed database surface.
The other REVIEW branches and the rh-0025 worktree were never entered or
modified. Real Synology sync remains one operator runbook away — no
credentials exist here by design.

## Environment notes for the next dispatch

- The disposable `reelhouse-postgres-dev` container (loopback :5433) was
  reused from the RH-0024 session and left running with the scratch
  databases dropped; `reelhouse` still holds only RH-0024's migration 0001.
- On this Windows/Git-Bash shell, capture CLI exit codes through pipes with
  `set -o pipefail` — plain `$?` after `| tail` reports the pipe's last
  command and will lie about fail-closed exits.
- Backgrounded Git-Bash processes (`node server &`) survive their shell on
  this machine; kill by port (`netstat -ano` + `taskkill //F //PID`) as
  before.
