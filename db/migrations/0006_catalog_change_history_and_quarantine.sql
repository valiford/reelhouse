-- RH-0032: incremental refresh pipeline — change history, source revisions,
-- sync watermark, and duplicate-identity quarantine.
--
-- media_item_changes is append-only per-run history of catalog state
-- transitions (added/updated/removed/restored) with the source revision and
-- the source-provided observation time, so a change can always be traced to
-- what Jellyfin said and when it said it. Item rows are never deleted
-- (tombstones only), so neither the items nor their history are ever
-- cascaded away: the FKs deliberately have no ON DELETE action.
--
-- media_sync_state carries the incremental watermark: the newest source
-- DateLastSaved a successful run has fully covered. It advances only on
-- success and only forward (GREATEST on upsert), so a failed or concurrent
-- run can never rewind coverage.
--
-- media_item_quarantine isolates conflicting source identities (the same
-- Jellyfin item id reported twice in one run with differing placement or
-- content) non-destructively: the first occurrence wins deterministically,
-- the conflict is recorded for the repair workbench (RH-0036), and the run
-- itself succeeds. Only one open quarantine per identity may exist (partial
-- unique index); a re-occurrence bumps the existing row instead.
--
-- media_sync_runs gains the 'incremental' mode plus restored/quarantined
-- counters and the watermark the run effectively covered.
--
-- All tables stay in schema `public`, so migration 0001's default privileges
-- make them DML-accessible to the least-privilege application role exactly
-- like the existing media_* family.

ALTER TABLE public.media_sync_runs
  DROP CONSTRAINT media_sync_runs_mode_check;
ALTER TABLE public.media_sync_runs
  ADD CONSTRAINT media_sync_runs_mode_check CHECK (mode IN ('full', 'incremental'));
ALTER TABLE public.media_sync_runs
  ADD COLUMN items_restored   integer NOT NULL DEFAULT 0,
  ADD COLUMN items_quarantined integer NOT NULL DEFAULT 0,
  ADD COLUMN watermark        timestamptz;

-- Source-provided observation time (Jellyfin DateLastSaved) for the item, as
-- provenance of freshness alongside our own synced_at. Kept via COALESCE on
-- upsert: a payload that omits it never erases a previously known value.
ALTER TABLE public.media_items
  ADD COLUMN source_observed_at timestamptz;

CREATE TABLE public.media_item_changes (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id          bigint NOT NULL REFERENCES public.media_sync_runs(id),
  item_id         bigint NOT NULL REFERENCES public.media_items(id),
  source          text NOT NULL DEFAULT 'jellyfin',
  jellyfin_id     text NOT NULL,
  library_id      bigint NOT NULL REFERENCES public.media_libraries(id),
  change_kind     text NOT NULL,
  -- The source revision the change was observed at: Jellyfin Etag when
  -- present, else the payload's DateLastSaved; removals infer rather than
  -- observe, so they carry NULL.
  source_revision text,
  -- When the source says the change happened (DateLastSaved); inferred
  -- changes (removed/restored from a presence sweep) carry the run's start.
  observed_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  -- For 'updated': bounded, deterministically ordered list of the fields
  -- that actually differed (library placement included as "library").
  changed_fields  jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT media_item_changes_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT media_item_changes_kind_check
    CHECK (change_kind IN ('added', 'updated', 'removed', 'restored')),
  CONSTRAINT media_item_changes_updated_fields_check
    CHECK (change_kind <> 'updated' OR (jsonb_typeof(changed_fields) = 'array' AND jsonb_array_length(changed_fields) > 0))
);

CREATE INDEX media_item_changes_item_idx ON public.media_item_changes (item_id, id);
CREATE INDEX media_item_changes_run_idx ON public.media_item_changes (run_id, id);

CREATE TABLE public.media_sync_state (
  source      text NOT NULL,
  watermark   timestamptz NOT NULL,
  last_run_id bigint REFERENCES public.media_sync_runs(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_sync_state_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT media_sync_state_source_key PRIMARY KEY (source)
);

CREATE TABLE public.media_item_quarantine (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source        text NOT NULL DEFAULT 'jellyfin',
  reason        text NOT NULL,
  -- The conflicting source identity (Jellyfin item id).
  identity      text NOT NULL,
  run_id        bigint NOT NULL REFERENCES public.media_sync_runs(id),
  -- Bounded projection of the conflicting occurrence (identity, placement,
  -- revision markers) — evidence for repair, never a raw payload dump.
  payload       jsonb NOT NULL,
  detail        text NOT NULL,
  occurrences   integer NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'quarantined',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  CONSTRAINT media_item_quarantine_source_check CHECK (source = 'jellyfin'),
  CONSTRAINT media_item_quarantine_reason_check CHECK (reason IN ('duplicate_identity')),
  -- 'released'/'discarded' are reserved for the RH-0036 repair workbench;
  -- the sync only ever writes 'quarantined'.
  CONSTRAINT media_item_quarantine_status_check
    CHECK (status IN ('quarantined', 'released', 'discarded')),
  CONSTRAINT media_item_quarantine_resolved_check
    CHECK ((status = 'quarantined') = (resolved_at IS NULL))
);

-- At most one OPEN quarantine per (source, identity, reason): a later run
-- that sees the same conflict again bumps occurrences on the existing row.
CREATE UNIQUE INDEX media_item_quarantine_open_idx
  ON public.media_item_quarantine (source, identity, reason)
  WHERE status = 'quarantined';
CREATE INDEX media_item_quarantine_status_idx
  ON public.media_item_quarantine (status, last_seen_at);
