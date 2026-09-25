# ReelHouse PostgreSQL 18 — connectivity, roles, and migrations (RH-0030)

ReelHouse keeps household/application state in a PostgreSQL 18 `reelhouse`
database (Synology-hosted in production) while Jellyfin remains the
playback/library authority, reached only through its HTTP API. Clients never
receive PostgreSQL credentials; the database boundary lives exclusively in
server-side code, and every secret arrives through the environment only —
nothing is written to disk, bundled, or echoed.

## Components

| Path | Role |
|---|---|
| `src/lib/db/config.ts` | Pure parse/validate/redact of `DATABASE_URL` + bounded `DATABASE_*` overrides. No I/O. |
| `src/lib/db/pool.ts` | `server-only` guarded `pg` pool singleton, `query()`, `checkDatabase()`, `closePool()`. |
| `src/lib/db/migrator.ts` | Versioned migration loader/planner/runner: checksums, advisory lock, per-migration transactions; `checkMigrations()` and pool-backed `summarizeMigrations()` for diagnostics. |
| `db/migrations/NNNN_name.sql` | Ordered, forward-only, idempotent migrations. `{{app_role}}` is the only supported placeholder. |
| `scripts/db-migrate.ts` | CLI: `npm run db:migrate` (owner role). Redacted, fail-closed output. |
| `src/lib/jellyfin-health.ts` | Bounded `/System/Info/Public` reachability probe for `/api/health` (no API key sent). |
| `src/app/api/health/route.ts` | Readiness: database (fail-closed) + migration summary + catalog/household freshness + Jellyfin (informational). |
| `src/lib/readmodels/` | RH-0040 bounded read models: home rails, search, diagnostics, served by `/api/library` + `/api/search` when the catalog is synced; `pg.ts` is the server-only pool bridge. |
| `scripts/dr-verify.ts` | RH-0040 backup/restore acceptance: pg_dump → scratch restore → per-table count+digest verification. See [DR.md](DR.md). |
| `docker-compose.dev-db.yml` | Disposable loopback PostgreSQL 18 for development/verification. |
| `src/lib/catalog/`, `scripts/catalog-sync.ts` | Media catalog schema/sync built on this layer (`npm run catalog:sync`). See [CATALOG.md](CATALOG.md). |

## Environment

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Application role (least privilege, DML only). Blank = demo mode, no database features. |
| `DATABASE_MIGRATE_URL` | Owner/migrator role used only by `npm run db:migrate`. Falls back to `DATABASE_URL`. |
| `DATABASE_APP_ROLE` | Role name substituted into migrations for `{{app_role}}`; defaults to the `DATABASE_URL` user. |
| `DATABASE_POOL_MAX` | 1–100, default 10. |
| `DATABASE_CONNECT_TIMEOUT_MS` | 100–60,000, default 10,000. |
| `DATABASE_IDLE_TIMEOUT_MS` | 1,000–600,000, default 30,000. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 100–600,000, default 10,000 (app queries only; migrations are not clipped). |
| `JELLYFIN_HEALTH_TIMEOUT_MS` | 250–15,000, default 3,000. |

Invalid values are rejected (fail closed), never clamped. `sslmode` in the
URL wins over `DATABASE_SSL`; `require`-grade TLS is accepted with
self-signed certificates (Synology LAN reality), `verify-ca`/`verify-full`
enforce full verification.

## Redaction rules

- Anything echoed back (logs, health payloads, CLI errors) goes through
  `redactDatabaseUrl` / `describeDatabaseConfig` / `redactError`: password
  masked, query string dropped, raw URL scrubbed from library error text.
- Validation errors name the problem and the environment variable, never the
  URL or its credentials.
- The Jellyfin probe sends no API key at all, so nothing credential-bearing
  can leak through it.

## Role model (least privilege)

| Role | Grants | Used by |
|---|---|---|
| Owner / migrator | Database owner; applies migrations | `npm run db:migrate` only |
| App (`reelhouse_app` in the dev profile) | `LOGIN`, `CONNECT`; DML on owner-created tables via default privileges; read-only on `schema_migrations` | the Next.js server (`DATABASE_URL`) |

The app role is never a superuser, never `CREATEDB`/`CREATEROLE`, and never
receives DDL. It cannot create tables; migration 0001 turns future
owner-created tables (and sequences) into DML-accessible objects
automatically.

Synology provisioning (human-run, adjust names/passwords; workers never
change production credentials):

