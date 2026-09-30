-- P1: stale LINE webhook queue rows are never auto-replayed.
--
-- PR #165 added a once-per-minute recovery sweep for recent pending ordered
-- webhook rows. The sweep only *selects* sources with a recent pending row, but
-- claim_line_webhook_event claims the head of the whole source. A pending (or
-- lease-expired processing) row older than 60 minutes therefore still replayed
-- whenever anything newer arrived for the same LINE source — a stale business
-- event (Produce close, White Sheet field, slip image) applied hours late.
--
-- Contract after this migration:
--   * A row received more than 60 minutes ago that is pending, or processing
--     with an expired five-minute lease, moves to status 'stale'. That
--     transition happens inside claim_line_webhook_event itself, so no caller —
--     webhook drain, recovery sweep, or a future path — can claim it.
--   * 'stale' is terminal for ordering (like 'failed'), so one stuck event no
--     longer blocks every later event from the same LINE group forever.
--   * reconcile_line_webhook_queue() quarantines globally, then surfaces each
--     stale row exactly once (stale_surfaced_at) and returns bounded queue
--     metrics for internal cron logging.
--   * Manual review: inspect raw_messages by raw_message_id. To close a
--     reviewed row without replay, set status = 'failed' with an
--     error_message (completed_at is already set). Nothing here re-queues it.
--
-- received_at (database time of first durable receipt) is the age clock. A
-- LINE redelivery of the same webhookEventId hits ON CONFLICT DO NOTHING in
-- receive_line_webhook_event and does not reset it.

BEGIN;

ALTER TABLE public.line_webhook_event_queue
  ADD COLUMN IF NOT EXISTS stale_surfaced_at timestamptz;

ALTER TABLE public.line_webhook_event_queue
  DROP CONSTRAINT IF EXISTS line_webhook_event_queue_status_check;
ALTER TABLE public.line_webhook_event_queue
  ADD CONSTRAINT line_webhook_event_queue_status_check
  CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'stale'));

