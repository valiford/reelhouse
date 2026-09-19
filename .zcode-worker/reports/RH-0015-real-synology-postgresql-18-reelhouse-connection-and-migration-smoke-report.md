# RH-0015 Worker Report — Real Synology PostgreSQL 18 ReelHouse Connection and Migration Smoke

- **Date:** 2026-09-19 (claimed 11:30 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0015-real-synology-pg18-connection-migration-smoke`
- **Base:** `origin/main` @ `9028194`, integrating `origin/rh-0002-postgres18-reelhouse-connectivity` @ `fd9e99b` and `origin/rh-0003-reelhouse-schema-migrations` @ `e8f82fe`

## Claim

Dispatch bootstrap ran (`git fetch origin --prune`); the queue was read from
`origin/main` per protocol. `origin/main` @ `9028194` ("Reload tomorrow ZCode
priority queue", committed 2026-09-19 01:56) reloaded the Ready Queue with the
RH-0015–RH-0021 wave flagged `WAVE: Tomorrow priority` — i.e., today's
working day. RH-0015 is priority 1, `READY`, `AUTOMATION_ELIGIBLE: true`, and
carries no dependency gate (unlike RH-0005/0006/0007, which the queue lists
explicitly under "Waiting for dependencies"). Lease check before claiming:
`rh-0002/0003/0008/0009/0010` exist as remote branches and/or local worktrees
(skipped as leased); no `rh-0015*` branch or worktree existed — claim
uncontested. The lease branch was pushed to origin before implementation
started.

## What was built

Two things: **integration** of the two parallel review layers this job wires
together, and the **smoke harness** itself.

### 1. Branch integration (rh-0002 ⊕ rh-0003 on main base)

RH-0002 (connection layer: `config.ts`, `pool.ts`, `/api/health`) and
RH-0003 (schema + migrator: 9 migrations, `migrator.ts`, `db-migrate.ts`)
branch in parallel from the same main history, so RH-0015's branch merges
both. Conflicts resolved: branch copy of `JOB_QUEUE.md` (kept wave + accurate
Review Queue), `package.json` (test scripts unioned), `.env.example` (comment
unioned; mentions `MIGRATION_DATABASE_URL` and the smoke). `package-lock.json`
auto-merged and `npm install` confirmed it consistent (zero changes); merged
baseline was verified green (lint, typecheck, 29/29 unit tests) before any
new work. The only change to either branch's code is exporting
`MIN_PG_VERSION_NUM` from `migrator.ts` so the smoke reuses the 18-gate
instead of duplicating it.

### 2. End-to-end smoke check (`npm run db:smoke`)

| Path | Role |
|---|---|
| `src/lib/db/smoke.ts` | `runSmoke()` — five bounded, redacted stages (below); pure helpers (`summarizeStages`, `formatSmokeReport`, `withTimeout`) split out for unit tests; deliberately no `server-only`/alias so the CLI and tests import it under plain Node (same split as `migrator.ts`) |
| `scripts/db-smoke.ts` | CLI (`node scripts/db-smoke.ts`); env-only configuration (`DATABASE_URL` target, `MIGRATION_DATABASE_URL` owner-role override — same contract as `db-migrate.ts`); exit 0 only when every stage passed |
| `src/lib/db/smoke.test.ts` | 9 unit tests: aggregation (pass/fail/skip semantics, empty report), formatting (target line, stage lines, durations, verdicts), watchdog (bounded rejection + pass-through) |
| `src/lib/db/smoke.int.test.ts` | 6 integration tests against the disposable PG18 (own `reelhouse_smoke` database so it never fights the migration suite): full pass from empty schema, idempotent repeat, mutated-history refusal, fail-closed unconfigured env, wrong-scheme rejection before I/O, bounded+redacted unreachable target |
| `docs/DB_SMOKE.md` | Runbook: stage table with per-stage persistence effects, safety model, disposable-DB usage, **real-Synology operator procedure** with the two-role command, failure policy, programmatic use |
| `README.md`, `docs/DATABASE.md`, `docs/MIGRATIONS.md`, `.env.example`, `package.json` | Cross-links and the `db:smoke` / extended `test` / `test:db` scripts |

Smoke stages, in order — configuration failure skips everything, failed
connect skips the rest, later independent stages still report when an earlier
one fails:

1. `config` — `loadDatabaseConfig(env)` validates the environment exactly as
   the app reads it; redacted summary printed; unconfigured/invalid fails
   closed.
2. `connect` — TCP/TLS connect with the configured timeout, `SELECT 1`
   latency, `SHOW server_version` with the PostgreSQL 18 gate (older servers
   refuse the run).
3. `migrations` — full history verification + apply via `runMigrations()`,
   then an immediate repeat run that must apply nothing (duplicate/repeat
   regression path).
4. `pool` — pool built with the app's exact semantics (`createPool` mirror):
   `poolMax` concurrent queries carrying per-query payloads (crossed
   responses detected), `totalCount ≤ max` asserted, and a live
   cancellation probe (session `statement_timeout` shrunk; `pg_sleep` beyond
   it must abort with SQLSTATE 57014 — proves the server enforces bounded
   statements).
5. `transactions` — on a session-scoped `TEMP` table (cannot survive the
   session): `ROLLBACK` discards, `COMMIT` persists, an aborted statement
   (`1/0`) cannot partial-apply.

Safety model: the only persistent change a smoke run can make is applying
the versioned forward-only migrations (their purpose); everything else is
`SELECT`-only or `TEMP`-only. Every error passes `redactError()` against
every raw URL the run used; the target is only ever named via
`describeDatabaseConfig()`. Watchdog bounds the whole run (default 120 s).

## Commits on the branch

1. `Merge remote-tracking branch 'origin/rh-0002-postgres18-reelhouse-connectivity'` —
   integration, queue conflict resolved.
2. `Merge remote-tracking branch 'origin/rh-0003-reelhouse-schema-migrations'` —
   integration, queue/package.json/.env.example conflicts resolved.
3. `Add end-to-end database smoke check with real-target runbook (RH-0015)` —
   smoke module, CLI, tests, docs, script wiring.
4. *(this commit)* — Job spec → REVIEW, queue updated (RH-0015 → Review
   Queue, RH-0002 review row restored in the branch copy), this report.

## Verification evidence (2026-09-19, Node 22.19.0 / Docker; disposable PostgreSQL 18.6 only)

Static: `npm run lint` clean; `npm run typecheck` clean; `npm run build`
succeeds with the unchanged route surface (`○ /`, `ƒ /api/health`,
`ƒ /api/library`, `ƒ /api/search`); `npm test` **38/38** (config 12,
migrator 17, smoke 9).

Live CLI runs (`npm run db:smoke`):

| Case | Expected | Result |
|---|---|---|
| Full smoke, empty schema (`reelhouse_smoke` on the disposable PG18) | all 5 stages pass, 9 migrations applied, exit 0 | ✅ `SMOKE OK`, `9 applied, 0 already applied, repeat run clean` |
| Immediate repeat | idempotent, exit 0 | ✅ `0 applied, 9 already applied, repeat run clean` |
| Unreachable port with `DATABASE_CONNECT_TIMEOUT_MS=1500` | bounded redacted failure, exit 1, correct skip cascade | ✅ `[FAIL] connect — connect ECONNREFUSED 127.0.0.1:59999` in ~1.5 s, `migrations/pool/transactions` `[SKIP]`, exit 1 |
| No credentials in the environment | fail closed, exit 1 | ✅ `No database configured: set DATABASE_URL…`, exit 1 |
| Wrong scheme (`mysql://…`) | rejected before any network I/O | ✅ config stage fails `must use postgres:// or postgresql://`, connect skipped |
| Tampered recorded checksum (`deadbeef`) | migration stage refuses; other stages still report; exit 1 | ✅ `Applied migration "0001_updated_at_trigger.sql" no longer matches its recorded checksum … editing applied migrations is refused`; pool/transactions still `[PASS]`; exit 1 |

Suites: `npm run test:db` **33/33** (migrations 27 + smoke 6) against the
disposable PG18 container. Redaction audited in the integration suite: the
credential pair never appears in any formatted report.

**Two-role end-to-end proof** (the shape the Synology runbook prescribes):
against the RH-0002 disposable dev-db profile — `DATABASE_URL` =
least-privilege `reelhouse_app` (LOGIN+CONNECT only), `MIGRATION_DATABASE_URL`
= owner role — the full smoke passes: owner role applied the 9 migrations,
the restricted app role served connect/pool (10/10 concurrent + cancellation
probe)/transactions. All containers discarded afterwards (`test:db:down`,
`down -v`).

**Merged app runtime:** `npm start` with the app-role `DATABASE_URL` →
`GET /api/health` = HTTP 200 `{"state":"reachable","latencyMs":136,
"configSummary":"postgresql://reelhouse_app:***@127.0.0.1:5433/reelhouse
ssl=disable poolMax=10"}` — RH-0002's readiness surface works on the
integrated branch.

No-secrets audit: no `.env` exists; the only credentials in the tree remain
the two committed **dev-only** disposable passwords RH-0002 already
documented (`reelhouse_owner_dev`, `reelhouse_app_dev`), plus the disposable
test pair inside test files (pre-existing `migrations.int.test.ts` pattern).
No production credential values anywhere.

## Requirement-by-requirement

| Requirement (job spec) | Result |
|---|---|
| Wire the server-side data layer to a real PostgreSQL 18 target with environment-only credentials | ✅ Harness verified end-to-end against real PostgreSQL 18.6 servers (disposable, two roles); **the production Synology leg itself is the one remaining operator command** — no Synology credentials exist in this environment (fail-closed on missing credentials, worker rule 10). `docs/DB_SMOKE.md` §"Running against the real Synology" is the exact procedure |
| Verify migrations | ✅ Live apply (9/9), history verification, idempotent repeat, mutated-history refusal demonstrated |
| Verify pooling | ✅ poolMax concurrency with payload integrity, max respected, live statement-cancellation proof (57014) |
| Verify transactions | ✅ rollback / commit / aborted-transaction semantics on session-scoped TEMP tables |
| Verify readiness | ✅ `/api/health` 200 `reachable` under the merged layer |
| Safe failure diagnostics — bounded and redacted | ✅ connect/statement timeouts + watchdog; credential pair provably absent from all output; skip cascade isolates failures |
| Deterministic tests cover success, stale/duplicate/failure/recovery paths | ✅ 38 unit + 33 integration; stale = checksum refusal, duplicate = idempotent repeat, failure = unreachable/auth/config paths, recovery = re-run green after container restart (suite `before` + repeat cases) |
| Existing suites remain green | ✅ lint/typecheck/build/`npm test`/`test:db` all green |
| No production restart, credential change, or media deletion | ✅ production never contacted; only disposable containers touched, all discarded |
| Report evidence and stop in REVIEW | ✅ this report; branch left in REVIEW; nothing merged |

## Findings the controller should see

1. **The real-Synology leg needs one operator step.** This environment has
   no Synology credentials by design (none in env, no `.env`; worker rule 10
   forbids inventing them). The delivered gate is the `db:smoke` harness +
   `docs/DB_SMOKE.md` runbook; after provisioning the roles per
   `docs/DATABASE.md`, the two-role command in that runbook is the complete
   remaining action. Recommend accepting this job as the smoke deliverable
   and tracking the operator run as its acceptance step.
2. **Migrations grant no table privileges** (`db/migrations/*.sql` contain no
   `GRANT`): after migration, `reelhouse_app` still has zero DML rights on
   the domain tables — the dev init script's comment ("DML grants arrive
   with the RH-0003 migrations") does not match the migration files. Harmless
   today (no feature reads/writes the DB yet; the smoke's app-role probes
   need only CONNECT+TEMP), but RH-0017/0018 (first persistence features) or
   RH-0006 must add the DML grants as a migration.
3. **Merge order matters for the small conflicts.** rh-0002 and rh-0003 are
   parallel branches; this branch already integrates both (queue copy,
   `package.json` test line, `.env.example`). Merging `rh-0002` → `rh-0003` →
   this branch (or just this branch last) preserves those resolutions;
   merging in another order will re-surface the same three-way conflicts.
   `package-lock.json` merged cleanly and `npm install` is a no-op.
4. **Test-runner parallelism is safe across the two integration suites**:
   the smoke suite drives its own `reelhouse_smoke` database inside the same
   disposable container, so `node --test` file-level parallelism cannot
   cross-contaminate the migration suite's `reelhouse_test` database.
5. Carried-forward operational notes from RH-0002/RH-0003 remain valid:
   postgres:18 volume-path convention (compose files here already handle
   it), the open next@16.0.1 CVE (RH-0008), and the Windows orphaned-node-
   listener cleanup after `npm start` (handled during this verification).

## Handoff

Upon acceptance: controller merges (suggested order in finding 3) — worker
never merges. Next wave priorities per `origin/main`: RH-0016 (Jellyfin →
`media_catalog` sync, appends migrations 0010+ via the same runner), then
RH-0017/0018 (persistence features on the now-proven surface). The
disposable dev-db/test-db profiles remain the verification targets; the
production contact path is documented and gated behind `db:smoke`.
