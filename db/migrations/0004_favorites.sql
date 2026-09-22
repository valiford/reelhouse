-- RH-0027 migration 0004: favorites.
-- A favorite is the (profile, media) pair itself; the composite primary
-- key enforces uniqueness without a surrogate id.

CREATE TABLE favorite (
    profile_id   uuid NOT NULL
                 REFERENCES household_profile (id) ON DELETE CASCADE,
    media_ref_id uuid NOT NULL
                 REFERENCES media_item_ref (id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, media_ref_id)
);

-- Serves "which profiles favorited this item" (e.g. badge rendering).
CREATE INDEX favorite_media_ref_idx ON favorite (media_ref_id);
