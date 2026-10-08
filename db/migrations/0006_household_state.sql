-- RH-0033: household state — profiles, preferences, favorites, watchlists,
-- collections, home rows, watch state, playback history, and Jellyfin links.
--
-- The household_* table family owns ReelHouse household state: it is a
-- separate authority from media_catalog (the normalized Jellyfin mirror) and
-- from Jellyfin itself (still the playback/library authority via API only).
-- Rows are written by the idempotent household import, never derived from
-- catalog rows, and never touch Jellyfin's internal database.
--
-- Identity and isolation:
-- - Profiles are identified by `slug` (the contractual identity, derived
--   from the display name once and pinned); renaming a profile never
--   rewrites its rows. Every profile-scoped row carries profile_id, so
--   profile isolation is structural: no household read exists without a
--   profile scope.
-- - Item-scoped rows carry (source, jellyfin_id) as their identity — the
--   same stable Jellyfin identity the catalog uses — plus a nullable
--   provenance link into media_items, filled when the catalog knows the
--   item and kept (COALESCE on upsert) when a later import cannot resolve
--   it. Household references survive catalog churn: media_items are never
--   deleted (tombstones only), so these FKs need no ON DELETE action.
-- - Removal is a tombstone everywhere (removed_at / archived_at), never a
--   delete; re-adding clears the tombstone and preserves first_added_at.
--   Playback history is append-only.
-- - updated_at moves only when content actually changes (the loader's
--   upserts guard with IS DISTINCT), so an idempotent re-import writes
--   nothing at all; freshness lives in household_sync_runs instead.
--
-- Tables stay in schema public on purpose: migration 0001's default
-- privileges make every owner-created public table DML-accessible to the
-- least-privilege application role automatically.

CREATE TABLE public.household_profiles (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug         text NOT NULL,
  display_name text NOT NULL,
  initials     text,
  is_default   boolean NOT NULL DEFAULT false,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT household_profiles_slug_check CHECK (slug <> ''),
  CONSTRAINT household_profiles_name_check CHECK (display_name <> ''),
  CONSTRAINT household_profiles_slug_format CHECK (slug ~ '^[a-z0-9_]+$'),
  CONSTRAINT household_profiles_slug_key UNIQUE (slug)
);

-- At most one active default profile; archived defaults do not block a new one.
CREATE UNIQUE INDEX household_profiles_default_idx
  ON public.household_profiles (is_default)
  WHERE is_default AND archived_at IS NULL;
CREATE INDEX household_profiles_active_idx
  ON public.household_profiles (archived_at)
  WHERE archived_at IS NULL;

-- Key/value preferences per profile. The key registry (allowed keys and
-- value shapes) lives in the import loader, so adding a preference is a
-- code change, not a schema change; the schema only bounds storage.
CREATE TABLE public.household_preferences (
  profile_id bigint NOT NULL REFERENCES public.household_profiles(id),
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT household_preferences_key_check CHECK (key <> ''),
  CONSTRAINT household_preferences_value_check CHECK (jsonb_typeof(value) IN ('string', 'number', 'boolean')),
  CONSTRAINT household_preferences_profile_key_key PRIMARY KEY (profile_id, key)
);

-- Jellyfin account links: which Jellyfin user drives which profile. A
-- Jellyfin user can never drive two profiles (global unique), and a profile
-- has at most one account per source. A link is a pointer, not history:
-- unlinking deletes the row.
CREATE TABLE public.household_jellyfin_accounts (
  profile_id       bigint NOT NULL REFERENCES public.household_profiles(id),
  source           text NOT NULL DEFAULT 'jellyfin',
  jellyfin_user_id text NOT NULL,
  linked_at        timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT household_jellyfin_accounts_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT household_jellyfin_accounts_user_check CHECK (jellyfin_user_id <> ''),
  CONSTRAINT household_jellyfin_accounts_profile_source_key PRIMARY KEY (profile_id, source),
  CONSTRAINT household_jellyfin_accounts_source_user_key UNIQUE (source, jellyfin_user_id)
);

CREATE TABLE public.household_favorites (
  profile_id     bigint NOT NULL REFERENCES public.household_profiles(id),
  source         text NOT NULL DEFAULT 'jellyfin',
  jellyfin_id    text NOT NULL,
  item_id        bigint REFERENCES public.media_items(id),
  position       integer NOT NULL DEFAULT 0,
  first_added_at timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz,
  CONSTRAINT household_favorites_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT household_favorites_id_check CHECK (jellyfin_id <> ''),
  CONSTRAINT household_favorites_position_check CHECK (position >= 0),
  CONSTRAINT household_favorites_profile_item_key PRIMARY KEY (profile_id, source, jellyfin_id)
);

