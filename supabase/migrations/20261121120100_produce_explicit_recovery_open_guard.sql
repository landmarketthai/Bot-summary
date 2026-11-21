BEGIN;

-- Recovery targets an open draft. An ordinary append can accept an older LINE
-- item after a close boundary, so it cannot enforce this rule on our behalf.
CREATE OR REPLACE FUNCTION public.recover_pending_produce_deferred_event(
  p_session_key text,
  p_line_event_id text,
  p_raw_text text,
  p_reply_token text,
  p_line_timestamp_ms bigint,
  p_expected_session_generation uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_pending public.pending_sessions%ROWTYPE;
  v_append jsonb;
BEGIN
  IF COALESCE(btrim(p_session_key), '') = ''
     OR COALESCE(btrim(p_line_event_id), '') = ''
     OR p_expected_session_generation IS NULL THEN
    RAISE EXCEPTION 'deferred Produce recovery requires a session key, line event id, and expected generation';
  END IF;

  SELECT * INTO v_pending FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_found');
  END IF;
  IF v_pending.session_generation IS DISTINCT FROM p_expected_session_generation THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'generation_conflict');
  END IF;
  IF v_pending.terminalized OR v_pending.entry_origin IS NOT NULL
     OR v_pending.plain_text_opened_line_timestamp_ms IS NULL
     OR v_pending.close_event_timestamp_ms IS NOT NULL THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'recovery_draft_closed');
  END IF;

  v_append := public.append_pending_session(
    p_session_key, p_raw_text, p_reply_token, p_line_event_id,
    p_line_timestamp_ms, false, p_expected_session_generation, NULL
  );

  IF COALESCE((v_append->>'accepted')::boolean, false) THEN
    UPDATE public.pending_produce_deferred_events
    SET status = 'admitted', defer_reason = 'explicit_recovery',
        session_generation = p_expected_session_generation, resolved_at = clock_timestamp()
    WHERE line_event_id = p_line_event_id AND session_key = p_session_key
      AND status IN ('waiting', 'rejected_before_opener', 'rejected_after_close', 'rejected_orphan');
  END IF;

  RETURN v_append;
END;
$fn$;

COMMIT;
