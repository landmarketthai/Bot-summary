-- Add recent terminal OCR provider failures to the existing durable health
-- snapshot. This replaces only the function body; its signature and grants
-- remain compatible with the already-deployed alert state machine.
BEGIN;

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
  ), provider AS (
    SELECT count(*) AS provider_failed_24h
      FROM public.slip_checks sc
     WHERE sc.status = 'FAILED'
       AND sc.updated_at > now() - interval '24 hours'
       AND (
         sc.failure_reason IN (
           'extractor_disabled',
           'extractor_not_configured',
           'extractor_http_bad_request',
           'extractor_http_auth_error',
           'extractor_http_not_found',
           'extractor_http_rate_limit',
           'extractor_http_upstream_error',
           'extractor_http_timeout'
         )
         OR sc.failure_reason LIKE 'ocr_retry:%'
       )
  ), health AS (
    SELECT limits.stale_seconds,
           limits.ocr_seconds,
           ledger.*,
           ocr.ocr_missing_overdue,
           ocr.ocr_processing_overdue,
           provider.provider_failed_24h
      FROM limits CROSS JOIN ledger CROSS JOIN ocr CROSS JOIN provider
  )
  SELECT jsonb_build_object(
    'version', 1,
    'stale_threshold_seconds', stale_seconds,
    'ocr_overdue_threshold_seconds', ocr_seconds,
    'unhealthy', (
      unbound_stale + received_stale + ingesting_stale + retry_stale
      + queue_dead + failed_permanent_24h + late_after_finalize_24h
      + ocr_missing_overdue + ocr_processing_overdue + provider_failed_24h
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
    'provider_failed_24h', provider_failed_24h,
    'oldest_open_age_seconds', oldest_open_age_seconds
  ) FROM health;
$fn$;

REVOKE ALL ON FUNCTION public.slip_ingest_alert_health(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.slip_ingest_alert_health(integer, integer)
  TO service_role;

COMMIT;
