# RH-0031 — Jellyfin full-library dataload into PostgreSQL media_catalog — Worker Report

**Date:** 2026-09-22 (claimed 2:37 PM EDT, inside the 11:00–21:00 America/New_York window)
**Branch:** `rh-0031-jellyfin-full-library-dataload-into-postgresql-media-catalog` (worktree `reelhouse-rh-0031`)
**Status:** REVIEW — not merged, nothing deployed, no production credentials touched, Jellyfin's internal database untouched.

## What was delivered

The normalized media catalog: a provenance-preserving PostgreSQL 18 mirror of
the Jellyfin library, loaded server-side through Jellyfin's HTTP API only.

- `db/migrations/0002_media_catalog_libraries.sql`, `0003_media_catalog_items.sql`,
  `0004_media_catalog_item_facets.sql`, `0005_media_catalog_sync_runs.sql` —
  catalog schema on the RH-0030 migration layer (tables stay in schema
  `public`, so migration 0001's default privileges automatically make them
  DML-accessible to the least-privilege app role):
  - `media_libraries` — Jellyfin libraries with collection type.
  - `media_items` — movies, series, seasons, episodes (and Jellyfin `Video`
    home content normalized as movies) with metadata, series/season/episode
    hierarchy references (deliberately no hard self-FK: Jellyfin can return
    an episode whose series was filtered out) and file state from the
    primary media source (path, container, size, first 32 trimmed streams).
  - `media_genres` / `media_studios` / `media_people` + four join tables
    (genres, studios, people with `person_type`/`role_name`/`list_order`,
    provider IDs). People are identified by `(source, name)` — the API does
    not guarantee a GUID on every People entry — and keep Jellyfin's person
    GUID as provenance (COALESCE-upserted: a later payload that omits it
    never erases it).
  - `media_sync_runs` — append-only per-run history with counters, scrubbed
    error detail, and a status/finished_at consistency CHECK.
- `src/lib/catalog/source.ts` — `CatalogSource` Jellyfin adapter: bounded
  per-request abort timeout, API key only in the `X-Emby-Token` header
  (never in a URL), strict pagination, redacted errors (server URL and key
  scrubbed from transport-failure messages), fail-closed env validation for
  `CATALOG_SYNC_HTTP_TIMEOUT_MS` (1000–300000, default 30000) and
  `CATALOG_SYNC_BATCH_SIZE` (50–1000, default 500).
- `src/lib/catalog/normalize.ts` — pure normalization; every Jellyfin field
  is runtime-validated (invalid optionals become NULL, never coerced or
  clamped), identity fails closed (`CatalogIdentityError` on missing
  Id/Name), out-of-scope types (`PhotoAlbum`, …) return null and are counted
  as skipped.
- `src/lib/catalog/sync.ts` — full-load reconciliation: run row appended,
  libraries upserted, items paged per library and committed in one bounded
  transaction per page (durable batch-sized progress), tombstoning in a
  single final transaction scoped to libraries the run actually confirmed,
  facet joins re-derived per item, `first_seen_at` set once and never
  rewritten, `synced_at`/`last_seen_at` advanced only on confirmed presence.
  A source reporting **zero libraries fails closed** rather than
  reconciling the catalog to empty. Failures record the run as `failed`
  with a scrubbed detail and throw `CatalogSyncError` carrying the summary.
- `src/lib/catalog/pg-executor.ts` — pg Pool adapter pinning one connection
  per `BEGIN…COMMIT` batch.
- `scripts/catalog-sync.ts` + `npm run catalog:sync` — CLI: requires
  `DATABASE_URL` (app role) + `JELLYFIN_URL` + `JELLYFIN_API_KEY`, fails
  closed on missing/invalid values, prints scrubbed summaries, exits
  non-zero on failure.
- `scripts/dev/jellyfin-stub.mjs` — deterministic local Jellyfin double
  (canned libraries/items, `FAULT_MODE=error500|error500-second-page|empty-libraries`)
  so reviewers can reproduce the full evidence without a real Jellyfin.
- Docs: `docs/CATALOG.md` (schema, identity model, reconciliation
  semantics, verification runbook), README section, `docs/DATABASE.md`
  cross-link, `.env.example` additions.
- `src/lib/db/integration.int.test.ts` — **minimal adaptation of the
  existing RH-0030 suite** (details under "Notes for reviewers"): its
  assertions assumed the migrations directory contains exactly migration
  0001; they now express the same contract independent of history length.

## Constraints honored

- Jellyfin reached only via its HTTP API (`/Library/MediaFolders`,
  `/Items`); its internal database untouched; no playback behavior changed.
- Clients never receive PostgreSQL credentials: the sync is server-side
  only (no client-bundle import path), the app-role DSN never leaves the
  server, every echoed error goes through URL/key scrubbing, and the API
  key travels only in request headers.
- `reelhouse` household state and `media_catalog` catalog state remain
  separate authorities; no household tables were touched.
- Idempotent/provenance-preserving: re-running migrations applies nothing;
  re-running the sync rewrites identical values, appends exactly one
  history row, and creates no new rows; removals are tombstones, never
  deletes; resurrections preserve the original `first_seen_at`.
- No merge to `main`, no deploy/release, no production credential changes.
- Other workers' containers (`reelhouse-postgres-dev` :5433,
  `reelhouse-pg18-test` :55433) untouched; verification used my own
  throwaway container `reelhouse-rh0031-pg18` on 127.0.0.1:5436 (removed
  afterwards).

## Branch base (important for reviewers)

