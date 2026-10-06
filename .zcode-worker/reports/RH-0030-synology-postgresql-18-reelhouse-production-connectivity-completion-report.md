# RH-0030 — Synology PostgreSQL 18 ReelHouse production connectivity completion — Worker Report

**Date:** 2026-09-22 (claimed 12:33 PM EDT, inside the 11:00–21:00 America/New_York window)
**Branch:** `rh-0030-synology-postgresql-18-reelhouse-production-connectivity-completion` (worktree `reelhouse-rh-0030`, cut from `origin/main` @ `f205b96`)
**Status:** REVIEW — not merged, nothing deployed, no production credentials touched.

## What was delivered

A complete server-side PostgreSQL 18 connectivity layer on top of current
`origin/main` (the baseline on `main` had no database code at all):

- `src/lib/db/config.ts` — pure parse/validate/redact of `DATABASE_URL` and
  bounded `DATABASE_*` overrides. Two-role design: `DATABASE_URL` (least-
  privilege app role) and `DATABASE_MIGRATE_URL` (owner/migrator, used only by
  `npm run db:migrate`). Fail-closed on invalid values (never clamped);
  `sslmode`/`DATABASE_SSL` map to libpq semantics with Synology self-signed
  reality (`require` = encrypted, `verify-ca`/`verify-full` = verified).
  Every echoed string goes through `redactDatabaseUrl`/`describeDatabaseConfig`/
  `redactError` (password masked, query string dropped, raw URL scrubbed).
- `src/lib/db/pool.ts` — `server-only`-guarded `pg` pool singleton (import in a
  client component fails the build, so credentials can never reach the browser
  bundle), `query()`, `checkDatabase()`, `closePool()`. Pooling (`poolMax`),
  connect/idle/statement timeouts all bounded and env-tunable. Unconfigured
  throws (callers branch on state); a pool-level `error` handler prevents an
  errored idle client from killing the process. Fail-closed: no demo-data
  fallback on the database path.
- `src/lib/db/migrator.ts` — versioned, forward-only, idempotent migration
  runner: `db/migrations/NNNN_name.sql`, `public.schema_migrations` bookkeeping
  with SHA-256 checksums (raw file bytes, so history verifies identically
  across environments), advisory-locked runs, per-migration transactions with
  rollback, fail-closed before executing anything on edited/missing history,
  strict `{{app_role}}`-only placeholder substitution. Also `checkMigrations()`
  (owner-role read-only status) and `summarizeMigrations()` (pool-backed
  read-only summary for health — no second connection, no advisory lock,
  missing table ⇒ "nothing applied", never throws).
- `db/migrations/0001_app_role_grants_baseline.sql` — grants the app role DML
  on future owner-created tables/sequences via default privileges and
  read-only `schema_migrations` access; never DDL. Idempotent.
- `scripts/db-migrate.ts` — `npm run db:migrate` CLI with redacted,
  fail-closed output and idempotence ("up to date" on re-run).
- `src/lib/jellyfin-health.ts` — bounded (3 s default) reachability probe of
  Jellyfin `/System/Info/Public`. Sends no API key; state-as-data, never
  throws; Jellyfin remains the playback/library authority via API only.
- `src/app/api/health/route.ts` — dynamic readiness endpoint: database
  fail-closed (`invalid`/`unreachable` ⇒ 503), `unconfigured` ⇒ 200 demo mode,
  plus a diagnostic `migrations` summary and informational `jellyfin` state,
  neither of which flips overall status.
- `docker-compose.dev-db.yml` + `docker/postgres-dev-init/01-app-role.sql` —
  disposable loopback PostgreSQL 18 dev profile (binds `127.0.0.1:5433` only)
  provisioning the same least-privilege role split as production.
- Docs/runbook: `docs/DATABASE.md` (env table, redaction rules, role model,
  Synology provisioning SQL, migration contract, readiness contract, runbook),
  README section, `.env.example` additions, `DATABASE_URL` wired into
  `docker-compose.yml` (blank ⇒ demo mode), `serverExternalPackages: ["pg"]`
  in `next.config.ts`, `allowImportingTsExtensions` in `tsconfig.json`.

## Constraints honored

- Env-only secrets; nothing credential-bearing in any response body (verified
  live below), logs, or error messages; `server-only` build-time guard.
- Clients never receive PostgreSQL credentials; no `DATABASE_URL`-derived value
  enters client bundles.
- Jellyfin touched only via its HTTP API (key-free probe); its internal
  database untouched.
- Migrations idempotent and provenance-preserving: re-runs apply nothing;
  existing rows are never rewritten; bookkeeping records checksum history.
