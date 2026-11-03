-- Keep corrected approval validation; no decisions or credits are changed.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.slip_reference_claims) THEN
    RAISE EXCEPTION 'financial_guards_rollback_refused' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.financial_maintenance WHERE paused) THEN
    RAISE EXCEPTION 'financial_guards_rollback_requires_pause' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $$;
DROP TRIGGER IF EXISTS settlement_finalizations_credit_guard ON public.settlement_finalizations;
DROP FUNCTION IF EXISTS public.guard_settlement_finalization_credit();
-- M3 definition, before persisted credits froze failed scopes.
CREATE OR REPLACE FUNCTION public.money_close_is_finalized(p_source text, p_business_date date, p_round uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.settlement_finalizations f
    WHERE f.status IN ('sending', 'sent', 'ambiguous')
      AND ((p_round IS NOT NULL AND f.accountability_round_id = p_round)
        OR (f.accountability_round_id IS NULL AND f.source_id = p_source AND f.business_date = p_business_date))
  );
$$;
COMMIT;
