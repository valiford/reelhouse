# RH-0016 Worker Report — Jellyfin to PostgreSQL media_catalog synchronization

- **Date:** 2026-09-19 (claimed 12:36 America/New_York, inside 11:00–21:00 window)
- **Worker:** ZCODE (WBNQ Soundscape Design Engineer dispatch)
- **Status:** **REVIEW** (worker output; never merges, deploys, or releases)
- **Branch (lease + deliverable):** `rh-0016-jellyfin-to-postgresql-media-catalog-synchronization`
- **Base:** `origin/rh-0015-real-synology-pg18-connection-migration-smoke` @ `ba7a957` — the branch that integrates rh-0002 (connection layer) + rh-0003 (migrator + reelhouse schema) onto main, exactly as RH-0015's handoff prescribed for this job ("RH-0016 … appends migrations 0010+ via the same runner" — realized as the catalog's own history on the same runner)

## Claim

Dispatch bootstrap ran (`git fetch origin --prune`); the queue was read from
`origin/main` per protocol (the local checkout sits on the rh-0002 REVIEW
branch, whose queue copy is not authoritative). `origin/main` @ the wave
reload lists RH-0015 (p1) and RH-0008 (p1) as highest-priority READY; both are
leased (branches + worktrees, checked before claiming), as are
RH-0009/0010/0002/0003. RH-0016 is the highest-priority unclaimed READY job
with `AUTOMATION_ELIGIBLE: true` and no dependency gate. Lease check: no
`rh-0016*` branch or worktree existed — claim uncontested. The lease branch
was pushed to origin before implementation started.

## What was built

The `media_catalog` database per `docs/ARCHITECTURE.md` — a **separate**
PostgreSQL 18 database from `reelhouse` — plus the engine that mirrors
Jellyfin library metadata into it through the Jellyfin API only.

### 1. Catalog schema (`db/migrations-catalog/0001–0003`, own history, same runner)

- `0001` — `catalog_library` and `catalog_item` (movies/series/seasons/episodes
  with file facts: path/container/size/date_created), `catalog_provider_id`
  (imdb/tmdb/… with a lookup index). Identity is `(source, external_id)`;
  `content_hash` is the payload fingerprint; provenance/freshness columns
  (`observed_at`, `last_seen_at`, `source_revision`, `missing_since`,
  `retired_at`); parent linkage is a real FK to `(source, external_id)` so an
  orphaned child can never commit silently; named CHECKs pin kind, parent
  shape, and the retirement state machine.
- `0002` — normalized taxonomies: `catalog_genre` / `catalog_studio` /
  `catalog_person` (folded `name_key` identity) + per-item join rows with
  list order and person role/character.
- `0003` — operational state kept **beside the data it describes**:
  `catalog_scan` (per-run audit with bounded counts and redacted error),
  `catalog_sync_state` (per-library incremental cursor), `catalog_quarantine`
  (ambiguous identities with verbatim payload snapshots).
  Rationale: catalog operational state must be atomic with catalog writes, and
  rebuilding either database must not cost the other its state. The
  `reelhouse.sync_cursor` table (RH-0003) remains for household-side
  reconciliation jobs; this interpretation is flagged for the controller
  below.

### 2. Sync engine (`src/lib/catalog/`)

- `config.ts` — fail-closed config: `MEDIA_CATALOG_DATABASE_URL` (+SSL
  fallback) reusing the reelhouse validation rules via a new env-name
  parameterization of `loadDatabaseConfig()`; `JELLYFIN_URL`/`JELLYFIN_API_KEY`
  (server-scoped API key, never a user token, never stored);
  `MEDIA_CATALOG_RETIREMENT_DAYS` (default 30).
- `model.ts` (pure) — Jellyfin payload → normalized model; four kinds only
  (others are counted skips); canonical SHA-256 fingerprint over stored
  content (taxonomies sorted, people in billing order, ETag excluded) so
  payload ordering can never fabricate changes.
- `jellyfin-client.ts` — bounded HTTP client (timeout, pagination, key only in
  the `X-Emby-Token` header, key-free errors), injectable for fixtures.
