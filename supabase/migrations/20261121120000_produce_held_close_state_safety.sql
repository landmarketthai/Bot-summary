BEGIN;

-- A queued LINE event can be processed after a delivery it predates. Compare
-- the event's own timestamp with delivery proof while holding the review lock.
CREATE OR REPLACE FUNCTION public.confirm_produce_validation_review(
  p_session_key text,
  p_session_generation uuid,
  p_validation_digest text,
  p_line_user_id text,
  p_line_event_id text,
  p_line_timestamp_ms bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_row public.produce_entry_validation_reviews%ROWTYPE;
  v_terminalized boolean;
BEGIN
  SELECT terminalized INTO v_terminalized FROM public.pending_sessions
  WHERE session_key = p_session_key AND session_generation = p_session_generation
  FOR UPDATE;

  IF v_terminalized THEN
    RETURN jsonb_build_object('status', 'terminalized');
  END IF;

  SELECT * INTO v_row FROM public.produce_entry_validation_reviews
  WHERE session_key = p_session_key AND session_generation = p_session_generation
    AND validation_digest = p_validation_digest
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_row.confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_confirmed', 'id', v_row.id,
      'confirmed_by_line_user_id', v_row.confirmed_by_line_user_id);
  END IF;

  IF v_row.presented_delivered_at IS NULL THEN
    RETURN jsonb_build_object('status', 'not_presented');
  END IF;

  IF nullif(btrim(p_line_event_id), '') IS NULL OR v_row.presented_line_event_id = p_line_event_id THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF p_line_timestamp_ms IS NULL
     OR p_line_timestamp_ms <= extract(epoch FROM v_row.presented_delivered_at) * 1000 THEN
    RETURN jsonb_build_object('status', 'not_presented');
  END IF;

  UPDATE public.produce_entry_validation_reviews
  SET confirmed_at = clock_timestamp(), confirmed_by_line_user_id = p_line_user_id,
      confirmed_line_event_id = p_line_event_id
  WHERE id = v_row.id;

  RETURN jsonb_build_object('status', 'confirmed', 'id', v_row.id);
END;
$fn$;

REVOKE ALL ON FUNCTION public.confirm_produce_validation_review(text, uuid, text, text, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_produce_validation_review(text, uuid, text, text, text, bigint)
  TO service_role;

-- Approval and re-arming the finalizer share the pending-row lock and transaction.
CREATE OR REPLACE FUNCTION public.confirm_pending_validation_close(
  p_session_key text,
  p_session_generation uuid,
  p_ingest_revision integer,
  p_line_user_id text,
  p_line_event_id text,
  p_line_timestamp_ms bigint,
  p_runtime_environment text,
  p_confirmation_digest text,
  p_required_digests text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_pending public.pending_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_pending FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND OR v_pending.terminalized OR v_pending.entry_origin IS NOT NULL
     OR v_pending.session_generation IS DISTINCT FROM p_session_generation
     OR v_pending.close_session_generation IS DISTINCT FROM p_session_generation
     OR p_ingest_revision IS NULL OR v_pending.ingest_revision IS DISTINCT FROM p_ingest_revision
     OR p_line_user_id IS NULL OR v_pending.line_user_id IS DISTINCT FROM p_line_user_id
     OR p_runtime_environment IS NULL
     OR coalesce(v_pending.runtime_environment, 'production') IS DISTINCT FROM p_runtime_environment
     OR v_pending.close_event_timestamp_ms IS NULL OR p_line_timestamp_ms IS NULL
     OR p_line_timestamp_ms <= v_pending.close_event_timestamp_ms
     OR nullif(btrim(p_line_event_id), '') IS NULL
     OR v_pending.close_line_event_id IS NOT DISTINCT FROM p_line_event_id THEN
    RETURN jsonb_build_object('status', 'stale');
  END IF;

  IF v_pending.next_attempt_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', CASE WHEN p_required_digests IS NULL
      THEN 'not_found' ELSE 'proceed' END);
  END IF;

  -- NULL is an individual subunit acknowledgement. A close supplies the
  -- complete list of required approvals (empty when the gate found no review).
  IF p_required_digests IS NULL THEN
    RETURN public.confirm_produce_validation_review(
      p_session_key, p_session_generation, p_confirmation_digest, p_line_user_id,
      p_line_event_id, p_line_timestamp_ms
    );
  END IF;

  IF p_confirmation_digest = ANY (p_required_digests) THEN
    PERFORM public.confirm_produce_validation_review(
      p_session_key, p_session_generation, p_confirmation_digest, p_line_user_id,
      p_line_event_id, p_line_timestamp_ms
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(p_required_digests) AS required(digest)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.produce_entry_validation_reviews r
      WHERE r.session_key = p_session_key AND r.session_generation = p_session_generation
        AND r.validation_digest = required.digest AND r.confirmed_at IS NOT NULL
        -- Pre-delivery-proof approvals are historical. Where delivery is known,
        -- a queued earlier close may not release the hold using a later approval.
        AND (r.presented_delivered_at IS NULL
          OR p_line_timestamp_ms > extract(epoch FROM r.presented_delivered_at) * 1000)
    )
  ) THEN
    RETURN jsonb_build_object('status', 'review_required');
  END IF;

  UPDATE public.pending_sessions SET next_attempt_at = clock_timestamp()
  WHERE id = v_pending.id AND next_attempt_at IS NULL;

  RETURN jsonb_build_object('status', 'proceed');
