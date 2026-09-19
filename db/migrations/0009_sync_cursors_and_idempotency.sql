-- ReelHouse migration 0009: sync cursors and idempotency metadata.
-- Operational state for reconciliation jobs (RH-0004's Jellyfin sync and
-- beyond): where each job left off, and which external operations already
-- ran so replays are no-ops instead of duplicates.

CREATE TABLE sync_cursor (
    id                uuid PRIMARY KEY DEFAULT uuidv7(),
    -- One row per reconciliation job (e.g. 'jellyfin_library_sync').
    job               text NOT NULL UNIQUE CHECK (btrim(job) <> ''),
    cursor            jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(cursor) = 'object'),
    last_started_at   timestamptz,
    last_succeeded_at timestamptz,
    last_error        text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_record (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    -- Namespace separating unrelated jobs that could collide on a key.
    scope           text NOT NULL CHECK (btrim(scope) <> ''),
    idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
    -- Optional hash of the request the key committed, for replay detection.
    fingerprint     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (scope, idempotency_key)
);

CREATE TRIGGER sync_cursor_set_updated_at
    BEFORE UPDATE ON sync_cursor
    FOR EACH ROW EXECUTE FUNCTION reelhouse_set_updated_at();
