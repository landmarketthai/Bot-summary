-- P0: order stateful LINE work by LINE event time, not network arrival time.
--
-- Production 2026-09-19: forwarded Produce items 16-23 were sent before
-- `จบรายการเบิก` according to LINE payload timestamps, but arrived at our
-- webhook after the close and received larger receive_order values. The queue
-- therefore processed the close first and fabricated a missing-item block.
--
-- receive_order remains the deterministic tie-breaker and audit sequence.
-- LINE payload timestamp is the semantic order used by Produce boundaries.

BEGIN;

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
  SELECT q.* INTO v_row
  FROM public.line_webhook_event_queue q
  JOIN public.raw_messages r ON r.id = q.raw_message_id
  WHERE q.source_id = p_source_id
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
  'This lets timestamp-earlier forwarded items repair network-arrival reordering around a close.';

REVOKE ALL ON FUNCTION public.claim_line_webhook_event(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_line_webhook_event(text) TO service_role;

COMMIT;
