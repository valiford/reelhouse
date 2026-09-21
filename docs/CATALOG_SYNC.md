# Jellyfin → media_catalog synchronization (RH-0026)

The media catalog — what exists in the library, with normalized metadata —
lives in a PostgreSQL 18 `media_catalog` database, separate from the
`reelhouse` household database. It is populated exclusively from the Jellyfin
HTTP API by a batch synchronization job. Jellyfin remains the playback and
library authority: this job reads its API, never its internal database, and
never writes to it.

```
Jellyfin (authority)  --HTTP API-->  sync engine (CLI)  -->  media_catalog (PG18)
                                                              reelhouse (PG18, untouched)
```

## Components

| Path | Role |
|---|---|
| `src/lib/catalog/config.ts` | Pure parse/validate of `MEDIA_CATALOG_*` credentials, Jellyfin sync config, and the sync policy; no I/O |
| `src/lib/catalog/model.ts` | Jellyfin payload → normalized model + the content fingerprint that makes syncs idempotent |
| `src/lib/catalog/jellyfin-client.ts` | Bounded API-only client (timeout per request, API key only in the `X-Emby-Token` header); interface is fixture-injectable |
| `src/lib/catalog/sync.ts` | The engine: full/incremental/rebuild modes, quarantine, retirement, per-page transactions |
| `scripts/catalog-migrate.ts` | `npm run catalog:migrate` — applies `db/migrations-catalog/` to the catalog database |
| `scripts/catalog-sync.ts` | `npm run catalog:sync[:full|:rebuild]` — the batch job |
| `db/migrations-catalog/0001–0004` | Grants baseline, libraries/items/provider ids, taxonomies, sync operational state |

## Data authorities and identity

- `media_catalog` rows identify as `(source, external_id)` — the same pair
  reelhouse-side `media_item_ref` rows use. Nothing in `media_catalog`
  references the `reelhouse` database and vice versa; the catalog can be
  rebuilt from Jellyfin at any time without touching household state.
- Jellyfin item ids are data, not surrogate keys. Content changes are
  detected by a canonical fingerprint over every stored content field
  (provider ids and taxonomies sorted, people in billing order,
  `source_revision`/ETag excluded), so re-syncing unchanged content updates
  nothing but freshness.

## Environment

| Variable | Meaning |
|---|---|
| `MEDIA_CATALOG_DATABASE_URL` | Catalog database, sync role. **Required.** Blank = catalog sync refuses to run; there is deliberately no fallback to `DATABASE_URL` (the household database must never receive catalog writes). |
| `MEDIA_CATALOG_MIGRATE_URL` | Catalog owner/migrator role for `catalog:migrate`; falls back to the sync URL. |
| `MEDIA_CATALOG_APP_ROLE` | Explicit sync role name for migration grants; defaults to the sync URL user. |
| `MEDIA_CATALOG_RETIREMENT_DAYS` | 1–3650, default 30. How long an item stays missing before a full scan retires it. |
| `JELLYFIN_URL` + `JELLYFIN_API_KEY` | Jellyfin base URL and a server-scoped API key. The key never enters a URL, the database, or logs. |
| `JELLYFIN_SYNC_TIMEOUT_MS` | 1000–120000, default 30000, per HTTP request. |

Invalid values are rejected (fail closed), never clamped. The catalog
database also accepts the shared `DATABASE_POOL_MAX`-style overrides through
its URL; the sync pool itself is fixed at 4 connections (batch job, not a
resident service) with a 30s statement timeout.

## Role model (least privilege)

The catalog database mirrors the reelhouse role split:

| Role | Grants | Used by |
|---|---|---|
| Catalog owner / migrator | Database owner; applies `db/migrations-catalog/` | `npm run catalog:migrate` only |
| Sync role | DML on catalog tables via the grants-baseline migration; read-only migration bookkeeping; **no DDL, no TRUNCATE** | `npm run catalog:sync` |

Because the sync role is DML-only, rebuild uses plain `DELETE` (cascading via
the schema FKs) rather than `TRUNCATE`, so every sync mode — rebuild
included — runs without elevating the role. Migration `0001` sets default
privileges so tables added by later catalog migrations inherit the grants
automatically.

Synology provisioning (human-run; workers never change production
credentials):

```sql
-- As the PostgreSQL superuser (role names may match the reelhouse ones or
-- be catalog-specific):
CREATE DATABASE media_catalog OWNER reelhouse_owner;
GRANT CONNECT ON DATABASE media_catalog TO reelhouse_app;
```

## Sync modes