-- Bounded metrics and the global quarantine scan read only open or stale rows.
CREATE INDEX IF NOT EXISTS line_webhook_event_queue_open_received_idx
  ON public.line_webhook_event_queue (received_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS line_webhook_event_queue_stale_idx
  ON public.line_webhook_event_queue (receive_order)
  WHERE status = 'stale';

-- Move stale-aged open rows to 'stale'. p_source_id NULL = every source.
-- Rows are locked in receive_order with SKIP LOCKED so concurrent callers
-- (per-source claims and the global reconcile) never deadlock; a skipped row
-- is being handled by the other caller, and the claim below still refuses it.
CREATE OR REPLACE FUNCTION public.quarantine_stale_line_webhook_events(
  p_source_id text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.line_webhook_event_queue q
     SET status = 'stale',
         claim_token = NULL,
         completed_at = now()
   WHERE q.id IN (
     SELECT s.id
       FROM public.line_webhook_event_queue s
      WHERE (p_source_id IS NULL OR s.source_id = p_source_id)
        AND s.received_at <= now() - interval '60 minutes'
        AND (
          s.status = 'pending'
          OR (
            s.status = 'processing'
            AND s.processing_started_at <= now() - interval '5 minutes'
          )
        )
      ORDER BY s.receive_order
      FOR UPDATE SKIP LOCKED
   );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$fn$;

-- Same semantic-timestamp claim as 20260919134000, plus: quarantine this
-- source's stale rows first (in the same transaction), and never select a row
-- older than 60 minutes even if a concurrent quarantine skipped it.
CREATE OR REPLACE FUNCTION public.claim_line_webhook_event(
  p_source_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.line_webhook_event_queue;
BEGIN
  PERFORM public.quarantine_stale_line_webhook_events(p_source_id);

  SELECT q.* INTO v_row
  FROM public.line_webhook_event_queue q
  JOIN public.raw_messages r ON r.id = q.raw_message_id
  WHERE q.source_id = p_source_id
    AND q.received_at > now() - interval '60 minutes'
    AND (
      q.status = 'pending'
      OR (
        q.status = 'processing'
        AND q.processing_started_at <= now() - interval '5 minutes'
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.line_webhook_event_queue earlier
      JOIN public.raw_messages er ON er.id = earlier.raw_message_id
      WHERE earlier.source_id = q.source_id
        AND earlier.status IN ('pending', 'processing')
        AND (
          COALESCE(
            CASE WHEN (er.payload->>'timestamp') ~ '^[0-9]+$'
              THEN (er.payload->>'timestamp')::bigint END,
            floor(extract(epoch FROM earlier.received_at) * 1000)::bigint
          ),
          earlier.receive_order
        ) < (
          COALESCE(
            CASE WHEN (r.payload->>'timestamp') ~ '^[0-9]+$'
              THEN (r.payload->>'timestamp')::bigint END,
            floor(extract(epoch FROM q.received_at) * 1000)::bigint
          ),
          q.receive_order
        )
    )
  ORDER BY
    COALESCE(
      CASE WHEN (r.payload->>'timestamp') ~ '^[0-9]+$'
        THEN (r.payload->>'timestamp')::bigint END,
      floor(extract(epoch FROM q.received_at) * 1000)::bigint
    ),
    q.receive_order
  LIMIT 1
  FOR UPDATE OF q SKIP LOCKED;

  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE public.line_webhook_event_queue
     SET status = 'processing',
         processing_started_at = now(),
         processing_attempts = processing_attempts + 1,
         claim_token = gen_random_uuid(),
         completed_at = NULL
   WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'queue_id', v_row.id,
    'line_event_id', v_row.line_event_id,
    'source_id', v_row.source_id,
    'raw_message_id', v_row.raw_message_id,
    'receive_order', v_row.receive_order,
    'claim_token', v_row.claim_token
  );
END;
$fn$;

COMMENT ON FUNCTION public.claim_line_webhook_event(text) IS
  'Claims stateful LINE work by payload timestamp, with receive_order as a deterministic tie-breaker. '
  'Rows received more than 60 minutes ago are quarantined as stale first and are never claimed.';

-- Global quarantine + surface-once + bounded metrics. Safe to call from
-- concurrent schedulers: surfacing claims rows with FOR UPDATE SKIP LOCKED and
-- stamps stale_surfaced_at, so each stale row is returned by exactly one call.
CREATE OR REPLACE FUNCTION public.reconcile_line_webhook_queue(
  p_surface_limit integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_quarantined integer;
  v_surfaced jsonb;
  v_limit integer := greatest(1, least(coalesce(p_surface_limit, 20), 100));
BEGIN
  v_quarantined := public.quarantine_stale_line_webhook_events(NULL);

  WITH picked AS (
    SELECT s.id
      FROM public.line_webhook_event_queue s
     WHERE s.status = 'stale'
       AND s.stale_surfaced_at IS NULL
     ORDER BY s.receive_order
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  ), surfaced AS (
    UPDATE public.line_webhook_event_queue q
       SET stale_surfaced_at = now()
      FROM picked
     WHERE q.id = picked.id
    RETURNING q.line_event_id, q.source_id, q.raw_message_id, q.received_at,
              q.processing_attempts, q.receive_order
  )
  SELECT coalesce(
           jsonb_agg(jsonb_build_object(
             'line_event_id', line_event_id,
             'source_id', source_id,
             'raw_message_id', raw_message_id,
             'received_at', received_at,
             'processing_attempts', processing_attempts
           ) ORDER BY receive_order),
           '[]'::jsonb)
    INTO v_surfaced
    FROM surfaced;

  RETURN jsonb_build_object(
    'quarantined', v_quarantined,
    'surfaced', v_surfaced,
    'pending_count', (
      SELECT count(*) FROM public.line_webhook_event_queue WHERE status = 'pending'
    ),
    'processing_count', (
      SELECT count(*) FROM public.line_webhook_event_queue WHERE status = 'processing'
    ),
    'oldest_pending_age_seconds', (
      SELECT floor(extract(epoch FROM now() - min(received_at)))::bigint
        FROM public.line_webhook_event_queue WHERE status = 'pending'
    ),
    'stale_count', (
      SELECT count(*) FROM public.line_webhook_event_queue WHERE status = 'stale'
    ),
    'oldest_stale_age_seconds', (
      SELECT floor(extract(epoch FROM now() - min(received_at)))::bigint
        FROM public.line_webhook_event_queue WHERE status = 'stale'
    )
  );
END;
$fn$;

COMMENT ON FUNCTION public.reconcile_line_webhook_queue(integer) IS
  'Quarantines LINE webhook queue rows older than 60 minutes as stale (never replayed), '
  'surfaces each stale row once for manual review, and returns bounded queue metrics.';

REVOKE ALL ON FUNCTION public.quarantine_stale_line_webhook_events(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_line_webhook_event(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_line_webhook_queue(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quarantine_stale_line_webhook_events(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_line_webhook_event(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_line_webhook_queue(integer) TO service_role;

COMMIT;
