-- RH-0031: media catalog — item facets (genres, studios, people, external IDs).
--
-- Normalized joins, re-derived per item on every sync that sees the item:
-- a facet join always reflects exactly what Jellyfin reported for that item
-- at synced_at, so re-running a sync is idempotent. Facet rows themselves are
-- never deleted when an item stops referencing them — other items (and sync
-- history) may still reference them, and pruning shared facets is a
-- maintenance decision, not a sync side effect.
--
-- People are identified by (source, name): Jellyfin's People entries carry
-- stable GUIDs in practice but the API does not guarantee an Id on every
-- entry, so the name is the contractual identity and the GUID — when
-- present — is stored as provenance (kept via COALESCE on upsert, never
-- nulled by a later payload that omitted it).

CREATE TABLE public.media_genres (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL DEFAULT 'jellyfin',
  name   text NOT NULL,
  CONSTRAINT media_genres_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT media_genres_source_name_key UNIQUE (source, name)
);

CREATE TABLE public.media_studios (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL DEFAULT 'jellyfin',
  name   text NOT NULL,
  CONSTRAINT media_studios_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT media_studios_source_name_key UNIQUE (source, name)
);

CREATE TABLE public.media_people (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source      text NOT NULL DEFAULT 'jellyfin',
  name        text NOT NULL,
  jellyfin_id text,
  CONSTRAINT media_people_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT media_people_source_name_key UNIQUE (source, name)
);

CREATE TABLE public.media_item_genres (
  item_id  bigint NOT NULL REFERENCES public.media_items(id) ON DELETE CASCADE,
  genre_id bigint NOT NULL REFERENCES public.media_genres(id),
  PRIMARY KEY (item_id, genre_id)
);

CREATE TABLE public.media_item_studios (
  item_id   bigint NOT NULL REFERENCES public.media_items(id) ON DELETE CASCADE,
  studio_id bigint NOT NULL REFERENCES public.media_studios(id),
  PRIMARY KEY (item_id, studio_id)
);

-- person_type is Jellyfin's open vocabulary (Actor, Director, Writer, …):
-- it is externally controlled, so it is bounded (non-empty) rather than
-- enumerated; an unknown value is data, not an error.
CREATE TABLE public.media_item_people (
  item_id     bigint NOT NULL REFERENCES public.media_items(id) ON DELETE CASCADE,
  person_id   bigint NOT NULL REFERENCES public.media_people(id),
  person_type text NOT NULL,
  role_name   text,
  list_order  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, person_id, person_type),
  CONSTRAINT media_item_people_type_check CHECK (person_type <> '')
);

-- External provider IDs (Imdb/Tmdb/Tvdb/…) exactly as Jellyfin reported
-- them; one value per provider per item.
CREATE TABLE public.media_item_provider_ids (
  item_id        bigint NOT NULL REFERENCES public.media_items(id) ON DELETE CASCADE,
  provider_name  text NOT NULL,
  provider_value text NOT NULL,
  PRIMARY KEY (item_id, provider_name),
  CONSTRAINT media_item_provider_name_check CHECK (provider_name <> ''),
  CONSTRAINT media_item_provider_value_check CHECK (provider_value <> '')
);

CREATE INDEX media_item_genres_genre_idx
  ON public.media_item_genres (genre_id);
CREATE INDEX media_item_studios_studio_idx
  ON public.media_item_studios (studio_id);
CREATE INDEX media_item_people_person_idx
  ON public.media_item_people (person_id);
CREATE INDEX media_item_provider_ids_value_idx
  ON public.media_item_provider_ids (provider_name, provider_value);
