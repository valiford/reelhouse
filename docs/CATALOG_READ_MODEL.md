# Catalog read model — search, browse, recommendations (RH-0020)

How ReelHouse serves search, library browsing, and recommendation rails from
the `media_catalog` database (see [CATALOG_SYNC.md](CATALOG_SYNC.md) for how
that database is populated). The read model is **read-only**: the sync engine
owns every write, and Jellyfin is never touched at request time — a catalog
served page costs zero Jellyfin availability.

## Layout

| Path | Role |
|---|---|
| `src/lib/catalog/read-model.ts` | The read model: pool, freshness, bounded search with keyset pagination, rails, library browse, MediaItem mapping |
| `src/lib/catalog/config.ts` | Parse/validate for `MEDIA_CATALOG_STALE_HOURS` (freshness policy) alongside the sync configuration |
| `src/app/api/search/route.ts` | `GET /api/search` — catalog-first search with Jellyfin fallback |
| `src/app/api/library/route.ts` | `GET /api/library` — catalog-first browse with Jellyfin/demo fallback |
| `src/app/api/catalog/recommendations/route.ts` | `GET /api/catalog/recommendations` — bounded rails, catalog-only |
| `src/lib/catalog/read-model.test.ts` | Unit suite: query bounding, cursor codec, LIKE escaping, mapping (pure) |
| `src/lib/catalog/read-model.int.test.ts` | Integration suite against the disposable PG18 (read contract) |

## Explicit degradation, never silent substitution

Every UI-facing read names its **source** and carries degradation facts:

- `source: "catalog"` — served from the read model; the `catalog` field
  carries `{ state, lastSucceededAt }` where `state` is `fresh`, `stale`
  (last successful sync older than the policy), or `empty` (never synced).
- `source: "jellyfin"` — catalog not configured / unreachable / empty, so the
  request fell back to the live Jellyfin API. The `catalog` field explains
  why: `unconfigured`, `unavailable` (with a redacted, bounded detail), or
  the sync state for an empty catalog. `degraded` names a Jellyfin problem
  (`jellyfin_unconfigured` → demo data, `jellyfin_unreachable`).
- `GET /api/catalog/recommendations` is catalog-only and fails closed with
  `503 catalog_unconfigured` / `503 catalog_unavailable` — there is no honest
  recommendation to fabricate from demo data.

**Stale is served, but labelled.** A lagging sync degrades visibly (the
`catalog.state` field), never silently and never with a hard refusal of
read-only data. Writes and migrations are where fail-closed applies.

## Bounded search — `GET /api/search`

Catalog mode (any parameter beyond `q` is catalog-only and ignored by the
Jellyfin fallback):

| Parameter | Contract |
|---|---|
| `q` | ≤ 200 chars; matched case-insensitively against name / sort name / original title; `%`, `_` and `\` are escaped so `100%` finds a literal percent |
| `kind` | Comma-separated subset of `movie, series, season, episode` (default `movie,series`) |
| `genre` | Exact genre name (case/whitespace folded to the catalog's `name_key`), ≤ 100 chars |
| `year` | 1000–2999 |
| `sort` | `name` (default), `rating`, `recent`, `year` |
| `limit` | 1–100 (default 24) |
| `cursor` | Opaque `nextCursor` from the previous page |

Response: `{ source, query, items, total, nextCursor, catalog }`. Items are
the household `MediaItem` shape (the external id IS the Jellyfin item id, so
household links keep working) plus `hasArt` and `missing`.

### Stale-response ordering (keyset pagination)

Every sort is a deterministic **total order** — the sort key, then the unique
`external_id` — and pagination walks it with an opaque cursor instead of an
offset. An offset page silently shifts when rows are inserted or removed
between requests; a keyset page always starts exactly where the previous page
ended. Clients can therefore merge cached (stale) and fresh pages without
duplicating or skipping rows across a sync. `total` is the live count and may
drift between pages; the ordering cannot.

`rating`, `recent`, and `year` are `DESC NULLS LAST` sorts: rows without a
value sort after every valued row, and the cursor carries a `null` marker so
the NULLS LAST zone paginates continuously.

### Missing-art handling

`hasArt: false` marks items without a primary image tag; the API never
fabricates an image URL for them (and composes URLs only from
`NEXT_PUBLIC_JELLYFIN_URL` / `JELLYFIN_URL` when a tag exists). Clients render
a deterministic placeholder instead of a broken image.

## Recommendation rails — `GET /api/catalog/recommendations`

Optional `genre` (≤ 100 chars) and `limit` (1–50, default 12). Returns
`top_rated` (community rating DESC NULLS LAST), `recently_added` (date created
DESC NULLS LAST), and, when `genre` is given, a `genre` rail — all bounded,
deterministic, and **art-first**: items with art lead each rail (by the rail
key), art-less items follow still included and flagged, so rails present well
without hiding anything. Rails read the catalog only — no per-request
Jellyfin dependency.

## Library browse — `GET /api/library`

Catalog mode builds the legacy payload shape from bounded read-model queries:
`Recently Added` and `Top Rated` rails plus alphabetical `Movies` / `Shows`
sections (default 12 each) and a hero chosen as the newest item that actually
has art. Empty/unconfigured/unavailable catalogs fall back to the Jellyfin
path with the explicit `catalog` / `degraded` fields described above.

## Configuration

| Variable | Meaning |
|---|---|
| `MEDIA_CATALOG_DATABASE_URL` | Catalog read target (same semantics as the sync's; unset = feature unavailable, never a silent degradation) |
| `MEDIA_CATALOG_STALE_HOURS` | Freshness policy: last successful sync older than this → `state: "stale"` (default 24, bounds 1–8760) |

The read pool is fixed and small (4 connections, 10 s statement timeout,
`application_name = reelhouse-catalog-read`); read failures are folded into a
single redacted, ≤ 2000-char error path that never carries the database URL
or credentials.

## Retirement visibility

Per [CATALOG_SYNC.md](CATALOG_SYNC.md), readers filter `retired_at IS NULL`.
Items still in the softer `missing_since` state remain visible with
`missing: true` — a lagging full scan shrinks nothing silently.

## Verification

```bash
npm test                    # unit: query bounding, cursor codec, mapping
npm run test:db             # + read-model integration suite (disposable PG18)
```

The integration suite pins the read contract end to end: keyset walks with no
gaps or duplicates for every sort (including across the NULLS LAST boundary),
page stability when rows are inserted mid-walk (the stale-response ordering
property), filter combinations, wildcard escaping (`100%`), retired
invisibility and `missing` flagging, missing-art facts, rails ordering,
freshness states, and redacted fail-closed behavior against unreachable
databases. Nothing in the suite can reach a real Jellyfin server or the
production Synology target.
