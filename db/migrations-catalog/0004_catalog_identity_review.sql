-- media_catalog migration 0004: identity review and safe remapping (RH-0023).
--
-- The operator-side half of the quarantine workflow, on top of the
-- sync-owned table from 0003 (docs/CATALOG_REVIEW.md):
--
-- - Wider quarantine vocabulary. Catalog-level detectors record
--   duplicate_path (two live items sharing one file path) and
--   renamed_identity (a missing/retired item whose path reappeared under a
--   different id). The sync keeps owning its five reasons: neither side
--   writes the other's reasons, so ownership of a row is always derivable
--   from its reason.
-- - Operator resolution columns. A reviewed entry can be closed with an
--   action, a note, and who decided. Auto-closes (a successful sync, a
--   detector no longer seeing the conflict) set only resolved_at, so
--   "action IS NULL but resolved" always means an automatic close, and a
--   re-detected conflict clears the operator columns rather than letting a
--   stale verdict masquerade as health.
-- - catalog_identity_override. Durable, operator-authored identity
--   decisions: a contested provider id belongs to a named item, or an item
--   belongs to a named library. The sync consults overrides before its
--   first-writer-wins heuristic, so a remap is enforced deterministically
--   on every later scan. Overrides reference source ids as text on purpose
--   (no foreign keys): they are human judgments that must survive catalog
--   rebuilds, which wipe content but keep review decisions.

ALTER TABLE catalog_quarantine DROP CONSTRAINT catalog_quarantine_reason_check;
ALTER TABLE catalog_quarantine ADD CONSTRAINT catalog_quarantine_reason_check
    CHECK (reason IN ('duplicate_provider_id', 'duplicate_external_id', 'orphan_parent',
                      'invalid_item', 'library_conflict', 'duplicate_path', 'renamed_identity'));

ALTER TABLE catalog_quarantine
    ADD COLUMN resolution_action text,
    ADD COLUMN resolution_note  text,
    ADD COLUMN resolved_by      text;

ALTER TABLE catalog_quarantine ADD CONSTRAINT catalog_quarantine_resolution_action_check
    CHECK (resolution_action IN ('dismissed', 'source_fixed', 'discarded', 'remapped'));

-- Operator resolutions carry an action and a who; automatic closes carry
-- neither. resolved_at stays the single source of truth for "is this open".
ALTER TABLE catalog_quarantine ADD CONSTRAINT catalog_quarantine_resolution_shape CHECK (
    (
        resolution_action IS NULL
        AND resolved_by IS NULL
        AND (resolution_note IS NULL OR btrim(resolution_note) <> '')
    ) OR (
        resolution_action IS NOT NULL
        AND resolved_at IS NOT NULL
        AND resolved_by IS NOT NULL
        AND btrim(resolved_by) <> ''
        AND (resolution_note IS NULL OR btrim(resolution_note) <> '')
    )
);

-- Detector-owned rows: found by scan, closed by scan, bounded listing.
CREATE INDEX catalog_quarantine_detector_idx
    ON catalog_quarantine (reason, last_detected_at DESC)
    WHERE resolved_at IS NULL AND reason IN ('duplicate_path', 'renamed_identity');

-- Path equality is the duplicate/rename detector's join key.
CREATE INDEX catalog_item_path_idx
    ON catalog_item (path)
    WHERE path IS NOT NULL;

CREATE TABLE catalog_identity_override (
    id                    uuid PRIMARY KEY DEFAULT uuidv7(),
    source                text NOT NULL CHECK (source IN ('jellyfin')),
    kind                  text NOT NULL CHECK (kind IN ('provider_claim', 'library_pin')),
    -- provider_claim: (provider, external_value) belongs to canonical_external_id.
    -- library_pin:    external_id belongs to the library whose external id is
    --                 canonical_external_id.
    provider              text,
    external_value        text,
    external_id           text,
    canonical_external_id text NOT NULL CHECK (btrim(canonical_external_id) <> ''),
    -- Bounded human context: why the decision was made, and by whom.
    reason                text NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 1000),
    created_by            text NOT NULL CHECK (btrim(created_by) <> '' AND length(created_by) <= 200),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT catalog_identity_override_provider_claim_shape CHECK (
        (kind = 'provider_claim') = (
            provider IS NOT NULL AND external_value IS NOT NULL AND external_id IS NULL
        )
    ),
    CONSTRAINT catalog_identity_override_library_pin_shape CHECK (
        (kind = 'library_pin') = (
            external_id IS NOT NULL AND provider IS NULL AND external_value IS NULL
        )
    ),
    CONSTRAINT catalog_identity_override_no_self_pin CHECK (
        kind <> 'library_pin' OR external_id <> canonical_external_id
    )
);

CREATE TRIGGER catalog_identity_override_set_updated_at
    BEFORE UPDATE ON catalog_identity_override
    FOR EACH ROW EXECUTE FUNCTION catalog_set_updated_at();

-- One decision per contested identity: one verdict per provider id, one
-- library verdict per item. Re-review replaces the row's decision fields.
CREATE UNIQUE INDEX catalog_identity_override_provider_claim_uidx
    ON catalog_identity_override (source, provider, external_value)
    WHERE kind = 'provider_claim';

CREATE UNIQUE INDEX catalog_identity_override_library_pin_uidx
    ON catalog_identity_override (source, external_id)
    WHERE kind = 'library_pin';
