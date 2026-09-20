# Backup, restore, and disaster recovery (RH-0021)

How ReelHouse backups are taken, verified, and turned into recovery. Scope:
the two ReelHouse-owned PostgreSQL 18 databases — household-owned
`reelhouse` state and rebuildable `media_catalog` — plus the runbook that
ties them to the Jellyfin resync. Not in scope: Jellyfin's own data (it is
the playback/library authority and is never backed up, modified, or read at
the database level by ReelHouse) and the connection layer itself
([DATABASE.md](DATABASE.md)).

## The two databases get different treatment

| | `reelhouse` | `media_catalog` |
|---|---|---|
| Owns | Household state: profiles, preferences, watch state, favorites, watchlists, collections, home rows, Jellyfin links | Normalized catalog mirrored from Jellyfin |
| Authority | **ReelHouse itself — this data exists nowhere else.** A backup is the only recovery | **Jellyfin, through the sync.** A backup is an optimization; the rebuild is the recovery |
| Restore policy | Restore from the newest verified backup | Prefer `catalog:migrate` + `catalog:rebuild` (full Jellyfin resync); restore a backup only when the sync cannot rebuild (e.g. Jellyfin library metadata changed or the NAS is gone) |

This split is why the backup layout keeps the two databases in separate
directories with separate manifests: a `media_catalog` backup past its
freshness bound is disposable, a `reelhouse` backup past its freshness bound
is a problem.

## What a backup looks like

One backup is one directory, produced by `npm run db:backup`:

```
<out>/
  manifest.json              versioned, self-describing inventory
  manifest.json.sha256       manifest checksum sidecar (tamper evidence)
  reelhouse/01-household_profile.jsonl
  reelhouse/…                one canonical JSONL file per table, PK-ordered
  media_catalog/01-catalog_library.jsonl
  media_catalog/…
```

- **Canonical JSONL**: every row is one line of canonical JSON (dates as UTC
  ISO strings, `jsonb` key-sorted, keys sorted recursively), so a table's
  content has exactly one byte representation. `bigint` values stay strings
  and round-trip exactly.
- **Checksums**: each table's `sha256` is computed over its canonical lines
  in primary-key order — with text keys pinned to `COLLATE "C"`, so the same
  backup verifies identically on the NAS and on a laptop.
- **Manifest**: per-database server version, migration history (name +
  checksum from `schema_migrations`), per-table row counts/checksums/column
  lists, and freshness markers: newest `updated_at` overall, and — for the
  catalog — the last successful scan time.
- The backup is read-only against the sources and never contacts Jellyfin.

## Commands

```bash
npm run db:backup -- --out <dir> [--only reelhouse|media_catalog]
npm run db:restore-verify -- --from <dir> --offline          # files only, no database
npm run db:restore-verify -- --from <dir> [--only …]         # the full proof
```

Configuration is environment-only, like every other ReelHouse database
tool:

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | `reelhouse` backup source |
| `MEDIA_CATALOG_DATABASE_URL` | `media_catalog` backup source |
| `RESTORE_VERIFY_DATABASE_URL` | Disposable scratch database for restore verification — its name **must** match `rh_restore_[a-z0-9_]{1,50}`; the tool drops and recreates it |
| `BACKUP_MAX_AGE_HOURS` | Freshness bound for verification (default 168 = one week, 1–8760) |

Unconfigured sources are skipped by `db:backup` (it prints that it skipped
them); `--only` naming an unconfigured source fails. Exit code 0 means the
backup or verification passed; everything else exits 1 with a bounded,
redacted message.

## Restore verification — the only backup you can trust is a restored one

`db:restore-verify` proves a backup end to end without ever touching a
production database. It needs the backup directory and a scratch URL and
nothing else:

1. **Offline** (also available as `--offline`): manifest validation against
   the table registry, manifest sidecar checksum, per-file checksums and
   line/column shape, and the freshness bound.
2. **Migration history**: the manifest's recorded migrations must equal the
   local migration tree exactly, in both directions. A backup taken by
   different code than the one verifying it is refused — that uncertainty is
   not resolvable at restore time.
3. **Scratch restore**: for each database, one scratch database
   (`rh_restore_*`) is created, migrated with the real migrator (which
   itself refuses pre-18 servers), loaded table by table in one transaction
   per table, and then **content checksums are recomputed from the restored
   database** and compared against the manifest. The scratch is dropped on
   success; on failure it is dropped too unless `--keep-on-failure` was
   given (forensics — drop it manually when done).