- No merge to `main`, no deploy/release, no production credential changes; the
  pre-existing `reelhouse-postgres-dev` (port 5433) and `reelhouse-pg18-test`
  (55433) containers owned by other workers were left untouched — verification
  used a separate throwaway container `reelhouse-rh0030-pg18` on port 5434,
  removed afterwards.

## Verification evidence

Environment: Node v22.19.0 (native TS type-stripping), Docker 29.8.0,
`postgres:18` image — server version confirmed live as
`PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2)`.

### Automated contracts

| Suite | Command | Result |
|---|---|---|
| Hermetic units (config parse/redact matrix, planner/placeholder/loader matrix, migration-summary matrix, Jellyfin probe matrix with injected fetch) | `npm test` | 38/38 pass |
| Integration vs disposable PG18 (migration apply + idempotence, checksum-tamper fail-closed, DML-yes/DDL-never role smoke incl. `pg_roles` superuser/createdb/createrole/replication all false, migrator-as-app-role fail-closed on fresh DB with no half-created bookkeeping, pool-backed summary parity with owner status + fresh-DB 42P01 handling, fresh-DB pending status, unreachable-host bounded connect (~1.5 s bound), auth-failure redaction + next-connection recovery) | `npm run test:int` | 9/9 pass |
| Lint | `npm run lint` | clean |
| Typecheck | `npm run typecheck` | clean |
| Production build | `npm run build` | green; `/api/health` dynamic (ƒ), shell static |

### Live CLI evidence

- `npm run db:migrate` against PG18.6: applied migration 0001 with
  `(app role: reelhouse_app)`; a second run printed
  `db:migrate up to date — 1 migration(s) already applied (app role: reelhouse_app)`
  (idempotence through the real CLI).
- `SELECT version()` on the container returned PostgreSQL 18.6;
  `schema_migrations` held exactly `1 | app_role_grants_baseline`.

### Live HTTP evidence (`npm start`, curl)

| Scenario | `DATABASE_URL` | HTTP | Observed body (key fields) |
|---|---|---|---|
| Demo mode | unset | **200** | `database.state=unconfigured`, `migrations={state:unknown,detail:"database unconfigured"}`, `jellyfin.state=unconfigured`, `status=ok` |
| Configured + reachable | app role → 5434 | **200** | `database.state=reachable latencyMs=7`, `configSummary=postgresql://reelhouse_app:***@127.0.0.1:5434/reelhouse ssl=disable poolMax=10` (password masked), `migrations={state:ok,applied:1,pending:0,lastVersion:1}` |
| Configured + unreachable | port 5499 (closed) | **503** | `database.state=unreachable detail="connect ECONNREFUSED 127.0.0.1:5499"`; the URL's real password (`supersecret`) appears nowhere in the payload; `migrations` degrades to `unknown` |
| Invalid config | `mysql://…` | **503** | `database.state=invalid detail="DATABASE_URL must use postgres:// or postgresql:// (got mysql:)"` — URL/credentials never echoed |

App shell `GET /` returned HTTP 200 in all modes. Browser-pane verification of
the rendered UI was unavailable in this session (in-app browser webview not
attached); the UI code is untouched by this job and HTTP-level checks above
cover the changed surface. Recovery paths (DB down ⇒ 503 with redacted detail;
DB back ⇒ next request healthy) are covered deterministically by the
integration suite's bounded-connect and auth-failure-recovery cases.

## Notes for reviewers

- `migrations` in `/api/health` is intentionally diagnostic-only: it uses the
  application pool (no second connection), reports `unknown` (with bounded
  detail) when migrations aren't shipped with a standalone bundle, and never
  flips the overall status. Future jobs that read business tables may choose to
  make `pending>0` gate readiness.
- The Jellyfin probe and health route report state as data by design —
  unreachable Jellyfin is legitimate demo mode, not an unhealthy ReelHouse.
- Migration checksums hash raw file bytes (pre-`{{app_role}}` substitution) so
  the same history verifies across environments with different role names.
- Follow-up jobs in this wave (RH-0031+ media catalog, RH-0033 household
  dataload) can build directly on this layer; the grants baseline means owner
  migrations automatically make future tables DML-accessible to the app role.

## Worker state

- Implementation commit on the job branch; REVIEW bookkeeping (queue row move,
  job spec `STATUS: REVIEW`, this report) in a follow-up commit.
- No other worker's branch, worktree, or container was touched.
- Time of last claim-window check: 2026-09-22, inside 11:00–21:00 EDT.
