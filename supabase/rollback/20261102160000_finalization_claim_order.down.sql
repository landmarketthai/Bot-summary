-- Roll back 20261102160000 to the 20261102150000 state. No data changes: the
-- money_claimed_at column and its values are kept (the app then falls back to
-- the app-side claimed_at, which has a small race window between two scopes
-- finalizing at the same moment). Run before 20261102150000's down file when
-- rolling back further.

BEGIN;

-- 20261102150000 definition.
CREATE OR REPLACE FUNCTION public.normalize_slip_reference(p_reference text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT nullif(regexp_replace(coalesce(p_reference, ''),
    E'[[:space:]\\u00A0\\u1680\\u2000-\\u200D\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]', '', 'g'), '');
$$;

-- 20261102130000 definition (the trigger itself is 20261102140000's).
CREATE OR REPLACE FUNCTION public.lock_settlement_finalization_money()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.lock_money_close(NEW.source_id, NEW.business_date, NEW.accountability_round_id);
  RETURN NEW;
END;
$$;

COMMIT;
