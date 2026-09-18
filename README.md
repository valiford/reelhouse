# ReelHouse

ReelHouse is the household media experience layer for the Synology-hosted media stack.

## Architecture direction

- **Jellyfin** remains the media playback/transcoding/library engine.
- **ReelHouse** owns household-facing application state and UX.
- **PostgreSQL 18 on the Synology** is the shared server database platform.
- Database `reelhouse` stores ReelHouse-owned application state.
- Database `media_catalog` stores normalized media/library catalog data and stable mappings to Jellyfin items.
- Browser/mobile clients never receive PostgreSQL credentials and never connect directly to PostgreSQL.
- ReelHouse talks to PostgreSQL through its server-side API/data layer and talks to Jellyfin through the Jellyfin API.

## Repository bootstrap

The current production/development source tree exists on the Synology at:

`/volume1/docker/reelhouse`

See [docs/IMPORT_EXISTING_SOURCE.md](docs/IMPORT_EXISTING_SOURCE.md) before copying or pushing that tree into this repository.

## Z-Code

Autonomous work is controlled under `.zcode-worker/`. Workers may claim only READY, automation-eligible jobs whose dependencies are satisfied and which do not already have a branch/worktree lease.

No worker may deploy, release, alter production credentials, expose PostgreSQL directly to the Internet, or replace Jellyfin's internal database.
