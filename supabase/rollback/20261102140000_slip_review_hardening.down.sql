-- Roll back 20261102140000 to the 20261102130000 state. No data changes:
-- every decision, manual entry and finalization row is kept. Revert the
-- application code first. Run before 20261102130000's down file when rolling
-- back further.

BEGIN;

GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.slip_check_approvals TO service_role;

DROP TRIGGER IF EXISTS settlement_finalizations_money_close_lock ON public.settlement_finalizations;
CREATE TRIGGER settlement_finalizations_money_close_lock
BEFORE INSERT ON public.settlement_finalizations
FOR EACH ROW EXECUTE FUNCTION public.lock_settlement_finalization_money();

CREATE OR REPLACE FUNCTION public.money_close_is_finalized(p_source text, p_business_date date, p_round uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_round IS NOT NULL
    THEN EXISTS (SELECT 1 FROM public.settlement_finalizations WHERE accountability_round_id = p_round)
    ELSE EXISTS (SELECT 1 FROM public.settlement_finalizations
                 WHERE source_id = p_source AND business_date = p_business_date AND accountability_round_id IS NULL)
  END;
$$;

CREATE OR REPLACE FUNCTION public.assert_slip_check_round_open(p_check_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source text;
  v_round uuid;
  v_day date;
BEGIN
  SELECT e.source_id, e.accountability_round_id,
         ((e.received_at AT TIME ZONE 'Asia/Bangkok') - interval '4 hours')::date
  INTO v_source, v_round, v_day
  FROM public.slip_checks c JOIN public.slip_evidences e ON e.id = c.evidence_id
  WHERE c.id = p_check_id;
  PERFORM public.lock_money_close(v_source, v_day, v_round);
  IF public.money_close_is_finalized(v_source, v_day, v_round) THEN
    RAISE EXCEPTION 'slip_check_round_finalized' USING ERRCODE = 'object_not_in_prerequisite_state';
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
  PERFORM public.lock_money_close(v_source, v_day, v_round);
  IF public.money_close_is_finalized(v_source, v_day, v_round) THEN
    RAISE EXCEPTION 'slip_check_round_finalized' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;

-- 20261102120000 definition.
CREATE OR REPLACE FUNCTION public.review_slip_check(
  p_check_id uuid,
  p_decision text,
  p_amount   numeric,
  p_reason   text,
  p_reviewer text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_ref text;
  v_transfer numeric;
  v_created timestamptz;
  v_existing public.slip_check_approvals%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT status, nullif(btrim(reference_id), ''), transfer_amount, created_at
  INTO v_status, v_ref, v_transfer, v_created
  FROM public.slip_checks WHERE id = p_check_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'slip_check_not_found:%', p_check_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status NOT IN ('EXTRACTED', 'PARTIAL_EXTRACTED') OR v_transfer IS NULL THEN
    RAISE EXCEPTION 'slip_check_not_reviewable' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_ref IS NULL THEN
    RAISE EXCEPTION 'slip_check_reference_required' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.slip_checks o
    WHERE btrim(o.reference_id) = v_ref
      AND o.status IN ('EXTRACTED', 'PARTIAL_EXTRACTED')
      AND (o.created_at, o.id) < (v_created, p_check_id)
  ) THEN
    RAISE EXCEPTION 'slip_check_is_duplicate' USING ERRCODE = 'unique_violation';
  END IF;
  PERFORM public.assert_slip_check_round_open(p_check_id);

  SELECT * INTO v_existing FROM public.slip_check_approvals
  WHERE slip_check_id = p_check_id AND status = 'active';
  IF FOUND THEN
    IF v_existing.decision = p_decision
       AND v_existing.approved_amount IS NOT DISTINCT FROM p_amount THEN
      RETURN jsonb_build_object('approval_id', v_existing.id, 'already', true);
    END IF;
    RAISE EXCEPTION 'slip_check_already_reviewed' USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO public.slip_check_approvals (slip_check_id, decision, approved_amount, reason, reviewer)
  VALUES (p_check_id, p_decision, CASE WHEN p_decision = 'approved' THEN p_amount END, p_reason, p_reviewer)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('approval_id', v_id, 'already', false);
END;
$$;

-- 20261102130000 definitions.
CREATE OR REPLACE FUNCTION public.review_manual_slip_entry(
  p_entry_id uuid,
  p_decision text,
  p_amount   numeric,
  p_reason   text,
  p_reviewer text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ref text;
  v_session_status text;
  v_winner uuid;
  v_existing public.slip_check_approvals%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT nullif(btrim(e.reference_id), ''), s.status INTO v_ref, v_session_status
  FROM public.manual_slip_entries e JOIN public.manual_slip_sessions s ON s.id = e.session_id
  WHERE e.id = p_entry_id
  FOR UPDATE OF e;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual_entry_not_found:%', p_entry_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_session_status <> 'closed' THEN
    RAISE EXCEPTION 'manual_entry_session_not_closed' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_ref IS NOT NULL AND p_decision = 'approved' THEN
    SELECT c.id INTO v_winner FROM public.slip_checks c
    WHERE btrim(c.reference_id) = v_ref AND c.status IN ('EXTRACTED', 'PARTIAL_EXTRACTED')
    ORDER BY c.created_at, c.id LIMIT 1;
    IF v_winner IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.slip_check_approvals a
      WHERE a.slip_check_id = v_winner AND a.status = 'active' AND a.decision = 'rejected'
    ) THEN
      RAISE EXCEPTION 'manual_entry_is_ai_slip' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  PERFORM public.assert_manual_entry_round_open(p_entry_id);

  SELECT * INTO v_existing FROM public.slip_check_approvals
  WHERE manual_entry_id = p_entry_id AND status = 'active';
  IF FOUND THEN
    IF v_existing.decision = p_decision AND v_existing.approved_amount IS NOT DISTINCT FROM p_amount THEN
      RETURN jsonb_build_object('approval_id', v_existing.id, 'already', true);
    END IF;
    RAISE EXCEPTION 'slip_check_already_reviewed' USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO public.slip_check_approvals (manual_entry_id, decision, approved_amount, reason, reviewer)
  VALUES (p_entry_id, p_decision, CASE WHEN p_decision = 'approved' THEN p_amount END, p_reason, p_reviewer)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('approval_id', v_id, 'already', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_slip_check_review(
  p_approval_id uuid,
  p_revoked_by  text,
  p_reason      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_check uuid;
  v_entry uuid;
BEGIN
  SELECT slip_check_id, manual_entry_id INTO v_check, v_entry FROM public.slip_check_approvals
  WHERE id = p_approval_id AND status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'slip_check_review_not_active' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_check IS NOT NULL THEN
    PERFORM public.assert_slip_check_round_open(v_check);
  ELSE
    PERFORM public.assert_manual_entry_round_open(v_entry);
  END IF;
  UPDATE public.slip_check_approvals
  SET status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_revoked_by, revoke_reason = p_reason
  WHERE id = p_approval_id;
  RETURN jsonb_build_object('revoked', true);
END;
$$;

DROP FUNCTION IF EXISTS public.lock_money_close_scope(text, date, uuid);
DROP FUNCTION IF EXISTS public.manual_entry_claims_reference(uuid);

REVOKE ALL ON FUNCTION public.review_slip_check(uuid, text, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_slip_check(uuid, text, numeric, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.review_manual_slip_entry(uuid, text, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_manual_slip_entry(uuid, text, numeric, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.revoke_slip_check_review(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_slip_check_review(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.assert_slip_check_round_open(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_manual_entry_round_open(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.money_close_is_finalized(text, date, uuid) FROM PUBLIC, anon, authenticated;

COMMIT;
