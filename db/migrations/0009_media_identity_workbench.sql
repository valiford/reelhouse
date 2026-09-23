-- RH-0036: media identity conflict quarantine and repair workbench.
--
-- Extends the RH-0032 quarantine (which the sync only ever fills with
-- 'duplicate_identity' rows) into the operator workbench:
--
-- reason now also covers the scan-detected conflict classes:
--   duplicate_file       — two or more ACTIVE items share one file_path
--                          (Jellyfin re-identified a file, or a duplicate
--                          import): the file is the conflicting identity.
--   moved_media          — an ACTIVE item's file_path equals a TOMBSTONED
--                          item's file_path: the file now lives under a new
--                          Jellyfin identity and the old identity is retired.
--   missing_external_id  — an ACTIVE movie/series has no external provider
--                          IDs, so cross-rename identity reconciliation has
--                          nothing to anchor on.
-- The `identity` column carries the conflict key: the Jellyfin item id for
-- duplicate_identity/missing_external_id, the file path for
-- duplicate_file/moved_media.
--
-- media_identity_scans is the workbench's own append-only run history (one
-- row per operator scan), mirroring media_sync_runs conventions: rows are
-- never updated except the counters of the currently-running scan, and a
-- scan is either still running (no finish time) or finished (succeeded/
-- failed, with a finish time).
--
-- media_identity_repairs is the audit trail: every workbench resolution
-- (release/discard/remap) appends exactly one row with the operator identity
-- and bounded before/after evidence. Rows are never updated or deleted.
--
-- quarantine.run_id becomes nullable and gains the sibling scan_id so each
-- row proves its origin: sync-detected conflicts reference the run that saw
-- them, scan-detected conflicts reference the scan that found them — exactly
-- one of the two, never both, never neither.

ALTER TABLE public.media_item_quarantine
  DROP CONSTRAINT media_item_quarantine_reason_check;
ALTER TABLE public.media_item_quarantine
  ADD CONSTRAINT media_item_quarantine_reason_check
    CHECK (reason IN ('duplicate_identity', 'duplicate_file', 'moved_media', 'missing_external_id'));

CREATE TABLE public.media_identity_scans (
  id                              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status                          text NOT NULL DEFAULT 'running',
  started_at                      timestamptz NOT NULL DEFAULT now(),
  finished_at                     timestamptz,
  findings_duplicate_file         integer NOT NULL DEFAULT 0,
  findings_moved_media            integer NOT NULL DEFAULT 0,
  findings_missing_external_id    integer NOT NULL DEFAULT 0,
  quarantines_opened              integer NOT NULL DEFAULT 0,
  quarantines_bumped              integer NOT NULL DEFAULT 0,
  truncated                       boolean NOT NULL DEFAULT false,
  error_detail                    text,
  CONSTRAINT media_identity_scans_status_check
    CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT media_identity_scans_finished_check
    CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL))
);

ALTER TABLE public.media_item_quarantine
  ALTER COLUMN run_id DROP NOT NULL,
  ADD COLUMN scan_id bigint REFERENCES public.media_identity_scans(id);
ALTER TABLE public.media_item_quarantine
  ADD CONSTRAINT media_item_quarantine_origin_check
    CHECK ((run_id IS NULL) <> (scan_id IS NULL));

CREATE TABLE public.media_identity_repairs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quarantine_id bigint NOT NULL REFERENCES public.media_item_quarantine(id),
  -- released/discarded resolve the conflict; remapped additionally re-pointed
  -- the catalog item's library placement before resolving.
  action        text NOT NULL,
  operator      text NOT NULL,
  note          text,
  -- Bounded before/after projection of the decision (quarantine evidence,
  -- placement change). Audit evidence, never a raw payload dump.
  evidence      jsonb NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_identity_repairs_action_check
    CHECK (action IN ('released', 'discarded', 'remapped')),
  CONSTRAINT media_identity_repairs_operator_check CHECK (operator <> ''),
  CONSTRAINT media_identity_repairs_note_check CHECK (note IS NULL OR note <> '')
);

CREATE INDEX media_identity_repairs_quarantine_idx
  ON public.media_identity_repairs (quarantine_id, id);
