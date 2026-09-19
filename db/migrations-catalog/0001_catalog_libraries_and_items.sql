-- media_catalog migration 0001: libraries, items, and provider identifiers.
--
-- This is the media_catalog database (docs/ARCHITECTURE.md): normalized
-- catalog data mirrored from authoritative media sources. The reelhouse
-- database is a DIFFERENT database on the same PostgreSQL 18 service and
-- owns household state; nothing here references it. The logical bridge
-- between the two is (source, external_id), exactly the pair stored by
-- reelhouse.media_item_ref.
--
-- Identity rule: a catalog row's identity is (source, external_id). The
-- Jellyfin item id is data here, never a surrogate for one. content_hash is
-- the fingerprint of the mapped payload, so re-syncing unchanged content is
-- a no-op for every content column (only last_seen_at moves).
--
-- Retirement is non-destructive: items that stop appearing in scans are
-- first marked missing_since, then retired_at once the policy threshold is
-- met (enforced by the sync engine, docs/CATALOG_SYNC.md). Rows are never
-- deleted by syncing; only an explicit rebuild (which also never touches
-- Jellyfin) clears catalog content.

CREATE OR REPLACE FUNCTION catalog_set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE catalog_library (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    source              text NOT NULL CHECK (source IN ('jellyfin')),
    external_id         text NOT NULL CHECK (btrim(external_id) <> ''),
    name                text NOT NULL CHECK (btrim(name) <> ''),
    collection_type     text,
    primary_image_tag   text,
    -- Provenance/freshness (same semantics as catalog_item below).
    observed_at         timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    missing_since       timestamptz,
    retired_at          timestamptz,
    content_hash        text NOT NULL CHECK (btrim(content_hash) <> ''),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, external_id)
);

CREATE TABLE catalog_item (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    library_id          uuid NOT NULL REFERENCES catalog_library (id) ON DELETE CASCADE,
    source              text NOT NULL CHECK (source IN ('jellyfin')),
    external_id         text NOT NULL CHECK (btrim(external_id) <> ''),
    kind                text NOT NULL,
    -- Hierarchy inside one database: season -> series, episode -> season
    -- (or series when the episode is not filed under a season). Enforced by
    -- a real FK so an orphaned child can never be committed silently; the
    -- sync quarantines orphans before attempting the write.
    parent_external_id  text,
    name                text NOT NULL CHECK (btrim(name) <> ''),
    sort_name           text,
    original_title      text,
    production_year     integer,
    premiere_date       date,
    overview            text,
    official_rating     text,
    community_rating    numeric(3, 1) CHECK (community_rating IS NULL OR (community_rating >= 0 AND community_rating <= 10)),
    runtime_seconds     integer CHECK (runtime_seconds IS NULL OR runtime_seconds >= 0),
    index_number        integer,
    parent_index_number integer,
    -- File/location facts where the source provides them.
    path                text,
    container           text,
    size_bytes          bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
    date_created        timestamptz,
    -- Presentation datum (tag only; clients compose the URL themselves).
    primary_image_tag   text,
    -- Provenance: first observation, latest observation, and the source
    -- revision this content came from.
    observed_at         timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    source_revision     text,
    -- Retirement state machine (missing_since -> retired_at), engine-driven.
    missing_since       timestamptz,
    retired_at          timestamptz,
    content_hash        text NOT NULL CHECK (btrim(content_hash) <> ''),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, external_id),
    CONSTRAINT catalog_item_kind_check CHECK (kind IN ('movie', 'series', 'season', 'episode')),
    CONSTRAINT catalog_item_kind_parent_check
      CHECK ((kind IN ('season', 'episode')) = (parent_external_id IS NOT NULL)),
    CONSTRAINT catalog_item_retired_requires_missing CHECK (retired_at IS NULL OR missing_since IS NOT NULL),
    CONSTRAINT catalog_item_retired_after_missing CHECK (retired_at IS NULL OR missing_since <= retired_at)
);

-- Children die with their parents (series removed => seasons/episodes gone
-- in a rebuild; a retired series keeps its subtree, retirement is per row).
CREATE INDEX catalog_item_library_idx ON catalog_item (library_id);
CREATE INDEX catalog_item_parent_idx ON catalog_item (source, parent_external_id);
CREATE INDEX catalog_item_kind_idx ON catalog_item (kind);
CREATE INDEX catalog_item_freshness_idx ON catalog_item (last_seen_at);
CREATE INDEX catalog_item_missing_idx ON catalog_item (missing_since) WHERE missing_since IS NOT NULL;

CREATE TRIGGER catalog_item_set_updated_at
    BEFORE UPDATE ON catalog_item
    FOR EACH ROW EXECUTE FUNCTION catalog_set_updated_at();

CREATE TRIGGER catalog_library_set_updated_at
    BEFORE UPDATE ON catalog_library
    FOR EACH ROW EXECUTE FUNCTION catalog_set_updated_at();

-- External/provider identifiers (imdb/tmdb/tvdb/...), one id per provider.
-- The engine quarantines rather than merges when two items claim the same
-- (provider, external_value) — that ambiguity must never be resolved
-- silently — so this stays a plain table with a lookup index, not a unique
-- constraint.
CREATE TABLE catalog_provider_id (
    item_id        uuid NOT NULL REFERENCES catalog_item (id) ON DELETE CASCADE,
    provider       text NOT NULL CHECK (btrim(provider) <> ''),
    external_value text NOT NULL CHECK (btrim(external_value) <> ''),
    PRIMARY KEY (item_id, provider)
);

CREATE INDEX catalog_provider_id_lookup_idx ON catalog_provider_id (provider, external_value);
