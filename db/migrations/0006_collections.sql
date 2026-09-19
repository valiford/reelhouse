-- ReelHouse migration 0006: curated collections and their items.
-- Collections are household-level curation. Their creator is recorded as
-- provenance only: ON DELETE SET NULL so deleting a profile never
-- destroys the household's collections.

CREATE TABLE collection (
    id                    uuid PRIMARY KEY DEFAULT uuidv7(),
    name                  text NOT NULL CHECK (btrim(name) <> ''),
    description           text NOT NULL DEFAULT '',
    created_by_profile_id uuid REFERENCES household_profile (id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX collection_name_key ON collection (lower(name));

CREATE TABLE collection_item (
    collection_id uuid NOT NULL REFERENCES collection (id) ON DELETE CASCADE,
    media_ref_id  uuid NOT NULL REFERENCES media_item_ref (id) ON DELETE CASCADE,
    position      integer NOT NULL CHECK (position > 0),
    added_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (collection_id, media_ref_id)
);

CREATE INDEX collection_item_order_idx
    ON collection_item (collection_id, position, added_at);
CREATE INDEX collection_item_media_ref_idx ON collection_item (media_ref_id);

CREATE TRIGGER collection_set_updated_at
    BEFORE UPDATE ON collection
    FOR EACH ROW EXECUTE FUNCTION reelhouse_set_updated_at();
