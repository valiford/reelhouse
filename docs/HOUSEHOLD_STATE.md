# Household state persistence (RH-0018)

How ReelHouse persists favorites, watchlists, curated collections, and
home-screen row configuration in the `reelhouse` PostgreSQL 18 database,
and how the API exposes them. Not in scope: connection/pooling mechanics
([DATABASE.md](DATABASE.md)), the schema/migration machinery
([MIGRATIONS.md](MIGRATIONS.md)), profile CRUD and watch-state persistence
(RH-0017), catalog sync ([CATALOG_SYNC.md](CATALOG_SYNC.md)).

## Layout

| Path | Role |
|---|---|
| `src/lib/household/model.ts` | Pure request model: validation, bounds, media identity, fingerprints. Unit-tested, no I/O |
| `src/lib/household/errors.ts` | Error codes and the code → HTTP status mapping; unknown errors collapse to 503 |
| `src/lib/household/store.ts` | Persistence over the RH-0003 schema. Takes any `QueryExecutor`; multi-step ops run in `withTransaction()` |
| `src/lib/household/idempotency.ts` | `Idempotency-Key` claim/replay machinery, atomic with the mutation |
| `src/lib/household/http.ts` | Route plumbing: handler wrapper, body framing, mutation rendering |
| `src/app/api/favorites`, `watchlists`, `collections`, `home-rows` | The API routes (all `force-dynamic`) |
| `db/migrations/0010_idempotency_responses.sql` | Stored replay responses for `idempotency_record` |

The lib deliberately avoids `server-only` and the `@/` alias so tests run
under plain Node; the server boundary stays in `src/lib/db/pool.ts`, which
routes import. Database credentials therefore remain server-side, and
PostgreSQL is never exposed to clients.

## Data authorities

