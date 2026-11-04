-- Roll back 20261102130000 to the 20261102120000 state. Financial records are
-- KEPT: manual_slip_entries.requires_review / reference_id and every
-- slip_check_approvals row (including manual-entry decisions) stay in place.
-- Revert the application code first. Run before 20261102120000's down file
-- when rolling back both.

BEGIN;

DROP TRIGGER IF EXISTS settlement_finalizations_money_close_lock ON public.settlement_finalizations;
DROP FUNCTION IF EXISTS public.lock_settlement_finalization_money();
DROP FUNCTION IF EXISTS public.review_manual_slip_entry(uuid, text, numeric, text, text);

-- 20261102120000 definitions (no money-close lock, AI checks only).
CREATE OR REPLACE FUNCTION public.assert_slip_check_round_open(p_check_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source text;
  v_round uuid;
  v_received timestamptz;
BEGIN
  SELECT e.source_id, e.accountability_round_id, e.received_at
  INTO v_source, v_round, v_received
  FROM public.slip_checks c JOIN public.slip_evidences e ON e.id = c.evidence_id
  WHERE c.id = p_check_id;

  IF v_round IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.settlement_finalizations WHERE accountability_round_id = v_round) THEN
      RAISE EXCEPTION 'slip_check_round_finalized' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM public.settlement_finalizations
    WHERE source_id = v_source
      AND accountability_round_id IS NULL
      AND business_date = ((v_received AT TIME ZONE 'Asia/Bangkok') - interval '4 hours')::date
  ) THEN
    RAISE EXCEPTION 'slip_check_round_finalized' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
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
BEGIN
  SELECT slip_check_id INTO v_check FROM public.slip_check_approvals
  WHERE id = p_approval_id AND status = 'active';
  IF NOT FOUND OR v_check IS NULL THEN
    -- A manual-entry decision cannot be revoked without 20261102130000.
    RAISE EXCEPTION 'slip_check_review_not_active' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM 1 FROM public.slip_checks WHERE id = v_check FOR UPDATE;
  PERFORM public.assert_slip_check_round_open(v_check);
  UPDATE public.slip_check_approvals
  SET status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_revoked_by, revoke_reason = p_reason
  WHERE id = p_approval_id;
  RETURN jsonb_build_object('revoked', true);
END;
$$;

DROP FUNCTION IF EXISTS public.assert_manual_entry_round_open(uuid);
DROP FUNCTION IF EXISTS public.money_close_is_finalized(text, date, uuid);
DROP FUNCTION IF EXISTS public.lock_money_close(text, date, uuid);

-- 20260926090000 definition of the append RPC (ignores reference/review keys).
CREATE OR REPLACE FUNCTION public.append_manual_slip_entries_atomic(
  p_session_id uuid,
  p_entries jsonb,
  p_line_message_id text,
  p_line_user_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_start integer;
  v_expected integer;
  v_inserted integer;
BEGIN
  IF p_line_message_id IS NULL OR btrim(p_line_message_id) = '' THEN
    RAISE EXCEPTION 'manual_slip_line_message_id_required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'manual_slip_entries_required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT status INTO v_status
  FROM public.manual_slip_sessions
  WHERE id = p_session_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual_slip_session_not_found:%', p_session_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'manual_slip_session_not_open:%', p_session_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.manual_slip_entries
    WHERE session_id = p_session_id
      AND line_message_id = p_line_message_id
  ) THEN
    RETURN jsonb_build_object('inserted', 0, 'duplicate', true);
  END IF;
  SELECT COALESCE(MAX(sequence_no) + 1, 0)
  INTO v_start
  FROM public.manual_slip_entries
  WHERE session_id = p_session_id;
  v_expected := jsonb_array_length(p_entries);
  INSERT INTO public.manual_slip_entries (
    session_id, sequence_no, raw_line, amount, line_message_id, line_user_id
  )
  SELECT
    p_session_id,
    v_start + ordinality::integer - 1,
    elem->>'raw_line',
    (elem->>'amount')::numeric,
    p_line_message_id,
    p_line_user_id
  FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS x(elem, ordinality)
  WHERE NULLIF(btrim(elem->>'raw_line'), '') IS NOT NULL
    AND (elem->>'amount')::numeric > 0;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> v_expected THEN
    RAISE EXCEPTION 'manual_slip_entries_invalid: expected %, inserted %',
      v_expected, v_inserted
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN jsonb_build_object('inserted', v_inserted, 'duplicate', false);
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_slip_check_review(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_slip_check_review(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.append_manual_slip_entries_atomic(uuid, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_manual_slip_entries_atomic(uuid, jsonb, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.assert_slip_check_round_open(uuid) FROM PUBLIC, anon, authenticated;

COMMIT;
