# RH-0021 Worker Report — PostgreSQL backup restore catalog rebuild and disaster recovery

- **Date:** 2026-09-20 (claimed 17:25 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0021-postgresql-backup-restore-catalog-rebuild-and-disaster-recovery` (pushed to origin)
- **Base:** `rh-0022-household-continue-watching-reconciliation-and-profile-isolation-guard` @ `319c308` — the backend-wave tip that carries rh-0002 (connection layer) + rh-0003 (migrator + reelhouse schema) + rh-0015 (smoke) + rh-0016 (catalog schema + Jellyfin sync engine, incl. the multi-database config parameterization) + rh-0017/0018 (household state) + rh-0022. Backup/DR needs exactly that surface: both schemas, their migrators, and the sync's rebuild path. This mirrors how rh-0020 was cut from the same tip, so rh-0021 is a sibling of rh-0020, independent of it.

## Claim

Dispatch bootstrap ran (`git fetch origin --prune`); the queue was read from
`origin/main` per protocol. `origin/main`'s copy is stale in both directions
(empty Review Queue, everything READY): the actual lease state is
branch/worktree existence, checked directly. All READY entries except two are
leased (branches at `E:/…/reelhouse-rh-NNNN`, all verified present after the
fetch): the whole backend chain (rh-0002/0003/0015/0016/0017/0018/0020/0022,
all in REVIEW on their branches) and the frontend wave (rh-0008–0014,
rh-0019, rh-0022, rh-0023 — rh-0014 has since been claimed too). The two
unleased READY jobs:

- **RH-0004** — skipped as a duplicate claim: its scope ("Jellyfin API to
  `media_catalog` synchronization with stable item identity, provenance,
  freshness, idempotent reconciliation") is fulfilled by leased **RH-0016**,
  whose spec covers the same ground and whose branch is implemented,
  reviewed-marked, and carries a verification report. Claiming RH-0004 would
  duplicate an existing lease (worker rule 2); this report re-flags it for
  controller retirement.
- **RH-0021** — the highest-priority genuinely unclaimed READY job with
  `AUTOMATION_ELIGIBLE: true` and no declared dependency → **claimed**. No
  `rh-0021*` branch, worktree, or remote branch existed; claim uncontested.

## What was built

Backup/restore/DR for the two ReelHouse-owned PostgreSQL 18 databases with
**separate treatment per data authority**, per the job spec and
docs/ARCHITECTURE.md:

- `reelhouse` — household state that exists nowhere else; a verified backup
  is the only recovery.
- `media_catalog` — normalized catalog mirrored from Jellyfin; the **full
  Jellyfin resync** (`catalog:rebuild`, RH-0016) is the recovery authority,
  and a backup is an optimization. The manifest carries
  `lastSuccessfulScanAt` so operators can act on that directly.

### 1. Pure model (`src/lib/backup/model.ts`, no I/O)

- **Table registry** for both databases — restore/checksum order is
  FK-safe (parents before children; asserted by a unit test against the
  full migration FK graph) with primary-key column lists; keyed off the
  migration file sets, so schema changes must touch it.
- **Canonical serialization** — one byte form per row (UTC ISO dates,
  recursively key-sorted objects, `undefined`→`null`), incremental
  per-table SHA-256 over PK-ordered lines. `bigint` stays text and
  round-trips exactly. Text keys are pinned to `COLLATE "C"` in ORDER BY
  and keyset comparison so checksums are reproducible across servers.
- **Manifest** build/validate (version 1): per-database server version,
  migration history (name+checksum), per-table rows/checksums/columns,
  freshness (`latestUpdatedAt`, `lastSuccessfulScanAt`), redacted URL
  label. Validation is strict against the registry: unknown databases,
  missing/renamed/reordered tables, wrong file paths, bad checksums,
  duplicate or non-identifier column names (column names become quoted
  identifiers in restore SQL), malformed timestamps — all fail.
- **Staleness** (`BACKUP_MAX_AGE_HOURS`, default 168 h, bounds 1–8760) and
  verification diffing (files vs manifest, migration sets both directions,
  restored tables vs manifest).
- **Scratch guard** — `RESTORE_VERIFY_DATABASE_URL` must name a database
  matching `rh_restore_[a-z0-9_]{1,50}`; anything else is refused before
  any connection, so a stray variable can never aim the tool at a real
  database.

### 2. Snapshot writer (`src/lib/backup/snapshot.ts`)

- Read-only against sources; PK-ordered **keyset pagination** (1 000
  rows/page, 10 000-page fail-closed cap — never a silently truncated
  backup); PK shape cross-checked against the registry from `pg_index`.
- One canonical JSONL file per table plus `manifest.json` and its
  `manifest.json.sha256` sidecar, written only after every file completes.
- Output directory must be new or empty; existing backups are never
  overwritten. Every error is redacted (URL) and bounded (2 000 chars).

### 3. Restore verification (`src/lib/backup/restore.ts`)

Three fail-closed phases; **no production database is ever contacted** —
the tool needs only the backup directory and the scratch URL:

1. Offline: manifest validation + sidecar checksum + per-file checksums
   and line/column shape + freshness bound.
2. Migration history: manifest-recorded migrations must equal the local
   tree exactly, both directions (fail-closed on "migration uncertainty",
   worker rule 10).
3. Scratch restore: per database its own disposable scratch lifecycle —
   create → real migrator (refuses pre-18 servers) → load table by table,
   one transaction per table → **content checksums recomputed from the
   restored database** and compared to the manifest → drop. The first
   failing database stops the run; `--keep-on-failure` keeps its scratch
   for forensics, `keepScratchOnSuccess` leaves the final scratch in place
   for follow-on drills. Duplicate rows/corrupt files roll back inside
   their transaction and fail the run.

### 4. CLIs (`scripts/`, env-only credentials, exit 0 only on success)

- `npm run db:backup -- --out <dir> [--only reelhouse|media_catalog]`
- `npm run db:restore-verify -- --from <dir> [--offline] [--only …]
  [--keep-on-failure]`

### 5. Docs

`docs/BACKUP_RESTORE.md` — the DR runbook: per-authority treatment table,
backup anatomy, commands/env table, verification phases, and three
scenarios (household-data loss; catalog corruption → preferred resync;
full NAS loss) plus freshness rules of thumb and the safety model.
README backup/DR section; CATALOG_SYNC.md's RH-0021 forward-reference now
points at the runbook; `.env.example` documents both new variables.

## Verification evidence (2026-09-20, Node 22.19.0 / Docker, disposable PostgreSQL 18.6 container only)

| Gate | Result |
|---|---|
| `npm run lint` | ✅ clean (0 problems) |
| `npm run typecheck` | ✅ clean |
| `npm run build` | ✅ succeeds; route surface unchanged |
| `npm test` (unit) | ✅ **128/128** (incl. **23 new** backup model tests) |
| `npm run test:db` (integration) | ✅ **114/114** (incl. **13 new** backup integration tests) |

New backup integration suite (own databases inside the disposable container:
`reelhouse_backup_reelhouse`, `reelhouse_backup_catalog`, scratch
`rh_restore_check_inttest`; fixture Jellyfin — no network; source databases
never modified beyond test seeds):

| Path | Evidence |
|---|---|
| Backup structure | ✅ manifest validates against registry, sidecar = sha256(manifest), per-file line counts = manifest counts, freshness markers populated, no credentials in any output file |
| Determinism | ✅ two snapshots of unchanged content: every table checksum identical (canonical form + collation-pinned order) |
| Empty databases | ✅ zero-row backup round-trips (empty-table sha256 = sha256("")) |
| No overwrite | ✅ refuses a non-empty output directory |
| End-to-end restore | ✅ both databases migrated + loaded + checksum-proved in the scratch; scratch dropped; `pg_database` confirms removal |
| Tampered data file | ✅ checksum problem, offline failure, **no scratch ever created** |
| Edited manifest | ✅ sidecar mismatch caught |
| Stale backup | ✅ `stale` problem; restoreVerify refuses **before** creating anything |
| Forged duplicate PK | ✅ a fully self-consistent (re-signed) backup with a duplicated row passes offline verification and is rejected by the database at load; transaction rolled back; scratch dropped by default |
| Migration drift | ✅ missing local / backup-predates-tree / checksum mismatch all refuse, before any scratch exists |
| Scratch guard | ✅ non-`rh_restore_*` URL refused pre-connection; mis-targeted database verified untouched |
| Keep flags | ✅ `--keep-on-failure` retains the failing scratch; success-keep leaves the final scratch for drills |
| **DR resync drill** | ✅ restored catalog scratch wiped back to empty, then rebuilt through the **real sync engine** (`catalog:rebuild`, fixture Jellyfin) with changed content — proving recovery comes from Jellyfin, not the backup |

Live CLI evidence (disposable targets, real commands): `db:backup` full run
per-table counts + manifest sha256 (exit 0) → `--offline` verify OK → full
restore-verify with both scratch lifecycles, 5-row reelhouse + 0-row catalog
reloaded and verified, scratch dropped (exit 0) → tampered favorite file →
`OFFLINE VERIFY FAILED`, exit 1 → wrong-name scratch URL → refused, exit 1.
**Production Synology was never contacted; Jellyfin was never contacted by
backup/restore tooling; no source database was ever written to; the only
databases touched were disposable container-local ones.**

## Requirement-by-requirement (job spec acceptance)

| Criterion | Result |
|---|---|
| Separate backup/restore treatment for household-owned `reelhouse` vs rebuildable `media_catalog` | ✅ Per-authority runbook + manifest freshness split + `--only` selective backup/verify; DR scenarios A/B/C encode the policy |
| Disposable restore verification | ✅ Phase-3 scratch lifecycle; `rh_restore_*` name guard; dropped by default |
| Checksums | ✅ Canonical per-table SHA-256 in manifest, re-proved offline and against the restored database |
| Freshness | ✅ `latestUpdatedAt` + `lastSuccessfulScanAt` markers; `BACKUP_MAX_AGE_HOURS` fail-closed bound |
| Full Jellyfin resync | ✅ DR drill rebuilds a wiped restored catalog through the real RH-0016 sync engine; runbook scenario B makes resync the preferred catalog recovery |
| Recovery runbook | ✅ docs/BACKUP_RESTORE.md (three scenarios + schedules + safety model) |
| Deterministic tests cover success/stale/duplicate/failure/recovery | ✅ 23 unit + 13 integration tests, tables above |
| Existing suites remain green | ✅ lint/typecheck/build + 128 unit + 114 db-integration |
| Diagnostics bounded and redacted | ✅ 2 000-char bound + URL redaction; no-credential assertion in-suite |
| Report evidence and stop in REVIEW | ✅ this report; nothing merged |

## Findings the controller should see

1. **RH-0004 should be retired as superseded by RH-0016** (same scope;
   RH-0016 is leased, implemented, in REVIEW). Re-flagged from the claim
   section — it is the only thing blocking a clean "no stale READY" queue.
2. **Restore verification needs `CREATEDB` (or a pre-created scratch)** on
   whatever server verifies backups: the tool creates/drops the
   `rh_restore_*` scratch. On the disposable profile the test role is
   superuser; on the Synology service the operator should either grant
   `CREATEDB` to a dedicated verification role or pre-create the scratch
   database and point `RESTORE_VERIFY_DATABASE_URL` at it. Documented in
   the runbook; no production change was made or is required by this job.
3. **Backups are per-table sequential reads**, not a single
   point-in-time snapshot: a write landing mid-backup can produce a
   FK-inconsistent directory, which restore verification then correctly
   rejects (rerun). Schedule backups in quiet hours (runbook says so).
   A `REPEATABLE READ` cross-table snapshot is the later upgrade if
   ever needed.
4. **timestamptz precision**: canonical rows carry millisecond ISO
   timestamps (JS `Date`); microsecond components are truncated at
   snapshot time, consistently on both checksum sides. Restored data can
   differ from the source by sub-millisecond amounts; nothing in the
   schema or APIs depends on that precision (watch-state ordering uses
   explicit event timestamps and last-writer-wins logic, unaffected).
5. **Merge order**: this branch sits on the rh-0022 tip, sibling of
   rh-0020. Merging the backend chain (…→rh-0022) then either or both of
   rh-0020/rh-0021 preserves all resolutions; rh-0020 and rh-0021 touch
   disjoint files (search read-model vs backup/DR) and merge cleanly in
   either order.

## Handoff

Upon acceptance: controller merges per finding 5. Remaining unclaimed READY
on the stale-but-authoritative origin/main copy: none — every READY job now
has a lease (RH-0014's branch appeared since the last sweep; RH-0004 should
be retired per finding 1). Queue maintenance (moving REVIEW branches to
accepted, re-arming RH-0005/0006/0007 dependency gates) is the controller's
call; the runbook's schedule section defines the backup cadence operators
should adopt after the first production backup.

## Commits on the branch

1. `Add PostgreSQL backup snapshot, restore verification, and DR CLIs (RH-0021)`
2. `Document backup restore and disaster recovery runbook (RH-0021)`
3. *(this commit)* — Queue updated (RH-0021 → Review Queue), this report.
