# ReelHouse disaster recovery — authorities, backup/restore, and rebuild (RH-0040)

ReelHouse state lives in two PostgreSQL authorities with opposite recovery
semantics, plus two things it must never treat as its own state:

| State | Where | Recovery semantics |
|---|---|---|
| Household state (`household_*`, migration history) | PostgreSQL `reelhouse` | **Durable.** Survives only as backups; a restore is the recovery path. |
| Media catalog (`media_*`) | PostgreSQL `reelhouse` | **Rebuildable.** A provenance-preserving mirror of the Jellyfin library; re-running a full sync rebuilds it. Restoring it is an optimization, not a requirement. |
| Media files | Synology shares, read-only mounts | ReelHouse never writes or deletes media; recovery belongs to the NAS's own backup policy. |
| Jellyfin's internal database | Jellyfin host | Never read or written by ReelHouse. Jellyfin recovers by its own means; ReelHouse re-syncs from its API afterwards. |

Clients never receive PostgreSQL credentials in any recovery path; the
database boundary stays server-side.

## Backup policy (household state is the crown jewels)

```bash
# On any machine that can reach the database (owner/migrator role):
pg_dump --format=plain --no-owner --no-privileges --schema=public \
  --dbname=reelhouse --file=reelhouse-$(date +%F).sql
# (set PGHOST/PGPORT/PGUSER/PGPASSWORD in the environment; never pass the
#  password as a command-line argument)
```

- Cadence: at least nightly, and always after a household import or any
  change to household curation (favorites, watchlists, collections, home
  rows). Household state changes rarely but is irreplaceable.
- Retention: keep 7 daily + 4 weekly copies on a different volume than the
  database (NAS share or off-NAS target).
- The catalog rides along in the same dump — free insurance that also keeps
  change history and quarantine evidence (`media_item_changes`,
  `media_item_quarantine`) for the repair workbench.

## Restore acceptance — `npm run dr:verify`

A backup that has never been restored is a hypothesis. `scripts/dr-verify.ts`
proves one restorable end-to-end:

```bash
export DATABASE_MIGRATE_URL="postgresql://reelhouse_owner:...@YOUR-NAS-IP:5432/reelhouse"
export DATABASE_RESTORE_URL="postgresql://reelhouse_owner:...@SCRATCH-HOST:5432/reelhouse_dr_check"
npm run dr:verify
```

The script refuses a non-empty scratch database, dumps the source with
`pg_dump`, restores into the scratch with `psql` (`ON_ERROR_STOP`), then
compares every ReelHouse-owned table (26, including migration bookkeeping)
by row count and an ordered row digest, failing closed on any drift. Timings
double as measured RTO inputs. Connection details travel via `PG*`
environment variables only — never argv — so nothing credential-bearing can
leak into process listings or logs.

When the PostgreSQL client tools are not on the host's `PATH` (e.g. the
server runs in a container), override the two tool commands; the database
name is appended as the final argument and the dump is piped through
stdout/stdin:

```bash
export DR_PG_DUMP_CMD="docker exec reelhouse-postgres pg_dump -U reelhouse_owner --no-owner --no-privileges --schema=public"
export DR_PSQL_CMD="docker exec -i reelhouse-postgres psql -U reelhouse_owner --set ON_ERROR_STOP=1 --quiet"
```

Run it: after setting up backups (once), after any migration lands, and as
part of the quarterly DR drill.

## Recovery procedures

### A. Database loss (the real DR scenario)

1. Provision a fresh PostgreSQL 18 instance (Synology package or container).
2. Create the roles and database as the superuser (see
   [DATABASE.md](DATABASE.md), "Role model").
3. Restore the newest backup:
   `psql --set ON_ERROR_STOP=1 --dbname reelhouse --file reelhouse-YYYY-MM-DD.sql`
   as the owner role.
4. Verify: `npm run dr:verify` with the restored database as the source and
   a scratch as the target — every table must report `ok`.
5. Point `DATABASE_URL` (app role) at the restored database and check
   `GET /api/health`: database reachable, migrations `ok`, catalog
   diagnostics present.

RPO: the backup cadence (household changes since the last dump are lost —
this is why curation changes trigger a backup). RTO: instance provisioning
+ restore time + verification; the dr:verify timings measure the restore
and verification share on the actual data size.

### B. Catalog corruption or drift (no household loss)

The catalog is rebuildable from Jellyfin at any time, without touching
media files or Jellyfin's internal database:

1. (Clean-room option) Drop and recreate the `media_*` tables by re-applying
   migrations to a fresh database, then restore only `household_*` +
   `schema_migrations` from the newest backup — or, in place, leave the
   existing tables alone: the sync reconciles them.
2. Run a full sync: `npm run catalog:sync` (Jellyfin reachable). The full
   mode re-reads every library, upserts, tombstones what vanished, and
   re-seeds the incremental watermark.
3. Confirm via `GET /api/health`: `catalog.activeItems` matches the library,
   `quarantined` shows any identity conflicts found.

Recovery never deletes media and never writes to Jellyfin: the catalog is
ReelHouse-owned mirror state, and the household authority is not involved.

### C. Stale catalog (Jellyfin moved on, reads look old)

1. Check `GET /api/health` `catalog.lastSuccessfulSyncAt` / `watermark`.
2. Run `npm run catalog:sync -- --incremental` — watermark-windowed deltas
   plus the presence sweep catch the catalog up (see
   [CATALOG.md](CATALOG.md)); a previously failed run re-covers its window
   automatically.
3. If the watermark froze on repeated failures, fix the source, then run
   again — a failed run never advanced the watermark, so nothing was missed.

### D. Jellyfin unreachable (degraded mode, not a DR event)

Jellyfin is the playback/library authority; when it is down:

- `/api/health` reports `jellyfin.unreachable` and stays 200 (database
  health governs readiness).
- The home screen keeps serving from the PostgreSQL read models
  (`source: "catalog"`): rails, search, continue-watching, and collections
  are catalog state and do not need Jellyfin at request time.
- Only the legacy paths (no database configured, or catalog not yet synced)
  fall back to the built-in demo library, and playback obviously waits for
  Jellyfin to return.

## Checks after any recovery

- `GET /api/health`: `database.state = reachable`, `migrations.state = ok`
  (no pending, no checksum conflicts), `catalog.state = ok`,
  `jellyfin` informational.
- `npm run dr:verify` against the recovered database (source) and a scratch
  (target) — all tables `ok`.
- Spot-check the living-room surface: home rails render per profile,
  `GET /api/search?q=` returns bounded results, continue-watching reflects
  household watch state.
