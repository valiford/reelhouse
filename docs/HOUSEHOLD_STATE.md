# Household state persistence (RH-0017)

How ReelHouse-owned household state — profiles, per-profile preferences,
the watch/continue-watching overlay, Jellyfin account links, the stable
media-item bridge, and sync metadata — is persisted in the PostgreSQL 18
`reelhouse` database through the server API.

Scope of this document: the persistence API added by RH-0017. Not in
scope: the schema and migrations themselves (RH-0003 — see
[MIGRATIONS.md](MIGRATIONS.md)), the connection layer
([DATABASE.md](DATABASE.md)), favorites/watchlists/collections/home rows
(RH-0018), and catalog data (RH-0016 —
[CATALOG_SYNC.md](CATALOG_SYNC.md)).

## Authorities and boundaries

- Everything here is **ReelHouse-owned state**. Jellyfin is never written;
  its user ids and item ids are stored as **data**, never as identity, and
  no Jellyfin token is ever persisted (the account link stores the user id
  only).
- Clients (TV / browser / mobile) reach this state only through the
  ReelHouse API routes below. PostgreSQL is never exposed to clients, and
  the routes never fall back to demo data: an unconfigured or rejected
  database is a `503`, never degraded state.
- The media bridge is `media_item_ref (source, external_id)` — the stable
  join key RH-0018+ will reuse. Deleting a profile cascades to everything
  it owns (preferences, watch state, playback history, link); Jellyfin and
  `media_catalog` are untouched.

## Layout

| Path | Role |
|---|---|
| `src/lib/household/validate.ts` | Pure request validation. Value-free bounded errors; mirrors the database CHECKs |
| `src/lib/household/errors.ts` | Typed store errors + SQLSTATE classification (unique→conflict, FK→missing, CHECK→input) |
| `src/lib/household/store.ts` | All SQL. Injected runner, no `server-only`, type-only pg import — drivable from routes and plain-Node tests |
| `src/lib/household/api.ts` | The single error→response mapper and the bounded JSON body reader |
| `src/app/api/profiles/**` | The route handlers (thin glue: parse → store → respond) |
| `src/lib/household/household.test.ts` | Unit suite (validation, classification, mapping, scripted runners) |
| `src/lib/household/household.int.test.ts` | Integration suite on the disposable PG18 (`reelhouse_household_test` database, created on demand) |

## HTTP API

All routes are dynamic (`force-dynamic`). Errors share one envelope:
`{"error":{"code","message"}}` with codes `invalid_request` (400),
`not_found` (404), `conflict` (409), `database_unavailable` (503), and
`internal_error` (500). Messages are bounded and value-free; the raw
`DATABASE_URL` is scrubbed from anything echoed.

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

### Recording watch progress

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

### Continue Watching semantics

`?mode=continue` is exactly the shape of the `watch_state_resume_idx`
partial index: `completed = false AND position_ticks > 0`, newest
`last_played_at` first, hard-bounded. Marking progress `completed: true`
drops the item from the rail; a later in-progress write returns it.

## Sync metadata (library-level, intentionally not HTTP)

`sync_cursor` and `idempotency_record` are persisted through
`src/lib/household/store.ts` (`markSyncStarted`, `markSyncSucceeded`,
`markSyncFailed`, `claimIdempotencyKey`) for reconciliation jobs
(the household-side counterpart to the catalog sync; the watch-progress
idempotency above is their first in-API consumer). Semantics:

- `markSyncStarted` upserts the job row; an explicit cursor replaces the
  stored one, an absent cursor preserves it.
- `markSyncSucceeded` stamps `last_succeeded_at` and clears `last_error`;
  `markSyncFailed` writes a **bounded** error (≤ 2000 chars) and never
  clears `last_succeeded_at` — the cursor keeps telling the truth about the
  last good run.
- `claimIdempotencyKey` claims-or-replays on the UNIQUE `(scope, key)`
  pair; a same-key/different-fingerprint replay raises a conflict.

## Roles and privileges

The API runtime role needs **DML only** on the household tables plus
SELECT on `media_item_ref` (`INSERT` included); migrations keep requiring a
DDL-capable role (see [MIGRATIONS.md](MIGRATIONS.md)). Provisioning remains
an operator task — see the RH-0015 findings and
[DB_SMOKE.md](DB_SMOKE.md) for the gated production commands.

## Verification

```bash
npm test            # unit: validation, classification, mapping, scripted runners
npm run test:db:up  # disposable PostgreSQL 18
npm run test:db     # includes household.int.test.ts (own reelhouse_household_test DB)
npm run test:db:down
```

The integration suite covers: profile CRUD and cascade deletion,
case-insensitive duplicate names, preferences replacement (and the
database CHECK backstop), stable media-ref resolution, the link's 1:1 and
uniqueness rules, atomic progress writes and rollback (media ref included),
missing-profile and CHECK-violation classification, the continue-watching
filter/order/limit, per-profile scoping, the sync lifecycle
(start/succeed/fail/recover with bounded errors), and idempotent
claim/replay/conflict semantics.
