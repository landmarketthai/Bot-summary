-- Release guards for slip money. Additive, re-runnable, no data changes.
-- Production apply required, after 20261103100000. Needs 20261102110000
-- (the financial write stop: financial_maintenance + assert_financial_writes_open).
--
-- 1. Settled scopes take no new manual money (release P0-B). Once a
--    settlement of a (source, day, round) is handed out (sending / sent /
--    ambiguous) or has recorded its credits (any status), a manual-slip
--    session cannot be opened or closed there, and no entry can be added.
--    Before this, a session opened and closed AFTER the settlement added
--    unreferenced money to the day's live total (sent ฿70, live ฿100).
--    Enforced on the tables, so the LINE commands, the RPCs and any
--    server-side write are covered alike. Existing rows are untouched.
--    Scope rule (asymmetric on purpose): a legacy-day settlement (round NULL)
--    settles every round of that source and day; a round settlement settles
--    that round only, never the legacy-day scope. Locks have the same shape:
--    a round-scope write takes the round key then the day key, a day-scope
--    write the day key only, so day and round writes of one source and day
--    always meet on the day key.
-- 2. Manual slips are immutable once written (release P1-3): an entry is
--    never updated or deleted; a session is never deleted, never moves to
--    another source / day / round, and once closed is never updated again.
--    The only session UPDATE is the open -> closed close. TRUNCATE of either
--    table is refused. service_role can open a session directly, but append
--    and close only through their SECURITY DEFINER RPCs; triggers also cover
--    owner/direct SQL.
-- 3. The financial write stop of 20261102110000 also covers review decisions
--    (slip_check_approvals INSERT / UPDATE) and reference credits
--    (claim_slip_references), including the pilot source allowlist.
-- Lock order: stop row (FOR SHARE) → scope keys round → day.

BEGIN;

-- Review RPCs lock the money scope BEFORE their approval-row trigger fires.
-- Acquire the maintenance-row share lock in those entry points first; the
-- approval trigger then reacquires it in the same transaction. Do NOT put the
-- stop in lock_money_close itself: finalizations leaving 'sending' for
-- 'failed'/'sent' MUST still be able to record an in-flight outcome while
-- financial_maintenance is paused.
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
  PERFORM public.assert_financial_writes_open(v_source);
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
  PERFORM public.assert_financial_writes_open(v_source);
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

-- A scope is settled when its money was handed out, or its settlement
-- recorded credits (even if that row is now failed: its retry re-sends them).
CREATE OR REPLACE FUNCTION public.money_scope_is_settled(p_source text, p_business_date date, p_round uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT public.money_close_is_finalized(p_source, p_business_date, p_round)
      OR EXISTS (
        SELECT 1 FROM public.settlement_finalizations f
        WHERE f.claims_recorded_at IS NOT NULL
          AND f.source_id = p_source AND f.business_date = p_business_date
          AND (f.accountability_round_id IS NULL OR f.accountability_round_id = p_round)
      );
$$;

CREATE OR REPLACE FUNCTION public.assert_manual_slip_scope_open(p_source text, p_business_date date, p_round uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_financial_writes_open(p_source);
  PERFORM public.lock_money_close_scope(p_source, p_business_date, p_round);
  IF public.money_scope_is_settled(p_source, p_business_date, p_round) THEN
    RAISE EXCEPTION 'manual_slip_scope_settled' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_manual_slip_session_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'manual_slip_immutable' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       OLD.status IS DISTINCT FROM 'open'
       OR NEW.status IS DISTINCT FROM 'closed'
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.business_date IS DISTINCT FROM OLD.business_date
       OR NEW.accountability_round_id IS DISTINCT FROM OLD.accountability_round_id) THEN
    RAISE EXCEPTION 'manual_slip_immutable' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF TG_OP = 'INSERT' OR (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed') THEN
    PERFORM public.assert_manual_slip_scope_open(NEW.source_id, NEW.business_date, NEW.accountability_round_id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS manual_slip_sessions_scope_guard ON public.manual_slip_sessions;
CREATE TRIGGER manual_slip_sessions_scope_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.manual_slip_sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_manual_slip_session_write();

CREATE OR REPLACE FUNCTION public.guard_manual_slip_entry_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source text;
  v_day date;
  v_round uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'manual_slip_immutable' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT s.source_id, s.business_date, s.accountability_round_id INTO v_source, v_day, v_round
  FROM public.manual_slip_sessions s WHERE s.id = NEW.session_id;
  PERFORM public.assert_manual_slip_scope_open(v_source, v_day, v_round);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS manual_slip_entries_scope_guard ON public.manual_slip_entries;
CREATE TRIGGER manual_slip_entries_scope_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.manual_slip_entries
FOR EACH ROW EXECUTE FUNCTION public.guard_manual_slip_entry_write();

CREATE OR REPLACE FUNCTION public.refuse_manual_slip_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'manual_slip_immutable' USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;
DROP TRIGGER IF EXISTS manual_slip_sessions_no_truncate ON public.manual_slip_sessions;
CREATE TRIGGER manual_slip_sessions_no_truncate
BEFORE TRUNCATE ON public.manual_slip_sessions
FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_manual_slip_truncate();
DROP TRIGGER IF EXISTS manual_slip_entries_no_truncate ON public.manual_slip_entries;
CREATE TRIGGER manual_slip_entries_no_truncate
BEFORE TRUNCATE ON public.manual_slip_entries
FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_manual_slip_truncate();

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.manual_slip_sessions FROM service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.manual_slip_entries FROM service_role;

-- Review decisions stop during maintenance and outside the pilot sources.
CREATE OR REPLACE FUNCTION public.guard_slip_review_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_financial_writes_open(coalesce(
    (SELECT e.source_id FROM public.slip_checks c JOIN public.slip_evidences e ON e.id = c.evidence_id
     WHERE c.id = NEW.slip_check_id),
    (SELECT s.source_id FROM public.manual_slip_entries m JOIN public.manual_slip_sessions s ON s.id = m.session_id
     WHERE m.id = NEW.manual_entry_id)));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS slip_check_approvals_maintenance_guard ON public.slip_check_approvals;
CREATE TRIGGER slip_check_approvals_maintenance_guard
BEFORE INSERT OR UPDATE ON public.slip_check_approvals
FOR EACH ROW EXECUTE FUNCTION public.guard_slip_review_write();

-- Credits stop during maintenance and outside the pilot (20261103100000 body + the check).
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
  v_source text;
BEGIN
  SELECT f.status, f.claims_recorded_at, f.source_id INTO v_status, v_recorded, v_source
  FROM public.settlement_finalizations f WHERE f.id = p_finalization_id FOR UPDATE;
  PERFORM public.assert_financial_writes_open(v_source);
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
REVOKE ALL ON FUNCTION public.money_scope_is_settled(text, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_manual_slip_scope_open(text, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_manual_slip_session_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_manual_slip_entry_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refuse_manual_slip_truncate() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_slip_review_write() FROM PUBLIC, anon, authenticated;

COMMIT;
