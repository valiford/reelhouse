# ReelHouse Schema Migrations (RH-0003)

How the `reelhouse` PostgreSQL 18 database schema is defined, applied, and
recovered. The migration system is **forward-only**: schema history is
append-only and verifiable, never rewritten.

> The separate `media_catalog` database uses the same runner with its own
> history (`db/migrations-catalog/`, `npm run catalog:migrate`); see
> [CATALOG_SYNC.md](CATALOG_SYNC.md).

## Layout

```
db/migrations/0001_updated_at_trigger.sql
db/migrations/0002_household_profiles_and_preferences.sql
...
scripts/db-migrate.ts          CLI entry point
src/lib/db/migrator.ts         runner core (also used by tests)
```

Files are named `NNNN_lowercase_snake_title.sql`, versions are contiguous,
and files apply in strict version order.

## Applying migrations

```bash
export DATABASE_URL=postgresql://<owner-role>:<password>@<host>:5432/reelhouse
npm run db:migrate              # apply pending migrations
npm run db:migrate:dry-run      # print the plan without changing anything
```

- `MIGRATION_DATABASE_URL` may override `DATABASE_URL` for the runner so
  operators can target a disposable database without touching the app's URL.
- The URL is never printed; the runner fails closed when it is missing.
- `npm run db:smoke` runs migrations as part of the full end-to-end check —
  see [DB_SMOKE.md](DB_SMOKE.md) before pointing it at a new environment.
- PostgreSQL **18+ is enforced** (`SHOW server_version`): the schema uses
  native `uuidv7()` and refuses to run on older servers.
- Runs hold a session advisory lock (key `726101000726101`), so two runners
  serialize; each migration applies at most once.
- Each migration runs in **one transaction together with its
  `schema_migrations` row**: a failed migration rolls back completely and
  records nothing.
- Each migration file is checksummed (SHA-256 over LF-normalized content;
  `.gitattributes` pins `db/migrations/*.sql` to LF) and the checksum is
  recorded at apply time.

## The bookkeeping table

`schema_migrations` lives in the `public` schema next to the domain tables
and is owned by the runner (created on first run, not by a migration file):

| column | meaning |
|---|---|
| `name` | migration file name (primary key) |
| `checksum` | SHA-256 of the file content at apply time |
| `applied_at` | when it committed |
| `execution_ms` | apply duration |
| `pg_version` | `SHOW server_version` of the applying server |

## History verification (refuses mutated history)

Before every run the runner compares recorded history with the local
`db/migrations/` tree and **refuses to proceed** when any of these hold:

1. An applied migration's file is missing locally (history hole).
2. An applied migration's local checksum differs from the recorded one
   (edited history).
3. A local file carries a version at or below the newest applied version but
   has no recorded history (renamed or rewritten old migration).
4. Local versions are non-contiguous or duplicated, or a file name is
   malformed (the tree is not deterministic).

There is no override flag. When verification fails, the resolution is a
decision, not a workaround: restore the file to its recorded content, or —
if the change is genuinely intended — write a **new forward migration** and
follow the recovery procedure below.

## Schema conventions

- **Identity:** every table keys on `uuid` defaults of PostgreSQL 18's
  native `uuidv7()` (time-ordered, index-friendly). Application code may
  supply its own UUIDs. Nothing derives from Jellyfin's internal row ids.
- **External media identity:** `media_item_ref` is the only bridge to
  externally-sourced media — `(source, external_id)` with `source`
  constrained to known authorities (`'jellyfin'` today). All ReelHouse-owned
  state references `media_item_ref.id`, so external ids stay remappable.
- **No credentials in the database:** Jellyfin access tokens and PostgreSQL
  credentials are never stored in schema tables.
- **Enums:** `text` + `CHECK` constraints, not `CREATE TYPE` enums; domains
  grow via new migrations.
- **Timestamps:** `timestamptz` everywhere; mutable tables carry
  `created_at`/`updated_at` with `updated_at` maintained by trigger
  (migration 0001).
- **Deletion semantics:** household-owned rows cascade with their owner
  (deleting a profile removes its favorites, watchlists, watch state);
  household-shared artifacts survive with provenance nulled
  (`collection.created_by_profile_id`).
- **Ordering:** list positions (`position integer > 0`) are allowed to have
  gaps so splicing doesn't rewrite rows; readers order by
  `(position, added_at, id)`.

## Roles and privileges

Migrations need DDL rights (schema/table ownership). The application runtime
role (RH-0002's pool) needs only DML on the domain tables plus
`SELECT` on `schema_migrations`. Running the app under the migration/owner
role is supported but not required; RH-0006 owns least-privilege tightening.

## Rollback / recovery

There are **no down migrations**, by design: reverse DDL is unreliable and
would silently destroy data. Recovery paths, in order of preference:

1. **Failed apply:** nothing to recover. A migration that errors rolls back
   its whole transaction and records nothing; the database is exactly as
   before the run.
2. **Bad committed migration (forward fix):** write a new `NNNN_*.sql` that
   corrects the schema (add/drop/alter). Never edit or delete the old file —
   history verification would refuse to run and any override would desync
   existing databases.
3. **Restore from backup:** take a pre-migration backup before applying
   migrations to any non-disposable database:
   `pg_dump -Fc -d "$DATABASE_URL" -f reelhouse-pre-NNNN.dump`.
   Restore with `pg_restore --clean --if-exists -d "$DATABASE_URL" file.dump`
   (requires exclusive access; stop the app first). The full
   backup/restore/disaster-recovery runbook for the `reelhouse` database is
   RH-0007's deliverable; this section defines the migration-relevant
   minimum.
4. **Checksum refusal investigation:** when verification reports a mutated
   file, compare `checksum` in `schema_migrations` against
   `sha256sum` of the local file (LF-normalized). If the local edit was
   unintentional, restore the file from Git (`git checkout -- <file>`).
   If the database's recorded checksum itself is wrong (e.g. manually
   tampered table), treat it as drift: restore the table from backup or
   rebuild the schema on a fresh database and re-point the app — never
   UPDATE `schema_migrations` by hand.

## Local testing

```bash
npm run test:db:up     # disposable PostgreSQL 18 on 127.0.0.1:55433 (tmpfs)
npm test               # pure unit tests (no database needed)
npm run test:db        # apply-from-empty, repeat-run, constraints,
                       # mutated-history refusal, concurrent runs
npm run test:db:down   # discard the disposable database
```

The integration suite destructively resets the `public` schema of its target
database (`DROP SCHEMA public CASCADE`) — it must only ever be pointed at a
disposable database, never at the Synology production target.
