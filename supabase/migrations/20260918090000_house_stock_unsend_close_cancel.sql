-- House Stock hotfix: LINE unsend of a pending close ("จบ") must cancel the
-- close and return the session to 'open' when it is still recoverable
-- (status = 'closing', quiet/deadline barrier not yet finalized). A session
-- that already reached 'finalized' / 'failed_closed' / 'voided' is NEVER
-- reopened or mutated here — the app layer fails closed and records a
-- correction-required condition through the existing Data Quality inbox.
--
-- Narrow and additive: no existing 0047 table, column, or RPC signature
-- changes. Evidence rows in physical_inventory_session_ingests are never
-- touched — this only resets session-level close bookkeeping so the session
-- behaves as if its close had not yet been requested.

BEGIN;

-- physical_inventory_sessions close-boundary fields are immutable once set.
-- Canceling a still-recoverable close is the one narrow exception. The
-- append-only close_canceled lifecycle marker for the exact current close must
-- already exist in the same transaction before the closing -> open reversal.
CREATE OR REPLACE FUNCTION public.physical_inventory_forbid_terminal_session_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cancel_close boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'physical_inventory_sessions rows must not be deleted';
  END IF;
  IF OLD.status IN ('finalized', 'failed_closed', 'voided') THEN
    RAISE EXCEPTION
      'physical_inventory_sessions status=% is terminal and immutable', OLD.status;
  END IF;

  IF OLD.status = 'closing' AND NEW.status = 'open' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.physical_inventory_lifecycle_events e
      WHERE e.session_id = OLD.id
        AND e.event = 'close_canceled'
        AND e.detail ->> 'canceled_close_line_event_id' = OLD.close_line_event_id
    ) INTO v_cancel_close;
  END IF;

  IF v_cancel_close THEN
    IF NEW.close_requested_at IS NOT NULL
       OR NEW.close_event_timestamp_ms IS NOT NULL
       OR NEW.close_quiet_until IS NOT NULL
       OR NEW.close_deadline_at IS NOT NULL
       OR NEW.close_line_event_id IS NOT NULL
       OR NEW.close_raw_message_id IS NOT NULL THEN
      RAISE EXCEPTION
        'physical inventory close cancel must clear the full close boundary';
    END IF;
  ELSE
    IF OLD.close_event_timestamp_ms IS NOT NULL
       AND NEW.close_event_timestamp_ms IS DISTINCT FROM OLD.close_event_timestamp_ms THEN
      RAISE EXCEPTION 'close_event_timestamp_ms is immutable once set';
    END IF;
    IF OLD.close_quiet_until IS NOT NULL
       AND NEW.close_quiet_until IS DISTINCT FROM OLD.close_quiet_until THEN
      RAISE EXCEPTION 'close_quiet_until is immutable once set';
    END IF;
    IF OLD.close_deadline_at IS NOT NULL
       AND NEW.close_deadline_at IS DISTINCT FROM OLD.close_deadline_at THEN
      RAISE EXCEPTION 'close_deadline_at is immutable once set';
    END IF;
  END IF;

  IF OLD.opened_line_event_id IS DISTINCT FROM NEW.opened_line_event_id THEN
    RAISE EXCEPTION 'opened_line_event_id is immutable';
  END IF;
  IF NEW.snapshot_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.physical_inventory_snapshots s
      WHERE s.id = NEW.snapshot_id AND s.session_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'snapshot_id must reference a snapshot owned by this session';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Allow one additional narrow, append-only lifecycle marker for an audited
-- close cancellation. Void/supersede stay blocked exactly as 0047 documents.
ALTER TABLE public.physical_inventory_lifecycle_events
  DROP CONSTRAINT IF EXISTS physical_inventory_lifecycle_events_event_check;
ALTER TABLE public.physical_inventory_lifecycle_events
  ADD CONSTRAINT physical_inventory_lifecycle_events_event_check
    CHECK (event IN ('finalized', 'failed_closed', 'voided', 'superseded', 'close_canceled'));

ALTER TABLE public.physical_inventory_lifecycle_events
  DROP CONSTRAINT IF EXISTS physical_inventory_lifecycle_no_void_supersede_yet;
ALTER TABLE public.physical_inventory_lifecycle_events
  ADD CONSTRAINT physical_inventory_lifecycle_no_void_supersede_yet
    CHECK (event IN ('finalized', 'failed_closed', 'close_canceled'));

