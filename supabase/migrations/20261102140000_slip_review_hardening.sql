-- Hardening of slip reviews after an adversarial review of 20261102120000 /
-- 20261102130000. Forward-only, re-runnable, no data changes. Production
-- apply required, after 20261102130000.
--
-- 1. "Finalized" means money handed out or possibly handed out
--    (sending / sent / ambiguous). A failed or not-yet-claimed finalization no
--    longer blocks reviews: its retry claims the row and re-reconciles.
-- 2. The money-close lock is also taken when a finalization row is UPDATEd
--    (the failed → sending re-claim), not only on INSERT.
-- 3. A round-bound slip is also covered by the legacy day-level finalization
--    (accountability_round_id NULL, which reconciles round-bound evidence of
--    that source/day): reviews take the round AND the day lock and check both.
-- 4. Ownership of a full reference is the same rule as
--    src/lib/slips/reference-ownership.ts: the earliest AI read (with a
--    transfer amount, not rejected) or counted manual entry owns the money.
--      * approving an AI read is refused when an earlier counted manual entry
--        owns the reference;
--      * approving a manual entry is refused when the AI read or an earlier
--        manual entry owns the reference (wallet reads, without a transfer
--        amount, never own bank money);
--      * revoking a decision is refused while the other path holds a claim on
--        the same reference — so money never moves out of a finalized round.
-- 5. An identical retry returns the existing decision before any other check
--    (idempotent even after finalization).
-- 6. service_role cannot write slip_check_approvals directly: decisions are
--    written only by the SECURITY DEFINER review RPCs.

BEGIN;

-- ── 1–3: finalized scope and locks ──────────────────────────────────────────
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

-- Round key first, then day key: one fixed order, so two reviews cannot deadlock.
CREATE OR REPLACE FUNCTION public.lock_money_close_scope(p_source text, p_business_date date, p_round uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_round IS NOT NULL THEN
    PERFORM public.lock_money_close(p_source, p_business_date, p_round);
  END IF;
  PERFORM public.lock_money_close(p_source, p_business_date, NULL);
END;
$$;

DROP TRIGGER IF EXISTS settlement_finalizations_money_close_lock ON public.settlement_finalizations;
CREATE TRIGGER settlement_finalizations_money_close_lock
BEFORE INSERT OR UPDATE OF status ON public.settlement_finalizations
FOR EACH ROW EXECUTE FUNCTION public.lock_settlement_finalization_money();

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
  IF v_round IS NOT NULL THEN
    SELECT coalesce((SELECT r.business_date FROM public.accountability_rounds r WHERE r.id = v_round), v_day)
    INTO v_day;
  END IF;
  PERFORM public.lock_money_close_scope(v_source, v_day, v_round);
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
  PERFORM public.lock_money_close_scope(v_source, v_day, v_round);
  IF public.money_close_is_finalized(v_source, v_day, v_round) THEN
    RAISE EXCEPTION 'slip_check_round_finalized' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;

-- ── 4: reference ownership helpers ──────────────────────────────────────────
-- A manual entry that counts as money on its own (not superseded): closed
-- session, not rejected, approved — or needs no review and the AI read of the
-- reference was not rejected.
CREATE OR REPLACE FUNCTION public.manual_entry_claims_reference(p_entry_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.manual_slip_entries e
    JOIN public.manual_slip_sessions s ON s.id = e.session_id AND s.status = 'closed'
    LEFT JOIN public.slip_check_approvals d ON d.manual_entry_id = e.id AND d.status = 'active'
    WHERE e.id = p_entry_id
      AND coalesce(d.decision, '') <> 'rejected'
      AND (d.decision = 'approved' OR (
        NOT e.requires_review
        AND NOT EXISTS (
          SELECT 1 FROM public.slip_checks w
          JOIN public.slip_check_approvals wd ON wd.slip_check_id = w.id AND wd.status = 'active' AND wd.decision = 'rejected'
          WHERE w.id = (
            SELECT c.id FROM public.slip_checks c
            WHERE btrim(c.reference_id) = btrim(e.reference_id) AND c.status IN ('EXTRACTED', 'PARTIAL_EXTRACTED')
            ORDER BY c.created_at, c.id LIMIT 1
          )
        )
      ))
  );
$$;

-- ── 4–5: review RPCs ─────────────────────────────────────────────────────────
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
  v_decision text;
  v_ref text;
BEGIN
  SELECT slip_check_id, manual_entry_id, decision INTO v_check, v_entry, v_decision
  FROM public.slip_check_approvals
  WHERE id = p_approval_id AND status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'slip_check_review_not_active' USING ERRCODE = 'no_data_found';
  END IF;

  -- A revoke may not hand the reference's money to a row in ANOTHER round
  -- (which may already be finalized). Refused exactly when ownership could move.
  IF v_check IS NOT NULL THEN
    SELECT nullif(btrim(reference_id), '') INTO v_ref FROM public.slip_checks WHERE id = v_check;
    -- Revoking an approval leaves the AI read live (owner unchanged). Revoking
    -- a REJECTION makes it live again and can take the money from a manual
    -- entry of the same reference: resolve that entry first.
    IF v_decision = 'rejected' AND v_ref IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.manual_slip_entries e
      LEFT JOIN public.slip_check_approvals d ON d.manual_entry_id = e.id AND d.status = 'active'
      WHERE btrim(e.reference_id) = v_ref AND coalesce(d.decision, '') <> 'rejected'
    ) THEN
      RAISE EXCEPTION 'slip_check_review_has_dependents' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    PERFORM public.assert_slip_check_round_open(v_check);
  ELSE
    SELECT nullif(btrim(reference_id), '') INTO v_ref FROM public.manual_slip_entries WHERE id = v_entry;
    -- A referenced manual decision competes with the live AI read and other
    -- manual entries of the reference: undoing it could move the money.
    IF v_ref IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM public.slip_checks c
        WHERE btrim(c.reference_id) = v_ref AND c.status IN ('EXTRACTED', 'PARTIAL_EXTRACTED')
          AND c.transfer_amount IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.slip_check_approvals a
                          WHERE a.slip_check_id = c.id AND a.status = 'active' AND a.decision = 'rejected')
      )
      OR EXISTS (
        SELECT 1 FROM public.manual_slip_entries o
        LEFT JOIN public.slip_check_approvals d ON d.manual_entry_id = o.id AND d.status = 'active'
        WHERE btrim(o.reference_id) = v_ref AND o.id <> v_entry AND coalesce(d.decision, '') <> 'rejected'
      )
    ) THEN
      RAISE EXCEPTION 'slip_check_review_has_dependents' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    PERFORM public.assert_manual_entry_round_open(v_entry);
  END IF;

  UPDATE public.slip_check_approvals
  SET status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_revoked_by, revoke_reason = p_reason
  WHERE id = p_approval_id;
  RETURN jsonb_build_object('revoked', true);
END;
$$;

-- ── 6: decisions are written only by the RPCs ───────────────────────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.slip_check_approvals FROM service_role;

REVOKE ALL ON FUNCTION public.review_slip_check(uuid, text, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_slip_check(uuid, text, numeric, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.review_manual_slip_entry(uuid, text, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_manual_slip_entry(uuid, text, numeric, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.revoke_slip_check_review(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_slip_check_review(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.money_close_is_finalized(text, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lock_money_close_scope(text, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_slip_check_round_open(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_manual_entry_round_open(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.manual_entry_claims_reference(uuid) FROM PUBLIC, anon, authenticated;

COMMIT;
