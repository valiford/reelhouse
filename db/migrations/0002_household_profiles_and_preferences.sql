-- ReelHouse migration 0002: household profiles and per-profile preferences.
-- A profile is a household member (the persistent home for what the UI
-- hardcodes today). Identity is a surrogate UUID assigned by ReelHouse;
-- nothing here derives from Jellyfin's internal row ids.

CREATE TABLE household_profile (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    display_name text NOT NULL CHECK (btrim(display_name) <> ''),
    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Names are unique case-insensitively ("vali" and "V'Ali" must not coexist).
CREATE UNIQUE INDEX household_profile_display_name_key
    ON household_profile (lower(display_name));

CREATE TABLE profile_preferences (
    profile_id  uuid PRIMARY KEY REFERENCES household_profile (id) ON DELETE CASCADE,
    -- Preferences are free-form key/value JSON objects for now; a JSON
    -- object is enforced so callers cannot smuggle arrays or scalars in.
    preferences jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(preferences) = 'object'),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER household_profile_set_updated_at
    BEFORE UPDATE ON household_profile
    FOR EACH ROW EXECUTE FUNCTION reelhouse_set_updated_at();

CREATE TRIGGER profile_preferences_set_updated_at
    BEFORE UPDATE ON profile_preferences
    FOR EACH ROW EXECUTE FUNCTION reelhouse_set_updated_at();
