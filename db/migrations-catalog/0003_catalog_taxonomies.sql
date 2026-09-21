-- media_catalog migration: taxonomies — genres, people, studios.
--
-- Normalized shared vocabularies extracted from item payloads, plus the
-- per-item join rows. Identity for these is the source's own name (Jellyfin
-- identifies genres/studios/people by name, not id), folded through
-- name_key = lower(btrim(name)) so "Sci-Fi" and "sci-fi " are one row.
-- People keep their source role/character data on the join row because the
-- same person participates in an item in several capacities.
--
-- Join rows are fully rewritten by the sync whenever an item's content hash
-- changes; nothing else ever mutates them.

CREATE TABLE catalog_genre (
    id       uuid PRIMARY KEY DEFAULT uuidv7(),
    name     text NOT NULL CHECK (btrim(name) <> ''),
    name_key text NOT NULL UNIQUE CHECK (btrim(name_key) <> ''),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog_studio (
    id       uuid PRIMARY KEY DEFAULT uuidv7(),
    name     text NOT NULL CHECK (btrim(name) <> ''),
    name_key text NOT NULL UNIQUE CHECK (btrim(name_key) <> ''),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog_person (
    id       uuid PRIMARY KEY DEFAULT uuidv7(),
    name     text NOT NULL CHECK (btrim(name) <> ''),
    name_key text NOT NULL UNIQUE CHECK (btrim(name_key) <> ''),
    -- External ids for people are sparse and provider-dependent; jsonb here,
    -- names elsewhere: a strict table per provider for person ids is not
    -- justified until a consumer needs to query them.
    provider_ids jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_ids) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog_item_genre (
    item_id  uuid NOT NULL REFERENCES catalog_item (id) ON DELETE CASCADE,
    genre_id uuid NOT NULL REFERENCES catalog_genre (id) ON DELETE CASCADE,
    list_order integer NOT NULL CHECK (list_order >= 0),
    PRIMARY KEY (item_id, genre_id)
);

CREATE TABLE catalog_item_studio (
    item_id   uuid NOT NULL REFERENCES catalog_item (id) ON DELETE CASCADE,
    studio_id uuid NOT NULL REFERENCES catalog_studio (id) ON DELETE CASCADE,
    list_order integer NOT NULL CHECK (list_order >= 0),
    PRIMARY KEY (item_id, studio_id)
);

-- list_order is part of the key on purpose: one person can appear twice in
-- an item's people list (two roles), and the order carries "top billing".
CREATE TABLE catalog_item_person (
    item_id   uuid NOT NULL REFERENCES catalog_item (id) ON DELETE CASCADE,
    person_id uuid NOT NULL REFERENCES catalog_person (id) ON DELETE CASCADE,
    list_order integer NOT NULL CHECK (list_order >= 0),
    role_type text CHECK (role_type IN ('actor', 'director', 'writer', 'producer', 'composer', 'guest_star', 'other')),
    role_name text,
    PRIMARY KEY (item_id, person_id, list_order)
);

CREATE INDEX catalog_item_genre_genre_idx ON catalog_item_genre (genre_id);
CREATE INDEX catalog_item_studio_studio_idx ON catalog_item_studio (studio_id);
CREATE INDEX catalog_item_person_person_idx ON catalog_item_person (person_id);
