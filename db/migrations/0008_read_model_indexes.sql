-- RH-0040: read-model indexes for bounded catalog reads.
--
-- The read models (home rails, search) always read active rows with a
-- deterministic order and a hard LIMIT. These indexes let PostgreSQL answer
-- that shape without scanning tombstoned rows or sorting the whole table.
-- Indexes are metadata: they change no rows, so re-apply semantics and the
-- provenance contracts of RH-0031/0033 are untouched.
--
-- DESC in PostgreSQL defaults to NULLS FIRST, which would put items without
-- a date first in "recently added"; both indexes spell out NULLS LAST so the
-- empty dates sink deterministically and the index ordering matches the
-- read-model queries exactly.

-- Recently-added rail: newest active items across libraries. Partial (active
-- rows only) so tombstones never enter the scan.
CREATE INDEX media_items_recent_idx
  ON public.media_items (date_created DESC NULLS LAST, id)
  WHERE removed_at IS NULL;

-- Search and alphabetical rails: deterministic case-folded name order.
-- Supports ORDER BY lower(name) directly and prefix searches on lower(name).
CREATE INDEX media_items_name_lower_idx
  ON public.media_items (lower(name), id);
