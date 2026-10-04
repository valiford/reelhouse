# RH-0037 — PostgreSQL backup restore catalog rebuild and disaster-recovery acceptance — Worker Report

**Date:** 2026-09-23 (claimed ~4:30 PM EDT, inside the 11:00–21:00 America/New_York window)
**Branch:** `rh-0037-postgresql-backup-restore-catalog-rebuild-and-disaster-recovery-acceptance` (worktree `reelhouse-rh-0037`, stacked on the wave chain at `2e75b0d` — the `rh-0036` tip, whose history carries rh-0030→0034; rebase onto the squash-merge successors if any land, no force-push)
**Status:** REVIEW — not merged, nothing deployed, no production credentials touched, no Synology contact, Jellyfin's internal database untouched (the only Jellyfin access in the whole job is the read-only API surface of the rebuild).

## What was delivered

The recovery story, split the way the data actually splits:

- **Durable vs rebuildable, stated by the schema.**
  `db/migrations/0010_disaster_recovery_ledgers.sql` adds three append-only
  run ledgers in the `media_sync_runs` house style (running →
  succeeded/failed with a finished-at parity CHECK; default privileges from
  0001 give the least-privilege app role DML; no extra grants):
  `dr_backup_runs` (artifact path, **two** SHA-256 checksums, byte size,
  bounded row counts), `dr_restore_runs` (dry-run flag, computed vs expected
  checksums, ledger binding, `checksum_verified`, import counters), and
  `dr_rebuild_runs` (bound to the `media_sync_runs` row the resync produced,
  post-rebuild counts, verification verdict). The success-side CHECKs are
  deliberately one-sided (`status <> 'succeeded' OR …`): a failed run may
  carry partial evidence — e.g. a failed rebuild still records the sync run
  it attempted — without tripping a parity form that forbids it (the
  two-sided form was tried and rejected: it silently left failed rebuild rows
  `running`; the integration suite caught it).
- **`src/lib/dr/artifact.ts`** — pure artifact format, hermetically tested:
  JSON envelope (exact key set, version 1, kind/scope pinned) around the
  household manifest in its **input shape**, with an embedded manifest
  SHA-256 over the snapshot's exact serialization. Any edit — including a
  re-serialization that reorders members — breaks it; an internally
  re-stamped edit is *by design not catchable at this layer*, which is
  exactly why real restores require an external binding (ledger row or
  operator-recorded file checksum).
- **`src/lib/dr/backup.ts`** — household capture: one deterministic read
  pass over the ACTIVE household (archived/tombstoned state is not part of
  the live household), canonical UTC stamps, ordering pinned by
  slug/position/id, so an unchanged household backs up to byte-identical
  artifact content. The capture validates its own output through the
  household manifest contract *before* anything is written, refuses an empty
  household (a backup the import could never load is not a backup), and the
  artifact sink is invoked only after capture+validation+serialization
  succeeded. Provenance-preserving by construction: the payload carries the
  `first_added_at`/`first_played_at` stamps the loader pins, so
  **capture → restore → capture reproduces the identical manifest** (pinned
  by the suite on a fresh database).
- **`src/lib/dr/restore.ts`** — verification ladder (file checksum vs
  `--sha256` → envelope + embedded checksum → ledger binding vs
  `--run-id` → full manifest contract) and then **the real household import,
  not a second write path**. A real restore MUST be bound to evidence
  (`--run-id` or `--sha256`); unbound restores are refused. `--dry-run`
  verifies everything and then replays the full import inside one
  transaction that is rolled back — including the import's own run
  bookkeeping, which lives outside its mutation transaction and forced the
  dry-run wrapper to wrap the whole import rather than just the mutation.
  Every failure after the run row exists is recorded on it, bounded and
  scrubbed.
- **`src/lib/dr/rebuild.ts`** — the catalog's recovery path is **the real
  full sync** wrapped in evidence: one `dr_rebuild_runs` row per attempt,
  bound to the `media_sync_runs` row on success, and verified before it
  reports success (every library the source reported must be present and
  active afterwards — a full reconciliation tombstones unreported libraries,
  so a mismatch means the rebuild did not converge). Jellyfin is only ever
  read; the source surface is read-only by construction — recovery without
  media deletion is structural, not a promise.
