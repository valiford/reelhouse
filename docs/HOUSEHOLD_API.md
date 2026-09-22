# ReelHouse household persistence API (RH-0027)

The household API wires ReelHouse-owned state to PostgreSQL 18: profiles,
per-profile preferences, favorites, watchlists, curated collections, the
continue-watching overlay, the append-only playback history, and Jellyfin
item/account links — with profile isolation enforced in SQL. All endpoints
are server-side only (`src/app/api/**`); clients never see PostgreSQL
credentials or SQL, and Jellyfin is never contacted by this layer.

Data authorities stay separate: the `reelhouse` database owns household
state, `media_catalog` owns the normalized Jellyfin mirror, and Jellyfin
remains the playback/library authority. Household rows reference media as a
`(source, external_id)` pair stored in `media_item_ref` — identity that
survives catalog rebuilds — and are deliberately NOT validated against
`media_catalog` on write (the catalog is rebuildable; household refs are the
durable anchor).

## Module layout

| Path | Role |
|---|---|
| `src/lib/household/errors.ts` | Typed errors + SQLSTATE classification (`classifyPgError`). |
| `src/lib/household/validate.ts` | Pure request validation for profile/preferences/watch-state payloads (400s before PostgreSQL is touched). |
| `src/lib/household/model.ts` | Pure request model for list payloads: names, media refs, positions, limits, body framing, fingerprints. |
| `src/lib/household/store.ts` | Profiles, preferences, Jellyfin links, media refs, watch state, idempotency claims; injected `SqlRunner` so tests drive the same functions. |
| `src/lib/household/lists.ts` | Favorites, watchlists, collections, positioned items, splice/reorder semantics. |
| `src/lib/household/api.ts` | The single error exit: bounded, value-free messages; 503 when the database is unconfigured. |
| `src/lib/household/http.ts` | `householdHandler` wrapper, bounded JSON body reads, atomic `runWrite`. |

## Endpoints

| Method + path | Purpose |
|---|---|
| `GET /api/profiles?includeInactive=1&limit=` | List profiles (active only by default, bounded). |
| `POST /api/profiles` `{ displayName, preferences? }` | Create; 201, or 409 on a case-insensitive duplicate name. |
| `GET /api/profiles/{id}` | One profile (with preferences). |
| `PATCH /api/profiles/{id}` `{ displayName?, isActive? }` | Rename and/or deactivate. |
| `DELETE /api/profiles/{id}` | Delete; cascades every owned row (preferences, favorites, watchlists, watch state, history, link). |
| `GET/PUT /api/profiles/{id}/preferences` | Read / full-replace the jsonb preference object. |
| `GET/PUT/DELETE /api/profiles/{id}/jellyfin-link` | The 1:1 Jellyfin account link (user id only; no tokens are ever stored). |
| `GET /api/profiles/{id}/watch-state?mode=all\|continue&limit=` | The overlay; `continue` is the Continue Watching rail (in-progress, newest first). |
| `PUT /api/profiles/{id}/watch-state` `{ source, externalId, positionTicks, durationTicks?, completed? }` | Record progress: upserts the overlay AND appends one history event, atomically. See idempotency below. |
| `GET/POST/DELETE /api/favorites` | List (`?profileId=`), add (`{ profileId, media: { source, id } }`), remove (`?profileId=&mediaSource=&mediaId=`). |
| `GET/POST /api/watchlists` | List (`?profileId=`) / create (`{ profileId, name }`). |
| `GET/PATCH/DELETE /api/watchlists/{id}?profileId=` | Detail (items in read order) / rename / delete. |
| `POST/PUT/DELETE /api/watchlists/{id}/items?profileId=` | Add-or-move (`{ media, position? }`), atomic reorder (`{ ordered: [media...] }`), remove. |
| `GET/POST /api/collections` | Household-level lists / create (`{ name, description?, createdByProfileId? }`; creator is provenance only). |
| `GET/PATCH/DELETE /api/collections/{id}` | Detail / rename-redescribe / delete (cascades items). |
| `POST/PUT/DELETE /api/collections/{id}/items` | Same positioned-item contract as watchlists. |

## Contracts

- **Profile isolation.** Every profile-owned row is addressed by an
  `(id, profile_id)` pair, and every route validates the profile first.
  Another profile's rows answer 404 — never 403 — so existence never leaks.
  `requireProfile` guards the routes; the schema's foreign keys back it up.
- **Bounded reads/writes.** List reads take `limit` (refused, not clamped,
  when out of range); request bodies are capped at 64 KiB; names, external
  ids, preferences, and positions have explicit contract limits; error
  messages never echo rejected input.
- **Media identity.** Writes resolve-or-create `media_item_ref`
  `(source, external_id)`; reads of favorites/lists require the ref to exist.
  `source` is `'jellyfin'` only; widening it is a migration.
- **Positions.** An explicit position splices (neighbors shift); an absent
  position appends; reads order by `(position, added_at, media_ref_id)`.
  Reorder renumbers 1..n atomically and refuses (409) any submitted set that
  does not exactly equal current membership — stale clients reload instead of
  corrupting order.
- **Idempotent progress.** `PUT /api/profiles/{id}/watch-state` accepts an
  `Idempotency-Key` header (≤200 printable ASCII chars). The first write
  claims `(scope, key)` with a fingerprint of the normalized payload in the
  same transaction as the mutation; a replay with the same payload returns
  the stored overlay state with `idempotentReplay: true` and appends NO
  history event; the same key with a different payload is a 409.
- **Errors.** One shape everywhere: `{ error: { code, message } }` with codes
  `invalid_request` (400), `not_found` (404), `conflict` (409),
  `database_unavailable` (503, fail-closed — no demo fallback), and
  `internal_error` (500, redacted message in the log only).

## Verification

- Hermetic unit tests: `npm test` (`src/lib/household/household.test.ts`).
- Deterministic PostgreSQL evidence: `npm run test:int` runs
  `household.int.test.ts` (migrations, profiles, preferences, links, watch
  state, replay, isolation, cascade, least privilege) and
  `lists.int.test.ts` (favorites, watchlists, collections, positions,
  reorder conflicts, isolation) against the disposable dev database — each
  in its own freshly provisioned database (`reelhouse_rh0027_test`,
  `reelhouse_rh0027_lists_test`) so parallel suites never fight.
