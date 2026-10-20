-- Durable, service-role-only operator alert state for the LINE slip ingest
-- ledger. The application route is separately fail-closed behind
-- SLIP_LEDGER_ALERT_ENABLED=true and an explicit LINE recipient.
--
-- One row is kept per SHA-256 recipient fingerprint. PostgreSQL serializes
-- claims on that row, so overlapping stateless cron invocations cannot both
-- send. A notification keeps the same LINE retry key and frozen health
-- snapshot through ambiguous failures and expired leases. A later reminder or
-- recovery is a new notification and therefore gets a new retry key.

BEGIN;

CREATE TABLE IF NOT EXISTS public.slip_ingest_alert_states (
  recipient_key             text PRIMARY KEY
                            CHECK (recipient_key ~ '^[0-9a-f]{64}$'),
  is_unhealthy              boolean NOT NULL DEFAULT false,
  incident_sequence         bigint NOT NULL DEFAULT 0 CHECK (incident_sequence >= 0),
  incident_started_at       timestamptz,
  incident_alert_delivered  boolean NOT NULL DEFAULT false,
  last_incident_sent_at     timestamptz,
  pending_kind              text CHECK (pending_kind IN ('incident', 'recovery')),
  pending_status            text CHECK (pending_status IN ('pending', 'sending', 'expired')),
  pending_retry_key         uuid,
  pending_health            jsonb,
  pending_created_at        timestamptz,
  pending_attempt_count     integer NOT NULL DEFAULT 0 CHECK (pending_attempt_count >= 0),
  next_attempt_at           timestamptz,
  lease_token               uuid,
  lease_until               timestamptz,
  last_error_code           text,
  last_health               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slip_ingest_alert_pending_shape CHECK (
    (pending_kind IS NULL
      AND pending_status IS NULL
      AND pending_retry_key IS NULL
      AND pending_health IS NULL
      AND pending_created_at IS NULL
      AND next_attempt_at IS NULL
      AND lease_token IS NULL
      AND lease_until IS NULL)
    OR
    (pending_kind IS NOT NULL
      AND pending_status IS NOT NULL
      AND pending_retry_key IS NOT NULL
      AND pending_health IS NOT NULL
      AND pending_created_at IS NOT NULL
      AND next_attempt_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.slip_ingest_alert_states IS
  'Durable deduplication, lease and stable LINE retry key for slip ingest health alerts; mutations are RPC-only.';

ALTER TABLE public.slip_ingest_alert_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.slip_ingest_alert_states FROM PUBLIC, anon, authenticated, service_role;

-- Operator-facing health. The 36-minute minimum is deliberate: it is longer
-- than the normal 25-image OCR recovery bound (28.5 minutes) and does not page
-- during the supported retry window. Terminal loss states page immediately.
CREATE OR REPLACE FUNCTION public.slip_ingest_alert_health(
  p_stale_seconds integer DEFAULT 2160,
  p_ocr_overdue_seconds integer DEFAULT 2160
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  WITH limits AS (
    SELECT least(greatest(coalesce(p_stale_seconds, 2160), 2160), 604800) AS stale_seconds,
           least(greatest(coalesce(p_ocr_overdue_seconds, 2160), 2160), 604800) AS ocr_seconds
  ), ledger AS (
    SELECT
      count(*) FILTER (WHERE ev.state = 'unbound') AS unbound_total,
      count(*) FILTER (
        WHERE ev.state = 'unbound'
          AND ev.received_at <= now() - make_interval(secs => limits.stale_seconds)
      ) AS unbound_stale,
      count(*) FILTER (
        WHERE ev.state = 'received'
          AND ev.received_at <= now() - make_interval(secs => limits.stale_seconds)
          AND coalesce(q.status, '') NOT IN ('failed', 'stale')
      ) AS received_stale,
      count(*) FILTER (
        WHERE ev.state = 'ingesting'
          AND ev.received_at <= now() - make_interval(secs => limits.stale_seconds)
      ) AS ingesting_stale,
      count(*) FILTER (WHERE ev.state = 'retry_pending') AS retry_pending_total,
      count(*) FILTER (
        WHERE ev.state = 'retry_pending'
          AND ev.received_at <= now() - make_interval(secs => limits.stale_seconds)
      ) AS retry_stale,
      count(*) FILTER (
        WHERE ev.state = 'received' AND q.status IN ('failed', 'stale')
      ) AS queue_dead,
      count(*) FILTER (
        WHERE ev.state = 'failed_permanent'
          AND ev.resolved_at > now() - interval '24 hours'
      ) AS failed_permanent_24h,
      count(*) FILTER (
        WHERE ev.state = 'late_after_finalize'
          AND ev.resolved_at > now() - interval '24 hours'
      ) AS late_after_finalize_24h,
      floor(extract(epoch FROM now() - min(ev.received_at) FILTER (
        WHERE ev.state IN ('unbound', 'received', 'ingesting', 'retry_pending')
      )))::bigint AS oldest_open_age_seconds
    FROM public.slip_image_events ev
    CROSS JOIN limits
    LEFT JOIN public.line_webhook_event_queue q ON q.raw_message_id = ev.raw_message_id
    -- Never age out unresolved receipts or dead queue rows. Otherwise a
    -- seven-day-old orphan disappears from health and causes a false OK.
    -- Resolved terminal losses are kept in the explicit 24-hour window
    -- based on resolved_at, regardless of the original receipt date.
    WHERE ev.state IN ('unbound', 'received', 'ingesting', 'retry_pending')
       OR (ev.state IN ('failed_permanent', 'late_after_finalize')
           AND ev.resolved_at > now() - interval '24 hours')
  ), ocr AS (
    SELECT
      count(*) FILTER (WHERE sc.id IS NULL) AS ocr_missing_overdue,
      count(*) FILTER (WHERE sc.status = 'PROCESSING') AS ocr_processing_overdue
    FROM public.slip_image_events ev
    CROSS JOIN limits
    JOIN public.slip_batches b ON b.id = ev.batch_id
    LEFT JOIN public.slip_checks sc ON sc.evidence_id = ev.evidence_id
    WHERE ev.state = 'attached'
      AND b.status IN ('collecting', 'closing')
      AND ev.resolved_at <= now() - make_interval(secs => limits.ocr_seconds)
      AND (sc.id IS NULL OR sc.status = 'PROCESSING')
  ), health AS (
    SELECT limits.stale_seconds,
           limits.ocr_seconds,
           ledger.*,
           ocr.ocr_missing_overdue,
           ocr.ocr_processing_overdue
      FROM limits CROSS JOIN ledger CROSS JOIN ocr
  )
  SELECT jsonb_build_object(
    'version', 1,
    'stale_threshold_seconds', stale_seconds,
    'ocr_overdue_threshold_seconds', ocr_seconds,
    'unhealthy', (
      unbound_stale + received_stale + ingesting_stale + retry_stale
      + queue_dead + failed_permanent_24h + late_after_finalize_24h
      + ocr_missing_overdue + ocr_processing_overdue
    ) > 0,
    'unbound_total', unbound_total,
    'unbound_stale', unbound_stale,
    'received_stale', received_stale,
    'ingesting_stale', ingesting_stale,
    'retry_pending_total', retry_pending_total,
    'retry_stale', retry_stale,
    'queue_dead', queue_dead,
    'failed_permanent_24h', failed_permanent_24h,
    'late_after_finalize_24h', late_after_finalize_24h,
    'ocr_missing_overdue', ocr_missing_overdue,
    'ocr_processing_overdue', ocr_processing_overdue,
    'oldest_open_age_seconds', oldest_open_age_seconds
  ) FROM health;
$fn$;

-- Atomically evaluate health, update the incident/recovery state machine, and
-- lease at most one notification. A recovery is created only after an incident
-- notification was durably marked delivered. If health turns unhealthy while
-- a recovery is pending, that recovery is cancelled before it can claim.
CREATE OR REPLACE FUNCTION public.claim_slip_ingest_health_alert(
  p_recipient_key text,
  p_stale_seconds integer DEFAULT 2160,
  p_ocr_overdue_seconds integer DEFAULT 2160,
  p_realert_seconds integer DEFAULT 21600,
  p_lease_seconds integer DEFAULT 60
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_state public.slip_ingest_alert_states%ROWTYPE;
  v_health jsonb;
  v_unhealthy boolean;
  v_now timestamptz := now();
  v_lease_seconds integer := greatest(10, least(coalesce(p_lease_seconds, 60), 120));
  v_realert_seconds integer := least(greatest(300, coalesce(p_realert_seconds, 21600)), 604800);
BEGIN
  IF p_recipient_key IS NULL OR p_recipient_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid recipient key' USING ERRCODE = '22023';
  END IF;

  v_health := public.slip_ingest_alert_health(p_stale_seconds, p_ocr_overdue_seconds);
  v_unhealthy := coalesce((v_health->>'unhealthy')::boolean, false);

  INSERT INTO public.slip_ingest_alert_states (recipient_key, last_health)
  VALUES (p_recipient_key, v_health)
  ON CONFLICT (recipient_key) DO NOTHING;

  SELECT * INTO v_state
    FROM public.slip_ingest_alert_states
   WHERE recipient_key = p_recipient_key
   FOR UPDATE;

  UPDATE public.slip_ingest_alert_states
     SET last_health = v_health, updated_at = v_now
   WHERE recipient_key = p_recipient_key;
  v_state.last_health := v_health;

  -- Never send a stale OK. A new unhealthy observation cancels an unsent
  -- recovery and starts a fresh incident with a fresh idempotency key.
  IF v_state.pending_kind = 'recovery' AND v_unhealthy THEN
    UPDATE public.slip_ingest_alert_states
       SET is_unhealthy = true,
           incident_sequence = incident_sequence + 1,
           incident_started_at = v_now,
           incident_alert_delivered = false,
           last_incident_sent_at = NULL,
           pending_kind = 'incident',
           pending_status = 'pending',
           pending_retry_key = gen_random_uuid(),
           pending_health = v_health,
           pending_created_at = v_now,
           pending_attempt_count = 0,
           next_attempt_at = v_now,
           lease_token = NULL,
           lease_until = NULL,
           last_error_code = NULL,
           updated_at = v_now
     WHERE recipient_key = p_recipient_key
     RETURNING * INTO v_state;
  END IF;

  -- No notification in flight: advance the health state machine.
  IF v_state.pending_kind IS NULL THEN
    IF v_unhealthy AND NOT v_state.is_unhealthy THEN
      UPDATE public.slip_ingest_alert_states
         SET is_unhealthy = true,
             incident_sequence = incident_sequence + 1,
             incident_started_at = v_now,
             incident_alert_delivered = false,
             last_incident_sent_at = NULL,
             pending_kind = 'incident',
             pending_status = 'pending',
             pending_retry_key = gen_random_uuid(),
             pending_health = v_health,
             pending_created_at = v_now,
             pending_attempt_count = 0,
             next_attempt_at = v_now,
             last_error_code = NULL,
             updated_at = v_now
       WHERE recipient_key = p_recipient_key
       RETURNING * INTO v_state;
    ELSIF v_unhealthy
          AND v_state.is_unhealthy
          AND v_state.incident_alert_delivered
          AND v_state.last_incident_sent_at <= v_now - make_interval(secs => v_realert_seconds) THEN
      UPDATE public.slip_ingest_alert_states
         SET pending_kind = 'incident',
             pending_status = 'pending',
             pending_retry_key = gen_random_uuid(),
             pending_health = v_health,
             pending_created_at = v_now,
             pending_attempt_count = 0,
             next_attempt_at = v_now,
             last_error_code = NULL,
             updated_at = v_now
       WHERE recipient_key = p_recipient_key
       RETURNING * INTO v_state;
    ELSIF NOT v_unhealthy AND v_state.is_unhealthy THEN
      IF v_state.incident_alert_delivered THEN
        UPDATE public.slip_ingest_alert_states
           SET is_unhealthy = false,
               pending_kind = 'recovery',
               pending_status = 'pending',
               pending_retry_key = gen_random_uuid(),
               pending_health = v_health,
               pending_created_at = v_now,
               pending_attempt_count = 0,
               next_attempt_at = v_now,
               last_error_code = NULL,
               updated_at = v_now
         WHERE recipient_key = p_recipient_key
         RETURNING * INTO v_state;
      ELSE
        -- It recovered before any incident delivery was confirmed. Reset
        -- silently: an OK without a preceding alert would be misleading.
        UPDATE public.slip_ingest_alert_states
           SET is_unhealthy = false,
               incident_started_at = NULL,
               incident_alert_delivered = false,
               last_incident_sent_at = NULL,
               updated_at = v_now
         WHERE recipient_key = p_recipient_key
         RETURNING * INTO v_state;
      END IF;
    END IF;
  END IF;

  IF v_state.pending_kind IS NULL THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'reason', CASE WHEN v_unhealthy THEN 'throttled' ELSE 'healthy' END,
      'health', v_health,
      'incident_sequence', v_state.incident_sequence
    );
  END IF;

  -- LINE retains a retry key for only 24 hours. Once that boundary is near,
  -- fail closed rather than risk duplicating an ambiguously delivered alert.
  -- Manual intervention is required for an expired notification; no fresh
  -- retry key may safely be minted for the same ambiguous delivery.
  IF v_state.pending_status = 'expired'
     OR v_state.pending_created_at <= v_now - interval '23 hours' THEN
    UPDATE public.slip_ingest_alert_states
       SET pending_status = 'expired', lease_token = NULL, lease_until = NULL,
           last_error_code = 'retry_key_expired', updated_at = v_now
     WHERE recipient_key = p_recipient_key;
    RETURN jsonb_build_object(
      'claimed', false, 'reason', 'retry_key_expired',
      'health', v_health, 'incident_sequence', v_state.incident_sequence
    );
  END IF;

  IF v_state.pending_status = 'sending'
     AND v_state.lease_until IS NOT NULL
     AND v_state.lease_until > v_now THEN
    RETURN jsonb_build_object(
      'claimed', false, 'reason', 'leased', 'health', v_health,
      'incident_sequence', v_state.incident_sequence
    );
  END IF;

  IF v_state.next_attempt_at > v_now THEN
    RETURN jsonb_build_object(
      'claimed', false, 'reason', 'retry_wait', 'health', v_health,
      'incident_sequence', v_state.incident_sequence,
      'next_attempt_at', v_state.next_attempt_at
    );
  END IF;

  UPDATE public.slip_ingest_alert_states
     SET pending_status = 'sending',
         pending_attempt_count = pending_attempt_count + 1,
         lease_token = gen_random_uuid(),
         lease_until = v_now + make_interval(secs => v_lease_seconds),
         updated_at = v_now
   WHERE recipient_key = p_recipient_key
   RETURNING * INTO v_state;

  RETURN jsonb_build_object(
    'claimed', true,
    'kind', v_state.pending_kind,
    'retry_key', v_state.pending_retry_key,
    'lease_token', v_state.lease_token,
    'attempt', v_state.pending_attempt_count,
    'incident_sequence', v_state.incident_sequence,
    'incident_started_at', v_state.incident_started_at,
    'health', v_state.pending_health
  );
END;
$fn$;

-- Compare-and-swap completion. Failure releases the lease and preserves both
-- the frozen payload and LINE retry key. Success clears the pending delivery.
CREATE OR REPLACE FUNCTION public.complete_slip_ingest_health_alert(
  p_recipient_key text,
  p_lease_token uuid,
  p_success boolean,
  p_retry_after_seconds integer DEFAULT NULL,
  p_error_code text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_kind text;
  v_now timestamptz := now();
  v_delay integer := greatest(1, least(coalesce(p_retry_after_seconds, 60), 86400));
BEGIN
  SELECT pending_kind INTO v_kind
    FROM public.slip_ingest_alert_states
   WHERE recipient_key = p_recipient_key
     AND pending_status = 'sending'
     AND lease_token = p_lease_token
   FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_success THEN
    UPDATE public.slip_ingest_alert_states
       SET incident_alert_delivered = CASE WHEN v_kind = 'incident' THEN true ELSE false END,
           last_incident_sent_at = CASE WHEN v_kind = 'incident' THEN v_now ELSE last_incident_sent_at END,
           incident_started_at = CASE WHEN v_kind = 'recovery' THEN NULL ELSE incident_started_at END,
           pending_kind = NULL,
           pending_status = NULL,
           pending_retry_key = NULL,
           pending_health = NULL,
           pending_created_at = NULL,
           pending_attempt_count = 0,
           next_attempt_at = NULL,
           lease_token = NULL,
           lease_until = NULL,
           last_error_code = NULL,
           updated_at = v_now
     WHERE recipient_key = p_recipient_key;
  ELSE
    UPDATE public.slip_ingest_alert_states
       SET pending_status = 'pending',
           next_attempt_at = v_now + make_interval(secs => v_delay),
           lease_token = NULL,
           lease_until = NULL,
           last_error_code = left(coalesce(nullif(p_error_code, ''), 'delivery_error'), 80),
           updated_at = v_now
     WHERE recipient_key = p_recipient_key;
  END IF;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION public.slip_ingest_alert_health(integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_slip_ingest_health_alert(text, integer, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_slip_ingest_health_alert(text, uuid, boolean, integer, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.slip_ingest_alert_health(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_slip_ingest_health_alert(text, integer, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_slip_ingest_health_alert(text, uuid, boolean, integer, text) TO service_role;

COMMIT;
