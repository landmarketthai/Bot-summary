-- Release guards for slip money. Additive, re-runnable, no data changes.
-- Production apply required, after 20261103100000.
--
-- 1. Settled scopes take no new manual money (release P0-B). Once a
--    settlement of a (source, day, round) is handed out (sending / sent /
--    ambiguous) or has recorded its credits (any status), a manual-slip
--    session cannot be opened or closed there, and no entry can be added.
--    Before this, a session opened and closed AFTER the settlement added
--    unreferenced money to the day's live total (sent ฿70, live ฿100).
--    Enforced on the tables, so the LINE commands, the RPCs and any
--    server-side write are covered alike. Existing rows are untouched.
-- 2. Financial maintenance switch (release P0-C): one row,
--    financial_maintenance.paused. While it is true the database refuses
--    every money commit:
--      * a settlement finalization entering sending / sent / ambiguous;
--      * a reference credit (claim_slip_references);
--      * a review decision (slip_check_approvals INSERT / UPDATE);
--      * manual-slip capture (session open / close, entries).
--    Evidence ingestion and OCR keep running and stay pending, so no LINE
--    event is lost. A refused finalization leaves its settlement unsent and
--    retryable. Toggle with SQL only (no API role can write the row).
-- Lock order is unchanged: scope keys round → day (lock_money_close_scope),
-- the same as reviews and the finalization trigger.

BEGIN;

CREATE TABLE IF NOT EXISTS public.financial_maintenance (
  singleton  boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  paused     boolean     NOT NULL DEFAULT false,
  reason     text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text
);
INSERT INTO public.financial_maintenance (singleton) VALUES (true) ON CONFLICT DO NOTHING;
ALTER TABLE public.financial_maintenance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_maintenance FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.financial_maintenance TO service_role;

CREATE OR REPLACE FUNCTION public.assert_financial_writes_open()
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.financial_maintenance WHERE paused) THEN
    RAISE EXCEPTION 'financial_maintenance' USING ERRCODE = 'object_not_in_prerequisite_state';
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
  PERFORM public.assert_financial_writes_open();
  PERFORM public.lock_money_close_scope(p_source, p_business_date, p_round);
  IF public.money_scope_is_settled(p_source, p_business_date, p_round) THEN
    RAISE EXCEPTION 'manual_slip_scope_settled' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_manual_slip_session_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed') THEN
    PERFORM public.assert_manual_slip_scope_open(NEW.source_id, NEW.business_date, NEW.accountability_round_id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS manual_slip_sessions_scope_guard ON public.manual_slip_sessions;
CREATE TRIGGER manual_slip_sessions_scope_guard
BEFORE INSERT OR UPDATE OF status ON public.manual_slip_sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_manual_slip_session_write();

CREATE OR REPLACE FUNCTION public.guard_manual_slip_entry_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source text;
  v_day date;
  v_round uuid;
BEGIN
  SELECT s.source_id, s.business_date, s.accountability_round_id INTO v_source, v_day, v_round
  FROM public.manual_slip_sessions s WHERE s.id = NEW.session_id;
  PERFORM public.assert_manual_slip_scope_open(v_source, v_day, v_round);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS manual_slip_entries_scope_guard ON public.manual_slip_entries;
CREATE TRIGGER manual_slip_entries_scope_guard
BEFORE INSERT ON public.manual_slip_entries
FOR EACH ROW EXECUTE FUNCTION public.guard_manual_slip_entry_write();

-- Review decisions stop during maintenance.
CREATE OR REPLACE FUNCTION public.guard_slip_review_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_financial_writes_open();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS slip_check_approvals_maintenance_guard ON public.slip_check_approvals;
CREATE TRIGGER slip_check_approvals_maintenance_guard
BEFORE INSERT OR UPDATE ON public.slip_check_approvals
FOR EACH ROW EXECUTE FUNCTION public.guard_slip_review_write();

-- Finalizations stop entering a handed-out status during maintenance
-- (20261102160000 body + the check). Leaving one (sending → sent / failed)
-- stays allowed, so an in-flight settlement can still record its outcome.
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
      PERFORM public.assert_financial_writes_open();
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

-- Credits stop during maintenance (20261103100000 body + the check).
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
  PERFORM public.assert_financial_writes_open();
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
REVOKE ALL ON FUNCTION public.assert_financial_writes_open() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.money_scope_is_settled(text, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_manual_slip_scope_open(text, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_manual_slip_session_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_manual_slip_entry_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_slip_review_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lock_settlement_finalization_money() FROM PUBLIC, anon, authenticated;

COMMIT;