A passing verification therefore proves the files, the manifest, the local
migration tree, the migrator, and the load path in one shot. Duplicate or
corrupt rows fail the load inside its transaction; nothing partial is ever
committed.

Scheduling guidance: verify after every backup and re-verify the newest
backup on a weekly cadence — a backup that has never been restored is a
hope, not a recovery.

## Runbook — disaster scenarios

All commands run from a ReelHouse checkout matching the production
migration history. Never restore over a live database directly: restore
into the scratch, prove it, then swap.

**A. Accidental household-data loss / corruption in `reelhouse`**

```bash
npm run db:restore-verify -- --from <newest-reelhouse-backup> --only reelhouse
# stop the ReelHouse container (the operator; tooling never restarts production)
# drop/recreate the reelhouse database as the owner role, then:
MIGRATION_DATABASE_URL=<owner-url> npm run db:migrate
# reload the verified data (psql \copy or the same loader path), then:
DATABASE_URL=<app-url> npm start   # GET /api/health -> reachable
```

**B. Catalog corruption or empty `media_catalog` (preferred: resync)**

```bash
# the catalog is rebuildable — recover from the authority, not the backup:
CATALOG_MIGRATION_DATABASE_URL=<owner-url> npm run catalog:migrate
MEDIA_CATALOG_DATABASE_URL=<app-url> JELLYFIN_URL=… JELLYFIN_API_KEY=… \
  npm run catalog:rebuild
```

Only if Jellyfin's library metadata is also gone/changed beyond recognition,
restore `media_catalog` from its newest verified backup the same way as (A)
— and note that a restored catalog is still just a cache: the next full
scan re-converges it.

**C. Full NAS loss**

1. Provision PostgreSQL 18, roles, and both databases per
   [DATABASE.md](DATABASE.md) and [CATALOG_SYNC.md](CATALOG_SYNC.md).
2. Restore `reelhouse` from the newest verified backup (scenario A).
3. Recreate `media_catalog` via resync (scenario B) — no catalog backup
   needed if Jellyfin's library survived.

**Freshness rules of thumb**

- `BACKUP_MAX_AGE_HOURS` fails verification beyond one week by default;
  tighten it if household activity is high.
- For the catalog, compare `freshness.lastSuccessfulScanAt` in the manifest
  with the sync schedule in [CATALOG_SYNC.md](CATALOG_SYNC.md): a backup
  older than the last successful full scan is not worth restoring — resync
  instead.

## Safety model

- Backups are read-only against sources; verification never contacts any
  database named by `DATABASE_URL`/`MEDIA_CATALOG_DATABASE_URL` — only the
  `rh_restore_*` scratch, whose name is pinned so a stray variable can never
  point the tool at a real database.
- Output directories must be new or empty; existing backups are never
  overwritten.
- No credentials in files: the manifest stores a redacted host/database
  label, never a URL with secrets, and every failure message is redacted
  and bounded (2000 characters) before it leaves the tool.
- Jellyfin is never contacted by backup or restore tooling; the resync in
  scenario B goes through the ordinary sync CLI, which only reads the
  Jellyfin API.
- The `reelhouse` database is never written by catalog tooling and vice
  versa; each scratch lifecycle carries exactly one database's schema.

## Verification

```bash
npm run test:db:up                                     # disposable PostgreSQL 18
npm test                                               # unit (registry, manifest, staleness, diffing)
npm run test:db                                        # all suites incl. src/lib/backup/backup.int.test.ts
npm run test:db:down                                   # discard the disposable database
```

The backup integration suite covers: manifest/sidecar/file structure,
byte-for-byte determinism of two snapshots over unchanged content, empty
databases, refusal to overwrite non-empty output, end-to-end scratch
restore with checksum proof and drop, tampered data files and edited
manifests (offline failure, no database contact), stale backups (fail
closed before scratch creation), forged self-consistent duplicates (load
rolls back, fail closed), migration drift in both directions, the scratch
naming guard, keep-on-failure/keep-on-success scratch semantics, and a DR
drill that wipes a restored catalog and rebuilds it from a fixture Jellyfin
through the real sync engine.
