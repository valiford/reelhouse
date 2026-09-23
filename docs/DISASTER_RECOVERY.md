# Disaster recovery — backup, restore, rebuild, and staleness (RH-0037)

How ReelHouse recovers. The design rests on one distinction:

| State | Kind | Lives in | Recovery |
|---|---|---|---|
| `household_*` | **Durable** — exists nowhere else | PostgreSQL only | Restore from a checksummed artifact |
| `media_catalog` (`media_*`) | **Rebuildable** — a mirror of the library | PostgreSQL (derived) | Full resync from the Jellyfin API |
| Media itself | Jellyfin's | Jellyfin (never touched) | Not ReelHouse's to recover |

Two consequences worth internalizing:

- **Recovery never deletes media.** Every DR command reads Jellyfin through
  its API or ignores it entirely; nothing writes to, deletes from, or even
  looks at Jellyfin's internal database. The worst-case DR operation rebuilds
  a mirror of what Jellyfin still serves.
- **There is no catalog backup file.** A catalog backup would be a stale copy
  of a mirror; the live source of truth is always one resync away. The DR
  ledger records rebuilds instead.

## The DR CLI (`npm run dr`)

Server-side only, like every database tool. Requires `DATABASE_URL` (the
least-privilege application role) and applied migrations (`npm run
db:migrate`). `rebuild` additionally needs `JELLYFIN_URL` +
`JELLYFIN_API_KEY`. Every echoed value is scrubbed of credentials.

```bash
npm run dr -- backup --out var/backups       # capture household state
npm run dr -- status                          # recoverability + staleness
npm run dr -- restore --file ARTIFACT --run-id N        # bound by ledger row
npm run dr -- restore --file ARTIFACT --sha256 <64-hex> # bound by runbook note
npm run dr -- restore --file ARTIFACT --dry-run         # verify only
npm run dr -- rebuild                         # full catalog resync, verified
```

Every operation appends exactly one row to its ledger — `dr_backup_runs`,
`dr_restore_runs`, or `dr_rebuild_runs` — with status, counters, and a
scrubbed error detail. Recovery claims are backed by rows, not memory.

## Backup

```bash
npm run dr -- backup --out var/backups
# dr backup succeeded — run #1: var\backups\reelhouse-household-….json
#   (4197 bytes, 43 rows)
# dr backup artifact sha256: c0015ee3…
# dr backup manifest sha256: 0ee26b3f…
```

The artifact is a JSON envelope around the complete household manifest (the
exact contract `household:import` consumes, in its input shape). Backing up
an unchanged household twice yields byte-identical snapshot content — the
manifest checksum is stable, only provenance fields move. The capture reads
ACTIVE state only (archived profiles/lists and tombstoned entries are not
part of the live household) and validates its own output through the
household manifest contract before any file is written; an empty household
refuses to back up, because a backup the import could never restore is not a
backup.

Two checksums answer two questions:

- **manifest sha256** (embedded in the envelope) — "is this the snapshot that
  was captured?" Any edit to the snapshot content, including a re-serialization
  that reorders members, breaks it. Always verified on restore.
- **artifact sha256** (over the whole file) — "are these the bytes that were
  written?" Recorded by the operator at backup time; a restore binds the file
  to it.

**Operator discipline:** after each backup, record both checksums outside the
database (the runbook note, a password manager, paper). If the database is
lost, the ledger that could vouch for the artifact is lost with it — the
recorded checksum is then the only binding left.

## Restore

A restore is the real household import — idempotent, provenance-preserving,
one transaction — wrapped in verification:

1. the artifact's embedded manifest checksum is verified (any corruption
   fails before the database is touched);
2. a **real restore must be bound to evidence**: `--run-id N` (the file must
   match the checksums recorded in `dr_backup_runs` row N) or `--sha256`
   (the file must match the operator-recorded checksum). An unbound restore
   is refused;
3. the manifest must satisfy the household contract;
4. the import runs; a second restore of the same artifact is a clean no-op.

`--dry-run` performs every verification step and then replays the full import
inside a transaction that is rolled back — including the import's own run
bookkeeping — so "what would this artifact do" is answered by doing it and
undoing it. A dry run is a verification, not a rehearsal: `dr status` keeps
flagging `restore_only_dry_run` until a real restore has succeeded.

