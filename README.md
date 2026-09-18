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
env vars are unset:

```bash
npm install
npm run lint
npm run typecheck
npm run build && npm start
```

Then check `GET /` (app shell), `GET /api/library`, and
`GET /api/search?q=`. See [docs/BASELINE.md](docs/BASELINE.md) for the
full imported-source baseline: deployment mapping, data authorities,
and the PostgreSQL 18 migration surface.

## Security note

Media is mounted read-only. Do not expose ports 8096 or 3210 directly to the public Internet. Use a VPN such as Tailscale for remote access.
