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
- Search with bounded pagination, type filters, and explicit empty/error states
- Metadata detail modal
- Jellyfin library connection with demo fallback and automatic reconnection (unavailable / stale / reconnecting / recovery states)
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
ReelHouse ships a built-in TV remote mode: arrow keys drive spatial focus across the top bar, hero, rails, search, and detail modal; Enter activates; Back/Escape (including webOS 461, Tizen GoBack, and Fire TV 10009 key codes) closes the topmost layer; focus rings appear only while navigating by remote/keyboard. Large living-room displays pick up a denser 10-foot layout automatically. Use a smart-TV browser for ReelHouse, or a standard Jellyfin TV client for direct playback.

### Next
Add an installable PWA, fullscreen TV player, and inactivity handling.

### Now included: remote keyboard and focus navigation

The web UI is remote-first: arrow keys drive spatial focus across the
topbar, hero, rails, cards, search, and detail modal; Enter/OK
activates; Escape/Back closes the topmost layer (modal → search →
profile menu) and never leaves the app; focus rings appear only while
keyboard/remote navigation is active. See
[docs/TV_NAVIGATION.md](docs/TV_NAVIGATION.md) for the key map, focus
rules, and test coverage.

### Later
Build thin clients for Android TV / Fire TV first, then Apple TV / Roku / Samsung / LG as needed. All clients use the same ReelHouse/Jellyfin backend.

## Media engine connection states

The UI treats the ReelHouse Engine (the server-side Jellyfin API layer)
as a live connection with explicit states, so a slow, unreachable, or
misbehaving Jellyfin never shows up as a silent blank page:

- **Connecting** — the first library load is in flight.
- **Connected** — Jellyfin served the library; a quiet health refresh
  runs every 60 s so later outages are detected without user
  interaction.
- **Unavailable** — the engine did not answer (or answered with
  malformed data) and there is nothing better to show: demo titles
  stand in, a banner names the bounded failure reason, and an
  automatic reconnect cycle starts.
- **Stale** — the engine dropped while engine data was already on
  screen: the last synced library stays visible (amber banner + chip)
  instead of being swapped for demo titles, and the reconnect cycle
  runs.
- **Reconnecting** — retries follow a bounded backoff ladder
  (2 s → 4 s → 8 s → 16 s → 30 s cap) with the attempt count shown on
  the source chip; manual Retry stays available at any time.
- **Recovery** — the first good answer after a degraded period ends
  the cycle, refreshes the data, and flashes a transient “Reconnected”
  chip before settling back to Connected.

Every engine request also carries a 12 s client deadline, so a hung
Jellyfin degrades into an explicit state rather than an endless
spinner. Diagnostics stay bounded and redacted: only short
status-style messages are surfaced to the UI, never URLs, payloads, or
household queries.

## Planned capabilities

1. Native playback inside ReelHouse with signed server-side playback sessions.
2. Profile-specific resume state and watchlists.
3. Automatic home-video grouping by date/event/location.
4. Collections, playlists, favorites and smart shelves.
5. Subtitle/audio-track controls and quality selection.
6. Media-health dashboard (duplicates, broken files, missing posters, codec compatibility).
7. Synology-aware hardware-transcoding setup wizard.
8. Optional AI semantic search over household video metadata, e.g. “show our Santorini sunset videos.”
9. TV remote navigation and 10-foot UI. *(focus-navigation shell shipped; player and PWA pending)*
10. Optional remote access without exposing the NAS directly.

## Development & verification

Local development and deterministic verification run on Node 22+ with no
credentials — the UI serves the built-in demo library when the Jellyfin
env vars are unset:

```bash
npm install
npm run lint
npm run typecheck
npm run test
npm run build && npm start
```

`npm run test` runs the deterministic vitest suite (spatial navigation
engine, TV interaction shell, bounded search/library contract, and
search-results resilience paths) with no network or credentials
required. Then check `GET /` (app shell), `GET /api/library`, and
`GET /api/search?q=`. The bounded search/library request contract is
documented in
[docs/SEARCH_LIBRARY_CONTRACT.md](docs/SEARCH_LIBRARY_CONTRACT.md). See
[docs/BASELINE.md](docs/BASELINE.md) for the full imported-source
baseline: deployment mapping, data authorities, and the PostgreSQL 18
migration surface.

## Security note

Media is mounted read-only. Do not expose ports 8096 or 3210 directly to the public Internet. Use a VPN such as Tailscale for remote access.
