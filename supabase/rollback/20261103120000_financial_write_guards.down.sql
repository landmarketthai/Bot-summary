-- Roll back 20261103120000 to the 20261103100000 state. No financial data
-- changes. Run with traffic stopped, after reverting the app code if it
-- depends on the guards. The maintenance row is dropped (it is a switch, not
-- a record); make sure it is not paused-by-intent before rolling back.

BEGIN;

DROP TRIGGER IF EXISTS manual_slip_sessions_scope_guard ON public.manual_slip_sessions;
DROP TRIGGER IF EXISTS manual_slip_entries_scope_guard ON public.manual_slip_entries;
DROP TRIGGER IF EXISTS slip_check_approvals_maintenance_guard ON public.slip_check_approvals;

-- 20261102160000 definition.
CREATE OR REPLACE FUNCTION public.lock_settlement_finalization_money()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('money-close:claim-order', 0));
  PERFORM public.lock_money_close(NEW.source_id, NEW.business_date, NEW.accountability_round_id);
  IF NEW.status IN ('sending', 'sent', 'ambiguous') THEN
    IF TG_OP = 'INSERT' OR OLD.status NOT IN ('sending', 'sent', 'ambiguous') THEN
      NEW.money_claimed_at := clock_timestamp();
    ELSE
      NEW.money_claimed_at := OLD.money_claimed_at;
    END IF;
  ELSE
    NEW.money_claimed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- 20261103100000 definition.
CREATE OR REPLACE FUNCTION public.claim_slip_references(p_finalization_id uuid, p_claims jsonb)
RETURNS TABLE (reference_id text, finalization_id uuid, slip_check_id uuid, manual_entry_id uuid, amount numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_status text;
  v_recorded timestamptz;
BEGIN
  SELECT f.status, f.claims_recorded_at INTO v_status, v_recorded
  FROM public.settlement_finalizations f WHERE f.id = p_finalization_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'sending' THEN
    RAISE EXCEPTION 'slip_claim_finalization_not_sending' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF jsonb_typeof(coalesce(p_claims, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'slip_claims_must_be_array' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_recorded IS NULL THEN
    INSERT INTO public.slip_reference_claims AS c (reference_id, finalization_id, slip_check_id, manual_entry_id, amount)
    SELECT public.normalize_slip_reference(e->>'reference_id'), p_finalization_id,
           nullif(e->>'slip_check_id', '')::uuid, nullif(e->>'manual_entry_id', '')::uuid, (e->>'amount')::numeric
    FROM jsonb_array_elements(coalesce(p_claims, '[]'::jsonb)) e
    WHERE public.normalize_slip_reference(e->>'reference_id') IS NOT NULL
    ON CONFLICT (reference_id) DO NOTHING;
  END IF;

  UPDATE public.settlement_finalizations f SET claims_recorded_at = coalesce(f.claims_recorded_at, now())
  WHERE f.id = p_finalization_id;

  RETURN QUERY
  SELECT c.reference_id, c.finalization_id, c.slip_check_id, c.manual_entry_id, c.amount
  FROM public.slip_reference_claims c
  WHERE c.reference_id IN (
    SELECT public.normalize_slip_reference(e->>'reference_id') FROM jsonb_array_elements(coalesce(p_claims, '[]'::jsonb)) e);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_slip_references(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_slip_references(uuid, jsonb) TO service_role;

DROP FUNCTION IF EXISTS public.guard_slip_review_write();
DROP FUNCTION IF EXISTS public.guard_manual_slip_entry_write();
DROP FUNCTION IF EXISTS public.guard_manual_slip_session_write();
DROP FUNCTION IF EXISTS public.assert_manual_slip_scope_open(text, date, uuid);
DROP FUNCTION IF EXISTS public.money_scope_is_settled(text, date, uuid);
DROP FUNCTION IF EXISTS public.assert_financial_writes_open();
DROP TABLE IF EXISTS public.financial_maintenance;

COMMIT;
