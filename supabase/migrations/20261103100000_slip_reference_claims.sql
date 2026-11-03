-- Persisted credits: one settlement finalization per canonical transfer
-- reference. Design contract: docs/slip-reference-claims.md. Additive,
-- re-runnable, no data changes. Production apply required, after
-- 20261102160000, BEFORE the app code that writes claims.
--
-- Replaces ownership derived from the current state of AI reads and manual
-- entries (which changes after a scope finalized: reviews, late images, late
-- sessions, LINE push failures) with a ledger the finalizer writes BEFORE it
-- reconciles. The primary key makes two concurrent finalizations credit one
-- reference at most once; rows are append-only, so a LINE timeout, a failed
-- status or a later review never erases a credit.

BEGIN;

CREATE TABLE IF NOT EXISTS public.slip_reference_claims (
  reference_id    text        PRIMARY KEY,
  finalization_id uuid        NOT NULL REFERENCES public.settlement_finalizations (id),
  slip_check_id   uuid        REFERENCES public.slip_checks (id),
  manual_entry_id uuid        REFERENCES public.manual_slip_entries (id),
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slip_reference_claims_one_target CHECK ((slip_check_id IS NULL) <> (manual_entry_id IS NULL))
);
-- Separate so a re-apply after the down file (which drops it) restores it.
ALTER TABLE public.slip_reference_claims DROP CONSTRAINT IF EXISTS slip_reference_claims_canonical;
ALTER TABLE public.slip_reference_claims ADD CONSTRAINT slip_reference_claims_canonical
  CHECK (reference_id = public.normalize_slip_reference(reference_id));
CREATE INDEX IF NOT EXISTS slip_reference_claims_finalization ON public.slip_reference_claims (finalization_id);
ALTER TABLE public.slip_reference_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.slip_reference_claims FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.slip_reference_claims TO service_role;

-- A finalization that recorded claims freezes its scope: a referenced row it
-- did not credit is "late after settlement" (pending), never counted.
ALTER TABLE public.settlement_finalizations ADD COLUMN IF NOT EXISTS claims_recorded_at timestamptz;

CREATE OR REPLACE FUNCTION public.slip_reference_claims_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'slip_reference_claims_append_only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS slip_reference_claims_append_only ON public.slip_reference_claims;
CREATE TRIGGER slip_reference_claims_append_only
BEFORE UPDATE OR DELETE ON public.slip_reference_claims
FOR EACH ROW EXECUTE FUNCTION public.slip_reference_claims_append_only();
DROP TRIGGER IF EXISTS slip_reference_claims_no_truncate ON public.slip_reference_claims;
CREATE TRIGGER slip_reference_claims_no_truncate
BEFORE TRUNCATE ON public.slip_reference_claims
FOR EACH STATEMENT EXECUTE FUNCTION public.slip_reference_claims_append_only();

-- Claims for a finalization that is being sent. Returns the claim that now
-- exists for every requested reference (this finalization's, or an earlier one).
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

  -- A retry (failed → sending, stale re-claim) re-uses the credits of its first
  -- attempt and adds none: the message LINE may already have delivered was
  -- built from exactly those.
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

-- Reviews respect credits: approve / reject / revoke of a target whose
-- reference is credited is refused (20261102150000 / 20261102140000 bodies + the check).
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

REVOKE ALL ON FUNCTION public.assert_slip_check_round_open(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_manual_entry_round_open(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.slip_reference_claims_append_only() FROM PUBLIC, anon, authenticated;

COMMIT;
