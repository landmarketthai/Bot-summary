-- TEST ONLY. Never apply to Production or place in supabase/migrations.
-- Source: 48450f00bba1d371b6af210a80fa804e0435d077:supabase/migrations/0042_pending_close_ingest.sql
-- Git blob: e55e853e055d95df5c9834ab6a58a6a28d84229e. Payload below is byte-for-byte unchanged.
-- Replay after 0030, before 0031; the reserved 0042 slot stays empty.
-- BEGIN VERBATIM HISTORICAL PAYLOAD
-- Pending produce sessions: generation-scoped ingest ledger + admission barrier.
-- Finalization rebuilds parser input from the ledger (LINE timestamp order),
-- not from accumulated_text append completion order.

ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS session_generation       uuid        NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS close_event_timestamp_ms bigint,
  ADD COLUMN IF NOT EXISTS close_requested_at      timestamptz,
  ADD COLUMN IF NOT EXISTS close_line_event_id     text,
  ADD COLUMN IF NOT EXISTS close_finalize_started_at timestamptz;

CREATE TABLE IF NOT EXISTS public.pending_session_ingest (
  session_key         text        NOT NULL REFERENCES public.pending_sessions(session_key) ON DELETE CASCADE,
  session_generation  uuid        NOT NULL,
  line_event_id       text        NOT NULL,
  line_timestamp_ms   bigint      NOT NULL,
  raw_text            text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_generation, line_event_id)
);

CREATE INDEX IF NOT EXISTS pending_session_ingest_session_key_idx
  ON public.pending_session_ingest (session_key, session_generation, line_timestamp_ms);

CREATE TABLE IF NOT EXISTS public.pending_session_admission (
  session_key         text        NOT NULL REFERENCES public.pending_sessions(session_key) ON DELETE CASCADE,
  session_generation  uuid        NOT NULL,
  line_event_id       text        NOT NULL,
  line_timestamp_ms   bigint      NOT NULL,
  admitted_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_generation, line_event_id)
);

CREATE INDEX IF NOT EXISTS pending_session_admission_session_key_idx
  ON public.pending_session_admission (session_key, session_generation, line_timestamp_ms);

