-- Roll back 20261103120000 to the 20261103100000 state. No financial data
-- changes. Run with financial writes stopped (financial_maintenance.paused),
-- after reverting the app code if it depends on the guards. The stop itself
-- (financial_maintenance, 20261102110000) stays: it is rolled back by its own
-- down file, last, and only when no credits exist.

BEGIN;

DROP TRIGGER IF EXISTS manual_slip_sessions_scope_guard ON public.manual_slip_sessions;
DROP TRIGGER IF EXISTS manual_slip_entries_scope_guard ON public.manual_slip_entries;
DROP TRIGGER IF EXISTS manual_slip_sessions_no_truncate ON public.manual_slip_sessions;
DROP TRIGGER IF EXISTS manual_slip_entries_no_truncate ON public.manual_slip_entries;
DROP TRIGGER IF EXISTS slip_check_approvals_maintenance_guard ON public.slip_check_approvals;

GRANT UPDATE, DELETE, TRUNCATE ON TABLE public.manual_slip_sessions TO service_role;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.manual_slip_entries TO service_role;

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
DROP FUNCTION IF EXISTS public.refuse_manual_slip_truncate();

-- Restore M6 review entry points, without the M7 maintenance-row lock.
CREATE OR REPLACE FUNCTION public.assert_slip_check_round_open(p_check_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source text;
  v_round uuid;
  v_receipt_day date;
  v_round_day date;
  v_day date;
BEGIN
  SELECT e.source_id, e.accountability_round_id,
         ((e.received_at AT TIME ZONE 'Asia/Bangkok') - interval '4 hours')::date
  INTO v_source, v_round, v_receipt_day
  FROM public.slip_checks c JOIN public.slip_evidences e ON e.id = c.evidence_id
  WHERE c.id = p_check_id;
  v_round_day := v_receipt_day;
  IF v_round IS NOT NULL THEN
    SELECT coalesce((SELECT r.business_date FROM public.accountability_rounds r WHERE r.id = v_round), v_receipt_day)
    INTO v_round_day;
    PERFORM public.lock_money_close(v_source, v_round_day, v_round);
  END IF;
  FOR v_day IN SELECT DISTINCT d FROM unnest(ARRAY[v_receipt_day, v_round_day]) d ORDER BY d LOOP
    PERFORM public.lock_money_close(v_source, v_day, NULL);
  END LOOP;
  IF public.money_close_is_finalized(v_source, v_round_day, v_round)
     OR public.money_close_is_finalized(v_source, v_receipt_day, NULL) THEN
    RAISE EXCEPTION 'slip_check_round_finalized' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.slip_checks k
    JOIN public.slip_reference_claims c ON c.reference_id = public.normalize_slip_reference(k.reference_id)
    WHERE k.id = p_check_id
  ) THEN
    RAISE EXCEPTION 'slip_reference_credited' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_manual_entry_round_open(p_entry_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source text;
  v_round uuid;
  v_day date;
BEGIN
  SELECT s.source_id, s.accountability_round_id, s.business_date
  INTO v_source, v_round, v_day
  FROM public.manual_slip_entries e JOIN public.manual_slip_sessions s ON s.id = e.session_id
  WHERE e.id = p_entry_id;
  PERFORM public.lock_money_close_scope(v_source, v_day, v_round);
  IF public.money_close_is_finalized(v_source, v_day, v_round) THEN
    RAISE EXCEPTION 'slip_check_round_finalized' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.manual_slip_entries m
    JOIN public.slip_reference_claims c ON c.reference_id = public.normalize_slip_reference(m.reference_id)
    WHERE m.id = p_entry_id
  ) THEN
    RAISE EXCEPTION 'slip_reference_credited' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;

COMMIT;
