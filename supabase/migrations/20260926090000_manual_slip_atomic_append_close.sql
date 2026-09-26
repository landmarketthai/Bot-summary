-- Manual-slip financial correctness hardening.
-- Serializes append and close on the parent session row so a closed session
-- can never gain entries that were excluded from the close total.
BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_manual_slip_entry_open_session()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status
  FROM public.manual_slip_sessions
  WHERE id = NEW.session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual_slip_session_not_found:%', NEW.session_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'manual_slip_session_not_open:%', NEW.session_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS manual_slip_entries_require_open_session
  ON public.manual_slip_entries;
CREATE TRIGGER manual_slip_entries_require_open_session
BEFORE INSERT ON public.manual_slip_entries
FOR EACH ROW EXECUTE FUNCTION public.enforce_manual_slip_entry_open_session();

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

CREATE OR REPLACE FUNCTION public.close_manual_slip_session_atomic(
  p_session_id uuid,
  p_line_user_id text,
  p_line_message_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_total numeric(12,2);
BEGIN
  SELECT status INTO v_status
  FROM public.manual_slip_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual_slip_session_not_found:%', p_session_id
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT COALESCE(SUM(amount), 0)::numeric(12,2)
  INTO v_total
  FROM public.manual_slip_entries
  WHERE session_id = p_session_id;

  IF v_status = 'closed' THEN
    RETURN jsonb_build_object('total', v_total, 'already_closed', true);
  END IF;

  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'manual_slip_session_invalid_status:%', v_status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE public.manual_slip_sessions
  SET status = 'closed',
      closed_at = clock_timestamp(),
      closed_by_line_user_id = p_line_user_id,
      closed_line_message_id = p_line_message_id
  WHERE id = p_session_id;

  RETURN jsonb_build_object('total', v_total, 'already_closed', false);
END;
$$;

REVOKE ALL ON FUNCTION public.append_manual_slip_entries_atomic(uuid, jsonb, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_manual_slip_entries_atomic(uuid, jsonb, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.close_manual_slip_session_atomic(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_manual_slip_session_atomic(uuid, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.enforce_manual_slip_entry_open_session()
  FROM PUBLIC, anon, authenticated;

COMMIT;
