# RH-0002 Worker Report — PostgreSQL 18 ReelHouse Connectivity

- **Date:** 2026-09-18 (claimed 16:06 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0002-postgres18-reelhouse-connectivity`
- **Base:** `origin/main` @ `593fdcf`

## Claim

Queue read from `origin/main` per dispatch bootstrap. RH-0002 was the
highest-priority READY job with `AUTOMATION_ELIGIBLE: true` and a
satisfied dependency (RH-0001 COMPLETE). No `rh-0002*` branch or
worktree existed — claim uncontested.

## What was built

A server-side PostgreSQL connection layer, plus the health surface that
proves it. No feature reads/writes the database yet (RH-0005+); no
schema exists (RH-0003).

| Path | Role |
|---|---|
| `src/lib/db/config.ts` | Pure parse/validate/redact logic — `DATABASE_URL` + bounded `DATABASE_*` overrides, SSL-mode mapping, no I/O |
| `src/lib/db/pool.ts` | `pg` pool singleton (`server-only` guarded), `query()`, `checkDatabase()`, `closePool()`; pool errors logged redacted instead of crashing |
| `src/app/api/health/route.ts` | `GET /api/health`, `force-dynamic`; readiness matrix below |
| `docker-compose.dev-db.yml` + `docker/postgres-dev-init/01-app-role.sql` | Disposable local PostgreSQL 18 on loopback `127.0.0.1:5433`; init script provisions the least-privilege `reelhouse_app` role |
| `docs/DATABASE.md` | Configuration, redaction rules, fail-closed matrix, role model, Synology wiring, verification runbook |
| `.env.example`, `docker-compose.yml`, `README.md` | Blank `DATABASE_URL` (blank = demo mode), compose passthrough, dev/verification docs |
| `next.config.ts`, `tsconfig.json`, `package.json` | `serverExternalPackages: ["pg"]`; `allowImportingTsExtensions` (noEmit-safe); `pg` + `server-only` deps, `@types/pg` devDep, `npm test` script |

Key properties:

- **Server-side only, enforced:** `pool.ts` imports `server-only`, so any
  Client Component import of the credential-bearing module fails the
  build. Nothing `NEXT_PUBLIC_*` carries database config.
- **Fail-closed:** invalid configuration throws at `getPool()` and
  reports 503 at `/api/health`; it never silently degrades. Blank
  `DATABASE_URL` is the legitimate demo mode (same philosophy as the
  Jellyfin fallback) and stays 200/`unconfigured`.
- **Redaction everywhere:** password-masked URL summaries; query string
  dropped from redactions; `redactError()` scrubs any raw-URL leak in
  library error messages; validation errors name the problem, never the
  URL.
- **Bounded:** pool max 10 (1–100), connect 10s (100ms–60s), idle 30s,
  `statement_timeout` + client `query_timeout` 10s (100ms–600s), all
  env-overridable and validated with hard bounds.
- **Least privilege:** runtime role `reelhouse_app` is LOGIN +
  CONNECT only — no DDL, not superuser, zero table privileges until
  RH-0003 migrations grant them. Owner/migrator role split documented;
  Synology provisioning SQL is a human-run sample in `docs/DATABASE.md`.

## Commits on the branch

1. `Add server-side PostgreSQL 18 connection layer` — config/pool/test
   modules, dependency and toolchain wiring.
2. `Expose database readiness at /api/health and wire environment` —
   health route, `.env.example`, compose (prod passthrough + disposable
   dev-db profile + role init), `docs/DATABASE.md`, README.
3. *(this commit)* — Job spec → REVIEW, queue updated, this report.

## Verification evidence (2026-09-18, Node 22.19.0 / npm 10.9.3 / Docker 29.8.0)

Static: `npm run lint` clean; `npm run typecheck` clean; `npm run build`
succeeds (routes: `○ /`, `ƒ /api/health`, `ƒ /api/library`, `ƒ /api/search`
— health correctly dynamic); `npm test` 12/12 (config parse/validate/
redact/override matrix).

Live integration against ordinary **PostgreSQL 18.6** in the disposable
loopback container (production never contacted; no Synology credentials
exist in this environment):

| Case | Expected | Result |
|---|---|---|
| Dev-db URL, app role | 200 `reachable` | ✅ `latencyMs:4`, summary `postgresql://reelhouse_app:***@127.0.0.1:5433/reelhouse ssl=disable poolMax=10` |
| Container stopped | 503 `unreachable`, no secrets | ✅ `connect ECONNREFUSED 127.0.0.1:5433`; recovered to 200 after restart |
| URL missing database name | 503 `invalid` (fail closed) | ✅ `DATABASE_URL has no database name` |
| Blank `DATABASE_URL` | 200 `unconfigured` (demo) | ✅ |
| Black-hole host, `DATABASE_CONNECT_TIMEOUT_MS=1500` | 503 within the bound | ✅ 503 in 1.51s |
| `GET /` and `GET /api/library` | unchanged | ✅ 200 / demo payload |

Least privilege proven live in the container: `reelhouse_app` is
`rolsuper=f, rolcreatedb=f`; `SELECT 1` succeeds; `CREATE TABLE` is
denied (`permission denied for schema public`).

No-secrets audit: `.env` still absent; staged tree contains only blank
`.env.example` values and the two committed **dev-only** disposable
passwords (`reelhouse_owner_dev`, `reelhouse_app_dev`) that exist solely
for the loopback-only throwaway profile — no production credential
values.

## Requirement-by-requirement

| Requirement (job spec) | Result |
|---|---|
| Server-side only; no browser/mobile credentials | ✅ `server-only` build guard; health responses audited |
| Environment-driven configuration with secret redaction | ✅ `DATABASE_URL` + `DATABASE_*`; redaction unit-tested and observed in live responses |
| Least-privilege application role assumptions | ✅ role split + live DDL denial proof; provisioning documented for the human operator |
| Connection pooling and bounded timeouts | ✅ `pg.Pool` with validated bounds; timeout bound demonstrated at 1.51s |
| Fail-closed startup/health for invalid configuration | ✅ throw + 503 matrix, all four states exercised |
| Local/disposable test profile distinct from Synology | ✅ `docker-compose.dev-db.yml`, loopback-only, `down -v` discarded after verification |
| No firewall/port exposure changes | ✅ prod compose adds no ports; dev-db binds `127.0.0.1` only |
| No production credential values committed | ✅ audited staged tree |

## Findings the controller should see

1. **`postgres:18` Docker image volume convention changed** (18+): data
   mounts must target `/var/lib/postgresql`, not `.../data` — mounting
   `.../data` aborts init. Already handled in `docker-compose.dev-db.yml`
   with an explanatory comment; relevant to RH-0003/RH-0007 tooling.
2. **next@16.0.1 CVE still open** (2 high, 1 critical via `npm audit` —
   the CVE-2025-66478 family flagged at baseline). Unchanged, dedicated
   job still recommended.
3. **`next start` warns under `output: "standalone"`** (pre-existing):
   local smoke works, but production entry should be the standalone
   server per the Dockerfile; worth an ops look when RH-0006 hardens
   the deployment boundary.
4. **Windows dev note:** killing the `npm start` wrapper orphans the
   node listener on port 3000; verification on Windows should kill the
   listening PID (as done here). Cosmetic, but it bit this run.
5. ESLint/`@types/node` versions unchanged; no new audit-relevant
   packages beyond `pg` (clean) and `server-only` (empty shim).

## Handoff

Upon acceptance: controller merges `rh-0002-postgres18-reelhouse-
connectivity` to `main` (worker never merges). RH-0003 (migrations)
and RH-0004 (catalog sync) remain READY and unblocked; `docs/DATABASE.md`
records the role split and connection contract they should build on.
The disposable dev-db profile is the intended target for RH-0003
migration verification.