CREATE INDEX household_favorites_active_idx
  ON public.household_favorites (profile_id, position)
  WHERE removed_at IS NULL;

CREATE TABLE public.household_watchlists (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id bigint NOT NULL REFERENCES public.household_profiles(id),
  slug       text NOT NULL,
  name       text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT household_watchlists_slug_check CHECK (slug <> ''),
  CONSTRAINT household_watchlists_name_check CHECK (name <> ''),
  CONSTRAINT household_watchlists_profile_slug_key UNIQUE (profile_id, slug)
);

CREATE TABLE public.household_watchlist_entries (
  watchlist_id   bigint NOT NULL REFERENCES public.household_watchlists(id),
  source         text NOT NULL DEFAULT 'jellyfin',
  jellyfin_id    text NOT NULL,
  item_id        bigint REFERENCES public.media_items(id),
  position       integer NOT NULL DEFAULT 0,
  first_added_at timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz,
  CONSTRAINT household_watchlist_entries_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT household_watchlist_entries_id_check CHECK (jellyfin_id <> ''),
  CONSTRAINT household_watchlist_entries_position_check CHECK (position >= 0),
  CONSTRAINT household_watchlist_entries_list_item_key PRIMARY KEY (watchlist_id, source, jellyfin_id)
);

CREATE INDEX household_watchlist_entries_active_idx
  ON public.household_watchlist_entries (watchlist_id, position)
  WHERE removed_at IS NULL;

-- Curated collections are household-scoped (not per profile): they are part
-- of the shared home experience and referenced by home rows.
CREATE TABLE public.household_collections (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        text NOT NULL,
  name        text NOT NULL,
  description text,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT household_collections_slug_check CHECK (slug <> ''),
  CONSTRAINT household_collections_name_check CHECK (name <> ''),
  CONSTRAINT household_collections_slug_key UNIQUE (slug)
);

CREATE TABLE public.household_collection_entries (
  collection_id  bigint NOT NULL REFERENCES public.household_collections(id),
  source         text NOT NULL DEFAULT 'jellyfin',
  jellyfin_id    text NOT NULL,
  item_id        bigint REFERENCES public.media_items(id),
  position       integer NOT NULL DEFAULT 0,
  first_added_at timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz,
  CONSTRAINT household_collection_entries_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT household_collection_entries_id_check CHECK (jellyfin_id <> ''),
  CONSTRAINT household_collection_entries_position_check CHECK (position >= 0),
  CONSTRAINT household_collection_entries_list_item_key PRIMARY KEY (collection_id, source, jellyfin_id)
);

CREATE INDEX household_collection_entries_active_idx
  ON public.household_collection_entries (collection_id, position)
  WHERE removed_at IS NULL;

-- Home-screen row configuration, per profile. `kind` is a closed set: the
-- built-in rails plus reference kinds that point at a library, collection,
-- or watchlist through `config` (validated by the loader, one known key per
-- kind).
CREATE TABLE public.household_home_rows (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id bigint NOT NULL REFERENCES public.household_profiles(id),
  slug       text NOT NULL,
  kind       text NOT NULL,
  title      text NOT NULL,
  position   integer NOT NULL DEFAULT 0,
  enabled    boolean NOT NULL DEFAULT true,
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT household_home_rows_slug_check CHECK (slug <> ''),
  CONSTRAINT household_home_rows_title_check CHECK (title <> ''),
  CONSTRAINT household_home_rows_kind_check
    CHECK (kind IN ('continue_watching', 'recently_added', 'favorites', 'library', 'collection', 'watchlist')),
  CONSTRAINT household_home_rows_position_check CHECK (position >= 0),
  CONSTRAINT household_home_rows_config_object_check CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT household_home_rows_profile_slug_key UNIQUE (profile_id, slug)
);

CREATE INDEX household_home_rows_active_idx
  ON public.household_home_rows (profile_id, position)
  WHERE archived_at IS NULL;

