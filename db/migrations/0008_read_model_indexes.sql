-- Read-model indexes for bounded catalog reads (RH-0041 carrier union:
-- RH-0040's two served-path indexes + RH-0034's faceted-browse indexes).
--
-- The read models (home rails, search) always read active rows with a
-- deterministic order and a hard LIMIT. These indexes let PostgreSQL answer
-- that shape without scanning tombstoned rows or sorting the whole table.
-- Indexes are metadata: they change no rows, so re-apply semantics and the
-- provenance contracts of RH-0031/0033 are untouched.
--
-- DESC in PostgreSQL defaults to NULLS FIRST, which would put items without
-- a date first in "recently added"; the recently-added indexes spell out
-- NULLS LAST so empty dates sink deterministically and the index ordering
-- matches the read-model queries exactly.
--
-- No extension-dependent opclasses (no pg_trgm): substring search stays a
-- bounded ILIKE scan — statement_timeout bounds it, LIMIT bounds its output —
-- so the read models never require superuser-only extensions. Rails driven by
-- the household_* family keep the partial indexes migration 0006 already
-- created. Indexes are owner-owned objects; the application role only ever
-- SELECTs, so no grant changes are needed here. Tables stay in schema public
-- per the family convention.

-- [RH-0040] Recently-added rail: newest active items across libraries.
-- Partial (active rows only) so tombstones never enter the scan.
CREATE INDEX media_items_recent_idx
  ON public.media_items (date_created DESC NULLS LAST, id)
  WHERE removed_at IS NULL;

-- [RH-0040] Search and alphabetical rails: deterministic case-folded name
-- order. Supports ORDER BY lower(name) directly and prefix searches.
CREATE INDEX media_items_name_lower_idx
  ON public.media_items (lower(name), id);

-- [RH-0034] Library/type listings ordered by display title (sort_name
-- falling back to name, case-folded), id as the pagination tiebreaker.
CREATE INDEX media_items_active_title_idx
  ON public.media_items (library_id, item_type, lower(COALESCE(sort_name, name)), id)
  WHERE removed_at IS NULL;

-- [RH-0034] "Recently added" browse sort over the added-or-first-seen
-- window (COALESCE covers items Jellyfin never gave a date_created).
CREATE INDEX media_items_active_added_idx
  ON public.media_items (COALESCE(date_created, first_seen_at) DESC, id DESC)
  WHERE removed_at IS NULL;

-- [RH-0034] Rating-led recommendation candidates and rating sort.
CREATE INDEX media_items_active_rating_idx
  ON public.media_items (community_rating DESC, id DESC)
  WHERE removed_at IS NULL;

-- [RH-0034] Year-filtered library listings.
CREATE INDEX media_items_active_year_idx
  ON public.media_items (library_id, item_type, production_year, id)
  WHERE removed_at IS NULL;
