-- 2026-09-15 ordered webhook retry hardening.
-- Retryable processing failures return to pending. Reply delivery is best-effort
-- only after business processing is durably completed.
ALTER TABLE public.line_webhook_event_queue
  DROP CONSTRAINT IF EXISTS line_webhook_event_queue_status_check;
ALTER TABLE public.line_webhook_event_queue
  ADD CONSTRAINT line_webhook_event_queue_status_check
  CHECK (status IN ('pending', 'processing', 'processed', 'failed'));

ALTER TABLE public.line_webhook_event_queue
  DROP CONSTRAINT IF EXISTS line_webhook_event_queue_processing_lease;
ALTER TABLE public.line_webhook_event_queue
  ADD CONSTRAINT line_webhook_event_queue_processing_lease CHECK (
    (status = 'processing'
      AND processing_started_at IS NOT NULL
      AND processing_attempts > 0
      AND claim_token IS NOT NULL)
    OR (status <> 'processing' AND claim_token IS NULL)
  );

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
   WHERE q.source_id = p_source_id
     AND (
       q.status = 'pending'
       OR (
         q.status = 'processing'
         AND q.processing_started_at <= now() - interval '5 minutes'
       )
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.line_webhook_event_queue earlier
        WHERE earlier.source_id = q.source_id
          AND earlier.receive_order < q.receive_order
          AND earlier.status IN ('pending', 'processing')
     )
   ORDER BY q.receive_order
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

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

CREATE OR REPLACE FUNCTION public.complete_line_webhook_event(
  p_raw_message_id uuid,
  p_claim_token    uuid,
  p_status         text,
  p_error_message  text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF p_status NOT IN ('pending', 'processed', 'failed') THEN
    RAISE EXCEPTION 'line queue: invalid completion status %', p_status;
  END IF;


  UPDATE public.line_webhook_event_queue
     SET status = p_status,
         error_message = CASE
           WHEN p_status = 'processed' THEN NULL
           ELSE COALESCE(NULLIF(btrim(p_error_message), ''), 'event processing failed')
         END,
         processing_started_at = CASE WHEN p_status = 'pending' THEN NULL ELSE processing_started_at END,
         claim_token = NULL,
         completed_at = CASE WHEN p_status = 'pending' THEN NULL ELSE now() END
   WHERE raw_message_id = p_raw_message_id
     AND status = 'processing'
     AND claim_token = p_claim_token;

  RETURN FOUND;
END;
$fn$;

REVOKE ALL ON FUNCTION public.claim_line_webhook_event(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_line_webhook_event(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_line_webhook_event(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_line_webhook_event(uuid, uuid, text, text)
  TO service_role;