- `sync.ts` — the engine. Libraries are consumed in **kind passes** (roots →
  seasons → episodes) so parents always exist before children; writes commit
  one transaction per page (failed page commits nothing; reruns idempotent);
  identical content updates only `last_seen_at`; ambiguous identities
  (duplicate provider id, duplicate payload id, cross-library claim, orphan
  parent) are **quarantined, never merged**, and auto-resolve on the next
  successful sync; retirement is non-destructive and full-scan-only
  (`missing_since` → `retired_at` past the threshold → restored in place on
  return); incremental mode rides a per-library `MinDateLastSaved` cursor and
  never retires; rebuild wipes catalog content only. Hard caps: 500/page,
  100 pages/library, 50,000 items/library — overflow fails the scan with a
  bounded message instead of truncating silently. Every stored/rethrown error
  is redacted (URL/key) and truncated to 2000 chars.
- `scripts/catalog-sync.ts` / `scripts/catalog-migrate.ts` — env-only CLIs
  (`catalog:sync[:full|:rebuild]`, `catalog:migrate[:dry-run]`), exit 1 on
  every fail-closed path.

### 3. Surgical change to reviewed code

`src/lib/db/config.ts` gains optional `urlVar`/`sslVar` env-name overrides
(defaults byte-identical; all 12 existing config tests pass unchanged). This
keeps validation/bounds/redaction for both databases in exactly one place.

### 4. Docs

`docs/CATALOG_SYNC.md` (full runbook: config, identity/provenance/freshness,
scan modes, retirement, quarantine review, role provisioning, schedule,
verification), README catalog section, additive cross-links in
`docs/DATABASE.md` + `docs/MIGRATIONS.md`, `.env.example` catalog variables,
`.gitattributes` LF pinning for the new migration directory.

## Verification evidence (2026-09-19, Node 22.19.0 / Docker, disposable PostgreSQL 18.6 only)

| Gate | Result |
|---|---|
| `npm run lint` | ✅ clean |
| `npm run typecheck` | ✅ clean |
| `npm run build` | ✅ succeeds; route surface unchanged (`○ /`, `ƒ /api/health`, `ƒ /api/library`, `ƒ /api/search`) |
| `npm test` (unit) | ✅ **60/60** (db config 12, migrator 17, smoke 9, catalog config 9, model 9, client 4) |
| `npm run test:db` (integration) | ✅ **47/47** (migrations 27, smoke 6, **catalog 14**) |

Catalog integration suite (`reelhouse_catalog_test` inside the disposable
container, fixture Jellyfin — no network, migrations re-applied from an empty
schema every run) covers, per the RH-0004/RH-0016 acceptance shape:

| Path | Evidence |
|---|---|
| Create | ✅ full scan creates libraries, items, taxonomies, provider ids; counts exact |
| No-change / idempotence | ✅ repeat scan: 0 upserts; `observed_at` never moves, `last_seen_at` tracks the sighting |
| Update | ✅ content change updates row + relations, preserves first observation, tracks new `source_revision` |
| Missing / stale | ✅ full scan marks `missing_since`; repeat missing does not re-mark |
| Retirement | ✅ past threshold the row is retired (not deleted); **restore** on return clears both stamps in place |
| Duplicate identity | ✅ provider-id conflict quarantines the challenger, existing item untouched, scan still succeeds; fixing upstream → item syncs and the record auto-resolves |
| Orphan | ✅ episode → season → series cascade quarantines then heals as the family arrives |
| Library conflict / duplicate payload | ✅ both quarantine, first writer wins |
| Incremental | ✅ cursor recorded and passed through (`MinDateLastSaved`); only changed items touched; **never retires**; cursor-less incremental degrades to a safe sighting pass |
| Rebuild | ✅ content + cursor wiped, catalog rebuilt, scan history preserved |
| Failure / recovery | ✅ Jellyfin 503 → scan row `failed` with bounded redacted error, no partial writes, next scan recovers; failed history kept |
| Fail-closed | ✅ no `MEDIA_CATALOG_DATABASE_URL` → refuses; unmigrated schema → bounded "run catalog:migrate"; wrong Jellyfin scheme → rejected pre-I/O |
| Schema guards | ✅ direct SQL: kind CHECK, `retired_at` requires `missing_since`, quarantine reason CHECK |

Redaction audited in-suite: the disposable credential pair never appears in
any scan error or sync-state error. CLI fail-closed verified live (exit 1 with
clear messages for missing credentials; bounded redacted `ECONNREFUSED` for an
unreachable Jellyfin). **Production was never contacted; Jellyfin was never
modified; no media was deleted; the reelhouse database was never touched by
the sync.** Disposable containers are the only infrastructure used.