END;
$fn$;

DROP FUNCTION IF EXISTS public.confirm_produce_validation_review(text, uuid, text, text, text);

-- Final persistence must also check the schedule under lock. A stale worker
-- may have decided to persist before a peer parked the same ingest revision.
CREATE OR REPLACE FUNCTION public.try_finalize_pending_generation(
  p_session_key text,
  p_expected_generation uuid,
  p_expected_line_user_id text,
  p_snapshot_revision integer,
  p_session_hash text,
  p_raw_text text,
  p_session jsonb,
  p_items jsonb,
  p_compatibility_hashes text[],
  p_expected_next_attempt_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_pending public.pending_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_pending FROM public.pending_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND OR v_pending.session_generation IS DISTINCT FROM p_expected_generation THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'generation_conflict');
  END IF;

  IF NOT v_pending.terminalized AND v_pending.close_event_timestamp_ms IS NOT NULL
     AND v_pending.line_user_id IS NOT DISTINCT FROM p_expected_line_user_id
     AND (v_pending.next_attempt_at IS NULL
       OR v_pending.next_attempt_at IS DISTINCT FROM p_expected_next_attempt_at) THEN
    RETURN jsonb_build_object('status', 'stale_snapshot', 'reason', 'stale_schedule');
  END IF;

  RETURN public.try_finalize_pending_generation(
    p_session_key, p_expected_generation, p_expected_line_user_id, p_snapshot_revision,
    p_session_hash, p_raw_text, p_session, p_items, p_compatibility_hashes
  );
END;
$fn$;

-- A worker that read the old schedule cannot park a generation after another
-- attempt already parked it or after the operator re-armed it.
CREATE OR REPLACE FUNCTION public.hold_pending_validation_review(
  p_session_key text,
  p_expected_session_generation uuid,
  p_expected_ingest_revision integer,
  p_expected_next_attempt_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  PERFORM 1 FROM public.pending_sessions
  WHERE session_key = p_session_key AND session_generation = p_expected_session_generation
    AND next_attempt_at = p_expected_next_attempt_at
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'stale_schedule');
  END IF;

  RETURN public.hold_pending_validation_review(
    p_session_key, p_expected_session_generation, p_expected_ingest_revision
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.confirm_pending_validation_close(
  text, uuid, integer, text, text, bigint, text, text, text[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_pending_validation_close(
  text, uuid, integer, text, text, bigint, text, text, text[]
) TO service_role;

REVOKE ALL ON FUNCTION public.hold_pending_validation_review(text, uuid, integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_pending_validation_review(text, uuid, integer, timestamptz)
  TO service_role;

REVOKE ALL ON FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb, text[], timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb, text[], timestamptz
) TO service_role;

COMMIT;
