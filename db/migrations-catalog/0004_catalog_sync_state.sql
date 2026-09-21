-- media_catalog migration: sync operational state.
--
-- Operational bookkeeping for the Jellyfin -> media_catalog sync
-- (docs/CATALOG_SYNC.md), kept in THIS database on purpose: it describes the
-- catalog, must be atomic with catalog writes, and a rebuild of the reelhouse
-- database must never cost the catalog its cursor (and vice versa).
--
-- catalog_scan is the freshness/audit record: one row per run, bounded
-- counts, redacted error. catalog_sync_state holds the resumable cursor.
-- catalog_quarantine holds ambiguous identities verbatim so a human (or a
-- later job) can resolve them; the sync never merges quarantined data.

CREATE TABLE catalog_scan (
    id                 uuid PRIMARY KEY DEFAULT uuidv7(),
    mode               text NOT NULL CHECK (mode IN ('incremental', 'full', 'rebuild')),
    status             text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    started_at         timestamptz NOT NULL DEFAULT now(),
    finished_at        timestamptz,
    -- Bounded outcome counts (see the engine for exact semantics).
    libraries_seen     integer NOT NULL DEFAULT 0,
    items_seen         integer NOT NULL DEFAULT 0,
    items_upserted     integer NOT NULL DEFAULT 0,
    items_unchanged    integer NOT NULL DEFAULT 0,
    items_missing      integer NOT NULL DEFAULT 0,
    items_retired      integer NOT NULL DEFAULT 0,
    items_quarantined  integer NOT NULL DEFAULT 0,
    items_skipped      integer NOT NULL DEFAULT 0,
    -- Bounded (truncated) and redacted failure detail; never carries secrets.
    error              text,
    CONSTRAINT catalog_scan_finished_shape CHECK (
        (status = 'running') = (finished_at IS NULL)
        AND (status = 'failed') = (error IS NOT NULL)
    )
);

CREATE INDEX catalog_scan_started_idx ON catalog_scan (started_at DESC);

CREATE TABLE catalog_sync_state (
    -- One row per sync job name (e.g. 'jellyfin_catalog').
    job               text PRIMARY KEY CHECK (btrim(job) <> ''),
    -- Per-library incremental cursor: {"libraries": {"<external_id>":
    -- {"since": "<iso>"}}}. Reset by rebuild.
    cursor            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cursor) = 'object'),
    last_started_at   timestamptz,
    last_succeeded_at timestamptz,
    last_error        text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER catalog_sync_state_set_updated_at
    BEFORE UPDATE ON catalog_sync_state
    FOR EACH ROW EXECUTE FUNCTION catalog_set_updated_at();

-- Ambiguous identities: the engine refuses to guess. A quarantined item is
-- NOT written to the catalog; its payload snapshot lands here instead.
CREATE TABLE catalog_quarantine (
    id                uuid PRIMARY KEY DEFAULT uuidv7(),
    source            text NOT NULL CHECK (source IN ('jellyfin')),
    external_id       text NOT NULL CHECK (btrim(external_id) <> ''),
    reason            text NOT NULL,
    -- Human-relevant facts (provider/value contested, missing parent id...).
    detail            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
    -- Verbatim mapped payload at detection time, for resolution without
    -- re-querying the source.
    payload           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    first_detected_at timestamptz NOT NULL DEFAULT now(),
    last_detected_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at       timestamptz,
    CONSTRAINT catalog_quarantine_reason_check
      CHECK (reason IN ('duplicate_provider_id', 'duplicate_external_id', 'orphan_parent', 'invalid_item', 'library_conflict')),
    UNIQUE (source, external_id, reason)
);

CREATE INDEX catalog_quarantine_open_idx ON catalog_quarantine (resolved_at) WHERE resolved_at IS NULL;
