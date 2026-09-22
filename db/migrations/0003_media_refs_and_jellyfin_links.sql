-- RH-0027 migration 0003: stable media identity and Jellyfin account links.
--
-- media_item_ref is the ONLY bridge between ReelHouse-owned state and
-- externally-sourced media. It stores the source authority plus that
-- authority's external id as text, so Jellyfin item ids are data here,
-- never identity. Household rows reference media_item_ref.id, which stays
-- stable even if the external id is later remapped, and which survives
-- media_catalog rebuilds (the catalog is a separate database; this bridge
-- is deliberately not validated against it on write).
--
-- jellyfin_account_link ties a household profile to a Jellyfin user id.
-- It is 1:1 in both directions. Jellyfin access tokens are credentials:
-- they are deliberately NOT stored here.

CREATE TABLE media_item_ref (
    id          uuid PRIMARY KEY DEFAULT uuidv7(),
    -- The provenance authority. Extending this domain is a migration.
    source      text NOT NULL CHECK (source IN ('jellyfin')),
    external_id text NOT NULL CHECK (btrim(external_id) <> ''),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, external_id)
);

CREATE TABLE jellyfin_account_link (
    id               uuid PRIMARY KEY DEFAULT uuidv7(),
    profile_id       uuid NOT NULL UNIQUE
                     REFERENCES household_profile (id) ON DELETE CASCADE,
    jellyfin_user_id text NOT NULL UNIQUE CHECK (btrim(jellyfin_user_id) <> ''),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER jellyfin_account_link_set_updated_at
    BEFORE UPDATE ON jellyfin_account_link
    FOR EACH ROW EXECUTE FUNCTION reelhouse_set_updated_at();
