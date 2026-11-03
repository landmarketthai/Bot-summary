-- Roll back 20261103100000 to the 20261102160000 state. Revert the app code
-- first. No data changes: slip_reference_claims, its rows and
-- settlement_finalizations.claims_recorded_at are KEPT (the credit ledger is
-- the audit record of what each sent settlement counted); only the RPC and
-- the review guards go. Run before 20261102160000's down file.

BEGIN;

DROP FUNCTION IF EXISTS public.claim_slip_references(uuid, jsonb);
-- The canonical-form check uses normalize_slip_reference, which 20261102150000's
-- down file drops; the rows stay (they were canonical when written).
ALTER TABLE public.slip_reference_claims DROP CONSTRAINT IF EXISTS slip_reference_claims_canonical;

-- 20261102150000 definition.
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
END;
$$;

-- 20261102140000 definition.
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
END;
$$;

REVOKE ALL ON FUNCTION public.assert_slip_check_round_open(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_manual_entry_round_open(uuid) FROM PUBLIC, anon, authenticated;

COMMIT;
