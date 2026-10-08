-- RH-0031: media catalog — sync run history.
--
-- Every catalog sync appends exactly one run row: it is the provenance and
-- freshness record for the load (when it ran, what it confirmed, what it
-- removed, why it failed). Rows are never updated except the counters of the
-- currently-running run; history is append-only.
--
-- status and finished_at move together: a run is either still running (no
-- finish time) or finished (succeeded/failed, with a finish time).

CREATE TABLE public.media_sync_runs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source           text NOT NULL DEFAULT 'jellyfin',
  mode             text NOT NULL DEFAULT 'full',
  status           text NOT NULL DEFAULT 'running',
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  libraries_seen   integer NOT NULL DEFAULT 0,
  items_seen       integer NOT NULL DEFAULT 0,
  items_upserted   integer NOT NULL DEFAULT 0,
  items_tombstoned integer NOT NULL DEFAULT 0,
  items_skipped    integer NOT NULL DEFAULT 0,
  pages_fetched    integer NOT NULL DEFAULT 0,
  error_detail     text,
  CONSTRAINT media_sync_runs_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT media_sync_runs_mode_check CHECK (mode IN ('full')),
  CONSTRAINT media_sync_runs_status_check
    CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT media_sync_runs_finished_check
    CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL))
);
