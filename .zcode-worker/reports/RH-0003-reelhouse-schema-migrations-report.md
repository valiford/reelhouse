# RH-0003 Worker Report — ReelHouse Schema and Versioned Migrations

- **Date:** 2026-09-18 (claimed 19:32 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0003-reelhouse-schema-migrations`
- **Base:** `origin/main` @ `f2cde50`

## Trigger

At dispatch the authoritative `origin/main` queue listed RH-0008 (p1),
RH-0009 (p2), and RH-0002 (p2) as READY but all three are leased by
existing branches/worktrees (checked before claiming). RH-0003 (p3) was
the highest-priority unclaimed READY job with `AUTOMATION_ELIGIBLE: true`
and its dependency (RH-0001) satisfied; no branch or worktree existed for
it, so the claim was uncontested. The lease was pushed to origin before
implementation started.

## Commits on the branch

1. *(implementation)* — PostgreSQL 18 schema + forward-only migration
   system: `db/migrations/0001–0009` (household profiles, preferences,
   media item refs, Jellyfin account links, favorites, watchlists,
   collections, watch/continue state, playback overlay, home rows, sync
   cursors, idempotency), `src/lib/db/migrator.ts` runner (history
   verification, checksums, advisory lock, PG18 gate), `scripts/db-migrate.ts`
   CLI, unit + integration test suites, disposable-PG18 compose file,
   `docs/MIGRATIONS.md` (incl. rollback/recovery), README/env updates.
2. *(this commit)* — Job spec → REVIEW, queue updated (RH-0003 moved to
   Review Queue), this report.

## Acceptance criteria

| Criterion | Result |
|---|---|
| Apply-from-empty passes on disposable PostgreSQL 18 | ✅ 9/9 migrations apply cleanly on `postgres:18` (18.6) Docker container; all 15 expected tables present |
| Repeat-run passes | ✅ Second run applies 0, history byte-identical; dry-run on empty and migrated DBs changes nothing |
| Constraint tests pass | ✅ 27/27 integration tests: unique (case-insensitive names, composite PKs, 1:1 links), FK, CHECK (jsonb shape, tick ranges, home-row source pairing, provenance domains), NOT NULL, cascade/SET-NULL deletion semantics |
| Rollback/recovery documentation | ✅ `docs/MIGRATIONS.md` §"Rollback / recovery" (failed-apply atomicity, forward-fix policy, pg_dump restore, checksum-refusal investigation) |
| Migrations refuse mutated history | ✅ Checksum mismatch, missing applied file, renamed/rewritten old version, non-contiguous/duplicate versions all refused with non-zero exit; DB left untouched |
| Stable identities independent of Jellyfin row IDs | ✅ UUIDv7 (PostgreSQL 18 native) surrogate keys; `media_item_ref` is the only external-media bridge — Jellyfin ids are data, never identity |
| Deterministic, versioned, idempotently recorded | ✅ `NNNN_title.sql` strictly ordered/contiguous; each migration commits atomically with its `schema_migrations` row (checksum, duration, server version) |
| No production contact, no deploy/merge | ✅ Only disposable local Docker PG18 touched; nothing merged to main |

## Verification evidence (2026-09-18, Node 22.19.0 / npm 10.9.3)

- `npm run lint` — clean. `npm run typecheck` — clean.
- `npm test` — 17/17 unit tests (file parsing, checksums/normalization,
  history-conflict detection, planning, PG version gate).
- `npm run test:db:up` → disposable `postgres:18` (18.6) healthy on
  127.0.0.1:55433 (tmpfs; port chosen away from other local stacks).
- `npm run test:db` — 27/27 integration tests, covering apply-from-empty,
  repeat-run idempotency, ~20 constraint cases, mutated-history refusal
  (edit / delete / rename an applied file), concurrent runner
  serialization via advisory lock, UUIDv7 defaults, updated_at trigger.
- CLI end-to-end on the disposable DB: `db:migrate:dry-run` (correct plan,
  no changes) → `db:migrate` (9 applied) → re-run ("nothing to do");
  without `DATABASE_URL` the CLI fails closed with exit 1 and never echoes
  the URL.
- `npm run build` — succeeds; routes unchanged (`/`, `/api/library`,
  `/api/search`).
- Disposable container discarded (`test:db:down`).

## Findings the controller should see

1. **postgres:18 image volume layout changed:** data now lives below
   `/var/lib/postgresql` (docker-library issue #37); mounting tmpfs at the
   old `.../data` path aborts the container. `docker-compose.test-db.yml`
   handles this; worth knowing for the Synology/backup work in RH-0007.
2. **Node type stripping + ESM:** `node --test` on `.ts` requires explicit
   `.ts` import extensions and `allowImportingTsExtensions: true` in
   tsconfig (matches the pattern RH-0002 established on its branch; merge
   order will need a small package.json/tsconfig conflict resolution).
3. **`pg` ^8.23.0 added as a dependency** on this branch (runner CLI);
   RH-0002's branch adds the same pin for the app pool — versions match.
4. **Schema covers only RH-0003's listed entities.** Recommendations and
   `media_catalog` tables are deliberately absent (RH-0004's domain); the
   migration system is ready for either to append migrations 0010+.
5. Migrations need a DDL-capable role; the app runtime role only needs DML
   (documented in `docs/MIGRATIONS.md` §"Roles and privileges" for RH-0006).

## Handoff

Upon acceptance: merge this branch to `main` (controller action). RH-0002
and RH-0005/RH-0006 can then integrate against a recorded, verifiable
schema; RH-0004 appends `media_catalog` migrations using the same runner.
Review queue after integration: RH-0003.
