# Household state persistence (RH-0017 + RH-0018)

How ReelHouse-owned household state — profiles, per-profile preferences,
the watch/continue-watching overlay, Jellyfin account links, favorites,
watchlists, curated collections, home-screen row configuration, the stable
media-item bridge, and sync metadata — is persisted in the PostgreSQL 18
`reelhouse` database through the server API.

Scope of this document: the household persistence API (RH-0017 profile /
preference / watch-state surface and RH-0018 lists / home-rows surface,
integrated on one shared kernel). Not in scope: the schema and migrations
themselves (RH-0003 — see [MIGRATIONS.md](MIGRATIONS.md)), the connection
layer ([DATABASE.md](DATABASE.md)), and catalog data (RH-0016 —
[CATALOG_SYNC.md](CATALOG_SYNC.md)).

## Authorities and boundaries

- Everything here is **ReelHouse-owned state**. Jellyfin is never written
  and never contacted by these libraries; its user ids and item ids are
  stored as **data**, never as identity, and no Jellyfin token is ever
  persisted (the account link stores the user id only).
- Clients (TV / browser / mobile) reach this state only through the
  ReelHouse API routes below. PostgreSQL is never exposed to clients, and
  the routes never fall back to demo data: an unconfigured or rejected
  database is a `503`, never degraded state.
- The media bridge is `media_item_ref (source, external_id)` — the stable
  join key shared by both surfaces. Deleting a profile cascades to
  everything it owns (preferences, watch state, playback history, link,
  favorites, watchlists); Jellyfin and `media_catalog` are untouched.
- Profile-scoped reads/writes are isolated in SQL: rows are addressed by
  `(id, profile_id)`, so another profile's rows are indistinguishable from
  absent ones (404, never a 403 existence leak, never a write).

## Layout

| Path | Role |
|---|---|
| `src/lib/household/validate.ts` | Pure request validation for the RH-0017 surface. Value-free bounded errors; mirrors the database CHECKs |
| `src/lib/household/model.ts` | Pure request model for the RH-0018 surface: bounds, media identity, home-row source pairing, idempotency keys, canonical fingerprints |
| `src/lib/household/errors.ts` | Typed store errors + SQLSTATE classification (unique→conflict, FK→missing, CHECK→input) — the ONE error family both surfaces throw |
| `src/lib/household/store.ts` | The RH-0017 kernel: all SQL for profiles/preferences/watch-state/links, `transact()`, `resolveMediaRef()`, `claimIdempotencyKey()`, sync metadata. Injected runner, no `server-only`, type-only pg import |
| `src/lib/household/lists.ts` | RH-0018 domain SQL (favorites/watchlists/collections/home-rows) built on the same kernel |
| `src/lib/household/idempotency.ts` | `runIdempotentMutation()`: claim + mutation + stored replay response in one transaction (RH-0018 endpoints) |
| `src/lib/household/api.ts` | The single error→response mapper and the bounded JSON body reader |
| `src/lib/household/http.ts` | Route wrapper for the RH-0018 routes (funnels into the same mapper) |
| `src/app/api/profiles/**`, `src/app/api/{favorites,watchlists,collections,home-rows}/**` | The route handlers (thin glue: parse → store → respond) |
| `src/lib/household/household.test.ts`, `model.test.ts` | Unit suites (validation, classification, mapping, scripted runners; RH-0018 bounds/fingerprints) |
| `src/lib/household/household.int.test.ts`, `household-lists.int.test.ts` | Integration suites on the disposable PG18 (own databases, created on demand) |
| `db/migrations/0010_idempotency_responses.sql` | Stored replay responses for `idempotency_record` (RH-0018, additive) |

## HTTP API

All routes are dynamic (`force-dynamic`). Errors share one envelope:
`{"error":{"code","message"}}` with codes `invalid_request` (400),
`not_found` (404), `conflict` (409), `database_unavailable` (503), and
`internal_error` (500). Messages are bounded and value-free; the raw
`DATABASE_URL` is scrubbed from anything echoed.

### Profiles & per-profile state (RH-0017)

