# ReelHouse

A private, household media interface for Synology NAS users. ReelHouse uses Jellyfin as the open-source media engine and supplies a custom TV-friendly web experience on top.

## Why this architecture

- Jellyfin handles media indexing, metadata, FFmpeg transcoding, hardware acceleration, subtitles, users and playback state.
- ReelHouse owns the household experience: presentation, profiles, recommendations, home-video organization, automation and future AI features.
- The web UI can run on a Synology DiskStation in Docker/Container Manager and is reachable by any browser on the LAN.
- Existing Jellyfin TV clients can be used immediately while dedicated ReelHouse TV clients are developed later.

## Phase 1 included

- Dark amber streaming UI
- Household profiles for V’Ali and Nicole
- Continue Watching / Recently Added / Movies / Shows rails
- Search
- Metadata detail modal
- Jellyfin library connection with demo fallback
- Docker Compose for Synology
- Read-only media mounts
- Optional /dev/dri hardware transcoding passthrough

## Synology quick start

1. Install **Container Manager** in DSM.
2. Copy this folder to something like `/volume1/docker/reelhouse`.
3. Edit `docker-compose.yml` and point the three `/volume1/video/...` mappings at your real media folders.
4. From that folder run:

   ```bash
   docker compose up -d jellyfin
   ```

5. Open `http://YOUR-NAS-IP:8096`, finish Jellyfin setup, add the mounted libraries, and create the household users.
6. Create a Jellyfin API key under Dashboard → Advanced → API Keys. Get the user ID from the Jellyfin API or admin UI tooling.
7. Copy `.env.example` to `.env` and fill in `JELLYFIN_API_KEY`, `JELLYFIN_USER_ID`, and the browser-facing `NEXT_PUBLIC_JELLYFIN_URL`.
8. Start the full stack:

   ```bash
   docker compose up -d --build
   ```

9. Browse to `http://YOUR-NAS-IP:3210`.

## TV strategy

### Immediately
Use a smart-TV browser for ReelHouse, or a standard Jellyfin TV client for direct playback.

### Next
Add a proper TV remote/focus mode and installable PWA.

### Later
Build thin clients for Android TV / Fire TV first, then Apple TV / Roku / Samsung / LG as needed. All clients use the same ReelHouse/Jellyfin backend.

## Planned capabilities

1. Native playback inside ReelHouse with signed server-side playback sessions.
2. Profile-specific resume state and watchlists.
3. Automatic home-video grouping by date/event/location.
4. Collections, playlists, favorites and smart shelves.
5. Subtitle/audio-track controls and quality selection.
6. Media-health dashboard (duplicates, broken files, missing posters, codec compatibility).
7. Synology-aware hardware-transcoding setup wizard.
8. Optional AI semantic search over household video metadata, e.g. “show our Santorini sunset videos.”
9. TV remote navigation and 10-foot UI.
10. Optional remote access without exposing the NAS directly.

## Development & verification

Local development and deterministic verification run on Node 22+ with no
credentials — the UI serves the built-in demo library when the Jellyfin
env vars are unset (and when `DATABASE_URL` is unset; see
[docs/DATABASE.md](docs/DATABASE.md)):

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build && npm start
```

Then check `GET /` (app shell), `GET /api/library`,
`GET /api/search?q=`, and `GET /api/health` (database readiness). See
[docs/BASELINE.md](docs/BASELINE.md) for the full imported-source
baseline: deployment mapping, data authorities, and the PostgreSQL 18
migration surface.

## Database schema & migrations

The `reelhouse` PostgreSQL 18 schema is versioned and forward-only:

```bash
npm run db:migrate              # apply pending migrations (DATABASE_URL)
npm run db:migrate:dry-run      # print the plan, change nothing
npm run db:smoke                # end-to-end smoke: connect + migrate + pool + transactions
npm run test:db:up              # disposable PostgreSQL 18 for tests
npm test && npm run test:db     # unit + migration/smoke integration suites
npm run test:db:down            # discard the disposable database
```

See [docs/MIGRATIONS.md](docs/MIGRATIONS.md) for the model, history
verification, and rollback/recovery policy, and
[docs/DB_SMOKE.md](docs/DB_SMOKE.md) for the end-to-end smoke runbook
(including the pre-acceptance gate for the production Synology database).

## Backup and disaster recovery

```bash
npm run db:backup -- --out <dir>            # snapshot reelhouse and/or media_catalog
npm run db:restore-verify -- --from <dir>   # prove the backup restores into a scratch
npm run db:restore-verify -- --from <dir> --offline   # manifest + files only
```

The `reelhouse` database holds household state that exists nowhere else —
back it up and verify the backup regularly. `media_catalog` is rebuildable
from Jellyfin via `catalog:rebuild`, so a backup there is an optimization,
not the recovery. Verification restores into a disposable `rh_restore_*`
scratch database and never touches production. Full runbook:
[docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md).

## Media catalog sync

The separate `media_catalog` PostgreSQL 18 database mirrors Jellyfin
library metadata through the Jellyfin API (never its internal database):

```bash
npm run catalog:migrate          # apply catalog migrations (MEDIA_CATALOG_DATABASE_URL)
npm run catalog:sync             # incremental scan
npm run catalog:sync:full        # full scan; computes non-destructive retirement
npm run catalog:rebuild          # wipe catalog content and rebuild from Jellyfin
```

Identity, provenance, freshness, quarantine of ambiguous identities, and
the retirement policy are documented in
[docs/CATALOG_SYNC.md](docs/CATALOG_SYNC.md). The sync fails closed on
missing credentials and never writes to Jellyfin or to the `reelhouse`
database.

## Household state API

ReelHouse-owned household state persists in the `reelhouse` PostgreSQL 18
database and is served to clients only through the ReelHouse API, never
through direct database access:

- **Profiles & per-profile state** (`/api/profiles…`): profiles, per-profile
  preferences, the watch/continue-watching overlay, and Jellyfin account
  links; progress writes are transactional, support safe retries via
  `Idempotency-Key`, refuse stale (older-timestamped) progress, and collapse
  duplicate playback events; `POST /api/profiles/{id}/watch-state/reconcile`
  folds the linked Jellyfin account's resumable items into the overlay with
  last-writer-wins by event time (Jellyfin is never written).
- **Lists & home rows** (`/api/favorites`, `/api/watchlists`,
  `/api/collections`, `/api/home-rows`): durable favorites, watchlists,
  curated collections, and home-screen row configuration with SQL-enforced
  profile isolation (foreign rows read as 404) and `Idempotency-Key` replay
  protection that returns the original response byte-for-byte.

Every response message is bounded and value-free.
See [docs/HOUSEHOLD_STATE.md](docs/HOUSEHOLD_STATE.md) for the route
contracts, identity rules, ordering semantics, and error semantics.

## Security note

Media is mounted read-only. Do not expose ports 8096 or 3210 directly to the public Internet. Use a VPN such as Tailscale for remote access.
