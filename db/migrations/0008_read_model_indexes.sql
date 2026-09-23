-- RH-0034: bounded read models — indexes for the client-facing read paths.
--
-- The read models (src/lib/readmodels) serve search/filter/pagination,
-- recently-added rails, and rating-driven recommendation inputs straight off
-- media_items. These partial indexes give those paths deterministic orders
-- and index-backed filters over the ACTIVE catalog only (removed_at IS NULL,
-- the same predicate every read model applies):
--
-- - active_title_idx     library/type listings ordered by display title
--                        (sort_name falling back to name, case-folded), with
--                        id as the pagination tiebreaker.
-- - active_added_idx     "recently added" rails across any library scope.
-- - active_rating_idx    rating-led recommendation candidates and rating sort.
-- - active_year_idx      year-filtered library listings.
--
-- No extension-dependent opclasses (no pg_trgm): substring search stays a
-- bounded ILIKE scan — statement_timeout bounds it, LIMIT bounds its output —
-- so the read models never require superuser-only extensions on the Synology
-- instance. Rails driven by the household_* family keep the partial indexes
-- migration 0007 already created. Indexes are owner-owned objects; the
-- application role only ever SELECTs, so no grant changes are needed here.
-- Tables stay in schema public per the family convention.

CREATE INDEX media_items_active_title_idx
  ON public.media_items (library_id, item_type, lower(COALESCE(sort_name, name)), id)
  WHERE removed_at IS NULL;

CREATE INDEX media_items_active_added_idx
  ON public.media_items (COALESCE(date_created, first_seen_at) DESC, id DESC)
  WHERE removed_at IS NULL;

CREATE INDEX media_items_active_rating_idx
  ON public.media_items (community_rating DESC, id DESC)
  WHERE removed_at IS NULL;

CREATE INDEX media_items_active_year_idx
  ON public.media_items (library_id, item_type, production_year, id)
  WHERE removed_at IS NULL;