The DR scenario has no ledger to bind to (the database is gone), which is
what `--sha256` is for:

```bash
# on the fresh database, after npm run db:migrate
npm run dr -- restore --file var/backups/reelhouse-household-….json \
  --sha256 c0015ee3fac85c74cbbf3a420c8618d86829e2bf301e1aa25c1ed4ee7fdedde2
```

Round-trip guarantee (pinned by the integration suite): capture → restore →
capture reproduces the identical manifest, byte for byte.

## Catalog rebuild

```bash
npm run dr -- rebuild
# dr rebuild succeeded — run #1 (sync run #2) verified:
#   libraries=2 items=8 changes=0 in 926ms
```

The rebuild is the real full catalog sync — the same reconciliation the
pipeline runs — wrapped in recovery evidence. It is verified before it
reports success: every library the source reported must be present and active
afterwards (a full reconciliation tombstones unreported libraries, so
anything else means the rebuild did not converge). The run row records the
`media_sync_runs` entry the resync produced, post-rebuild counts, and the
verdict.

Consequences, stated plainly:

- An in-place resync over an intact catalog rewrites what Jellyfin reports
  and appends no spurious change history (`changes=0` over an unchanged
  source); tombstones and change history survive.
- A rebuild onto a FRESH database (the disaster case: fresh `createdb` →
  `db:migrate` → `rebuild`) repopulates the catalog from scratch. Catalog
  provenance history (change rows, quarantine evidence, sync history) is
  derived and starts over; household state is NOT in that path — restore it
  from an artifact. Jellyfin item identities (`(source, jellyfin_id)`) are
  stable across rebuilds, so household item links re-resolve automatically
  on the next import.

## Stale-data detection

```bash
npm run dr -- status
```

One command answers "how recoverable is ReelHouse right now" from the
databases alone (no source contact): catalog freshness and household
freshness (same windows the client-facing status uses — 24h and 7d), the age
of the newest succeeded household backup (7d window), and whether recovery
has ever been rehearsed. The `verdicts` list is the actionable part:

| Verdict | Operator action |
|---|---|
| `catalog_never_synced` / `catalog_stale` | run `dr rebuild` |
| `household_never_imported` / `household_stale` | run `household:import` |
| `household_backup_missing` | run `dr backup`, record checksums |
| `household_backup_stale` | run `dr backup`, record checksums |
| `restore_never_rehearsed` | `dr restore --dry-run`, then a real bound restore |
| `restore_only_dry_run` | a real bound restore has never succeeded |
| `catalog_rebuild_never_rehearsed` | run `dr rebuild` against the real source |

Empty verdicts = the DR posture is clean.

## RTO / RPO notes

- **RPO (household):** the age of the newest succeeded `dr backup` — which
  is exactly what `dr status` reports and what `household_backup_stale`
  bounds. Backup cadence is an operator decision; the default verdict
  window is 7 days. Catalog RPO is 0: it rebuilds from the live source.
- **RTO (catalog):** one full resync, proportional to library size (the
  sync is batched and bounded; the CLI prints the duration). The rebuild is
  verified before it reports success, so "done" means converged.
- **RTO (household):** one artifact restore (bounded by the manifest limits;
  seconds for household-scale data) plus migration time on a fresh database.
- **Rehearsal is part of the posture:** `restore_never_rehearsed` and
  `catalog_rebuild_never_rehearsed` stay on the verdict list until a real
  restore and a real rebuild have succeeded, because an untested runbook is
  a theory.

## Verification evidence

Deterministic integration coverage (`src/lib/dr/dr.int.test.ts`, loopback
PG18, never Synology): migration 0010's ledger contracts under the
least-privilege app role; backup checksum evidence and idempotent capture;
the restore failure matrix (tampered bytes, corrupt envelope, unbound
restore, dangling ledger binding, ledger checksum mismatch, zero-profile
artifact) each failing closed with a recorded run row and a clean recovery;
a dry run persisting nothing; the capture → restore → capture round-trip
onto a fresh database; rebuild convergence, source-failure recording and
recovery, and idempotent in-place resync; and `dr status` moving from the
full greenfield verdict set to clean to stale. Hermetic unit suites pin the
artifact format and the verdict rules without a database.
