# ReelHouse PostgreSQL connectivity (RH-0002)

How the ReelHouse server connects to the household PostgreSQL 18 service.
Scope of this document: the server-side connection abstraction —
configuration, pooling, timeouts, redaction, and health. Not in scope:
schema and migrations (RH-0003), catalog sync (RH-0016 — see
[CATALOG_SYNC.md](CATALOG_SYNC.md) for the separate `media_catalog`
database), persistence features (RH-0005+), API contract hardening
(RH-0006). The end-to-end verification entry point for all of it lives in
[DB_SMOKE.md](DB_SMOKE.md).

## Layout

| Path | Role |
|---|---|
| `src/lib/db/config.ts` | Pure parse/validate/redact logic. No I/O; unit-tested by `src/lib/db/config.test.ts` |
| `src/lib/db/pool.ts` | `pg` pool singleton, `query()`, `checkDatabase()`, `closePool()`. Marked `server-only` — importing it from a Client Component fails the build |
| `src/app/api/health/route.ts` | `GET /api/health` readiness endpoint (see behavior matrix) |
| `docker-compose.dev-db.yml` | Disposable local PostgreSQL 18 for development/verification. Not part of the Synology stack |

## Configuration

Everything is environment-driven via `DATABASE_URL`; there is no other
source of credentials. Blank/unset `DATABASE_URL` is the supported
no-database demo mode (the UI keeps serving the built-in demo library,
exactly like the Jellyfin fallback).

| Variable | Default | Bounds | Meaning |
|---|---|---|---|
| `DATABASE_URL` | _(blank)_ | — | `postgres://` / `postgresql://` URL. Server-side only |
| `DATABASE_SSL` | from URL | `disable` … `verify-full` | SSL mode fallback, used only when the URL carries neither `sslmode` nor `ssl` |
| `DATABASE_POOL_MAX` | `10` | 1–100 | Max pooled connections |
| `DATABASE_CONNECT_TIMEOUT_MS` | `10000` | 100–60000 | Bounded connect time |
| `DATABASE_IDLE_TIMEOUT_MS` | `30000` | 1000–600000 | Idle client release |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `10000` | 100–600000 | Server `statement_timeout` and client `query_timeout` |

URL query parameters: `sslmode=disable|allow|prefer|require|verify-ca|verify-full`
or the `ssl=true|false` alias. Mapping: `disable` → no TLS;
`allow`/`prefer`/`require` → TLS without certificate verification (the
libpq `require` semantic, chosen because Synology LAN deployments use
self-signed certificates); `verify-ca`/`verify-full` → full verification.
Unrecognized values fail configuration validation — they never silently
disable TLS.

Invalid values (malformed URL, wrong scheme, out-of-bounds override,
unknown SSL mode, bad percent-encoding) are rejected before any network
I/O. Nothing falls back to defaults silently.

## Secret handling

- `server-only` on `pool.ts`: the credential-carrying module cannot be
  bundled for the browser; violating that is a build error.
- Logging goes through `redactDatabaseUrl()` / `describeDatabaseConfig()`
  (password masked, query string dropped) or `redactError()` (scrubs the
  raw URL if a library ever embeds it in an error message).
- Validation error messages name the variable and the problem; they never
  echo the URL.
- No production credential values are committed. `.env` is gitignored;
  `.env.example` ships blank values.

## Fail-closed behavior

`GET /api/health` (uncached, `force-dynamic`):

| State | Cause | HTTP | Body |
|---|---|---|---|
| `unconfigured` | `DATABASE_URL` blank | 200 | `{"status":"ok","database":{"state":"unconfigured"}}` |
| `invalid` | configuration rejected | 503 | validation errors (redacted) |
| `reachable` | `SELECT 1` succeeded | 200 | state, latency, redacted config summary |
| `unreachable` | ping failed or timed out | 503 | redacted error detail |

`unconfigured` stays 200 because it is a legitimate deployment mode (same
philosophy as the Jellyfin demo fallback), not a failure. Everything else
fails closed: an invalid configuration is an error, never a degraded
mode; the pool throws instead of returning a non-functional client.

## Role model (least privilege)

Two roles, never the superuser, never the table owner, from the app:

- `reelhouse_app` — runtime application role. `LOGIN`, `CONNECT` on the
  database, and — once RH-0003 creates schemas — DML grants on exactly the
  tables it needs. No `CREATE`, no `SUPERUSER`, no role administration.
- `reelhouse_owner` (name in the disposable profile; pick your own on the
  NAS) — owns schemas/tables and runs RH-0003 migrations. Never used by
  the running application.

Provisioning on the Synology PostgreSQL 18 service (run manually as the
Postgres administrator; ReelHouse tooling never provisions production
roles):

```sql
CREATE ROLE reelhouse_app LOGIN PASSWORD '<choose-a-secret>';
GRANT CONNECT ON DATABASE reelhouse TO reelhouse_app;
-- DML grants arrive with the RH-0003 migrations that create the tables.
```

## Synology wiring

1. Add to `/volume1/docker/reelhouse/.env`:
   `DATABASE_URL=postgresql://reelhouse_app:<secret>@<nas-host>:5432/reelhouse`
2. `docker-compose.yml` passes `DATABASE_URL` into the `reelhouse` (UI)
   container. The container-to-Postgres hop is the existing LAN path.
3. **No firewall or port-exposure change is required or permitted** for
   this feature: PostgreSQL keeps whatever (LAN-only) exposure it already
   has, browsers only ever talk to the ReelHouse API, and the compose
   file adds no published database port.

## Disposable local profile

```bash
docker compose -f docker-compose.dev-db.yml up -d
# DATABASE_URL for the app role (least-privilege, provisioned by init script):
#   postgresql://reelhouse_app:reelhouse_app_dev@127.0.0.1:5433/reelhouse
docker compose -f docker-compose.dev-db.yml down -v   # discard state
```

Binds to `127.0.0.1:5433` only. The committed passwords
(`reelhouse_owner_dev`, `reelhouse_app_dev`) are disposable development
values for this loopback-only profile, not production credentials.

## Verification runbook

Deterministic, no production contact (loopback only):

```bash
npm test            # config unit tests (parse/validate/redact)
npm run lint && npm run typecheck && npm run build

docker compose -f docker-compose.dev-db.yml up -d
DATABASE_URL=postgresql://reelhouse_app:reelhouse_app_dev@127.0.0.1:5433/reelhouse npm start
#   GET /api/health -> 200 {"status":"ok","database":{"state":"reachable",...}}
# stop the container:
#   GET /api/health -> 503 ... "unreachable"
# blank DATABASE_URL:
#   GET /api/health -> 200 ... "unconfigured"
# malformed DATABASE_URL (e.g. postgres://db.lan — no database name):
#   GET /api/health -> 503 ... "invalid"

# Least-privilege check (inside the dev container):
#   CREATE TABLE t (x int) as reelhouse_app must be denied.
```