The job spec says "start from current `origin/main`", but `origin/main`
(`f205b96`) contains **no database layer at all** — the connection pool,
migrator, grants baseline, and dev-db profile exist only on the RH-0030
REVIEW branch. Rebuilding them would have duplicated in-review files
(`src/lib/db/*`, `db/migrations/0001`, `docker-compose.dev-db.yml`,
`docs/DATABASE.md`) and guaranteed conflicts. This branch is therefore
**stacked on the RH-0030 REVIEW tip (`66934eb`)**, which the RH-0030 report
explicitly anticipated ("Follow-up jobs in this wave (RH-0031+ media
catalog …) can build directly on this layer"). If RH-0030 is squash-merged,
this branch will need a rebase onto the updated `main`; the catalog work
itself (migrations 0002–0005, `src/lib/catalog/`, CLI) is independent of
how the base lands.

## Verification evidence

Environment: Node v22.19.0 (native TS type-stripping), Docker 29.8.0,
`postgres:18` → server confirmed live as `PostgreSQL 18.6 (Debian
18.6-1.pgdg13+2)`.

### Automated contracts

| Suite | Command | Result |
|---|---|---|
| Hermetic units (incl. new normalization matrix, source-adapter wire contract with injected fetch) | `npm test` | 56/56 pass |
| Integration: 7 catalog cases (fresh-DB migrations + idempotence + status-CHECK, first full sync under app role, idempotent re-run, rename/tombstone/resurrect provenance, mid-run failure with durable partial progress + recovery run, zero-library guard + tombstone scoping + app-role DDL rejection, 55-item pagination) + 9 RH-0030 connectivity cases | `npm run test:int` (disposable PG18.6) | 16/16 pass |
| Lint | `npm run lint` | clean |
| Typecheck | `npm run typecheck` | clean |
| Production build | `npm run build` | green; `/api/health` dynamic (ƒ), shell static |

Integration tests use their own temporary database (`reelhouse_rh0031_tmp`,
dropped before/after each case) so they cannot collide with the RH-0030
suite even when `node --test` runs both files as parallel processes.

### Live CLI evidence (real `db:migrate` + `catalog:sync` + stub server)

- `npm run db:migrate` vs PG18.6: `applied 5 migration(s): 1, 2, 3, 4, 5
  (app role: reelhouse_app)`; second run: `db:migrate up to date — 5
  migration(s) already applied`.
- Healthy stub, `npm run catalog:sync` run 1: `succeeded — run #1 …
  libraries=2 items=9 upserted=8 tombstoned=0 skipped=1 pages=2`. Run 2
  (idempotence): identical counters; database still holds exactly 2
  libraries, 8 items, 4 genres, 2 studios, 3 people, 3 provider IDs, and
  now 2 run rows.
- `FAULT_MODE=error500` stub: `catalog:sync failed — run #5 recorded as
  failed`, error detail `Jellyfin API responded HTTP 500 for Items` — no
  URL, no API key anywhere in the payload; the CLI exited non-zero. Next
  run against the healthy stub: `run #6 succeeded, upserted=8` — full
  recovery, history append-only (6 rows).
- `GET /api/health` (built app, curl): demo mode 200
  `database.state=unconfigured`; configured+reachable 200 with
  `migrations={state:ok, applied:5, pending:0, lastVersion:5}` and password
  masked in `configSummary`; unreachable (closed port) 503 with
  `connect ECONNREFUSED` detail, real password never echoed. `GET /` 200 in
  all modes.

### Caught and fixed during verification (why the suites earn their keep)

- Node's TS strip-only mode rejects constructor **parameter properties**
  (both the source adapter and the test double initially used them) —
  rewritten as explicit field declarations.
- The tombstone seen-set was built from a libraries-array/items-array pair
  whose lengths differ by design; PostgreSQL multi-array `unnest` pads the
  shorter with NULLs (NOT NULL violation). Now per-item aligned pairs, and
  the temp insert uses `ON CONFLICT DO NOTHING` (seen-set semantics).
- A test-side fixture briefly contained two items sharing one Jellyfin Id —
  surfaced as a seen-set PK violation, fixed in the fixture.

## Notes for reviewers

- **RH-0030 suite adaptation:** `integration.int.test.ts` asserted exact
  single-migration totals (`appliedNow == [1]`, `schema_migrations` count
  1, `pending == 1`, …). With 0002–0005 present, those assertions are
  factually wrong for any branch carrying this directory. They now express
  the same contract history-length-agnostically (version 1 applied with
  recorded checksum, whole history applied, re-runs apply nothing, fresh DB
  fully pending), and the shared-DB reset drops all public tables before
  re-applying (a bare bookkeeping drop collides with DDL from earlier
  applies). No production code in that file changed.
- Tombstoning is scoped to libraries a run confirmed; items of libraries
  the run did not confirm (including vanished ones) keep `removed_at IS
  NULL` — conservative by design so a partial run never destroys
  unconfirmed state. Reads can filter via the library join; RH-0032
  (incremental refresh / change history) can tighten this.
- Media catalog lives in schema `public` with `media_*` names on purpose:
  migration 0001's default privileges cover exactly that, so the app role
  gains DML without new grant plumbing (documented in the migrations and
  docs/CATALOG.md).
- People identity is `(source, name)` with the GUID as provenance —
  rationale in migration 0004's header.
- The stub server writes no state and validates nothing; it is dev
  tooling under `scripts/dev/` and never imported by app code.
- Worker-rule note: process hygiene during live verification hit the known
  "orphan node on reused port" failure mode (a surviving stub answered one
  run); re-ran the demo with explicit port-ownership checks so the recorded
  evidence reflects the real faulted/healthy stubs.

## Worker state

- Implementation commit, then REVIEW bookkeeping (queue row move, job spec
  `STATUS: REVIEW`, this report) on the job branch; pushed to origin.
- No other worker's branch, worktree, container, or process was touched.
- Time of last claim-window check: 2026-09-22, inside 11:00–21:00 EDT.
