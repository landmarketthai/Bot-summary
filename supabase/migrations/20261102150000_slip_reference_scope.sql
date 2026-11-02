-- Reference normalization and the receipt-day scope for slip reviews.
-- Forward-only, re-runnable, no data changes. Production apply required,
-- after 20261102140000.
--
-- 1. normalize_slip_reference(): removes every whitespace character, including
--    no-break / zero-width spaces — the same rule as parseSlipExtraction (AI
--    reads) and normalizeSlipReference (TypeScript). Manual references are
--    stored normalized, so "0123 4567" can never escape the match with the
--    AI read "01234567" and be counted twice.
-- 2. A review of a round-bound AI slip also locks and checks the legacy
--    day-level (NULL-round) settlement of its RECEIPT day: the legacy
--    unscoped path counts evidence by the 04:00 receipt window, which can be
--    a different day from the round's business date. Lock order stays fixed
--    (round key, then day keys ascending), so reviews cannot deadlock.

BEGIN;

CREATE OR REPLACE FUNCTION public.normalize_slip_reference(p_reference text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT nullif(regexp_replace(coalesce(p_reference, ''),
    E'[[:space:]\\u00A0\\u1680\\u2000-\\u200D\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]', '', 'g'), '');
$$;

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

-- Same signature and checks as 20261102130000; the stored reference is normalized.
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
    public.normalize_slip_reference(elem->>'reference_id'),
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

REVOKE ALL ON FUNCTION public.normalize_slip_reference(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_slip_check_round_open(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.append_manual_slip_entries_atomic(uuid, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_manual_slip_entries_atomic(uuid, jsonb, text, text) TO service_role;

COMMIT;
