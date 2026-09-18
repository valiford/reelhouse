# ReelHouse Architecture

## Product boundary

ReelHouse is the household media experience layer. Jellyfin remains the playback/transcoding/library engine.

ReelHouse must not couple its own schema to Jellyfin's internal SQLite schema. Integration with Jellyfin is through the supported Jellyfin API and stable external IDs.

## PostgreSQL 18

The Synology-hosted PostgreSQL 18 service is the server database platform.

### reelhouse database

Owns household/application state:

- users and household profiles
- preferences
- favorites
- watchlists
- curated collections
- home-screen row configuration
- watch/continue state owned by ReelHouse
- recommendations and recommendation evidence
- Jellyfin account/item links
- sync cursors and operational state

### media_catalog database

Owns normalized catalog/inventory data:

- media items
- movies, series, seasons, episodes
- files and library locations
- people, genres, studios
- external/provider identifiers
- Jellyfin item mappings
- scan/import history
- catalog provenance/freshness

## Connection rule

Clients never connect directly to PostgreSQL.

```
TV / Browser / Mobile
        |
        v
   ReelHouse UI
        |
        v
   ReelHouse API
     |       |
     |       +----> Jellyfin API
     |
     +------------> PostgreSQL 18
                    |- reelhouse
                    `- media_catalog
```

Database credentials remain server-side. PostgreSQL port exposure must not be added merely to support clients.

## Recovery principle

The catalog must be rebuildable from authoritative media/Jellyfin sources. Household-owned state in `reelhouse` requires tested backup and restore.