## Requirement-by-requirement (job spec acceptance)

| Criterion | Result |
|---|---|
| Synchronize Jellyfin library metadata into the existing PG18 `media_catalog` database | ✅ Engine + schema + CLIs delivered; the production Synology `media_catalog` leg is an operator command (`catalog:migrate` then `catalog:sync:full`) exactly like RH-0015's smoke — no Synology credentials exist in this environment (fail-closed, worker rule 10) |
| Stable mappings | ✅ `(source, external_id)` identity; parent FK; bridge to `reelhouse.media_item_ref` documented (same key pair, no cross-database FK by design) |
| Provenance, freshness | ✅ `observed_at`/`last_seen_at`/`source_revision`/`content_hash` + `catalog_scan` audit trail |
| Idempotent upserts | ✅ fingerprint-guarded writes; repeat scans are pure sightings |
| Non-destructive retirement until policy threshold | ✅ missing → retired (threshold, default 30 d) → restored; never deletes |
| Duplicate/ambiguous identity quarantined, not merged | ✅ five quarantine reasons with snapshots + auto-resolution |
| Incremental sync + safe full rebuild | ✅ cursor-based incremental; rebuild wipes catalog only, never Jellyfin |
| Deterministic tests cover success/stale/duplicate/failure/recovery | ✅ 14-case fixture-backed integration suite + 22 catalog unit tests, table above |
| Existing suites remain green | ✅ lint/typecheck/build + 60 unit + 47 db-integration |
| Bounded, redacted diagnostics | ✅ caps everywhere; redaction asserted in-suite |
| Worker ends in REVIEW; never merge/deploy | ✅ this report; nothing merged |

## Findings the controller should see

1. **Queue topology conflict: RH-0016 duplicates legacy RH-0004.** The
   reloaded `origin/main` queue lists the RH-0016–0021 wave AND the legacy
   RH-0004 ("Jellyfin API to `media_catalog` synchronization…") as READY.
   This job fulfills RH-0004's scope (its detailed requirements were used as
   the acceptance baseline). Recommend the controller retire/mark RH-0004 as
   superseded when reconciling; the branch queue copy leaves RH-0004 in place
   for that decision.
2. **Operational state lives in the catalog DB by design.** RH-0003's
   `sync_cursor`/`idempotency_record` tables anticipate "RH-0004's Jellyfin
   sync" in the reelhouse database, but this build keeps the sync's cursor/
   scan history in `media_catalog` (atomicity with catalog writes; rebuild
   independence). `reelhouse.sync_cursor` remains unused for now — fine for
   RH-0017/0018's household jobs, but the controller may want a one-line
   decision recorded in ARCHITECTURE.md.
3. **Merge order matters.** This branch is a descendant of rh-0015 (which
   integrates rh-0002 + rh-0003). Merging rh-0002 → rh-0003 → rh-0015 → this
   branch (or simply this branch last) preserves all conflict resolutions;
   other orders re-surface the queue/package.json/.env.example conflicts.
   `src/lib/db/config.ts` changed only additively; RH-0002's 12 config tests
   pass unchanged here.
4. **`media_catalog` needs provisioning on the Synology service before the
   first real sync** (database + owner/app roles) — `docs/CATALOG_SYNC.md`
   §"Roles (least privilege)" has the exact commands; the migrations create
   no grants, consistent with RH-0003's convention (DML grants for the
   reelhouse side are still an open RH-0006/0017 item from RH-0015's
   findings).
5. Deletion detection rides full scans by design (incremental never retires);
   the runbook suggests nightly incremental + weekly full. If faster deletion
   visibility is wanted later, a scheduled per-library full scan is the knob,
   not a new mechanism.

## Handoff

Upon acceptance: controller merges (order in finding 3). Next unclaimed READY
per `origin/main` wave: RH-0017/0018 (persistence features on the proven
surface; the catalog's `(source, external_id)` rows are the join key household
state will use via `media_item_ref`). The disposable dev/test database
profiles remain the verification targets; production contact stays gated
behind the documented operator commands.

## Commits on the branch

1. `Parameterize ReelHouse database configuration for multiple databases`
2. `Add media_catalog schema, Jellyfin sync engine, and CLIs (RH-0016)`
3. `Document media_catalog sync operations (RH-0016)`
4. *(this commit)* — Job spec → REVIEW, queue updated (RH-0016 → Review
   Queue), this report.
