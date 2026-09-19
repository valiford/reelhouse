-- ReelHouse migration 0007: watch/continue state and the playback overlay.
--
-- watch_state is ReelHouse-owned "where am I" state per profile and item:
-- exactly one row per pair. Jellyfin remains the playback engine; this is
-- the ReelHouse-owned overlay (resume points, completion) per
-- docs/ARCHITECTURE.md, and a future sync may seed it from Jellyfin's
-- read-only UserData without ever writing to Jellyfin.
--
-- playback_event is the append-only history overlay where ReelHouse owns
-- the record. Rows are never updated, only inserted, so history survives
-- watch_state corrections.

CREATE TABLE watch_state (
    profile_id      uuid NOT NULL REFERENCES household_profile (id) ON DELETE CASCADE,
    media_ref_id    uuid NOT NULL REFERENCES media_item_ref (id) ON DELETE CASCADE,
    position_ticks  bigint NOT NULL DEFAULT 0 CHECK (position_ticks >= 0),
    duration_ticks  bigint CHECK (duration_ticks IS NULL OR duration_ticks > 0),
    completed       boolean NOT NULL DEFAULT false,
    last_played_at  timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, media_ref_id),
    CHECK (duration_ticks IS NULL OR position_ticks <= duration_ticks)
);

-- The Continue Watching query: this profile's in-progress items, newest
-- activity first. Partial keeps the hot path tiny.
CREATE INDEX watch_state_resume_idx
    ON watch_state (profile_id, last_played_at DESC)
    WHERE completed = false AND position_ticks > 0;

CREATE INDEX watch_state_media_ref_idx ON watch_state (media_ref_id);

-- Append-only; recorded_by carries the provenance of who observed the play.
CREATE TABLE playback_event (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    profile_id     uuid NOT NULL REFERENCES household_profile (id) ON DELETE CASCADE,
    media_ref_id   uuid NOT NULL REFERENCES media_item_ref (id) ON DELETE CASCADE,
    played_at      timestamptz NOT NULL DEFAULT now(),
    position_ticks bigint NOT NULL DEFAULT 0 CHECK (position_ticks >= 0),
    duration_ticks bigint CHECK (duration_ticks IS NULL OR duration_ticks > 0),
    completed      boolean NOT NULL DEFAULT false,
    recorded_by    text NOT NULL DEFAULT 'reelhouse'
                   CHECK (recorded_by IN ('reelhouse', 'jellyfin_import')),
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX playback_event_profile_played_idx
    ON playback_event (profile_id, played_at DESC);
CREATE INDEX playback_event_media_ref_idx ON playback_event (media_ref_id);

CREATE TRIGGER watch_state_set_updated_at
    BEFORE UPDATE ON watch_state
    FOR EACH ROW EXECUTE FUNCTION reelhouse_set_updated_at();