CREATE OR REPLACE FUNCTION public.cancel_physical_inventory_close(
  p_session_id          uuid,
  p_expected_generation uuid,
  p_close_line_event_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.physical_inventory_sessions%ROWTYPE;
  v_now     timestamptz := clock_timestamp();
  v_event   text;
BEGIN
  IF p_session_id IS NULL OR p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'session_id and expected_generation required';
  END IF;
  v_event := btrim(coalesce(p_close_line_event_id, ''));
  IF length(v_event) = 0 THEN
    RAISE EXCEPTION 'close_line_event_id required';
  END IF;

  SELECT * INTO v_session
  FROM public.physical_inventory_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'physical inventory session not found';
  END IF;

  IF v_session.session_generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'generation_conflict';
  END IF;

  -- Fail closed: a terminal session (finalized/failed_closed/voided) is never
  -- reopened or mutated here. Caller records a correction-required condition
  -- through the Data Quality inbox instead.
  IF v_session.status IN ('finalized', 'failed_closed', 'voided') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'canceled', false,
      'reason', 'already_terminal',
      'session_id', v_session.id,
      'status', v_session.status
    );
  END IF;

  IF v_session.status IS DISTINCT FROM 'closing' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'canceled', false,
      'reason', 'not_closing',
      'session_id', v_session.id,
      'status', v_session.status
    );
  END IF;

  -- Only cancel the exact close this unsend refers to. A different close
  -- already occupying the boundary (should be unreachable given the unique
  -- active-session index, but checked explicitly) is left untouched.
  IF v_session.close_line_event_id IS DISTINCT FROM v_event THEN
    RETURN jsonb_build_object(
      'ok', true,
      'canceled', false,
      'reason', 'close_event_mismatch',
      'session_id', v_session.id,
      'status', v_session.status
    );
  END IF;

  -- Append the audit marker first. The session immutability trigger only
  -- permits the closing -> open boundary clear when this exact marker exists.
  -- If the following UPDATE fails, the surrounding transaction rolls it back.
  INSERT INTO public.physical_inventory_lifecycle_events (
    session_id, event, actor, detail
  ) VALUES (
    v_session.id,
    'close_canceled',
    'system',
    jsonb_build_object(
      'canceled_close_line_event_id', v_event,
      'ingest_revision', v_session.ingest_revision
    )
  );

  UPDATE public.physical_inventory_sessions
  SET status                   = 'open',
      close_requested_at       = NULL,
      close_event_timestamp_ms = NULL,
      close_quiet_until        = NULL,
      close_deadline_at        = NULL,
      close_line_event_id      = NULL,
      close_raw_message_id     = NULL,
      updated_at               = v_now
  WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'ok', true,
    'canceled', true,
    'reason', 'unsend_before_finalize',
    'session_id', v_session.id,
    'status', v_session.status,
    'session_generation', v_session.session_generation
  );
END;
$$;

-- A canceled close's own ingest row is never deleted (evidence stays), so a
-- session that is later re-closed accumulates more than one kind='close'
-- ingest row. The eligibility clause below used to admit every kind='close'
-- row unconditionally, which — once a real second close exists — puts BOTH
-- the canceled "จบ" and the real one into the finalize candidate/hash. The
-- app parser stops at the FIRST close line it sees (parsePhysicalInventory-
-- Document), so the stale row would silently swallow every item admitted
-- after the cancellation, reproducing the exact bug this migration exists to
-- fix. Ground eligibility in the session's CURRENT close_line_event_id
-- instead of the bare 'close' kind so a canceled close can never re-enter a
-- later finalize.
CREATE OR REPLACE FUNCTION public.physical_inventory_compute_ingest_set_hash(
  p_session_id uuid
) RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT encode(
    extensions.digest(
      coalesce(
        (
          SELECT string_agg(
            i.line_event_id
              || E'\x1f' || i.line_timestamp_ms::text
              || E'\x1f' || i.kind
              || E'\x1f' || i.raw_text,
            E'\n'
            ORDER BY i.ingest_revision ASC, i.line_event_id ASC
          )
          FROM public.physical_inventory_session_ingests i
          JOIN public.physical_inventory_sessions s ON s.id = i.session_id
          WHERE i.session_id = p_session_id
            AND (
              (i.kind = 'close' AND i.line_event_id = s.close_line_event_id)
              OR (
                i.kind IS DISTINCT FROM 'close'
                AND (
                  s.close_event_timestamp_ms IS NULL
                  OR i.line_timestamp_ms <= s.close_event_timestamp_ms
                )
              )
            )
        ),
        ''
      ),
      'sha256'
    ),
    'hex'
  );
$$;

CREATE OR REPLACE FUNCTION public.get_physical_inventory_finalize_candidate(
  p_session_id          uuid,
  p_expected_generation uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_session_id IS NULL OR p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'session_id and expected_generation required';
  END IF;

  SELECT jsonb_build_object(
    'session_id', s.id,
    'session_generation', s.session_generation,
    'status', s.status,
    'ingest_revision', s.ingest_revision,
    'ingest_set_hash', public.physical_inventory_compute_ingest_set_hash(s.id),
    'close_event_timestamp_ms', s.close_event_timestamp_ms,
    'close_quiet_until', s.close_quiet_until,
    'close_deadline_at', s.close_deadline_at,
    'ingests', coalesce(
      (
        SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.ingest_revision)
        FROM (
          SELECT
            i.line_event_id,
            i.line_timestamp_ms,
            i.kind,
            i.raw_text,
            i.ingest_revision,
            i.line_message_id,
            i.raw_message_id
          FROM public.physical_inventory_session_ingests i
          WHERE i.session_id = s.id
            AND (
              (i.kind = 'close' AND i.line_event_id = s.close_line_event_id)
              OR (
                i.kind IS DISTINCT FROM 'close'
                AND (
                  s.close_event_timestamp_ms IS NULL
                  OR i.line_timestamp_ms <= s.close_event_timestamp_ms
                )
              )
            )
          ORDER BY i.ingest_revision ASC
        ) x
      ),
      '[]'::jsonb
    )
  )
  INTO v_result
  FROM public.physical_inventory_sessions s
  WHERE s.id = p_session_id
    AND s.session_generation = p_expected_generation;

  IF v_result IS NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.physical_inventory_sessions WHERE id = p_session_id
    ) THEN
      RAISE EXCEPTION 'physical inventory session not found';
    END IF;
    RAISE EXCEPTION 'generation_conflict';
  END IF;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.cancel_physical_inventory_close(uuid, uuid, text) IS
  'SECURITY DEFINER. Cancel a still-recoverable House Stock close (status=closing) '
  'when its close LINE message is unsent, returning the session to open. Never '
  'reopens or mutates a finalized/failed_closed/voided session. Ingest evidence '
  'rows are never modified or deleted.';

REVOKE ALL ON FUNCTION public.cancel_physical_inventory_close(uuid, uuid, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_physical_inventory_close(uuid, uuid, text)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_physical_inventory_close(uuid, uuid, text)
  TO service_role;

COMMIT;