| Route | Method | Purpose |
|---|---|---|
| `/api/profiles` | GET | List active profiles (`?includeInactive=1`, `?limit=` ≤ 200, default 100), display-name order |
| `/api/profiles` | POST | Create `{displayName, preferences?}` → 201; case-insensitive duplicate name → 409 |
| `/api/profiles/{id}` | GET | One profile with its preferences; 404 when absent |
| `/api/profiles/{id}` | PATCH | Rename and/or activate/deactivate `{displayName?, isActive?}` |
| `/api/profiles/{id}` | DELETE | Hard delete; cascades to all owned state → 204 |
| `/api/profiles/{id}/preferences` | GET | The profile's preferences object |
| `/api/profiles/{id}/preferences` | PUT | **Full replacement** of the preferences object (no merge semantics); must be a JSON object ≤ 16 KB / depth 32 |
| `/api/profiles/{id}/watch-state` | GET | All watch state for the profile (`?mode=all\|continue`, `?limit=`; `continue` = the Continue Watching rail: in-progress only, newest activity first, default 20 / max 50) |
| `/api/profiles/{id}/watch-state` | PUT | Record progress (see below) |
| `/api/profiles/{id}/jellyfin-link` | GET | The 1:1 Jellyfin account link (`{link: … \| null}`) |
| `/api/profiles/{id}/jellyfin-link` | PUT | Upsert `{jellyfinUserId}`; a user id claimed by another profile → 409 |
| `/api/profiles/{id}/jellyfin-link` | DELETE | Remove the link → 204 |

#### Recording watch progress

`PUT /api/profiles/{id}/watch-state` with:

```json
{
  "source": "jellyfin",
  "externalId": "<jellyfin item id>",
  "positionTicks": 300,
  "durationTicks": 6000,
  "completed": false
}
```

- `durationTicks` and `completed` are optional (`completed` defaults to
  `false`; a `null` duration is "unknown"). `positionTicks` must not exceed
  `durationTicks` — enforced in validation (400) and again by a database
  CHECK as the backstop.
- The `(source, external_id)` pair is resolved to a stable
  `media_item_ref` id, created on first sight (race-safe: the UNIQUE pair
  decides; a lost insert re-reads the winner).
- One transaction writes the overlay upsert **and** the append-only
  `playback_event`. Failure rolls back everything, including the media ref;
  corrections rewrite `watch_state`, never history.
- **Idempotent retries:** send an `Idempotency-Key` header (≤ 200 chars).
  The same key with the same payload replays without appending duplicate
  history (the response carries `"idempotentReplay": true`); the same key
  with a different payload is a `409`. The fingerprint is a SHA-256 over
  the canonical semantic input, so whitespace/reformatting differences in
  the request do not create false conflicts.

#### Continue Watching semantics

`?mode=continue` is exactly the shape of the `watch_state_resume_idx`
partial index: `completed = false AND position_ticks > 0`, newest
`last_played_at` first, hard-bounded. Marking progress `completed: true`
drops the item from the rail; a later in-progress write returns it.

### Favorites, watchlists, collections & home rows (RH-0018)

Media payloads address items as `{"source": "jellyfin", "id": "<id>"}` and
are resolved through the same `media_item_ref` bridge (resolve-or-create on
writes; require on reorders/removals — a stale client referencing unknown
media gets a 404). Home-row sources pair exactly one identifier with their
kind: `{"kind": "jellyfin_section", "sourceKey": "…"}` or
`{"kind": "collection", "collectionId": "<uuid>"}` — mirroring the
`home_row` CHECK. Deleting a collection cascades its membership and any
home row sourced from it.

| Route | Method | Purpose |
|---|---|---|
| `/api/favorites` | GET | The profile's favorites (`?profileId=`, `?limit=` default 200 / max 500), oldest first |
| `/api/favorites` | POST | Add `{profileId, media}` → 201; already favorited → 200 `{created:false}` |
| `/api/favorites` | DELETE | Remove (`?profileId=&mediaSource=&mediaId=`) → `{removed}` |
| `/api/watchlists` | GET / POST | List the profile's watchlists / create `{profileId, name}` (case-insensitive duplicate → tolerant existing return) |
| `/api/watchlists/{id}` | GET / PATCH / DELETE | Detail with ordered items / rename (strict: collision → 409) / delete with items |
| `/api/watchlists/{id}/items` | POST / PUT / DELETE | Add-or-move (`{media, position?}`) / atomic reorder (`{ordered:[…]}`) / remove |
| `/api/collections` | GET / POST | Household-level collections / create `{name, description?, createdByProfileId?}` |
| `/api/collections/{id}` | GET / PATCH / DELETE | Detail / rename+description (strict) / delete (cascades membership + sourced home rows) |
| `/api/collections/{id}/items` | POST / PUT / DELETE | Membership, same positioned-item semantics |
| `/api/home-rows` | GET / POST | Home-screen rows in display order / create `{rowKey, title, source, position?}` |
| `/api/home-rows/{id}` | PATCH / DELETE | Update `{title?, isEnabled?, source?}` / delete |
| `/api/home-rows/order` | PUT | Atomic reorder `{orderedIds:[…]}` |

`profileId` is a query parameter on GET/DELETE/PATCH and a body field on
POST; unknown profiles fail closed with 404.

#### Ordering semantics

- Item positions need not be contiguous. Reads order by
  `(position, added_at, media_ref_id)` for deterministic ties.
