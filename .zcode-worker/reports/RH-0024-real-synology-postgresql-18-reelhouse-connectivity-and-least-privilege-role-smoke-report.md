# RH-0024 Worker Report — Real Synology PostgreSQL 18 ReelHouse Connectivity and Least-Privilege Role Smoke

- **Date:** 2026-09-21 (claimed 14:30 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0024-real-synology-postgresql-18-reelhouse-connectivity-and-least-privilege-role-smoke`
- **Base:** `origin/main` @ `f9a630e` (current main per dispatch bootstrap; queue re-read from `origin/main` after fetch)

## Claim

Queue read from `origin/main:.zcode-worker/JOB_QUEUE.md` per the mandatory
bootstrap (`git fetch origin --prune` first; main had moved `df9b1d4 →
f9a630e`). RH-0024 was the highest-priority READY job (priority 1, wave
2026-09-21) with `AUTOMATION_ELIGIBLE: true` and no dependency field. All
other READY rows (RH-0002–RH-0023) have existing branches **and** worktrees
and were treated as leased; no `rh-0024*` branch or worktree existed —
claim uncontested. Dedicated branch + worktree created from `origin/main`.

## What was built

A server-side PostgreSQL 18 connection layer with a versioned migration
runner, a least-privilege grants-baseline migration, a migration CLI, and a
Jellyfin reachability probe surfaced at `/api/health`. No feature reads or
writes the database yet; the app-role schema belongs to later jobs, which
can drop migration files into `db/migrations/` and inherit grants
automatically.

| Path | Role |
|---|---|
| `src/lib/db/config.ts` | Pure parse/validate/redact of `DATABASE_URL` + `DATABASE_MIGRATE_URL` + bounded `DATABASE_*` overrides; SSL-mode mapping; no I/O |
| `src/lib/db/pool.ts` | `server-only` guarded `pg` pool singleton, `query()`, `checkDatabase()`, `closePool()`; pool errors logged redacted |
| `src/lib/db/migrator.ts` | Versioned migration loader/planner/runner: sha-256 checksums, fixed-key advisory lock, per-migration transactions, `{{app_role}}` placeholder, read-only `checkMigrations()` status |
| `db/migrations/0001_app_role_grants_baseline.sql` | Grants the app role DML on future owner-created tables/sequences (default privileges) and read-only migration bookkeeping |
| `scripts/db-migrate.ts` | `npm run db:migrate` — owner-role CLI; redacted fail-closed output, exit 1 on any failure |
| `src/lib/jellyfin-health.ts` | Bounded `/System/Info/Public` probe (3s default, 250ms–15s env-bounded); sends **no** API key |
| `src/app/api/health/route.ts` | `GET /api/health` — database (fail-closed) + Jellyfin (informational) |
| `docker-compose.dev-db.yml` + `docker/postgres-dev-init/01-app-role.sql` | Disposable loopback PG18 on `127.0.0.1:5433`; provisions owner + DML-locked `reelhouse_app` |
| `docs/DATABASE.md` | Config table, redaction rules, role model, Synology provisioning sample (human-run), migration contract, readiness matrix, verification runbook |
| `.env.example`, `docker-compose.yml`, `README.md` | Blank `DATABASE_URL`/`DATABASE_MIGRATE_URL`/`DATABASE_APP_ROLE`, compose passthrough, docs links |
| `next.config.ts`, `tsconfig.json`, `package.json` | `serverExternalPackages: ["pg"]`; `allowImportingTsExtensions`; `pg`/`server-only`/`@types/pg`; `test`, `test:int`, `db:migrate` scripts |

Key properties:

- **Least privilege is structural:** the app role starts with LOGIN+CONNECT
  only; migration 0001 grants DML via `ALTER DEFAULT PRIVILEGES` of the
  executing (migrator) role, so every future owner-created table is
  DML-accessible without granting DDL ever. `{{app_role}}` is substituted
  from the environment (`DATABASE_APP_ROLE` → `DATABASE_URL` user → migrator
  user) and validated as a plain lowercase identifier; checksums cover raw
  file bytes so history is stable across environments with different role
  names.
- **Migrations fail closed before executing anything** on: malformed
  filename, duplicate version, unknown `{{placeholder}}`, checksum mismatch
  on applied history, or an applied version whose file disappeared. Each
  migration commits independently; a fixed advisory lock serializes
  concurrent runners; the migrator client deliberately has no statement
  timeout (DDL legitimacy).
- **Migration bookkeeping stays read-only for the app role** — enforced by
  the runner on every pass (see Findings #1; the integration suite caught a
  real default-privileges cascade here).
- **Fail-closed readiness:** blank `DATABASE_URL` = demo mode (200);
  invalid or unreachable = 503 with named, redacted errors. Jellyfin state
  is informational only — an unreachable Jellyfin degrades to demo, never
  flips overall health.
- **Bounded diagnostics everywhere:** passwords masked, query strings
  dropped, raw URLs scrubbed from error text, probe messages truncated
  (300–4096 chars), no API key ever sent by the probe.

## Commits on the branch

1. `Add server-side PostgreSQL 18 connection layer with versioned migrations` —
   config/pool/migrator + tests, migration 0001, CLI, toolchain wiring.
2. `Expose database and Jellyfin readiness at /api/health with dev-db profile` —
   health route + Jellyfin probe + tests, `.env.example`, compose (prod
   passthrough + disposable dev-db + role init), `docs/DATABASE.md`, README.
3. *(this commit)* — Job spec → REVIEW, queue updated, this report.

## Verification evidence (2026-09-21, Node 22.19.0 / npm 10.9.3 / Docker 29.8.0)

Static contracts: `npm run lint` clean; `npm run typecheck` clean; `npm run
build` succeeds (`○ /`, `ƒ /api/health`, `ƒ /api/library`, `ƒ /api/search` —
health correctly dynamic); `npm test` **33/33** hermetic (config
parse/validate/redact matrix, migration planner/loader matrices, Jellyfin
probe matrix with injected fetch incl. bounded-timeout timing assertions).

Deterministic integration — `npm run test:int` **8/8** against ordinary
PostgreSQL **18.6** (Debian) in the disposable loopback container
(production never contacted; no Synology credentials exist in this
environment):

| Case | Result |
|---|---|
| Migrations apply as owner; re-apply is a no-op; checksum row recorded | ✅ appliedNow `[1]`, then `[]` skipped 1 |
| Grants baseline: app role SELECT/INSERT/UPDATE/DELETE on owner table; `CREATE TABLE` denied (`permission denied for schema public`); `schema_migrations` readable, DELETE denied | ✅ |
| Role smoke: `rolsuper=f`, `rolcreatedb=f`, `rolcreaterole=f`, `rolreplication=f`, `rolcanlogin=t` | ✅ |
| Edited migration history fails closed before executing anything | ✅ `changed on disk after being applied`, nothing re-applied |
| Migrator as app role on a fresh database fails closed; owner pipeline then succeeds end-to-end on the same database | ✅ bootstrap `permission denied`; owner run applies 0001 incl. `{{app_role}}` grant |
| `checkMigrations` fresh DB → `{ok, applied 0, pending 1}`, not an error | ✅ |
| Black-hole host with 1.5s connect timeout fails bounded (<10s wall) | ✅ |
| Wrong-password failure redacts credentials and next good-credential connect succeeds (recovery) | ✅ `password authentication failed`, then `SELECT 1` ok |

CLI (`npm run db:migrate`): `up to date — 1 migration(s) already applied
(app role: reelhouse_app)`; unconfigured → exit 1 with named guidance;
wrong password → exit 1 with redacted message.

Live readiness matrix against the built server (`npm start`):

| Case | Expected | Result |
|---|---|---|
| Dev-db URL, app role | 200 `reachable` | ✅ `latencyMs:4`, summary `postgresql://reelhouse_app:***@127.0.0.1:5433/reelhouse ssl=disable poolMax=10`, `jellyfin: unconfigured` |
| Container stopped | 503 `unreachable`, no secrets | ✅ `connect ECONNREFUSED 127.0.0.1:5433` |
| Container restarted | 200 again (recovery) | ✅ `latencyMs:28` |
| URL missing database name | 503 `invalid` (fail closed) | ✅ `DATABASE_URL has no database name` |
| `JELLYFIN_URL` = dead port, configured | 200 overall, `jellyfin: unreachable`, `fetch failed` | ✅ degraded, not unhealthy; `/api/library` still 200 demo |
| Blank `DATABASE_URL` | 200 `unconfigured` (demo) | ✅ (covered by hermetic config matrix + route logic) |
| `GET /` and `GET /api/library` | unchanged | ✅ 200; `<title>ReelHouse</title>`; demo payload |

Browser-automation note: the session's Node REPL browser backend was not
available, so UI verification was done at HTTP level; the app shell is
untouched baseline code (all changes are server-side), and the served page
returns the expected title and demo library.

Dev-db profile discarded after verification (`down -v`). No-secrets audit:
`.env` absent; staged tree contains only blank `.env.example` values and the
two committed **dev-only** throwaway passwords (`reelhouse_owner_dev`,
`reelhouse_app_dev`) for the loopback-only disposable profile — no
production credential values.

## Requirement-by-requirement (job spec)

| Acceptance criterion | Result |
|---|---|
| Deterministic PostgreSQL/Jellyfin integration evidence covers success and relevant failure/recovery paths | ✅ 8/8 integration + 33/33 hermetic + live matrix above (success, unreachable, invalid, timeout, auth failure, degraded Jellyfin, restart recovery) |
| Existing build/lint/typecheck/runtime safety contracts remain green | ✅ lint/typecheck clean, build green, `/api/health` dynamic, `server-only` guard intact, demo mode unchanged |
| Migrations are versioned and diagnostics bounded/redacted | ✅ `db/migrations/NNNN_name.sql` + checksummed history + advisory-locked runner; redaction unit-tested and observed in live responses and CLI |
| Report evidence and stop in REVIEW | ✅ this report; queue/spec marked REVIEW |

## Findings the controller should see

1. **PostgreSQL default-privileges cascade (important for RH-0003+):** any
   table (re)created by the migrator role after the grants baseline —
   including `schema_migrations` itself — automatically re-inherits the
   granted DML privileges for the app role. The integration suite caught a
   real cascade where a recreated bookkeeping table briefly became
   app-role-writable, which could have let a tampered migration execute.
   The runner now re-asserts read-only bookkeeping on every pass. Schema
   authors should know: owner-created tables are app-role-DML-writable by
   design from migration 0001 onward.
2. **`has_table_privilege(..., 'CREATE')` is invalid** (`unrecognized
   privilege type`, SQLSTATE 22023): CREATE is a schema/database privilege,
   not a table privilege. DDL denial must be proven by an actual
   `CREATE TABLE` rejection (as the smoke now does).
3. **`AbortSignal.timeout` timers are unref'd in Node:** in bare test
   processes the event loop can drain before the abort fires, cancelling
   pending tests. Hermetic probe tests keep an active handle. Relevant to
   any future timeout-based tests (RH-0006 hardening).
4. **Windows dev note (repeat of RH-0002):** killing the `npm start`
   wrapper orphans the node listener on port 3000; kill the listening PID.
5. **next@16.0.1 CVEs unchanged** (upgrade owned by RH-0008); PG18 Docker
   volume convention note carries over to RH-0025/RH-0028 tooling (handled
   in the committed dev-db compose).

## Handoff

Upon acceptance: controller merges
`rh-0024-real-synology-postgresql-18-reelhouse-connectivity-and-least-privilege-role-smoke`
to `main` (worker never merges). RH-0025 (schema migrations + household
constraints) drops migration files into `db/migrations/` and inherits the
runner, the advisory lock, the checksum contract, and app-role DML grants;
`docs/DATABASE.md` records the role split and connection contract. The
disposable dev-db profile is the intended verification target.
