# Search & Library API Contract

RH-0010 defines the bounded listing contract shared by the ReelHouse
search and library APIs. Both routes validate every parameter before
touching an upstream, reject unbounded requests, and return explicit
error payloads instead of fake empty results. RH-0005/RH-0006 should
reuse `src/lib/list-query.ts` rather than re-parsing parameters.

## Shared parameter bounds (`src/lib/list-query.ts`)

| Parameter | Bounds | Default | Invalid input |
|---|---|---|---|
| `q` | 1–200 chars after trim (required on search) | `""` | 400 |
| `kind` | Comma-separated subset of `Movie,Series,Episode,Video` (case-insensitive, deduplicated) | all kinds | 400 |
| `year` | Integer 1878–2100 | unset | 400 |
| `limit` | Integer 1–50 | 24 | 400 |
| `offset` | Integer 0–10000 | 0 | 400 |

Validation failures return **400** with:

```json
{ "error": { "code": "invalid_query", "field": "limit", "message": "limit must be an integer between 1 and 50." } }
```

## GET /api/search

- `q` is required (whitespace-only is rejected).
- Response: `{ source, query, items, total, limit, offset }`.
- `source` is `jellyfin` when credentials are configured, otherwise
  `demo` (demo-safe behavior: missing credentials search the demo
  library; they never touch the network).
- Deterministic identity: results are sorted upstream by `SortName`
  ascending, deduplicated by item `Id`, and paged with `StartIndex`/
  `Limit`. The same query + filters + page always yields the same
  items in the same order.
- Upstream failure: **502** with `{ "error": { "code": "upstream_unavailable", ... } }`
  — never a silent empty list.
- Client disconnect / upstream abort: **408** with an empty body.

## GET /api/library

- Optional `sections`: comma-separated subset of the known section
  titles (`Continue Watching, Recently Added, Movies, Shows,
  Home Videos`; case-insensitive). Unknown sections are a 400.
- Optional `limit`: bounds every returned section to at most `limit`
  items (1–50).
- Response: the library payload (`source`, `hero`, `sections`), with
  `degraded: true` added when Jellyfin was expected to serve the
  request but the route fell back to demo data. Missing credentials
  return plain demo data with no `degraded` flag (demo mode, not
  degradation).
- Both demo and live payloads honor `sections`/`limit` so the
  contract is identical in either mode.

## Client behavior (`src/components/ReelHouseApp.tsx`)

- Debounced (220 ms) search with `AbortController` cancellation on
  new input, filter change, clear, and unmount.
- Sequence guard: only the most recently issued request may commit
  results, so a late stale response can never overwrite fresh ones.
- Explicit states: `Searching…`, `No matches for “…”`, and an error
  panel with Retry; a degraded library chip appears when the payload
  is flagged `degraded`, and a banner with Retry appears when
  `/api/library` itself fails.
- Load-more paging appends pages and deduplicates by `id`; the button
  reports remaining matches and disappears when the result set is
  exhausted.

## Testing

`npm test` runs vitest: unit tests for the shared parser, route
tests for both API routes in demo and Jellyfin modes (bounded
determinism, filters, 400/408/502 paths), and jsdom interaction
tests for the search/library UI (loading, empty, error+retry,
cancellation, stale-response ordering, load-more dedupe).
