# Jellyfin → media_catalog synchronization (RH-0016)

How the `media_catalog` database is defined, populated, and operated. The
catalog is a **separate PostgreSQL 18 database** on the same Synology
service as the `reelhouse` database (see
[ARCHITECTURE.md](ARCHITECTURE.md)): `reelhouse` owns household state,
`media_catalog` owns normalized catalog data mirrored from Jellyfin.
Nothing in the sync ever couples to Jellyfin's internal database —
the sync reads the supported Jellyfin API only and never writes to
Jellyfin.

## Layout

| Path | Role |
|---|---|
| `db/migrations-catalog/0001–0003` | Catalog schema: libraries, items, provider ids, taxonomies, scan history, sync state, quarantine |
| `src/lib/catalog/config.ts` | Pure parse/validate for `MEDIA_CATALOG_DATABASE_URL`, Jellyfin sync credentials, retirement policy |
| `src/lib/catalog/model.ts` | Jellyfin payload → normalized model + the content fingerprint (pure) |
| `src/lib/catalog/jellyfin-client.ts` | Bounded Jellyfin API client (injectable for fixtures) |
| `src/lib/catalog/sync.ts` | The engine: pass-ordered scan, idempotent upserts, retirement, quarantine, rebuild |
| `scripts/catalog-migrate.ts` | Catalog migration CLI (`npm run catalog:migrate`) |
| `scripts/catalog-sync.ts` | Sync CLI (`npm run catalog:sync` / `:full` / `:rebuild`) |
| `src/lib/catalog/catalog.int.test.ts` | Fixture-backed integration suite against the disposable PG18 |

## Configuration

Everything is environment-driven; blank credentials mean the feature is
unavailable, never a silent degradation.

| Variable | Meaning |
|---|---|
| `MEDIA_CATALOG_DATABASE_URL` | Catalog database target (`postgres://`/`postgresql://`, same URL semantics as `DATABASE_URL` incl. `sslmode`) |
| `MEDIA_CATALOG_DATABASE_SSL` | Optional SSL fallback like `DATABASE_SSL` |
| `MEDIA_CATALOG_RETIREMENT_DAYS` | Days absent from full scans before retirement (default 30, 1–3650) |
| `JELLYFIN_URL`, `JELLYFIN_API_KEY` | Read-only API access with a server-scoped API key (never a user token; never stored in the database) |
| `JELLYFIN_SYNC_TIMEOUT_MS` | Optional per-request bound (default 30000, 1000–120000) |
| `CATALOG_MIGRATION_DATABASE_URL` | Optional owner-role override for migrations, mirroring `MIGRATION_DATABASE_URL` |

The URL is never logged: errors pass through the same redaction helpers
as the reelhouse connection layer, and failure details stored in
`catalog_scan.error` / `catalog_sync_state.last_error` are additionally
truncated to 2000 characters.

## Identity, provenance, freshness

- **Identity is `(source, external_id)`** — the Jellyfin item id is data,
  never identity. It is exactly the pair `reelhouse.media_item_ref` stores,
  which is how household state will link to catalog rows across the
  database boundary (no cross-database foreign keys, by design).
- `observed_at` = first sighting (never moves); `last_seen_at` = latest
  sighting; `source_revision` = the Jellyfin ETag (fallback
  `DateLastSaved`) captured at the last content change.
- `content_hash` is a canonical SHA-256 over every stored content field
  (taxonomies sorted, people in billing order, ETag excluded). A scan
  that sees identical content updates **only** `last_seen_at` — that is
  what makes repeated syncs a no-op.
- `catalog_scan` records every run: mode, status, bounded counts, bounded
  redacted error. It is the freshness/audit surface and survives rebuilds.

## Scan model

A library is consumed in **kind passes** — roots (series + movies), then
seasons, then episodes — so a parent row always exists before a child is
written, with no buffering or guessing. Pagination (500/page) and
library size (50,000 items) are hard caps: exceeding them fails the scan
with a bounded message instead of silently truncating the catalog.
Writes commit **one transaction per page**: a failed page commits
nothing, succeeded pages stay committed, and any rerun is idempotent.

