-- RH-0037: disaster-recovery ledgers — backup, restore, and catalog rebuild.
--
-- ReelHouse holds two kinds of state and they recover differently:
-- - household_* is the DURABLE authority: it exists only in PostgreSQL, so
--   it is backed up to checksummed artifacts and restored from them.
-- - media_catalog is REBUILDABLE: it is a mirror of what Jellyfin reports,
--   so its recovery path is a full resync from the Jellyfin API, never a
--   backup file (and never a write into Jellyfin — media is never deleted).
-- These ledgers record every recovery operation so the runbook's claims are
-- backed by rows, not memory.
--
-- All three tables mirror media_sync_runs conventions (0005): rows are
-- append-only history — never updated except the counters/status of the
-- currently-running row — and status and finished_at move together: a row is
-- either still running (no finish time) or finished (succeeded/failed, with
-- a finish time). Default privileges from 0001 give the least-privilege
-- application role DML on them automatically; no extra grants.
--
-- dr_backup_runs    one row per household snapshot artifact: what was
--                   captured, the artifact's SHA-256 (file bytes) and the
--                   manifest's SHA-256 (snapshot content), and bounded row
--                   counts. The checksums are what a later restore binds to.
-- dr_restore_runs   one row per restore attempt: which artifact was
--                   verified, which expectation it was checked against
--                   (ledger row via backup_run_id and/or an operator-supplied
--                   checksum), whether verification passed, and what the
--                   import wrote. Dry runs record evidence too and write
--                   nothing else (the import replays inside a rolled-back
--                   transaction).
-- dr_rebuild_runs   one row per catalog rebuild (full Jellyfin resync): the
--                   media_sync_runs row the resync produced, post-rebuild
--                   counts, and whether the rebuild verified (every library
--                   the source reported is present and active).

CREATE TABLE public.dr_backup_runs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope           text NOT NULL DEFAULT 'household',
  status          text NOT NULL DEFAULT 'running',
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  artifact_path   text,
  artifact_sha256 text,
  manifest_sha256 text,
  artifact_bytes  bigint,
  rows_captured   integer NOT NULL DEFAULT 0,
  counts          jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_detail    text,
  CONSTRAINT dr_backup_runs_scope_check CHECK (scope IN ('household')),
  CONSTRAINT dr_backup_runs_status_check
    CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT dr_backup_runs_finished_check
    CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL)),
  -- A succeeded row carries the full artifact record. Failed rows MAY carry
  -- partial artifact evidence (one-sided: the constraint only binds
  -- success, it does not police what a failure may record).
  CONSTRAINT dr_backup_runs_artifact_check CHECK (
    status <> 'succeeded' OR (
      artifact_path IS NOT NULL AND artifact_sha256 IS NOT NULL
      AND manifest_sha256 IS NOT NULL AND artifact_bytes IS NOT NULL
    )
  ),
  CONSTRAINT dr_backup_runs_sha256_format_check
    CHECK ((artifact_sha256 IS NULL OR artifact_sha256 ~ '^[0-9a-f]{64}$')
       AND (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$')),
  CONSTRAINT dr_backup_runs_path_check CHECK (artifact_path IS NULL OR artifact_path <> ''),
  CONSTRAINT dr_backup_runs_counts_check CHECK (jsonb_typeof(counts) = 'object')
);

CREATE INDEX dr_backup_runs_scope_idx ON public.dr_backup_runs (scope, id);

CREATE TABLE public.dr_restore_runs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope             text NOT NULL DEFAULT 'household',
  status            text NOT NULL DEFAULT 'running',
  dry_run           boolean NOT NULL DEFAULT false,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  artifact_path     text,
  -- Checksum computed from the artifact as presented (always recorded once
  -- the artifact was readable), and the expectation(s) it was checked
  -- against: the backup ledger row (--run-id) and/or an operator-supplied
  -- value (--sha256).
  manifest_sha256   text,
  expected_sha256   text,
  backup_run_id     bigint REFERENCES public.dr_backup_runs(id),
  checksum_verified boolean,
  rows_imported     integer NOT NULL DEFAULT 0,
  counts            jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_detail      text,
  CONSTRAINT dr_restore_runs_scope_check CHECK (scope IN ('household')),
  CONSTRAINT dr_restore_runs_status_check
    CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT dr_restore_runs_finished_check
    CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL)),
  -- Only a fully verified restore may succeed; a failed row may record a
  -- failed verification.
  CONSTRAINT dr_restore_runs_checksum_check
    CHECK (status <> 'succeeded' OR checksum_verified IS TRUE),
  CONSTRAINT dr_restore_runs_sha256_format_check
    CHECK ((manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$')
       AND (expected_sha256 IS NULL OR expected_sha256 ~ '^[0-9a-f]{64}$')),
  CONSTRAINT dr_restore_runs_path_check CHECK (artifact_path IS NULL OR artifact_path <> ''),
  CONSTRAINT dr_restore_runs_counts_check CHECK (jsonb_typeof(counts) = 'object')
);

CREATE INDEX dr_restore_runs_scope_idx ON public.dr_restore_runs (scope, id);

CREATE TABLE public.dr_rebuild_runs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mode            text NOT NULL DEFAULT 'full_resync',
  status          text NOT NULL DEFAULT 'running',
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  sync_run_id     bigint REFERENCES public.media_sync_runs(id),
  libraries_count integer NOT NULL DEFAULT 0,
  items_count     integer NOT NULL DEFAULT 0,
  verified        boolean,
  error_detail    text,
  CONSTRAINT dr_rebuild_runs_mode_check CHECK (mode IN ('full_resync')),
  CONSTRAINT dr_rebuild_runs_status_check
    CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT dr_rebuild_runs_finished_check
    CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL)),
  -- A succeeded rebuild is bound to the sync run that repopulated the
  -- catalog. A failed rebuild MAY reference the sync run it attempted
  -- (one-sided: only success is bound).
  CONSTRAINT dr_rebuild_runs_sync_check
    CHECK (status <> 'succeeded' OR sync_run_id IS NOT NULL),
  CONSTRAINT dr_rebuild_runs_verified_check
    CHECK (status <> 'succeeded' OR verified IS TRUE)
);