-- ReelHouse-owned watch/continue state, per profile and item. `hidden_from_continue`
-- is the continue-watching overlay: hiding an item from the rail without
-- losing its progress. first_played_at is set once and never rewritten;
-- absent-from-snapshot state is tombstoned (removed_at), never deleted, so
-- a partial import can never silently wipe progress history.
CREATE TABLE public.household_watch_state (
  profile_id           bigint NOT NULL REFERENCES public.household_profiles(id),
  source               text NOT NULL DEFAULT 'jellyfin',
  jellyfin_id          text NOT NULL,
  item_id              bigint REFERENCES public.media_items(id),
  position_ticks       bigint,
  duration_ticks       bigint,
  completed            boolean NOT NULL DEFAULT false,
  hidden_from_continue boolean NOT NULL DEFAULT false,
  first_played_at      timestamptz NOT NULL DEFAULT now(),
  last_played_at       timestamptz,
  removed_at           timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT household_watch_state_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT household_watch_state_id_check CHECK (jellyfin_id <> ''),
  CONSTRAINT household_watch_state_position_check CHECK (position_ticks IS NULL OR position_ticks >= 0),
  CONSTRAINT household_watch_state_duration_check CHECK (duration_ticks IS NULL OR duration_ticks >= 0),
  CONSTRAINT household_watch_state_profile_item_key PRIMARY KEY (profile_id, source, jellyfin_id)
);

CREATE INDEX household_watch_state_continue_idx
  ON public.household_watch_state (profile_id, last_played_at DESC)
  WHERE removed_at IS NULL AND hidden_from_continue = false AND completed = false;

-- Append-only playback history. Idempotent imports need a deterministic
-- event identity: (profile, source, jellyfin_id, played_at) — replaying the
-- same snapshot appends nothing. History rows are never tombstoned or
-- rewritten; watch_state is the live projection, this is the record.
CREATE TABLE public.household_playback_history (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id     bigint NOT NULL REFERENCES public.household_profiles(id),
  source         text NOT NULL DEFAULT 'jellyfin',
  jellyfin_id    text NOT NULL,
  item_id        bigint REFERENCES public.media_items(id),
  played_at      timestamptz NOT NULL,
  position_ticks bigint,
  duration_ticks bigint,
  completed      boolean NOT NULL DEFAULT false,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT household_playback_history_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT household_playback_history_id_check CHECK (jellyfin_id <> ''),
  CONSTRAINT household_playback_history_position_check CHECK (position_ticks IS NULL OR position_ticks >= 0),
  CONSTRAINT household_playback_history_duration_check CHECK (duration_ticks IS NULL OR duration_ticks >= 0),
  CONSTRAINT household_playback_history_event_key
    UNIQUE (profile_id, source, jellyfin_id, played_at)
);

CREATE INDEX household_playback_history_profile_idx
  ON public.household_playback_history (profile_id, played_at DESC);

-- Provenance and freshness record for every household import: when it ran,
-- what it wrote, why it failed. Append-only except the counters of the
-- currently-running run, mirroring media_sync_runs.
CREATE TABLE public.household_sync_runs (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status                      text NOT NULL DEFAULT 'running',
  started_at                  timestamptz NOT NULL DEFAULT now(),
  finished_at                 timestamptz,
  profiles_seen               integer NOT NULL DEFAULT 0,
  profiles_upserted           integer NOT NULL DEFAULT 0,
  profiles_archived           integer NOT NULL DEFAULT 0,
  preferences_upserted        integer NOT NULL DEFAULT 0,
  favorites_upserted          integer NOT NULL DEFAULT 0,
  favorites_removed           integer NOT NULL DEFAULT 0,
  watchlists_upserted         integer NOT NULL DEFAULT 0,
  watchlists_archived         integer NOT NULL DEFAULT 0,
  watchlist_entries_upserted  integer NOT NULL DEFAULT 0,
  watchlist_entries_removed   integer NOT NULL DEFAULT 0,
  collections_upserted        integer NOT NULL DEFAULT 0,
  collections_archived        integer NOT NULL DEFAULT 0,
  collection_entries_upserted integer NOT NULL DEFAULT 0,
  collection_entries_removed  integer NOT NULL DEFAULT 0,
  home_rows_upserted          integer NOT NULL DEFAULT 0,
  home_rows_archived          integer NOT NULL DEFAULT 0,
  watch_state_upserted        integer NOT NULL DEFAULT 0,
  watch_state_removed         integer NOT NULL DEFAULT 0,
  history_appended            integer NOT NULL DEFAULT 0,
  unresolved_links            integer NOT NULL DEFAULT 0,
  conflicts_skipped           integer NOT NULL DEFAULT 0,
  error_detail                text,
  CONSTRAINT household_sync_runs_status_check
    CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT household_sync_runs_finished_check
    CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL))
);
