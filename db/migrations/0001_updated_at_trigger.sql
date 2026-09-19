-- ReelHouse migration 0001: shared updated_at trigger infrastructure.
-- Mutable tables keep updated_at honest via this trigger rather than
-- relying on every caller to remember to set it.

CREATE OR REPLACE FUNCTION reelhouse_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
