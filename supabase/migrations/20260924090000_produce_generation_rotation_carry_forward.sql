-- Carry forward Produce items that a stale live generation admitted before a
-- timestamp-earlier opener reached the server.
--
-- Production incident (2026-09-23):
--   header: 1790176127327  "พี่เต้ย-ตลาด72 ชั่งคืน 23/9/2569"
--   item 1: 1790176127487  "1.น้อยหน่า40บาท\n30.5โล"
--
-- Item 1 executed first while the stream still had a previous live generation.
-- append_or_defer_pending_produce_item therefore admitted it to that generation
-- instead of creating a waiting deferred row. The header then rotated the
-- single pending_sessions row and replaced accumulated_text, stranding Item 1
-- in pending_session_ingest under the retired generation.
--
-- Rotation now re-admits retired-generation ingest rows, plus boundary rejects
-- made against that retired generation, only when the authoritative LINE
-- timestamp is strictly inside the new opener/close interval. True orphans and
-- rows at/before the opener or at/after the close remain rejected.

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure(
       'public.open_pending_plain_text_generation('
       || 'text,text,text,text,bigint,text,text,boolean,integer,uuid,text)'
     ) IS NULL THEN
    RAISE EXCEPTION
      '20260924090000: open_pending_plain_text_generation is missing; apply 20260815094931 first';
  END IF;
  IF to_regclass('public.pending_session_ingest') IS NULL THEN
    RAISE EXCEPTION '20260924090000: public.pending_session_ingest is missing';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.open_pending_plain_text_generation(
  p_session_key                 text,
  p_source_id                   text,
  p_line_user_id                text,
  p_line_event_id               text,
  p_line_timestamp_ms           bigint,
  p_raw_text                    text,
  p_reply_token                 text,
  p_mark_close                  boolean,
  p_expected_item_count         integer,
  p_expected_session_generation uuid,
  p_runtime_environment         text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_row            public.pending_sessions%ROWTYPE;
  v_generation     uuid;
  v_now            timestamptz := clock_timestamp();
  v_existing       boolean := false;
  v_reconciled     integer := 0;
  v_deferred       public.pending_produce_deferred_events%ROWTYPE;
  v_append         jsonb;
  v_carried        integer := 0;
  v_prior_gen      uuid;
  v_prior_opener   text;
  v_prior_close    text;
  v_stranded       record;
BEGIN
  IF COALESCE(btrim(p_session_key), '') = ''
     OR COALESCE(btrim(p_source_id), '') = ''
     OR COALESCE(btrim(p_line_user_id), '') = ''
     OR COALESCE(btrim(p_line_event_id), '') = ''
     OR COALESCE(btrim(p_raw_text), '') = ''
     OR p_line_timestamp_ms IS NULL OR p_line_timestamp_ms <= 0 THEN
    RAISE EXCEPTION 'plain-text opener identity, timestamp, and text are required';
  END IF;
  IF p_runtime_environment NOT IN ('production', 'preview', 'development') THEN
    RAISE EXCEPTION 'invalid runtime_environment: %', p_runtime_environment;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_session_key, 0));

  SELECT * INTO v_row
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF FOUND THEN
    v_existing := true;
    IF v_row.entry_origin IS NOT NULL THEN
      RETURN jsonb_build_object('opened', false, 'reason', 'structured_session_active');
    END IF;
    IF v_row.plain_text_opened_line_event_id = p_line_event_id THEN
      v_generation := v_row.session_generation;
    ELSE
      IF p_expected_session_generation IS NOT NULL
         AND v_row.session_generation IS DISTINCT FROM p_expected_session_generation THEN
        RETURN jsonb_build_object('opened', false, 'reason', 'generation_conflict');
      END IF;
      IF p_expected_session_generation IS NULL AND NOT v_row.terminalized THEN
        RETURN jsonb_build_object('opened', false, 'reason', 'active_generation_exists');
      END IF;

      v_prior_gen    := v_row.session_generation;
      v_prior_opener := v_row.plain_text_opened_line_event_id;
      v_prior_close  := v_row.close_line_event_id;

      v_generation := gen_random_uuid();
      UPDATE public.pending_sessions
      SET session_generation = v_generation,
          source_id = p_source_id,
          accumulated_text = p_raw_text,
          latest_reply_token = p_reply_token,
          line_user_id = p_line_user_id,
          created_at = v_now,
          updated_at = v_now,
          plain_text_opened_line_event_id = p_line_event_id,
          plain_text_opened_line_timestamp_ms = p_line_timestamp_ms,
          close_event_timestamp_ms = CASE WHEN p_mark_close THEN p_line_timestamp_ms END,
          close_requested_at = CASE WHEN p_mark_close THEN v_now END,
          close_line_event_id = CASE WHEN p_mark_close THEN p_line_event_id END,
          close_finalize_started_at = NULL,
          terminalized = false,
          next_attempt_at = CASE WHEN p_mark_close THEN v_now + interval '8 seconds' END,
          close_deadline_at = CASE WHEN p_mark_close THEN v_now + interval '30 seconds' END,
          close_session_generation = CASE WHEN p_mark_close THEN v_generation END,
          expected_item_count = CASE WHEN p_mark_close THEN p_expected_item_count END,
          ingest_revision = 1,
          finalization_started_at = NULL,
          finalized_at = NULL,
          finalization_status = 'pending',
          finalization_error = NULL,
          finalized_produce_session_id = NULL,
          accountability_round_id = NULL,
          finalize_hold_until = NULL,
          finalize_confirmed_at = NULL,
          finalize_confirm_line_event_id = NULL,
          runtime_environment = p_runtime_environment
      WHERE session_key = p_session_key;
    END IF;
  ELSE
    IF p_expected_session_generation IS NOT NULL THEN
      RETURN jsonb_build_object('opened', false, 'reason', 'generation_conflict');
    END IF;
    v_generation := gen_random_uuid();
    INSERT INTO public.pending_sessions (
      session_key, source_id, accumulated_text, latest_reply_token, line_user_id,
      created_at, updated_at, session_generation,
      plain_text_opened_line_event_id, plain_text_opened_line_timestamp_ms,
      close_event_timestamp_ms, close_requested_at, close_line_event_id,
      terminalized, next_attempt_at, close_deadline_at, close_session_generation,
      expected_item_count, ingest_revision, finalization_status, runtime_environment
    ) VALUES (
      p_session_key, p_source_id, p_raw_text, p_reply_token, p_line_user_id,
      v_now, v_now, v_generation,
      p_line_event_id, p_line_timestamp_ms,
      CASE WHEN p_mark_close THEN p_line_timestamp_ms END,
      CASE WHEN p_mark_close THEN v_now END,
      CASE WHEN p_mark_close THEN p_line_event_id END,
      false,
      CASE WHEN p_mark_close THEN v_now + interval '8 seconds' END,
      CASE WHEN p_mark_close THEN v_now + interval '30 seconds' END,
      CASE WHEN p_mark_close THEN v_generation END,
      CASE WHEN p_mark_close THEN p_expected_item_count END,
      1, 'pending', p_runtime_environment
    );
  END IF;

  INSERT INTO public.pending_session_admission (
    session_key, session_generation, line_event_id, line_timestamp_ms
  ) VALUES (p_session_key, v_generation, p_line_event_id, p_line_timestamp_ms)
  ON CONFLICT (session_generation, line_event_id) DO NOTHING;
  INSERT INTO public.pending_session_ingest (
    session_key, session_generation, line_event_id, line_timestamp_ms, raw_text
  ) VALUES (p_session_key, v_generation, p_line_event_id, p_line_timestamp_ms, p_raw_text)
  ON CONFLICT (session_generation, line_event_id) DO NOTHING;

  -- The fast admission path could only see the stale generation when these
  -- events executed. Preserve its ledger, but re-admit only events whose LINE
  -- time places them inside the generation being opened now.
  IF v_prior_gen IS NOT NULL THEN
    FOR v_stranded IN
      SELECT line_event_id, line_timestamp_ms, raw_text
      FROM public.pending_session_ingest
      WHERE session_key = p_session_key
        AND session_generation = v_prior_gen
        AND line_timestamp_ms > p_line_timestamp_ms
        AND (NOT p_mark_close OR line_timestamp_ms < p_line_timestamp_ms)
        AND line_event_id <> p_line_event_id
        AND line_event_id IS DISTINCT FROM v_prior_opener
        AND line_event_id IS DISTINCT FROM v_prior_close
      ORDER BY line_timestamp_ms, line_event_id
    LOOP
      v_append := public.append_pending_session(
        p_session_key,
        v_stranded.raw_text,
        p_reply_token,
        v_stranded.line_event_id,
        v_stranded.line_timestamp_ms,
        false,
        v_generation,
        NULL
      );
      IF COALESCE((v_append->>'accepted')::boolean, false) THEN
        v_carried := v_carried + 1;
      END IF;
    END LOOP;
  END IF;

  -- Waiting rows are the original no-opener case. Boundary rejects are eligible
  -- only when they were judged against the exact generation just retired.
  -- rejected_orphan is intentionally excluded because it has no proven opener.
  FOR v_deferred IN
    SELECT *
    FROM public.pending_produce_deferred_events
    WHERE runtime_environment = p_runtime_environment
      AND session_key = p_session_key
      AND line_timestamp_ms > p_line_timestamp_ms
      AND (NOT p_mark_close OR line_timestamp_ms < p_line_timestamp_ms)
      AND (
        (status = 'waiting' AND expires_at > v_now)
        OR (
          v_prior_gen IS NOT NULL
          AND session_generation = v_prior_gen
          AND status IN ('rejected_before_opener', 'rejected_after_close')
        )
      )
    ORDER BY line_timestamp_ms, line_event_id
    FOR UPDATE
  LOOP
    v_append := public.append_pending_session(
      p_session_key,
      v_deferred.raw_text,
      v_deferred.reply_token,
      v_deferred.line_event_id,
      v_deferred.line_timestamp_ms,
      false,
      v_generation,
      NULL
    );
    IF COALESCE((v_append->>'accepted')::boolean, false) THEN
      UPDATE public.pending_produce_deferred_events
      SET status = 'admitted',
          defer_reason = CASE
            WHEN v_deferred.status = 'waiting' THEN 'reconciled_with_opener'
            ELSE 'reconciled_after_generation_rotation'
          END,
          session_generation = v_generation,
          opener_line_event_id = p_line_event_id,
          opener_line_timestamp_ms = p_line_timestamp_ms,
          close_line_event_id = CASE WHEN p_mark_close THEN p_line_event_id END,
          close_line_timestamp_ms = CASE WHEN p_mark_close THEN p_line_timestamp_ms END,
          resolved_at = clock_timestamp()
      WHERE line_event_id = v_deferred.line_event_id
        AND status = v_deferred.status;
      v_reconciled := v_reconciled + 1;
    END IF;
  END LOOP;

  SELECT * INTO v_row FROM public.pending_sessions WHERE session_key = p_session_key;
  RETURN jsonb_build_object(
    'opened', true,
    'reason', CASE WHEN v_existing THEN 'rotated_or_idempotent' ELSE 'created' END,
    'reconciled_count', v_reconciled + v_carried,
    'carried_forward_count', v_carried,
    'session', to_jsonb(v_row)
  );
END;
$fn$;

COMMENT ON FUNCTION public.open_pending_plain_text_generation(
  text, text, text, text, bigint, text, text, boolean, integer, uuid, text
) IS
  'Opens or rotates a plain-text Produce generation. On rotation, LINE timestamp '
  're-admits waiting events and retired-generation ingest strictly inside the new boundaries.';

REVOKE ALL ON FUNCTION public.open_pending_plain_text_generation(
  text, text, text, text, bigint, text, text, boolean, integer, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_pending_plain_text_generation(
  text, text, text, text, bigint, text, text, boolean, integer, uuid, text
) TO service_role;

COMMIT;
