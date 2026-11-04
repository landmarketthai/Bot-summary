-- Manual slip entries that cannot be matched to an AI check are reviewed, not
-- auto-counted, in the new flow; and a review can never land after the round's
-- money is finalized, even under concurrent requests.
--
-- Builds on 20261102120000 (slip_check_approvals). Forward-only, additive,
-- re-runnable (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS).
--
--   * manual_slip_entries.requires_review — set by the NEW LINE flow for an
--     entry without a reference. Default false: every existing row and every
--     row written by today's app code keeps today's meaning (counted).
--   * slip_check_approvals.manual_entry_id — the same audited decision table
--     now also holds the authorized override for ONE manual entry (exactly one
--     of slip_check_id / manual_entry_id; one active decision per target).
--   * append_manual_slip_entries_atomic — same signature; additionally reads
--     optional reference_id / requires_review per entry. Old callers send
--     neither key and get exactly the old behaviour.
--   * money-close lock — settlement_finalizations INSERT and every review take
--     the same transaction advisory lock for the round (or source+day), so a
--     review either commits before the finalization or sees it and refuses.
--
-- Production apply required, after 20261102120000.

BEGIN;

ALTER TABLE public.manual_slip_entries
  ADD COLUMN IF NOT EXISTS requires_review boolean NOT NULL DEFAULT false;

ALTER TABLE public.slip_check_approvals
  ADD COLUMN IF NOT EXISTS manual_entry_id uuid REFERENCES public.manual_slip_entries(id) ON DELETE RESTRICT;
ALTER TABLE public.slip_check_approvals ALTER COLUMN slip_check_id DROP NOT NULL;
ALTER TABLE public.slip_check_approvals DROP CONSTRAINT IF EXISTS slip_check_approvals_one_target;
ALTER TABLE public.slip_check_approvals
  ADD CONSTRAINT slip_check_approvals_one_target CHECK (num_nonnulls(slip_check_id, manual_entry_id) = 1);
CREATE UNIQUE INDEX IF NOT EXISTS slip_check_approvals_one_active_manual
  ON public.slip_check_approvals (manual_entry_id) WHERE status = 'active' AND manual_entry_id IS NOT NULL;

-- The audit guard must also keep manual_entry_id immutable.
CREATE OR REPLACE FUNCTION public.guard_slip_check_approval_audit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'slip_check_approval_append_only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'revoked'
     OR NEW.slip_check_id IS DISTINCT FROM OLD.slip_check_id
     OR NEW.manual_entry_id IS DISTINCT FROM OLD.manual_entry_id
     OR NEW.decision IS DISTINCT FROM OLD.decision
     OR NEW.approved_amount IS DISTINCT FROM OLD.approved_amount
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.reviewer IS DISTINCT FROM OLD.reviewer
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'slip_check_approval_only_revoke_allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ── money-close lock ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lock_money_close(p_source text, p_business_date date, p_round uuid)
RETURNS void
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended(
    CASE WHEN p_round IS NOT NULL THEN 'money-close:round:' || p_round
         ELSE 'money-close:day:' || p_source || ':' || p_business_date END, 0));
$$;

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

DROP TRIGGER IF EXISTS settlement_finalizations_money_close_lock ON public.settlement_finalizations;
CREATE TRIGGER settlement_finalizations_money_close_lock
BEFORE INSERT ON public.settlement_finalizations
FOR EACH ROW EXECUTE FUNCTION public.lock_settlement_finalization_money();

-- AI check: lock its round, then refuse when already finalized.
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

-- ── authorized override of ONE manual entry ─────────────────────────────────
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
  -- Only a CLOSED session's entries are money; review what will be counted.
  IF v_session_status <> 'closed' THEN
    RAISE EXCEPTION 'manual_entry_session_not_closed' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- An entry whose reference has a live (not rejected) AI check is that AI
  -- check's money: approve the AI check instead, never both.
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

-- Revoke either kind of decision, under the same money-close lock.
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

-- Same signature and checks as 20260926090000; additionally stores the optional
-- per-entry reference_id / requires_review the new LINE flow sends.
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
    session_id, sequence_no, raw_line, amount, line_message_id, line_user_id, reference_id, requires_review
  )
  SELECT
    p_session_id,
    v_start + ordinality::integer - 1,
    elem->>'raw_line',
    (elem->>'amount')::numeric,
    p_line_message_id,
    p_line_user_id,
    nullif(btrim(elem->>'reference_id'), ''),
    coalesce((elem->>'requires_review')::boolean, false)
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

REVOKE ALL ON FUNCTION public.review_manual_slip_entry(uuid, text, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_manual_slip_entry(uuid, text, numeric, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.revoke_slip_check_review(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_slip_check_review(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.append_manual_slip_entries_atomic(uuid, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_manual_slip_entries_atomic(uuid, jsonb, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.lock_money_close(text, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.money_close_is_finalized(text, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lock_settlement_finalization_money() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_slip_check_round_open(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_manual_entry_round_open(uuid) FROM PUBLIC, anon, authenticated;

COMMIT;
