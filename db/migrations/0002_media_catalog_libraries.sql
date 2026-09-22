-- RH-0031: media catalog — Jellyfin libraries.
--
-- The media catalog (the media_* table family) owns normalized catalog state
-- synchronized FROM Jellyfin through its HTTP API. Jellyfin remains the
-- playback/library authority; these rows are a provenance-preserving mirror,
-- never a source of truth.
--
-- Stable identity: (source, jellyfin_id). Jellyfin item GUIDs are stable, so
-- re-running a sync upserts the same rows instead of creating new ones.
-- Freshness: synced_at / last_seen_at are advanced only by a sync that
-- actually confirmed the row against Jellyfin; first_seen_at is set once and
-- never rewritten. Removals are tombstones (removed_at), never deletes, so
-- history and household references survive library churn.
--
-- Tables stay in schema public on purpose: migration 0001's default
-- privileges make every owner-created public table DML-accessible to the
-- least-privilege application role automatically.

CREATE TABLE public.media_libraries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source          text NOT NULL DEFAULT 'jellyfin',
  jellyfin_id     text NOT NULL,
  name            text NOT NULL,
  collection_type text,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  CONSTRAINT media_libraries_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT media_libraries_source_jellyfin_id_key UNIQUE (source, jellyfin_id)
);

CREATE INDEX media_libraries_active_idx
  ON public.media_libraries (removed_at)
  WHERE removed_at IS NULL;
