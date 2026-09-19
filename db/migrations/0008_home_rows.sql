-- ReelHouse migration 0008: home-screen row configuration.
-- The home screen's fixed sections (Continue Watching, Recently Added,
-- Movies, Shows at baseline) become configurable rows. A row pulls from
-- exactly one source: a Jellyfin section or a curated collection — the
-- pairing CHECK makes the source unambiguous.

CREATE TABLE home_row (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    -- Stable row identifier used by the UI (e.g. 'continue_watching').
    row_key       text NOT NULL UNIQUE CHECK (btrim(row_key) <> ''),
    title         text NOT NULL CHECK (btrim(title) <> ''),
    source_kind   text NOT NULL CHECK (source_kind IN ('jellyfin_section', 'collection')),
    -- Identifier within the source authority (Jellyfin section id);
    -- NULL for collections, which point at collection_id instead.
    source_key    text CHECK (source_key IS NULL OR btrim(source_key) <> ''),
    collection_id uuid REFERENCES collection (id) ON DELETE CASCADE,
    position      integer NOT NULL CHECK (position > 0),
    is_enabled    boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CHECK ((source_kind = 'collection') = (collection_id IS NOT NULL))
);

CREATE INDEX home_row_position_idx ON home_row (position);

CREATE TRIGGER home_row_set_updated_at
    BEFORE UPDATE ON home_row
    FOR EACH ROW EXECUTE FUNCTION reelhouse_set_updated_at();