| Mode | Behavior |
|---|---|
| `incremental` (default) | Per-library `MinDateLastSaved` cursor from the previous successful scan; touches only changed items; **never retires** |
| `full` | Reads everything; sightings refresh freshness; computes missing/retirement |
| `rebuild` | Wipes catalog content (rows, taxonomies, quarantine, cursor) in the catalog database only, then a full scan; scan history is kept |

A first incremental run with no recorded cursor behaves as a sighting
pass without retirement, so it is safe before the first full scan.

## Retirement policy (non-destructive)

Items (and libraries) that stop appearing in **full** scans are first
marked `missing_since`; once they have been missing longer than
`MEDIA_CATALOG_RETIREMENT_DAYS`, they are marked `retired_at`. Rows are
never deleted by the sync, and a missing or retired item that reappears
is restored in place. Deletions only ever become visible through full
scans — schedule them (see "Suggested schedule").

Readers filter retirement with `retired_at IS NULL` (and
`missing_since IS NULL` for strictly healthy rows); nothing is hidden
irreversibly.

## Ambiguity is quarantined, never merged

`catalog_quarantine` records identities the sync refuses to guess about,
with the verbatim payload snapshot for resolution:

| Reason | Meaning |
|---|---|
| `duplicate_provider_id` | Another item already holds that provider id (first writer wins; the challenger is not written) |
| `duplicate_external_id` | The same id appeared twice in one run/payload |
| `library_conflict` | A second library claims an item another library owns |
| `orphan_parent` | A season/episode whose parent row does not exist |
| `invalid_item` | Payload present but not representable (e.g. no name) |

When the upstream ambiguity is fixed, the next successful sync of the
item sets `resolved_at` automatically — no manual cleanup. Open records
are the sync's answer to "why is this item missing from my catalog?":
check `SELECT external_id, reason, detail FROM catalog_quarantine WHERE resolved_at IS NULL;`

## Roles (least privilege)

Mirroring the reelhouse two-role model: an owner role applies migrations
(`catalog:migrate` with `CATALOG_MIGRATION_DATABASE_URL`), and a runtime
role carries only DML on the catalog tables. Provision on the Synology
service:

```sql
CREATE ROLE catalog_owner LOGIN PASSWORD '...';   -- migrate-time only
CREATE ROLE catalog_app LOGIN PASSWORD '...';     -- sync runtime
GRANT CONNECT ON DATABASE media_catalog TO catalog_app;
-- as catalog_owner, after `npm run catalog:migrate`:
GRANT USAGE ON SCHEMA public TO catalog_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO catalog_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO catalog_app;
```

The migration runner itself refuses servers older than PostgreSQL 18.

## Commands

```bash
npm run catalog:migrate          # apply pending catalog migrations
npm run catalog:migrate:dry-run  # print the plan, change nothing
npm run catalog:sync             # incremental scan
npm run catalog:sync:full        # full scan (computes retirement)
npm run catalog:rebuild          # wipe catalog content, then full scan
```

Exit code 0 only for a successful scan; every failure path is bounded,
redacted, and recorded in `catalog_scan`. Rebuilding **never touches
Jellyfin** and never touches the `reelhouse` database — the catalog is
reconstructible from the source of truth at any time.

## Suggested schedule

Nightly incremental scan; weekly full scan (retirement, deletions);
rebuild only for disaster recovery or after restoring an empty
`media_catalog` database. The backup/restore and DR runbook that consumes
these commands lives in [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

## Verification

```bash
npm run test:db:up                                     # disposable PostgreSQL 18
npm test                                               # unit (incl. mapping/fingerprint/client)
npm run test:db                                        # migration + smoke + catalog integration suites
npm run test:db:down                                   # discard the disposable database
```

The catalog integration suite drives `reelhouse_catalog_test` inside the
disposable container with a fixture Jellyfin client (no network) and
covers create / update / no-change / missing / retire / restore /
duplicate-provider / orphan / library-conflict / duplicate-payload /
incremental cursor / rebuild / failed-scan recovery / fail-closed
configuration, plus direct schema-guard checks. Nothing in this suite
can reach a real Jellyfin server or the production Synology target.