CREATE OR REPLACE FUNCTION public.admit_pending_session_event(
  p_session_key         text,
  p_line_event_id       text,
  p_line_timestamp_ms   bigint
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_generation uuid;
BEGIN
  SELECT session_generation INTO v_generation
  FROM public.pending_sessions
  WHERE session_key = p_session_key;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO public.pending_session_admission (
    session_key,
    session_generation,
    line_event_id,
    line_timestamp_ms
  )
  VALUES (
    p_session_key,
    v_generation,
    p_line_event_id,
    p_line_timestamp_ms
  )
  ON CONFLICT (session_generation, line_event_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.append_pending_session(
  p_session_key         text,
  p_new_text            text,
  p_reply_token         text,
  p_line_event_id       text    DEFAULT NULL,
  p_line_timestamp_ms   bigint  DEFAULT NULL,
  p_mark_close          boolean DEFAULT false
)
RETURNS SETOF public.pending_sessions
LANGUAGE plpgsql
AS $$
DECLARE
  v_row public.pending_sessions%ROWTYPE;
  v_generation uuid;
BEGIN
  SELECT session_generation INTO v_generation
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending session not found for append: %', p_session_key;
  END IF;

  UPDATE public.pending_sessions
  SET
    accumulated_text         = accumulated_text || E'\n' || p_new_text,
    latest_reply_token       = p_reply_token,
    updated_at               = now(),
    close_event_timestamp_ms = CASE WHEN p_mark_close THEN p_line_timestamp_ms ELSE close_event_timestamp_ms END,
    close_requested_at       = CASE WHEN p_mark_close THEN now()       ELSE close_requested_at END,
    close_line_event_id      = CASE WHEN p_mark_close THEN p_line_event_id ELSE close_line_event_id END
  WHERE session_key = p_session_key
  RETURNING * INTO v_row;

  IF p_line_event_id IS NOT NULL AND p_line_timestamp_ms IS NOT NULL THEN
    INSERT INTO public.pending_session_ingest (
      session_key,
      session_generation,
      line_event_id,
      line_timestamp_ms,
      raw_text
    )
    VALUES (
      p_session_key,
      v_generation,
      p_line_event_id,
      p_line_timestamp_ms,
      p_new_text
    )
    ON CONFLICT (session_generation, line_event_id) DO UPDATE SET
      raw_text          = EXCLUDED.raw_text,
      line_timestamp_ms = EXCLUDED.line_timestamp_ms;
  END IF;

  RETURN NEXT v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.register_pending_session_ingest(
  p_session_key         text,
  p_line_event_id       text,
  p_line_timestamp_ms   bigint,
  p_raw_text            text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_generation uuid;
BEGIN
  SELECT session_generation INTO v_generation
  FROM public.pending_sessions
  WHERE session_key = p_session_key;

  IF NOT FOUND OR p_raw_text IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.pending_session_ingest (
    session_key,
    session_generation,
    line_event_id,
    line_timestamp_ms,
    raw_text
  )
  VALUES (
    p_session_key,
    v_generation,
    p_line_event_id,
    p_line_timestamp_ms,
    p_raw_text
  )
  ON CONFLICT (session_generation, line_event_id) DO UPDATE SET
    raw_text          = EXCLUDED.raw_text,
    line_timestamp_ms = EXCLUDED.line_timestamp_ms;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_pending_close_ready(p_session_key text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_session public.pending_sessions%ROWTYPE;
  v_admission_count int;
  v_ingest_count int;
  v_straggler_count int;
BEGIN
  SELECT * INTO v_session
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND
     OR v_session.close_event_timestamp_ms IS NULL
     OR v_session.close_requested_at IS NULL THEN
    RETURN jsonb_build_object('ready', false, 'reason', 'not_closing');
  END IF;

  SELECT COUNT(*)::int INTO v_admission_count
  FROM public.pending_session_admission a
  WHERE a.session_key = p_session_key
    AND a.session_generation = v_session.session_generation
    AND a.line_timestamp_ms <= v_session.close_event_timestamp_ms;

  SELECT COUNT(*)::int INTO v_ingest_count
  FROM public.pending_session_ingest i
  WHERE i.session_key = p_session_key
    AND i.session_generation = v_session.session_generation
    AND i.line_timestamp_ms <= v_session.close_event_timestamp_ms
    AND i.raw_text IS NOT NULL
    AND btrim(i.raw_text) <> '';

  SELECT COUNT(*)::int INTO v_straggler_count
  FROM public.pending_session_admission a
  WHERE a.session_key = p_session_key
    AND a.session_generation = v_session.session_generation
    AND a.line_timestamp_ms <= v_session.close_event_timestamp_ms
    AND a.admitted_at > v_session.close_requested_at
    AND NOT EXISTS (
      SELECT 1
      FROM public.pending_session_ingest i
      WHERE i.session_generation = a.session_generation
        AND i.line_event_id = a.line_event_id
        AND i.raw_text IS NOT NULL
        AND btrim(i.raw_text) <> ''
    );

  -- Pre-0042 rows: accumulated_text already holds items but no admission ledger yet.
  IF v_admission_count = 0
     AND btrim(v_session.accumulated_text) <> ''
     AND (
       SELECT COUNT(*)::int
       FROM regexp_split_to_table(btrim(v_session.accumulated_text), E'\n') AS t(line)
       WHERE btrim(line) <> ''
     ) >= 3
  THEN
    RETURN jsonb_build_object(
      'ready',           true,
      'reason',          'legacy_accumulated',
      'admission_count', v_admission_count,
      'ingest_count',    v_ingest_count,
      'straggler_count', v_straggler_count,
      'session_generation', v_session.session_generation,
      'close_event_timestamp_ms', v_session.close_event_timestamp_ms
    );
  END IF;

  RETURN jsonb_build_object(
    'ready',           (v_admission_count = v_ingest_count AND v_straggler_count = 0 AND v_admission_count > 0),
    'reason',          CASE
                         WHEN v_admission_count = 0 THEN 'no_admissions'
                         WHEN v_admission_count <> v_ingest_count THEN 'awaiting_ingest'
                         WHEN v_straggler_count > 0 THEN 'stragglers'
                         ELSE 'ready'
                       END,
    'admission_count', v_admission_count,
    'ingest_count',    v_ingest_count,
    'straggler_count', v_straggler_count,
    'session_generation', v_session.session_generation,
    'close_event_timestamp_ms', v_session.close_event_timestamp_ms
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_pending_close_finalize(p_session_key text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_session public.pending_sessions%ROWTYPE;
  v_ready jsonb;
BEGIN
  SELECT * INTO v_session
  FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'gone');
  END IF;

  IF v_session.close_event_timestamp_ms IS NULL
     OR v_session.close_requested_at IS NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_closing');
  END IF;

  IF v_session.close_finalize_started_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_claimed');
  END IF;

  v_ready := public.check_pending_close_ready(p_session_key);

  IF NOT (v_ready->>'ready')::boolean THEN
    RETURN jsonb_build_object(
      'claimed',         false,
      'reason',          v_ready->>'reason',
      'admission_count', v_ready->'admission_count',
      'ingest_count',    v_ready->'ingest_count',
      'straggler_count', v_ready->'straggler_count'
    );
  END IF;

  UPDATE public.pending_sessions
  SET close_finalize_started_at = now()
  WHERE session_key = p_session_key
  RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'claimed', true,
    'session', to_jsonb(v_session),
    'admission_count', v_ready->'admission_count',
    'ingest_count', v_ready->'ingest_count'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admit_pending_session_event(text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admit_pending_session_event(text, text, bigint) TO service_role;

REVOKE ALL ON FUNCTION public.register_pending_session_ingest(text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_pending_session_ingest(text, text, bigint, text) TO service_role;

REVOKE ALL ON FUNCTION public.check_pending_close_ready(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_pending_close_ready(text) TO service_role;

REVOKE ALL ON FUNCTION public.claim_pending_close_finalize(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_pending_close_finalize(text) TO service_role;