```sql
-- As the PostgreSQL superuser:
CREATE ROLE reelhouse_owner LOGIN PASSWORD '...' ;
CREATE DATABASE reelhouse OWNER reelhouse_owner;
CREATE ROLE reelhouse_app LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE reelhouse TO reelhouse_app;
```

Then apply migrations from a machine that can reach the database:

```bash
export DATABASE_MIGRATE_URL="postgresql://reelhouse_owner:...@YOUR-NAS-IP:5432/reelhouse"
export DATABASE_URL="postgresql://reelhouse_app:...@YOUR-NAS-IP:5432/reelhouse"
npm run db:migrate
```

## Migrations

- Files: `db/migrations/NNNN_name.sql`, applied in ascending version order.
- Each run: advisory lock → ensure `public.schema_migrations` → verify
  history (checksum + file presence) → apply each pending file in its own
  transaction with the recorded version/name/checksum.
- Idempotent: re-running against an up-to-date database applies nothing and
  changes nothing.
- Fail closed before executing anything when: a filename does not match
  `NNNN_name.sql`, versions duplicate, an unknown `{{placeholder}}` appears,
  an applied checksum no longer matches, or an applied file is missing.
- Checksums cover the raw file bytes (before `{{app_role}}` substitution), so
  the same history verifies identically across environments with different
  role names.
- Forward-only: no down-migrations. Corrections land as new migrations.

Current migrations:

1. `0001_app_role_grants_baseline.sql` — grants the application role DML on
   future owner-created tables/sequences and read-only migration bookkeeping.
2. `0002`–`0005` — the media catalog family (`media_*`; see
   [CATALOG.md](CATALOG.md)).
3. `0006_household_state.sql` — the household state family
   (`household_*`; profiles, preferences, Jellyfin links, favorites,
   watchlists, collections, home rows, watch state, playback history,
   import runs; see [HOUSEHOLD.md](HOUSEHOLD.md)).
4. `0007_catalog_change_history_and_quarantine.sql` — the incremental
   catalog family: append-only `media_item_changes` history with source
   revisions, the advance-only `media_sync_state` watermark, duplicate
   `media_item_quarantine`, and the `incremental` run mode (see
   [CATALOG.md](CATALOG.md)).
5. `0008_read_model_indexes.sql` — bounded-read indexes for the RH-0040
   read models: a partial recent-items index (active rows, `date_created
   DESC NULLS LAST`) and a case-folded name index for deterministic search
   ordering. Indexes only — no rows are touched.

## Readiness contract (`GET /api/health`)

| `database.state` | HTTP | Meaning |
|---|---|---|
| `unconfigured` | 200 | Blank `DATABASE_URL` — legitimate demo mode |
| `reachable` | 200 | `SELECT 1` succeeded; `latencyMs` + redacted `configSummary` included |
| `invalid` | 503 | Configuration rejected; named errors included |
| `unreachable` | 503 | Redacted connection error included |

`migrations` is reported alongside whenever the database is reachable
(`ok` with applied/pending/lastVersion, or `unknown` with a bounded detail,
e.g. migrations not shipped with a standalone bundle). It is diagnostic and
never flips the overall status. `catalog` is reported alongside too (RH-0040):
when the database is reachable it carries freshness data — active
item/library counts, quarantine occupancy, last successful sync (time + mode),
the incremental watermark, active profile count, and last successful
household import — and degrades to `unknown` with a bounded detail instead
of ever failing the request. `jellyfin` is reported alongside as well
(`unconfigured` / `reachable` with name+version+latency / `unreachable`
with a redacted detail) and never flips the overall status either: an
unreachable Jellyfin degrades the library source to demo mode, it does not
make ReelHouse unhealthy.

## Development & verification runbook

```bash
npm install
npm test                      # hermetic: config, planner, probe matrices
docker compose -f docker-compose.dev-db.yml up -d
export REELHOUSE_TEST_MIGRATE_URL="postgresql://reelhouse_owner:reelhouse_owner_dev@127.0.0.1:5433/reelhouse"
export REELHOUSE_TEST_DATABASE_URL="postgresql://reelhouse_app:reelhouse_app_dev@127.0.0.1:5433/reelhouse"
npm run test:int              # deterministic integration + role smoke
npm run db:migrate            # apply migrations through the real runner
docker compose -f docker-compose.dev-db.yml down -v   # discard when done
```

The dev profile binds `127.0.0.1:5433` only, holds no real data, and its two
committed passwords (`reelhouse_owner_dev`, `reelhouse_app_dev`) exist solely
for that throwaway container. PG18 note: data volumes mount at
`/var/lib/postgresql` (18+ creates a major-version subdirectory; mounting
`.../data` aborts init).
