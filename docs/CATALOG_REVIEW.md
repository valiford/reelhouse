# Quarantine review and identity repair (RH-0023)

The operator-side workflow over the catalog quarantine created by the sync
([CATALOG_SYNC.md](CATALOG_SYNC.md)). The sync quarantines ambiguous
identities at detection time and refuses to guess; this workflow is how a
human reviews those entries, records a verdict, and — where the ambiguity is
an identity dispute — remaps ownership with a decision the sync then
enforces deterministically. It reads and writes **only the `media_catalog`
database**: Jellyfin is never modified (it is not even contacted), and the
`reelhouse` database is never touched.

## Layout

| Path | Role |
|---|---|
| `db/migrations-catalog/0004_catalog_identity_review.sql` | Quarantine resolution columns, detector reasons, `catalog_identity_override` |
| `src/lib/catalog/review.ts` | Review listing/resolution, catalog detectors, overrides (pure helpers + DB ops) |
| `scripts/catalog-review.ts` | Review CLI (`npm run catalog:review -- <command>`) |
| `src/lib/catalog/review.test.ts` | Unit suite for reason ownership, normalization, detector planning |
| `src/lib/catalog/review.int.test.ts` | Integration suite against the disposable PG18 |

## Quarantine vocabulary and ownership

`catalog_quarantine` rows are owned by exactly one side, derivable from the
reason:

| Owner | Reason | Meaning |
|---|---|---|
| sync | `duplicate_provider_id` | Another item already holds that provider id |
| sync | `duplicate_external_id` | The same id appeared twice in one run/payload |
| sync | `library_conflict` | A second library claims an item another library owns |
| sync | `orphan_parent` | A season/episode whose parent row does not exist |
| sync | `invalid_item` | Payload present but not representable (e.g. no name) |
| detector | `duplicate_path` | Two **live** items share one file path (duplicated files) |
| detector | `renamed_identity` | A missing/retired item whose path reappeared under a different id (rename / identity swap) |

Neither side ever writes the other's reasons. A row resolved without an
operator action was closed automatically (`resolved_at` set, no action):
by the sync (its own reasons, once the item syncs cleanly) or by a detector
re-scan that no longer sees the conflict.

## Resolution semantics

An operator resolution records **what** (`resolution_action`), **why**
(`resolution_note`), and **who** (`resolved_by`):

| Action | Meaning |
|---|---|
| `dismissed` | Known and accepted; detector findings with this verdict are **never re-opened** by re-detection |
| `source_fixed` | The operator believes upstream fixed it; reality wins on the next detection |
| `discarded` | The finding is stale noise; reality still wins on re-detection |
| `remapped` | Set only by the remap flows (`remap-provider`, `pin-library`) |

Honesty rule: re-detection **re-opens** entries and clears the operator
columns. A verdict never masquerades as health — if the conflict is still
real, the entry shows open again, whatever it was resolved with. The only
durable verdict is `dismissed` on detector findings, where re-detection is
the operator's own tool.

## Safe remapping: identity overrides

`catalog_identity_override` stores durable identity decisions:

- **provider claim** — `(provider, external_value)` belongs to a named item.
  Resolves a `duplicate_provider_id` dispute: from then on the sync
  quarantines any *other* item claiming that id with `viaOverride: true`
  evidence, deterministically, regardless of scan order.
- **library pin** — an item belongs to a named library. Resolves a
  `library_conflict` (typically a deliberate library move): a scan from the
  pinned library is sanctioned and applies the move even for unchanged
  content; a scan from anywhere else quarantines with the pin as evidence.

Overrides reference source ids as **text, with no foreign keys**, on
purpose: they are human judgments and **survive a rebuild** (which wipes
catalog content and quarantine history but keeps decisions). Remove an
override (`remove-override`) to return the decision to the sync's own
heuristics. Overrides never write to Jellyfin and never invent catalog
content — they only decide which claimant is canonical.

## Weak identity report

`weak-identity` lists live movies/series with **no provider id at all**:
their identity rests solely on the Jellyfin item id, so a source-side
re-identification is invisible to matching. Report-only advice for review —
never a quarantine. Seasons/episodes inherit identity from their parents and
are excluded.

## Commands

```bash
npm run catalog:review -- list [--status=open|resolved|all] [--reason=<reason>] [--limit=N]
npm run catalog:review -- show <quarantine-id>
npm run catalog:review -- detect
npm run catalog:review -- weak-identity [--limit=N]
npm run catalog:review -- resolve <id> --action=<dismissed|source_fixed|discarded> [--note=...] [--by=...]
npm run catalog:review -- remap-provider <provider> <value> --to=<canonical-item-id> [--note=...] [--by=...]
npm run catalog:review -- pin-library <item-id> --to=<canonical-library-id> [--note=...] [--by=...]
npm run catalog:review -- overrides [--limit=N]
npm run catalog:review -- remove-override <override-id>
```

- `detect` runs the two catalog detectors and **reconciles**: new or changed
  findings are recorded, findings the catalog no longer exhibits are closed.
  Detector output is bounded (500 findings each); when a detector truncates,
  the close step is skipped for that run so an unlisted finding is never
  mistaken for a healed one.
- Every command requires `MEDIA_CATALOG_DATABASE_URL`, fails closed on
  unknown ids/references (you cannot remap to an item or library the catalog
  does not know), prints no credentials, and exits 0 only on success.
- `--by` defaults to `operator`; pass a real identity for accountability.

## Suggested loop

After each scheduled sync (see the schedule in
[CATALOG_SYNC.md](CATALOG_SYNC.md)):

```bash
npm run catalog:review -- detect          # refresh detector findings
npm run catalog:review -- list            # triage everything open
npm run catalog:review -- weak-identity   # identity hygiene candidates
```

Resolve or remap what needs a human; leave source-data defects to re-open
until upstream actually fixes them. Verification is part of the standard
suite (`npm test`, `npm run test:db`).

## Boundaries

- No Jellyfin access, no Jellyfin writes, no Jellyfin internal database.
- No cross-database effects: the `reelhouse` database is untouched.
- No production deploy/release/credential changes; this tool is batch-only.
