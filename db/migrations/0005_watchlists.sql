-- ReelHouse migration 0005: watchlists and their items.
-- Each profile owns named watchlists; items carry an explicit position so
-- the UI can offer ordering. Positions need not be contiguous (splicing
-- must not require rewriting every row); readers order by
-- (position, added_at, media_ref_id) for deterministic ties.

CREATE TABLE watchlist (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    profile_id uuid NOT NULL REFERENCES household_profile (id) ON DELETE CASCADE,
    name       text NOT NULL CHECK (btrim(name) <> ''),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX watchlist_profile_name_key
    ON watchlist (profile_id, lower(name));

CREATE TABLE watchlist_item (
    watchlist_id uuid NOT NULL REFERENCES watchlist (id) ON DELETE CASCADE,
    media_ref_id uuid NOT NULL REFERENCES media_item_ref (id) ON DELETE CASCADE,
    position     integer NOT NULL CHECK (position > 0),
    added_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (watchlist_id, media_ref_id)
);

CREATE INDEX watchlist_item_order_idx
    ON watchlist_item (watchlist_id, position, added_at);
CREATE INDEX watchlist_item_media_ref_idx ON watchlist_item (media_ref_id);

CREATE TRIGGER watchlist_set_updated_at
    BEFORE UPDATE ON watchlist
    FOR EACH ROW EXECUTE FUNCTION reelhouse_set_updated_at();
