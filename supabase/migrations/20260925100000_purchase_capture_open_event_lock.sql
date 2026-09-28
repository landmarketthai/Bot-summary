-- Purchase capture: serialize concurrent opens of one LINE event id.
--
-- EVIDENCE
-- --------
-- pg-tests run #242 (PR #158, job purchase-capture-slice-b) failed
-- "concurrent conflicting duplicate open (different raw_text)": two opens of
-- one line_event_id with different raw_text BOTH succeeded. Reproduced
-- deterministically on PostgreSQL 17 by forcing the interleaving below.
--
-- ROOT CAUSE
-- ----------
-- open_purchase_capture_session (20260805130000) takes no lock before its
-- idempotency lookups (there is no session row to lock yet), and runs them as
-- two separate READ COMMITTED statements:
--   1. header ingest by line_event_id  -> full fingerprint, raw_text included
--   2. session by opened_line_event_id -> source/sender only
-- When the winning open commits between a racing duplicate's lookup 1 and
-- lookup 2, the duplicate misses the header ingest, finds the committed
-- session, and returns duplicate_open_event without ever comparing raw_text.
-- admit_purchase_capture_event is not affected: it re-checks the fingerprint
-- under the session row lock.
--
-- FIX
-- ---
-- The body is reissued unchanged except for one statement: a transaction-
-- scoped advisory lock on the event id, taken before the lookups. A racing
-- duplicate waits for the winner to commit, lookup 1 finds its header ingest,
-- and the full fingerprint decides: identical stays idempotent
-- (duplicate_open_event), anything else is line_event_conflict. Opens of
-- different event ids never share a lock, so already_open is unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.open_purchase_capture_session(
  p_source_type          text,
  p_source_id            text,
  p_sender_line_user_id  text,
  p_opened_line_event_id text,
  p_line_timestamp_ms    bigint,
  p_raw_text             text,
  p_line_message_id      text DEFAULT NULL,
  p_raw_message_id       uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_sender     text;
  v_source_id  text;
  v_event      text;
  v_session    public.purchase_capture_sessions%ROWTYPE;
  v_ingest     public.purchase_capture_session_ingests%ROWTYPE;
  v_now        timestamptz := clock_timestamp();
BEGIN
  IF p_source_type IS NULL OR p_source_type NOT IN ('user', 'group', 'room') THEN
    RAISE EXCEPTION 'invalid source_type';
  END IF;
  IF p_source_id IS NULL OR length(btrim(p_source_id)) = 0 THEN
    RAISE EXCEPTION 'source_id required';
  END IF;
  v_source_id := btrim(p_source_id);
  v_sender := btrim(coalesce(p_sender_line_user_id, ''));
  IF length(v_sender) = 0 THEN
    RAISE EXCEPTION 'sender_line_user_id required';
  END IF;
  v_event := btrim(coalesce(p_opened_line_event_id, ''));
  IF length(v_event) = 0 THEN
    RAISE EXCEPTION 'opened_line_event_id required';
  END IF;
  IF p_line_timestamp_ms IS NULL OR p_line_timestamp_ms <= 0 THEN
    RAISE EXCEPTION 'line_timestamp_ms must be positive';
  END IF;
  IF p_raw_text IS NULL OR length(btrim(p_raw_text)) = 0 THEN
    RAISE EXCEPTION 'raw_text required';
  END IF;

  -- Serialize every open of this LINE event id until commit, so a racing
  -- duplicate's lookups below see the winner's committed header ingest and
  -- compare the full fingerprint instead of accepting on source/sender alone.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('purchase-capture-open:' || v_event, 0)
  );

  -- Global LINE event identity first (idempotent redelivery after terminal).
  -- Idempotent ONLY when the redelivered event's fingerprint matches exactly.
  SELECT * INTO v_ingest
  FROM public.purchase_capture_session_ingests
  WHERE line_event_id = v_event;

  IF FOUND THEN
    SELECT * INTO v_session
    FROM public.purchase_capture_sessions
    WHERE id = v_ingest.session_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'purchase capture session not found';
    END IF;
    IF NOT public.purchase_capture_open_fingerprint_matches(
      v_ingest, v_session.source_type, v_session.source_id, v_session.sender_line_user_id,
      p_source_type, v_source_id, v_sender, p_line_timestamp_ms, p_raw_text,
      p_line_message_id, p_raw_message_id
    ) THEN
      RAISE EXCEPTION 'line_event_conflict';
    END IF;
    RETURN jsonb_build_object(
      'opened', false,
      'idempotent', true,
      'reason', 'duplicate_open_event',
      'session_id', v_session.id,
      'session_generation', v_session.session_generation,
      'status', v_session.status,
      'ingest_revision', v_session.ingest_revision
    );
  END IF;

  SELECT * INTO v_session
  FROM public.purchase_capture_sessions
  WHERE opened_line_event_id = v_event;

  IF FOUND THEN
    IF v_session.source_type IS DISTINCT FROM p_source_type
       OR v_session.source_id IS DISTINCT FROM v_source_id
       OR v_session.sender_line_user_id IS DISTINCT FROM v_sender THEN
      RAISE EXCEPTION 'line_event_conflict';
    END IF;
    RETURN jsonb_build_object(
      'opened', false,
      'idempotent', true,
      'reason', 'duplicate_open_event',
      'session_id', v_session.id,
      'session_generation', v_session.session_generation,
      'status', v_session.status,
      'ingest_revision', v_session.ingest_revision
    );
  END IF;

  BEGIN
    INSERT INTO public.purchase_capture_sessions (
      source_type,
      source_id,
      sender_line_user_id,
      opened_line_event_id,
      status,
      ingest_revision,
      created_at,
      updated_at
    ) VALUES (
      p_source_type,
      v_source_id,
      v_sender,
      v_event,
      'open',
      1,
      v_now,
      v_now
    )
    RETURNING * INTO v_session;
  EXCEPTION
    WHEN unique_violation THEN
      -- Same event redelivered and lost a race, or a different sender/source
      -- session is already active (the partial unique index this open would
      -- have violated). Distinguish the two rather than merging them.
      SELECT * INTO v_ingest
      FROM public.purchase_capture_session_ingests
      WHERE line_event_id = v_event;
      IF FOUND THEN
        SELECT * INTO v_session
        FROM public.purchase_capture_sessions
        WHERE id = v_ingest.session_id;
        IF NOT FOUND THEN
          RAISE;
        END IF;
        IF NOT public.purchase_capture_open_fingerprint_matches(
          v_ingest, v_session.source_type, v_session.source_id, v_session.sender_line_user_id,
          p_source_type, v_source_id, v_sender, p_line_timestamp_ms, p_raw_text,
          p_line_message_id, p_raw_message_id
        ) THEN
          RAISE EXCEPTION 'line_event_conflict';
        END IF;
        RETURN jsonb_build_object(
          'opened', false,
          'idempotent', true,
          'reason', 'duplicate_open_event',
          'session_id', v_session.id,
          'session_generation', v_session.session_generation,
          'status', v_session.status,
          'ingest_revision', v_session.ingest_revision
        );
      END IF;

      SELECT * INTO v_session
      FROM public.purchase_capture_sessions
      WHERE opened_line_event_id = v_event;
      IF FOUND THEN
        IF v_session.source_type IS DISTINCT FROM p_source_type
           OR v_session.source_id IS DISTINCT FROM v_source_id
           OR v_session.sender_line_user_id IS DISTINCT FROM v_sender THEN
          RAISE EXCEPTION 'line_event_conflict';
        END IF;
        RETURN jsonb_build_object(
          'opened', false,
          'idempotent', true,
          'reason', 'duplicate_open_event',
          'session_id', v_session.id,
          'session_generation', v_session.session_generation,
          'status', v_session.status,
          'ingest_revision', v_session.ingest_revision
        );
      END IF;

      SELECT * INTO v_session
      FROM public.purchase_capture_sessions
      WHERE source_id = v_source_id
        AND sender_line_user_id = v_sender
        AND status IN ('open', 'closing', 'awaiting_confirmation', 'confirming')
      LIMIT 1;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      RETURN jsonb_build_object(
        'opened', false,
        'idempotent', true,
        'reason', 'already_open',
        'session_id', v_session.id,
        'session_generation', v_session.session_generation,
        'status', v_session.status,
        'ingest_revision', v_session.ingest_revision
      );
  END;

  INSERT INTO public.purchase_capture_session_ingests (
    session_id, session_generation, line_event_id, line_message_id,
    line_timestamp_ms, raw_message_id, kind, raw_text, ingest_ordinal, created_at
  ) VALUES (
    v_session.id, v_session.session_generation, v_event, p_line_message_id,
    p_line_timestamp_ms, p_raw_message_id, 'header', p_raw_text, 1, v_now
  );

  INSERT INTO public.purchase_capture_lifecycle_events (
    session_id, event, actor, detail
  ) VALUES (
    v_session.id, 'opened', 'system',
    jsonb_build_object('opened_line_event_id', v_event)
  );

  RETURN jsonb_build_object(
    'opened', true,
    'idempotent', false,
    'reason', 'opened',
    'session_id', v_session.id,
    'session_generation', v_session.session_generation,
    'status', v_session.status,
    'ingest_revision', v_session.ingest_revision
  );
END;
$$;

COMMENT ON FUNCTION public.open_purchase_capture_session(
  text, text, text, text, bigint, text, text, uuid
) IS
  'SECURITY DEFINER. Atomically open a purchase-capture session for a header '
  'LINE event. Same opened_line_event_id with an identical fingerprint is '
  'idempotent (duplicate_open_event); a differing fingerprint under the same '
  'event id is refused (line_event_conflict); a second sender/source active '
  'session for a different event is refused distinctly (already_open). '
  'Concurrent opens of one event id are serialized by a transaction-scoped '
  'advisory lock.';

REVOKE ALL ON FUNCTION public.open_purchase_capture_session(
  text, text, text, text, bigint, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_purchase_capture_session(
  text, text, text, text, bigint, text, text, uuid
) TO service_role;

COMMIT;