- `reelhouse` owns everything in this document. Profiles are rows in
  `household_profile`; this layer validates they exist but does not manage
  them (RH-0017's job).
- Media identity is a `(source, external_id)` pair resolved through
  `media_item_ref` — ReelHouse-owned identity mapping. Jellyfin ids are
  data here, never identity, and Jellyfin is never contacted by this layer.
  Writes resolve-or-create the ref; reorder/remove operations require it to
  exist (a stale client referencing unknown media gets a 404).
- Jellyfin remains the playback/library authority; nothing here writes to
  it or reads its internal database.

## Endpoints

| Endpoint | Methods | Scope |
|---|---|---|
| `/api/favorites` | GET (`profileId`, `limit`), POST, DELETE | profile |
| `/api/watchlists` | GET (`profileId`), POST | profile |
| `/api/watchlists/{id}` | GET, PATCH (`name`), DELETE | profile |
| `/api/watchlists/{id}/items` | POST (`media`, `position?`), PUT (`ordered`), DELETE | profile |
| `/api/collections` | GET, POST (`name`, `description?`, `createdByProfileId?`) | household |
| `/api/collections/{id}` | GET, PATCH, DELETE | household |
| `/api/collections/{id}/items` | POST, PUT, DELETE | household |
| `/api/home-rows` | GET, POST (`rowKey`, `title`, `source`, `position?`) | household |
| `/api/home-rows/{id}` | PATCH (`title?`/`isEnabled?`/`source?`), DELETE | household |
| `/api/home-rows/order` | PUT (`orderedIds`) | household |

Media payloads address items as `{"source": "jellyfin", "id": "<id>"}`.
Home-row sources pair exactly one identifier with their kind:
`{"kind": "jellyfin_section", "sourceKey": "..."}` or
`{"kind": "collection", "collectionId": "<uuid>"}` — mirroring the
`home_row` CHECK. Deleting a collection cascades its membership and any
home row sourced from it; the CHECK-plus-FK design means a row can never
dangle.

## Ordering semantics

- Item positions need not be contiguous. Reads order by
  `(position, added_at, media_ref_id)` for deterministic ties.
- POST items without `position` appends; with `position` it splices (rows
  at or after the target shift). POSTing an item that is already a member
  without `position` is a no-op that reports its current slot; with a
  position it MOVES the member. Fresh inserts return 201, no-ops/moves 200.
- Reorder (PUT) is a full permutation of current membership in one
  transaction. A submitted set that differs from current membership is
  409 `stale_order_set` with counts in the detail — the recovery path is
  re-read then resubmit, and a rejected reorder changes nothing.
- Home rows follow the same rules; `row_key` is a stable lowercase slug
  (`continue_watching` style), and a duplicate create returns the existing
  row unmodified (`created: false`), never overwrites it.

## Profile isolation

Every profile-scoped operation names its `profileId` (query parameter for
GET/DELETE/PATCH, body field for POST) and fails closed on unknown profiles
(`profile_not_found`). Ownership is enforced in the same SQL statement
(`WHERE id = $1 AND profile_id = $2`), so another profile's rows are
indistinguishable from absent ones: 404, never a 403 existence leak, and
never a write. Collections and home rows are household-level by design
(curation is shared); their creator column is provenance only.

## Idempotency

All mutations are idempotent twice over:

1. **Naturally** — unique keys (`favorite` PK, watchlist/collection name
   uniqueness, `row_key`, member PKs) make repeats converge on the same
   state.
2. **By key** — a mutation carrying an `Idempotency-Key` header (1–200
   printable ASCII chars) commits one `idempotency_record` row — scope,
   key, fingerprint of the normalized request, and the exact success
   response — in the SAME transaction as the mutation. A replay with the
   same key and matching fingerprint returns the ORIGINAL status and body
   byte-for-byte plus `Idempotency-Replayed: true`; the same key with a
   different fingerprint is 409 `idempotency_key_reuse`. Scopes
   (`favorites.add`, `watchlists.items.reorder`, …) keep unrelated
   operations from colliding on a client key.

Because record and mutation commit atomically, a crash can never leave a
done-marker without its effect or vice versa, and a failed attempt does
not consume the key. Stored responses are success-only and bounded (8 KiB,
schema-enforced by the 0010 CHECK). Replays of deletes return the original
success even though the resource has since gone — that is the guarantee.

## Error contract

Failures return `{"error": {"code", "message", "detail?"}}` with:

| Code | HTTP | When |
|---|---|---|
| `validation_failed` | 400 | any malformed/out-of-bounds input |
| `profile_not_found` | 404 | unknown profile |
| `media_ref_not_found` | 404 | media unknown to ReelHouse on a read-side op |
| `watchlist_not_found` / `collection_not_found` / `home_row_not_found` | 404 | absent or foreign (isolation) |
| `duplicate_watchlist` / `duplicate_collection` | 409 | strict rename/create collision |
| `stale_order_set` | 409 | reorder set ≠ current membership |
| `idempotency_key_reuse` | 409 | key reused with a different fingerprint |
| `idempotency_state_invalid` | 500 | impossible record state; fail closed |
| `database_unavailable` | 503 | any other error (driver detail logged, redacted, never returned) |

## Bounded contracts

Request bodies ≤ 64 KiB; names/titles ≤ 200 chars, descriptions ≤ 2000,
external ids and idempotency keys ≤ 200, positions 1–1,000,000;
`limit` defaults to 200 and caps at 500; reorder payloads ≤ 500 entries;
stored idempotent responses ≤ 8 KiB JSON objects. List endpoints have
deterministic order. Diagnostics are bounded (log lines capped at 2000
chars) and redacted through the RH-0002 helpers.

## Trust model note

The household API trusts the caller to name the acting profile — there is
no authentication yet. This matches the current LAN deployment posture;
authentication/authorization hardening is future work (RH-0006 /
security upgrade track), and the SQL-level isolation here is the layer
that authorization will tighten, not replace.
