# Imported Source Baseline (RH-0001)

Established 2026-09-18 from the Synology deployment tree at
`/volume1/docker/reelhouse` (file copy; original file dates 2025-09-12
preserved). This document is the authoritative inventory of what the
imported application is, how the running deployment maps to repository
paths, which data authorities exist today, and the exact migration
surface the PostgreSQL 18 follow-on jobs (RH-0002–RH-0007) build on.

## Application inventory

| Concern | Baseline finding |
|---|---|
| Framework | Next.js 16.0.1, App Router, `output: "standalone"` |
| UI runtime | React 19.2.0 / react-dom 19.2.0, client component tree rooted at `src/components/ReelHouseApp.tsx` |
| Language | TypeScript 5.9.3, `strict: true`, `@/*` path alias to `src/*` |
| Package manager | npm (`npm install`; `package-lock.json` committed at baseline) |
| Lint | ESLint 9.39.1 flat config + `eslint-config-next` (core-web-vitals + typescript) |
| Node | `node:22-alpine` in Docker; Node 22.x local verification |
| Tests | None present. Verification is lint + typecheck + build + runtime smoke (below) |
| Persistence | **None server-side.** No database client, no writes anywhere in the app |
| State on the client | Ephemeral React state only; no localStorage/sessionStorage |
| Household profiles | Hardcoded UI constants (V'Ali / Nicole) in `ReelHouseApp.tsx`; no backend |
| Watchlist button | Rendered placeholder with no handler — Phase 2 surface, intentionally untouched |

### API boundaries (the only two)

- `GET /api/library` → `src/app/api/library/route.ts` → `getLibrary()` in `src/lib/jellyfin.ts`.
  Returns hero + sections (Continue Watching, Recently Added, Movies, Shows).
- `GET /api/search?q=` → `src/app/api/search/route.ts` → `searchLibrary(term)`.

Both are unauthenticated server-side proxies. Both call Jellyfin
`/Users/{userId}/Items` with the `X-Emby-Token` API-key header and
`cache: "no-store"`. Missing credentials or a Jellyfin error fall back
to the demo dataset (`src/lib/demo.ts`) for the library and to `[]` for
search. Credentials never reach the browser; only
`NEXT_PUBLIC_JELLYFIN_URL` is public by design.

### Jellyfin integration shape (relevant to RH-0004)

- Media identity today is the **raw Jellyfin item Id** used directly as
  `MediaItem.id`, for card keys and for detail-modal deep links into the
  Jellyfin web UI (`/web/index.html#!/details?id=...`). Playback happens
  in Jellyfin, not ReelHouse.
- Images are served from the public Jellyfin URL
  (`/Items/{id}/Images/{Primary|Backdrop}?...`), not stored by ReelHouse.
- Queried metadata: Overview, Genres, ProductionYear, CommunityRating,
  UserData (PlaybackPositionTicks / PlayedPercentage). Genres are the
  only taxonomy surfaced; people/studios are not requested today.
- Resume ("Continue Watching") is read via `IsResumable: "true"` —
  watch state is read-only from Jellyfin; ReelHouse never writes it.

## Synology deployment → repository mapping

| Synology location | Repository path | Role |
|---|---|---|
| `/volume1/docker/reelhouse` | repository root | Compose project directory |
| `/volume1/docker/reelhouse/jellyfin-config` | `jellyfin-config/` (gitignored) | Jellyfin `/config`: internal SQLite DB, metadata, plugins, logs, library root definitions |
| `/volume1/docker/reelhouse/jellyfin-cache` | `jellyfin-cache/` (gitignored) | Jellyfin `/cache`: transcode temp, image caches |
| `/volume1/video/Movies` | compose arg | `/media/movies:ro` inside the Jellyfin container |
| `/volume1/video/TV` | compose arg | `/media/tv:ro` |
| `/volume1/video/HomeVideos` | compose arg | `/media/home:ro` |
| `.env` beside `docker-compose.yml` | `.env` (gitignored; `.env.example` tracked) | `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `JELLYFIN_USER_ID`, `NEXT_PUBLIC_JELLYFIN_URL` |

Ports: Jellyfin `8096:8096`; ReelHouse UI `3210:3000` (container `next
start` standalone server). The UI container reaches Jellyfin at
`http://jellyfin:8096` over the Compose network.

## Secrets and runtime data exclusion (verified)

- No `.env` exists in the checkout; only `.env.example` (blank values).
- `.gitignore` covers `.env`, `.env.*` (`!.env.example`), `secrets/`,
  `*.pem|*.key|*.p12`, `node_modules/`, `.next/`, `data/`, `cache/`.
- RH-0001 added `jellyfin-config/` and `jellyfin-cache/` (617 MB of
  Jellyfin-owned runtime state) and generated build outputs
  (`next-env.d.ts`, `tsconfig.tsbuildinfo`) to `.gitignore`.
- Committed tree contains no secrets, media files, databases, caches,
  logs, or generated runtime state.

## Verification (deterministic, no credentials required — demo mode)

```bash
npm install
npm run lint        # eslint .
npm run typecheck   # tsc --noEmit  (script added at baseline)
npm run build       # next build
npm start           # then:
#   GET /                 -> 200, app shell
#   GET /api/library      -> {"source":"demo", ...}
#   GET /api/search?q=X   -> {"items":[...]}
```

All four commands pass at baseline (2026-09-18, Node 22.19.0 /
npm 10.9.3). Runtime smoke was executed against the production build:
`/` returned 200 with the app shell; `/api/library` returned the demo
payload; `/api/search?q=santorini` matched the demo "Santorini" item.

## Data authorities today

| Authority | Owns | Where |
|---|---|---|
| Jellyfin | user accounts/auth, library metadata, playback, continue-watching state, internal SQLite database | `jellyfin-config/jellyfin.db` and Jellyfin's schema — **off-limits to ReelHouse schema coupling** |
| ReelHouse | nothing yet — read-only proxy views of Jellyfin; UI state only | future `reelhouse` + `media_catalog` PostgreSQL 18 databases |
| Browser | ephemeral UI state only | no storage APIs used |
| Flat files | media itself, read-only | `/volume1/video/*` mounts |

This matches the authority separation in `docs/ARCHITECTURE.md`; the
imported source does not yet violate or implement the PostgreSQL half.

## PostgreSQL 18 migration surface (for RH-0002 / RH-0003 / RH-0004)

Per `docs/ARCHITECTURE.md`, two databases on the Synology PostgreSQL 18
service. Exact first-pass surface derived from this codebase:

**`reelhouse` (household application state)**

- household profiles — first persistent home for the hardcoded
  V'Ali / Nicole UI constants; profile switching is client-side today
- preferences
- favorites and watchlists — today the "＋ Watchlist" button is a no-op
- curated collections; home-screen row configuration (sections are
  currently fixed in `getLibrary()`: Continue Watching / Recently Added
  / Movies / Shows)
- ReelHouse-owned watch/continue state (currently read-only from
  Jellyfin `UserData`)
- recommendations + recommendation evidence
- Jellyfin account/item links
- sync cursors and operational state

**`media_catalog` (normalized catalog)**

- media items; movies, series, seasons, episodes
- files and library locations — initial sources are the three read-only
  mounts (`/media/movies`, `/media/tv`, `/media/home`)
- people, genres, studios (only genres are surfaced today)
- external/provider identifiers — none persisted today; the Jellyfin
  item Id is the sole identity in the system
- Jellyfin item mappings — must absorb the existing raw-Id usage
  (`MediaItem.id`, card keys, deep links) as the stable identity
- scan/import history; catalog provenance/freshness

**Connection rule to preserve:** clients never receive PostgreSQL
credentials; the API routes are the only server-side boundary, and the
same env-var pattern as the Jellyfin credentials (`JELLYFIN_*`) is the
natural home for future `DATABASE_URL`-style configuration.

## Known risks recorded at baseline (not fixed here)

1. **next@16.0.1 is flagged by npm as vulnerable (CVE-2025-66478).**
   Upgrading can change product behavior and belongs in a dedicated,
   human-approved follow-up job — deliberately not done at baseline.
2. eslint 9.39.1 is no longer supported upstream; cosmetic for now.
3. No automated test suite; verification is lint/typecheck/build/smoke.
4. API routes are unauthenticated (acceptable on the LAN for Phase 1A;
   RH-0006 owns bounded read/write contracts).
5. `searchLibrary` swallows Jellyfin errors and returns `[]`
   (indistinguishable from "no results"); note for RH-0006.
6. `next.config.ts` allows all http/https image hosts; unused today (the
   UI renders images via CSS backgrounds, not `next/image`).
