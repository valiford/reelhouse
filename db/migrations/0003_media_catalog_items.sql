-- RH-0031: media catalog — items (movies, series, seasons, episodes).
--
-- One table for every library item keeps the identity model single: a row is
-- identified by (source, jellyfin_id) and classified by item_type. Jellyfin's
-- series/season/episode hierarchy is carried as explicit reference columns
-- (no hard self-FK: Jellyfin may legitimately return an episode whose series
-- was filtered out or removed, and catalog reads must not lose it).
--
-- File state (path, container, size, streams) is captured from the item's
-- primary media source only — bounded, normalized inventory of what Jellyfin
-- exposes via API, never a copy of Jellyfin's internal database.

CREATE TABLE public.media_items (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source             text NOT NULL DEFAULT 'jellyfin',
  jellyfin_id        text NOT NULL,
  library_id         bigint NOT NULL REFERENCES public.media_libraries(id),
  item_type          text NOT NULL,
  name               text NOT NULL,
  original_title     text,
  sort_name          text,
  overview           text,
  production_year    integer,
  premiere_date      timestamptz,
  community_rating   numeric(3, 1),
  official_rating    text,
  runtime_ticks      bigint,
  container          text,
  file_path          text,
  file_size_bytes    bigint,
  media_streams      jsonb NOT NULL DEFAULT '[]'::jsonb,
  primary_image_tag  text,
  backdrop_image_tag text,
  etag               text,
  date_created       timestamptz,
  parent_jellyfin_id text,
  series_jellyfin_id text,
  series_name        text,
  season_jellyfin_id text,
  season_number      integer,
  episode_number     integer,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  removed_at         timestamptz,
  CONSTRAINT media_items_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT media_items_type_check
    CHECK (item_type IN ('movie', 'series', 'season', 'episode')),
  CONSTRAINT media_items_source_jellyfin_id_key UNIQUE (source, jellyfin_id)
);

CREATE INDEX media_items_library_type_idx
  ON public.media_items (library_id, item_type);
CREATE INDEX media_items_series_idx
  ON public.media_items (series_jellyfin_id)
  WHERE series_jellyfin_id IS NOT NULL;
CREATE INDEX media_items_active_idx
  ON public.media_items (library_id, item_type)
  WHERE removed_at IS NULL;
CREATE INDEX media_items_synced_at_idx
  ON public.media_items (synced_at);
