# Database smoke check

`npm run db:smoke` is one bounded, redacted command that wires the
connection layer (`src/lib/db/config.ts`, RH-0002) and the migration system
(`src/lib/db/migrator.ts`, RH-0003) to a real target and proves the whole
surface works end to end. It is the pre-acceptance gate for pointing
ReelHouse at the production Synology PostgreSQL 18 `reelhouse` database.

## What it verifies, stage by stage

| Stage | Proves | Persistent effect on the target |
|---|---|---|
| `config` | `DATABASE_URL` parses, validates, and summarizes under the bounded `DATABASE_*` overrides; redacted summary printed | none |
| `connect` | TCP/TLS reachability, `SELECT 1` latency, and the PostgreSQL 18 gate (`SHOW server_version` ≥ 18; anything older refuses the run) | none |
| `migrations` | Full history verification, then applies every pending migration exactly as `db:migrate` would; an immediate repeat run must apply nothing (idempotency / duplicate-run regression) | applies versioned, forward-only migrations — each atomic with its `schema_migrations` row |
| `pool` | A pool built with the app's exact semantics (bounds, timeouts) serves `poolMax` concurrent queries with per-query payloads (responses cannot cross), never exceeds `max`, and the server cancels a statement that exceeds a small statement-timeout budget (SQLSTATE `57014`) | none |
| `transactions` | `ROLLBACK` discards writes, `COMMIT` persists, and an aborted statement cannot partial-apply — all on a session-scoped `TEMP` table | none (the `TEMP` table dies with the session) |

Any failed stage stops everything that depends on it (configuration failure
skips all stages; a failed `connect` skips the rest), later independent
stages still report (so a migration problem does not hide a healthy pool),
and the command exits non-zero unless every stage passed.

## Safety model

- **Credentials are environment-only.** The smoke reads the same
  `DATABASE_URL` (and `DATABASE_*` overrides) the app reads — see
  [DATABASE.md](DATABASE.md) for the full configuration contract. No
  credential is ever accepted from a flag or a file.
- **Redaction everywhere.** The target is only ever printed through
  `describeDatabaseConfig()` (`user:***@host:port/db`), and every error
  message passes `redactError()` against every URL the run used, so a
  library leak cannot surface the password. Output is the redacted summary
  plus the stage report — nothing else.
- **Bounded.** Connection, statement, and query timeouts come from the
  validated configuration bounds; a watchdog (default 120 s, `--timeout`
  budget in `runSmoke({ timeoutMs })`) bounds the whole run.
- **Minimal, explicit footprint.** The only persistent change a smoke run
  can make is applying the versioned forward-only migrations — their whole
  purpose. The pool and transaction probes are `SELECT`-only or `TEMP`-only.
  No restart, no credential change, no media deletion, no role changes.

## Running against the disposable local database

```bash
npm run test:db:up              # disposable PostgreSQL 18 on 127.0.0.1:55433
npm run db:smoke                # with DATABASE_URL set, as shown below
npm run test:db:down            # discard everything
```

Concretely, with the container up and a created `reelhouse_smoke`
database (the integration suite creates it automatically):

```bash
DATABASE_URL=postgresql://reelhouse_test:reelhouse_test@127.0.0.1:55433/reelhouse_smoke \
npm run db:smoke
```

Expected output:

```
[pass] config (0 ms) — postgresql://reelhouse_test:***@127.0.0.1:55433/reelhouse_smoke ssl=disable poolMax=10
[pass] connect (4 ms) — latencyMs:2, server:PostgreSQL 18.6 ...
[pass] migrations (180 ms) — 9 applied, 0 already applied, repeat run clean, history verified
[pass] pool (2100 ms) — 10/10 concurrent queries ok, poolMax respected, statement cancellation enforced
[pass] transactions (6 ms) — rollback, commit, and aborted-transaction semantics verified on a session-scoped TEMP table
SMOKE OK
```

## Running against the real Synology PostgreSQL 18

Run this **once, deliberately**, from a machine that can reach the NAS, with
the role model from [MIGRATIONS.md](MIGRATIONS.md) ("Roles and privileges"):

```bash
# app role for the connection/pool/transaction stages,
# owner role for the migration stage (same host and database)
DATABASE_URL=postgresql://reelhouse_app:<app-secret>@<nas-host>:5432/reelhouse \
MIGRATION_DATABASE_URL=postgresql://reelhouse_owner:<owner-secret>@<nas-host>:5432/reelhouse \
npm run db:smoke
```

- First run applies migrations 0001–0009 to the `reelhouse` database and
  records history; every later run must report `0 applied` and stay green.
- If the app role should *not* own the migration stage, that is exactly what
  `MIGRATION_DATABASE_URL` exists for; a single owner-role `DATABASE_URL`
  also works (supported, per MIGRATIONS.md, though RH-0006 tightens this).
- A `SMOKE FAILED` run is a stop: fix the named stage (failures are
  self-describing and redacted) and re-run. Never hand-edit
  `schema_migrations` to force green — history conflicts are investigated,
  not overridden (see MIGRATIONS.md "Rollback / recovery").

**Operator checklist (Synology):**

1. PostgreSQL 18 reachable on the LAN path the ReelHouse container uses —
   no firewall or port-exposure change is required or permitted.
2. Roles provisioned per DATABASE.md (`reelhouse_app` LOGIN + CONNECT;
   owner role for DDL). ReelHouse tooling never provisions production roles.
3. Secrets provided through the environment of the shell running the smoke —
   never committed, never echoed.

## Programmatic use

```ts
import { runSmoke, formatSmokeReport } from "../src/lib/db/smoke.ts";

const report = await runSmoke({
  env: process.env,           // or an injected record in tests
  migrationsDir: "db/migrations",
  log: (line) => console.log(line)
});
if (!report.ok) console.error(formatSmokeReport(report));
```

Test coverage: `src/lib/db/smoke.test.ts` (pure report/watchdog logic) and
`src/lib/db/smoke.int.test.ts` (full pass from empty schema, idempotent
repeat, mutated-history refusal, fail-closed configuration, bounded +
redacted unreachable-target failure).
