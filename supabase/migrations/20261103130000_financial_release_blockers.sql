-- PR #195 release corrections. Forward-only; apply after M7 while paused.
-- Existing malformed approvals block installation for operator review; no money is rewritten.
BEGIN;

ALTER TABLE public.slip_check_approvals DROP CONSTRAINT slip_check_approvals_amount_shape;
ALTER TABLE public.slip_check_approvals ADD CONSTRAINT slip_check_approvals_amount_shape CHECK (
  (decision = 'approved' AND approved_amount IS NOT NULL
    AND approved_amount > 0 AND approved_amount < 'Infinity'::numeric)
  OR (decision = 'rejected' AND approved_amount IS NULL)
);

-- Recorded credits freeze reviews even after a failed push, including unreferenced manual entries.
CREATE OR REPLACE FUNCTION public.money_close_is_finalized(p_source text, p_business_date date, p_round uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.settlement_finalizations f
    WHERE (f.status IN ('sending', 'sent', 'ambiguous') OR f.claims_recorded_at IS NOT NULL)
      AND ((p_round IS NOT NULL AND f.accountability_round_id = p_round)
        OR (f.accountability_round_id IS NULL AND f.source_id = p_source AND f.business_date = p_business_date))
  );
$$;

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
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'slip_review_invalid_decision' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_decision = 'approved' AND (p_amount IS NULL OR round(p_amount, 2) <= 0
      OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')) THEN
    RAISE EXCEPTION 'slip_review_positive_amount_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) = 0 OR length(btrim(coalesce(p_reviewer, ''))) = 0 THEN
    RAISE EXCEPTION 'slip_review_reason_reviewer_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT status, nullif(btrim(reference_id), ''), transfer_amount, created_at
  INTO v_status, v_ref, v_transfer, v_created
  FROM public.slip_checks WHERE id = p_check_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'slip_check_not_found:%', p_check_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT * INTO v_existing FROM public.slip_check_approvals
  WHERE slip_check_id = p_check_id AND status = 'active';
  IF FOUND THEN
    IF v_existing.decision = p_decision
       AND v_existing.approved_amount IS NOT DISTINCT FROM (CASE WHEN p_decision = 'approved' THEN p_amount END) THEN
      RETURN jsonb_build_object('approval_id', v_existing.id, 'already', true);
    END IF;
    RAISE EXCEPTION 'slip_check_already_reviewed' USING ERRCODE = 'unique_violation';
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
  IF p_decision = 'approved' AND EXISTS (
    SELECT 1 FROM public.manual_slip_entries e
    WHERE btrim(e.reference_id) = v_ref AND e.created_at < v_created
      AND public.manual_entry_claims_reference(e.id)
  ) THEN
    RAISE EXCEPTION 'slip_check_superseded_by_manual' USING ERRCODE = 'unique_violation';
  END IF;
  PERFORM public.assert_slip_check_round_open(p_check_id);

  INSERT INTO public.slip_check_approvals (slip_check_id, decision, approved_amount, reason, reviewer)
  VALUES (p_check_id, p_decision, CASE WHEN p_decision = 'approved' THEN p_amount END, p_reason, p_reviewer)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('approval_id', v_id, 'already', false);
END;
$$;

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
  v_created timestamptz;
  v_session_status text;
  v_winner public.slip_checks%ROWTYPE;
  v_existing public.slip_check_approvals%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'slip_review_invalid_decision' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_decision = 'approved' AND (p_amount IS NULL OR round(p_amount, 2) <= 0
      OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')) THEN
    RAISE EXCEPTION 'slip_review_positive_amount_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) = 0 OR length(btrim(coalesce(p_reviewer, ''))) = 0 THEN
    RAISE EXCEPTION 'slip_review_reason_reviewer_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT nullif(btrim(e.reference_id), ''), e.created_at, s.status INTO v_ref, v_created, v_session_status
  FROM public.manual_slip_entries e JOIN public.manual_slip_sessions s ON s.id = e.session_id
  WHERE e.id = p_entry_id
  FOR UPDATE OF e;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual_entry_not_found:%', p_entry_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT * INTO v_existing FROM public.slip_check_approvals
  WHERE manual_entry_id = p_entry_id AND status = 'active';
  IF FOUND THEN
    IF v_existing.decision = p_decision
       AND v_existing.approved_amount IS NOT DISTINCT FROM (CASE WHEN p_decision = 'approved' THEN p_amount END) THEN
      RETURN jsonb_build_object('approval_id', v_existing.id, 'already', true);
    END IF;
    RAISE EXCEPTION 'slip_check_already_reviewed' USING ERRCODE = 'unique_violation';
  END IF;

  IF v_session_status <> 'closed' THEN
    RAISE EXCEPTION 'manual_entry_session_not_closed' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_ref IS NOT NULL AND p_decision = 'approved' THEN
    SELECT * INTO v_winner FROM public.slip_checks c
    WHERE btrim(c.reference_id) = v_ref AND c.status IN ('EXTRACTED', 'PARTIAL_EXTRACTED')
    ORDER BY c.created_at, c.id LIMIT 1;
    -- The AI read owns the reference when it is bank money, not rejected and
    -- not later than this entry (AI wins a tie): approve or correct THAT read.
    IF v_winner.id IS NOT NULL AND v_winner.transfer_amount IS NOT NULL
       AND v_winner.created_at <= v_created
       AND NOT EXISTS (
         SELECT 1 FROM public.slip_check_approvals a
         WHERE a.slip_check_id = v_winner.id AND a.status = 'active' AND a.decision = 'rejected'
       ) THEN
      RAISE EXCEPTION 'manual_entry_is_ai_slip' USING ERRCODE = 'unique_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.manual_slip_entries o
      WHERE btrim(o.reference_id) = v_ref AND o.id <> p_entry_id
        AND (o.created_at, o.id) < (v_created, p_entry_id)
        AND public.manual_entry_claims_reference(o.id)
    ) THEN
      RAISE EXCEPTION 'manual_entry_is_duplicate' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  PERFORM public.assert_manual_entry_round_open(p_entry_id);

  INSERT INTO public.slip_check_approvals (manual_entry_id, decision, approved_amount, reason, reviewer)
  VALUES (p_entry_id, p_decision, CASE WHEN p_decision = 'approved' THEN p_amount END, p_reason, p_reviewer)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('approval_id', v_id, 'already', false);
END;
$$;

-- Installed after the credit column exists: M0 must remain installable before M6/M7.
-- An old worker can still push outside SQL; this refuses its uncredited sent outcome.
CREATE OR REPLACE FUNCTION public.guard_settlement_finalization_credit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (NEW.status IN ('sent', 'ambiguous') OR NEW.message_sent_at IS NOT NULL) AND NEW.claims_recorded_at IS NULL THEN
    RAISE EXCEPTION 'settlement_credits_required' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS settlement_finalizations_credit_guard ON public.settlement_finalizations;
CREATE TRIGGER settlement_finalizations_credit_guard
BEFORE INSERT OR UPDATE ON public.settlement_finalizations
FOR EACH ROW EXECUTE FUNCTION public.guard_settlement_finalization_credit();

REVOKE ALL ON FUNCTION public.guard_settlement_finalization_credit() FROM PUBLIC, anon, authenticated;

COMMIT;