- POST items without `position` appends; with `position` it splices (rows
  at or after the target shift). POSTing an existing member without a
  position is a no-op that reports its current slot; with a position it
  MOVES the member. Fresh inserts return 201, no-ops/moves 200.
- Reorder (PUT) is a full permutation of current membership in one
  transaction. A submitted set that differs from current membership is a
  409 with counts in the message — the recovery path is re-read then
  resubmit, and a rejected reorder changes nothing.
- Home rows follow the same rules; `row_key` is a stable lowercase slug
  (`continue_watching` style), and a duplicate create returns the existing
  row unmodified (`created: false`), never overwrites it.

#### Idempotent retries (RH-0018 endpoints)

Every list/home-row mutation accepts an `Idempotency-Key` header (≤ 200
printable ASCII chars). The claim row — scope, key, fingerprint of the
normalized request, and the exact success response — commits in the SAME
transaction as the mutation:

- a crash can never orphan one side of the pair, and a failed attempt does
  not consume the key;
- a replay with the same key and matching fingerprint returns the ORIGINAL
  status and body byte-for-byte plus `Idempotency-Replayed: true` (it does
  not re-execute);
- the same key with a different fingerprint is a 409 (client bug, never a
  silent wrong replay); scopes (`favorites.add`,
  `watchlists.items.reorder`, …) keep unrelated operations apart.

Stored responses are success-only, JSON-object, ≤ 8 KiB — enforced by the
database CHECK from migration 0010, not convention. Without a key the
mutation still runs in one transaction and relies on the schema's natural
idempotency (unique keys, tolerant creates). The RH-0017 watch-progress
endpoint shares the same `idempotency_record` table with its own documented
body-flag replay shape (above); this stored-response pattern is canonical
for the RH-0018 endpoints.

## Sync metadata (library-level, intentionally not HTTP)

`sync_cursor` and `idempotency_record` are persisted through
`src/lib/household/store.ts` (`markSyncStarted`, `markSyncSucceeded`,
`markSyncFailed`, `claimIdempotencyKey`) for reconciliation jobs
(the household-side counterpart to the catalog sync; the watch-progress
and list-mutation idempotency above are their in-API consumers). Semantics:

- `markSyncStarted` upserts the job row; an explicit cursor replaces the
  stored one, an absent cursor preserves it.
- `markSyncSucceeded` stamps `last_succeeded_at` and clears `last_error`;
  `markSyncFailed` writes a **bounded** error (≤ 2000 chars) and never
  clears `last_succeeded_at` — the cursor keeps telling the truth about the
  last good run.
- `claimIdempotencyKey` claims-or-replays on the UNIQUE `(scope, key)`
  pair; a same-key/different-fingerprint replay raises a conflict.

## Bounded contracts

Request bodies ≤ 64 KiB; names/titles ≤ 200 chars, descriptions ≤ 2000,
external ids and idempotency keys ≤ 200, positions 1–1,000,000; favorites
`limit` default 200 / max 500; reorder payloads ≤ 500 entries; preferences
objects ≤ 16 KB / depth 32; stored idempotent responses ≤ 8 KiB JSON
objects. Log lines are capped and redacted through the RH-0002 helpers.

## Trust model note

The household API trusts the caller to name the acting profile — there is
no authentication yet. This matches the current LAN deployment posture;
authentication/authorization hardening is future work (RH-0006 / security
upgrade track), and the SQL-level isolation here is the layer that
authorization will tighten, not replace.

## Roles and privileges

The API runtime role needs **DML only** on the household tables plus
SELECT on `media_item_ref` (`INSERT` included); migrations keep requiring a
DDL-capable role (see [MIGRATIONS.md](MIGRATIONS.md)). Provisioning remains
an operator task — see the RH-0015 findings and
[DB_SMOKE.md](DB_SMOKE.md) for the gated production commands.

## Verification

```bash
npm test            # unit: validation, classification, mapping, scripted runners, RH-0018 bounds/fingerprints
npm run test:db:up  # disposable PostgreSQL 18
npm run test:db     # includes household.int.test.ts (reelhouse_household_test)
                    # and household-lists.int.test.ts (reelhouse_household_lists_test)
npm run test:db:down
```

The integration suites cover: profile CRUD and cascade deletion,
case-insensitive duplicate names, preferences replacement (and the
database CHECK backstop), stable media-ref resolution, the link's 1:1 and
uniqueness rules, atomic progress writes and rollback (media ref included),
missing-profile and CHECK-violation classification, the continue-watching
filter/order/limit, per-profile scoping, the sync lifecycle
(start/succeed/fail/recover with bounded errors), and idempotent
claim/replay/conflict semantics; plus favorites/watchlists/collections/
home-rows durability, duplicate creates, splice/move/reorder, stale-set
rejection, isolation, cascades, replay byte-equality, key-reuse conflicts,
mid-transaction rollback with key recovery, and the response-size CHECK.