- **`src/lib/dr/status.ts`** — `dr status` derives recoverability from the
  databases alone: catalog/household freshness (the read models' windows),
  backup age (7d window) versus the newest **succeeded** backup, and whether
  recovery has ever been rehearsed. The verdict rules are a pure function
  (`drVerdicts`), unit-tested without clock or database: empty list = clean,
  every entry names one operator action.
- **`scripts/dr.ts`** (`npm run dr`) — `backup | restore | rebuild | status`,
  workbench-style strict flag parsing, fail-closed env handling, scrubbed
  output, exit codes that match the ledger.
- Docs: `docs/DISASTER_RECOVERY.md` (authorities model, per-command
  procedures, checksum discipline — record both checksums OUTSIDE the
  database, because the ledger dies with the database — stale-data verdict
  table, RTO/RPO notes), README section, migration 0010 entry in
  `docs/DATABASE.md`, `.env.example` (`DR_BACKUP_DIR`, `DR_RESTORE_FILE`),
  `.gitignore` (`var/` — backup artifacts are operator-local).
- `package.json` — `dr` script; two hermetic suites in `test`, the
  integration suite in `test:int`.

## Design decisions worth review

- **No catalog backup file, on principle.** A backup of a mirror is a stale
  mirror; the catalog's recovery is the live resync. `dr_backup_runs.scope`
  is a single-value CHECK (`household`) that documents the boundary rather
  than a door left open.
- **A dry run is a verification, not a rehearsal.** `dr status` keeps
  flagging `restore_only_dry_run` even after a successful dry run, because
  "the import replays and rolls back cleanly" is not "we have restored for
  real". `restore_never_rehearsed` and `catalog_rebuild_never_rehearsed`
  stay on the verdict list until the real operations succeed.
- **Input shape in the artifact, normalized shape in the import.** The
  household manifest's preferences are an object on input and keyed pairs on
  output; the artifact stores the input shape (what a restore can load
  again) and the restore imports `normalizeManifest`'s output. The unit
  suite caught the first draft storing the wrong shape — an artifact no
  restore could load.
- **Two checksums, two questions.** The embedded manifest checksum survives
  an operator reformatting the file and pins snapshot content; the file
  checksum pins the bytes. A tamperer who re-stamps the embedded checksum
  produces an internally honest artifact — that is the case the mandatory
  external binding exists for, and the unit suite documents exactly that
  boundary instead of pretending one checksum layer could catch everything.
- **Stacking on the wave chain** (`2e75b0d`): the ledgers FK-reference
  `media_sync_runs` and the recovery paths drive the real sync/import
  runners — none of which is on `main` yet. Same rebase-on-squash-merge
  contract as rh-0036.

## Verification evidence

All commands run in `reelhouse-rh-0037` against the disposable loopback
PG18 profile (`docker-compose.dev-db.yml`, `127.0.0.1:5433`) — never
Synology; the "Jellyfin" was the deterministic stub
(`scripts/dev/jellyfin-stub.mjs`).

**Contracts green:**

- `npm run lint` — clean (0 errors, 0 warnings).
- `npm run typecheck` — clean.
- `npm run build` — production build succeeds.
- `npm test` — 158/158 hermetic (includes 10 new DR unit tests: artifact
  envelope/checksum/tamper matrix, verdict rules).
- `npm run test:int` with `REELHOUSE_TEST_MIGRATE_URL` /
  `REELHOUSE_TEST_DATABASE_URL` — 66/66 (8 new DR integration tests), run
  twice: standalone and as the full parallel suite (which caught and fixed a
  shared-database race in the first draft of the ledger-contract test; the
  suite now touches only its own temporary databases).

**Integration suite scenarios (deterministic, success AND failure/recovery):**
migration 0010 ledger contracts under the app role (status/finished parity,
closed scopes/modes, artifact/SHA-256 formats, checksum-verified gating);
backup checksum evidence + byte-identical idempotent recapture + artifact
content round-trip; the restore failure matrix — tampered bytes vs recorded
checksum, corrupt envelope with stale embedded checksum, unbound real
restore, dangling `--run-id`, ledger binding against different bytes, and a
zero-profile artifact refused by the import's own guard — each failing
closed with a recorded run row and the household provably untouched, each
followed by clean recovery; a dry run persisting nothing; capture → restore
→ capture identity on a fresh database plus a zero-write idempotent second
restore; rebuild convergence from empty (verified, bound to its sync run),
source-failure recording (rebuild row + the sync's own failed run row) and
recovery, idempotent in-place resync; and `dr status` from the full
greenfield verdict set → clean → stale catalog/household/backup verdicts.

**Live CLI pass** (dev profile, stub on 127.0.0.1:8097, seeded via the real
`catalog:sync` [2 libraries, 8 items] and real `household:import`
[2 profiles, 43 rows]):

- `dr status` — fresh data, 3 verdicts: `household_backup_missing`,
  `restore_never_rehearsed`, `catalog_rebuild_never_rehearsed`.
- `dr backup --out var/backups` — run #1, 43 rows, artifact sha256
  `c0015ee3…`, manifest sha256 `0ee26b3f…`, counts printed.
- `dr restore --file … --sha256 … --dry-run` — verified, nothing written
  (run #1).
- Unbound real restore — refused, exit 1, recorded as failed (run #2):
  "refusing to import an unbound artifact…".
- Tampered copy (`isDefault` flipped) + recorded `--sha256` — refused, exit
  1, recorded (run #3): "artifact bytes do not match the expected
  checksum…".
- Ledger-bound real restore (`--run-id 1`) — succeeded, exit 0, **0 writes**
  (the loader's idempotence over identical state).
- `dr rebuild` — run #1 (sync run #2) verified: libraries=2 items=8
  changes=0 in 926ms (no spurious change history over an unchanged source).
- `dr status` — catalog/household/backup all `fresh`, **verdicts: []**
  ("clean").
