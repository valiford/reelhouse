# ReelHouse media identity workbench — conflict quarantine and repair (RH-0036)

The workbench is the operator side of the catalog's conflict story. The sync
pipelines (RH-0031/0032) quarantine ambiguous source identities as they see
them; the workbench finds the conflict classes only a whole-catalog view can
see, inspects every quarantined conflict with its evidence, and records
audited operator resolutions — including the one bounded catalog write it
allows (placement remap). Jellyfin stays the playback/library authority: the
workbench reads Jellyfin's state only through what the sync already mirrored
into `media_catalog`, never through Jellyfin's internal database, and every
next sync reconciles the catalog against the live source.

## Components

| Path | Role |
|---|---|
| `db/migrations/0009_media_identity_workbench.sql` | Extends quarantine reasons; adds `media_identity_scans` (scan history) and `media_identity_repairs` (append-only audit); each quarantine proves a single origin (`run_id` xor `scan_id`). |
| `src/lib/catalog/workbench.ts` | Scan detectors (read-only SQL), bounded inspection, release/discard/remap with audit — all through the least-privilege application role. |
| `scripts/catalog-workbench.ts` | CLI: `npm run catalog:workbench -- scan | list | show | release | discard | remap`. |

## Conflict classes

| Reason | Written by | `identity` holds | Meaning |
|---|---|---|---|
| `duplicate_identity` | sync (RH-0032) | Jellyfin item id | The same Jellyfin id reported twice in one run with differing placement/content; first occurrence wins deterministically. |
| `duplicate_file` | scan | file path | Two or more ACTIVE catalog items claim one `file_path` — typically Jellyfin re-identified a file or an import was duplicated. |
| `moved_media` | scan | file path | An ACTIVE item claims a file that a retired (tombstoned) identity used to own — the moved/renamed-media signature. |
| `missing_external_id` | scan | Jellyfin item id | An ACTIVE movie/series has no external provider IDs (Imdb/Tmdb/Tvdb/…), so identity reconciliation across renames/moves has no anchor. Episodes/seasons are never flagged. |

Every open conflict is one `media_item_quarantine` row per
`(identity, reason)`: a re-observed conflict bumps `occurrences` and
`last_seen_at` but keeps the FIRST-recorded evidence payload. Scans never
auto-close rows — a conflict that disappears stays open until an operator
resolves it, because "no longer detected" is not "explained".

## Commands

```bash
npm run catalog:workbench -- scan
npm run catalog:workbench -- list [--status=quarantined|released|discarded|all] \
    [--reason=duplicate_identity|duplicate_file|moved_media|missing_external_id|all] [--limit=1-200]
npm run catalog:workbench -- show <quarantine-id>
npm run catalog:workbench -- release <quarantine-id> [--note "..."]
npm run catalog:workbench -- discard <quarantine-id> [--note "..."]
npm run catalog:workbench -- remap <quarantine-id> --library <jellyfin-library-id> [--note "..."]
```

Environment: `DATABASE_URL` (application role) is required; `scan`/`list`/
`show` are read-only or workbench-only writes. `REELHOUSE_OPERATOR` is
required for `release`/`discard`/`remap` and is recorded in every audit row —
repairs without an actor fail closed. The workbench never needs the
`JELLYFIN_*` variables: detection is pure PostgreSQL over mirrored state.

- **scan** — runs the three detectors in one snapshot-consistent transaction
  and records findings (bounded to 200 per detector; hitting the cap marks
  the scan `truncated` and the operator re-runs after resolving). The scan
  row in `media_identity_scans` records the outcome exactly like a sync run:
  counters, truncation flag, and a scrubbed error detail on failure. A
  failing detector aborts the whole scan atomically — nothing is recorded.
- **list / show** — bounded inspection. `show` bundles the quarantine row
  with its evidence payload, the involved catalog items (active and
  tombstoned), those items' most recent change-history rows, and the repair
  audit trail.
- **release** — the conflict was reviewed and the current catalog state is
  accepted (e.g. Jellyfin was fixed, or the deterministic first-occurrence
  choice is confirmed). Closes the row as `released`.
- **discard** — the finding was a false positive. Closes the row as
  `discarded`.
- **remap** — for `duplicate_identity` rows only: re-points the quarantined
  item's library placement to the operator-chosen ACTIVE library, then
  closes the row as `released` with a `remapped` audit entry carrying the
  before/after placement. The read, the placement write, the resolve, and
  the audit share one transaction. Refused, fail-closed: unknown target
  library, target equal to current placement (use `release` to confirm),
  tombstoned quarantined item, resolved rows, or any other reason.

Placement stays Jellyfin-owned: if an operator's remap disagrees with what
Jellyfin actually reports, the next sync moves the item back and opens a
fresh quarantine — a remap can never desync the catalog from its authority.

## Audit model

`media_identity_repairs` is append-only: one row per resolution with the
action (`released`/`discarded`/`remapped`), the operator identity, an
optional bounded note, and a bounded plain-data evidence projection
(quarantine summary + evidence payload, or the placement change for
remaps). Rows are never updated or deleted, so the history of WHO decided
WHAT about an ambiguous media identity and WHEN is always reconstructible.

## Schema notes

- `media_item_quarantine.reason` now allows `duplicate_identity`,
  `duplicate_file`, `moved_media`, `missing_external_id` (0006 allowed only
  the sync's `duplicate_identity`).
- Each quarantine row carries exactly one origin — the sync run that saw the
  conflict (`run_id`) or the scan that found it (`scan_id`); the
  `media_item_quarantine_origin_check` constraint rejects both and neither.
- `media_identity_scans` mirrors `media_sync_runs` conventions: append-only
  rows, counters move only while the scan runs, `status` and `finished_at`
  move together.
- All tables live in schema `public`, so migration 0001's default privileges
  make them DML-accessible to the least-privilege application role like the
  rest of the `media_*` family. Detectors are read-only; all workbench
  writes touch only workbench-owned tables.

## Verification

```bash
npm test         # hermetic: payload/validation matrices, placeholder invariant, migration drift guard
npm run test:int # adds workbench integration evidence (disposable local PG18)
```

Integration scenarios: migration 0009 constraint surface under the app role;
duplicate_file / moved_media / missing_external_id detection grown from real
sync runs (including the restore that settles a moved-media finding);
bump-not-duplicate with first-evidence preservation; atomic scan failure via
a revoked detector grant with recorded failure and clean recovery;
release/discard with audit trail, never-resolve-twice, and operator-required
rules; the remap happy path on a real sync-produced duplicate_identity
quarantine plus its full failure matrix; deterministic replay of a scan.

Live demonstration (dev DB + Jellyfin stub, then mutate the catalog):

```bash
docker compose -f docker-compose.dev-db.yml up -d
npm run db:migrate
DATASET=duplicates node scripts/dev/jellyfin-stub.mjs &
export JELLYFIN_URL=http://127.0.0.1:8097 JELLYFIN_API_KEY=stub-key
export DATABASE_URL=postgresql://reelhouse_app:reelhouse_app_dev@127.0.0.1:5433/reelhouse
npm run catalog:sync                                   # seed + duplicate-identity quarantine
npm run catalog:workbench -- scan                      # + duplicate_file / missing_external_id findings
npm run catalog:workbench -- list                      # pick row ids from the listing
npm run catalog:workbench -- show 1                    # evidence + items + history + repairs
export REELHOUSE_OPERATOR=operator-name
npm run catalog:workbench -- remap <duplicate-identity-id> --library lib-tv --note "TV placement is correct"
npm run catalog:workbench -- release <duplicate-file-id> --note "duplicate import cleaned up in Jellyfin"
```
