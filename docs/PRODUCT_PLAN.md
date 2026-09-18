# ReelHouse Product Plan

## Product goal

A private Netflix-style household media system that runs on the Synology home network and keeps personal media under household control.

## Architecture

```text
TV / Browser / Tablet / Phone
          |
          v
   ReelHouse UI :3210
          |
          v
  Jellyfin media engine :8096
      |       |       |
      |       |       +-- Watch state / users / metadata
      |       +---------- FFmpeg transcode / subtitles
      +------------------ Synology read-only media folders
```

Jellyfin is deliberately treated as an engine, not the product identity. ReelHouse owns household UX and can progressively replace/extend backend functions later where useful.

## Plex-equivalent feature map

| Area | ReelHouse direction | Phase |
|---|---|---|
| Library scanning | Jellyfin recursive libraries + scheduled/realtime scans | 1 |
| Posters / summaries / genres | Jellyfin metadata providers, editable later in ReelHouse | 1 |
| Movies / TV / home videos | Separate libraries and custom rails | 1 |
| Continue watching | Jellyfin user playback state | 1 |
| Household profiles | V’Ali / Nicole profiles, mapped to backend users | 1-2 |
| Search | Jellyfin indexed search | 1 |
| Smart-TV access | Responsive 10-foot web UI + Jellyfin TV clients initially | 1 |
| Native playback | ReelHouse playback sessions / HLS / direct-play selection | 2 |
| Watchlist / favorites | Profile-specific | 2 |
| Collections / playlists | Manual and smart collections | 2 |
| Subtitles / audio tracks | Playback controls | 2 |
| Hardware transcoding | Intel QSV / VA-API where Synology supports it | 2 |
| Remote access | Tailscale first; no raw NAS exposure | 2 |
| TV remote navigation | Spatial focus + remote key handling | 2 |
| Home-video intelligence | Event/date/location grouping; optional face labels | 3 |
| Semantic search | “Show Santorini sunset clips” / “football Saturdays” | 3 |
| Duplicate/media health | Codec, corrupt file, duplicate, missing-art dashboard | 3 |
| Native TV apps | Android TV / Fire TV first; others based on household need | 3 |

## Product principles

1. **Local-first.** Playback and metadata work without a cloud subscription.
2. **Read-only media access.** ReelHouse/Jellyfin should not mutate original video files.
3. **TV first.** Every interaction must work from ten feet away with directional controls.
4. **Household profiles.** Recommendations, history and watchlists are personal.
5. **No vendor lock-in.** Media remains ordinary files; metadata/export should stay portable.
6. **Safe remote access.** Prefer Tailscale/VPN over exposing NAS ports.

## Near-term implementation sequence

### Phase 1A — Runnable household catalog
- Synology Docker Compose
- Jellyfin engine
- ReelHouse homepage and search
- Library rails
- Profiles
- Detail view
- Demo fallback

### Phase 1B — Real playback
- Authenticate profiles against Jellyfin
- Create signed playback-session endpoints
- Direct Play when codec/container is supported
- HLS transcode fallback
- Resume-position writes
- Audio/subtitle selection

### Phase 1C — TV ergonomics
- Arrow-key / remote spatial navigation
- Focus rings and enlarged controls
- Fullscreen player optimized for TV
- Installable PWA
- Wake-lock and inactivity handling

## Naming candidates

- **ReelHouse** — recommended; clear household ownership and media meaning.
- **Flamingo Reel** — personal tie to the existing FlamingoData NAS name.
- **HomeFrame** — more polished, broader than movies.
- **ReelNest** — friendly household/media feel.
- **ScreenVault** — stronger “private media library” positioning.