| Mode | Reads | Retirement | Use |
|---|---|---|---|
| `incremental` (default) | Per-library `MinDateLastSaved` cursor; only changed items | never | the routine job |
| `full` | Everything, kind pass per library | marks missing, retires past threshold | daily/weekly, or before relying on retirement |
| `rebuild` | Wipes catalog content first (scan history kept), then a full scan | yes | recovery from corruption or operator request |

Each library is consumed in three passes — roots (`Series`, `Movie`), then
`Season`, then `Episode` — so a parent row always exists before a child is
written. Pages are bounded (500 items/page, 100 pages/library, 50,000
items/library hard cap that fails the scan rather than truncating silently)
and each page commits in its own transaction: a crashed scan keeps completed
pages, and reruns are idempotent.

## Quarantine — ambiguity never merges

Identities the engine cannot resolve are quarantined with their verbatim
mapped payload, never written, never merged:

| Reason | Meaning |
|---|---|
| `duplicate_provider_id` | Another item already holds this (provider, id) — first writer wins, the challenger quarantines |
| `duplicate_external_id` | The same Jellyfin id appeared twice in one run |
| `orphan_parent` | Child whose series/season does not exist yet |
| `invalid_item` | Payload failed mapping (e.g. no name) |
| `library_conflict` | The same external id was offered by a different library |

Orphans and identity disputes self-heal: once the source stops being
ambiguous, the next successful sighting writes the item and auto-closes its
open quarantine records. `catalog_quarantine` is the audit trail; a later
job may add manual repair tooling.

## Retirement — non-destructive

Items absent from a **full** scan are marked `missing_since`; once missing
longer than `MEDIA_CATALOG_RETIREMENT_DAYS`, they get `retired_at`. Retired
rows are hidden state, not deletions — a reappearing item is restored in
place (flags cleared, same row). Incremental scans never retire, so a
Jellyfin outage cannot age out the catalog. Libraries follow the same
machine.

## Operational runbook

```bash
npm install

# 1. Provision the schema (once per catalog database):
export MEDIA_CATALOG_MIGRATE_URL="postgresql://reelhouse_owner:...@YOUR-NAS-IP:5432/media_catalog"
export MEDIA_CATALOG_DATABASE_URL="postgresql://reelhouse_app:...@YOUR-NAS-IP:5432/media_catalog"
npm run catalog:migrate

# 2. First import (or recovery):
JELLYFIN_URL="http://YOUR-NAS-IP:8096" JELLYFIN_API_KEY="..." npm run catalog:sync:full

# 3. Routine schedule (e.g. hourly):
npm run catalog:sync

# 4. Weekly deep pass (picks up deletions/retirement):
npm run catalog:sync:full
```

Diagnostics:

```sql
-- Freshness and last outcome:
SELECT mode, status, started_at, items_upserted, items_quarantined, error
  FROM catalog_scan ORDER BY started_at DESC LIMIT 5;
-- Open ambiguities:
SELECT external_id, reason, detail, first_detected_at
  FROM catalog_quarantine WHERE resolved_at IS NULL;
-- Sync cursor/health:
SELECT * FROM catalog_sync_state WHERE job = 'jellyfin_catalog';
```

Failure behavior: every failure exits 1 with a redacted, bounded message;
the failed scan is recorded in `catalog_scan` (status `failed`, bounded
error, counts so far) and `catalog_sync_state.last_error`. Completed pages
stay committed. There is no retry loop — schedule the next run; it resumes
from the cursor.

## Verification (disposable, no real credentials)

```bash
npm test          # hermetic: config, mapping/fingerprint, HTTP client (fake fetch)
docker compose -f docker-compose.dev-db.yml up -d
export REELHOUSE_TEST_MIGRATE_URL="postgresql://reelhouse_owner:reelhouse_owner_dev@127.0.0.1:5433/reelhouse"
export REELHOUSE_TEST_DATABASE_URL="postgresql://reelhouse_app:reelhouse_app_dev@127.0.0.1:5433/reelhouse"
npm run test:int  # provisions its own reelhouse_rh0026_catalog database; fixture Jellyfin
docker compose -f docker-compose.dev-db.yml down -v
```

The integration suite covers: migration apply/idempotence, least-privilege
role evidence (DML yes; DDL, TRUNCATE, and bookkeeping writes no), schema
preflight fail-closed, full-sync normalization (movies/series/seasons/
episodes, path/container/size file facts, genres/studios/people/provider
ids), idempotent repeats, changed-content upserts, incremental cursor
behavior, the two-phase retirement machine with restoration, all quarantine
reasons with auto-resolution, pagination, rebuild identity turnover, and
failure/redaction/recovery.
