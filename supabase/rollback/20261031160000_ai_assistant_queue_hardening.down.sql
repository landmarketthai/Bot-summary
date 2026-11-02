-- Roll back 20261031160000_ai_assistant_queue_hardening.sql only: restores
-- the enqueue/claim/set_delivery functions of 20261031090000 and drops the
-- one-running-job index and push_started_at. Run before rolling back
-- 20261031150000.

BEGIN;

DROP INDEX IF EXISTS public.ai_assistant_jobs_one_running_per_conversation;

CREATE OR REPLACE FUNCTION public.enqueue_ai_assistant_job(
  p_job jsonb,
  p_max_outstanding_per_conversation integer DEFAULT 3,
  p_max_backlog integer DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_existing uuid;
  v_id uuid;
  v_outstanding integer;
  v_backlog integer;
  v_destination text := coalesce(p_job->>'destination', '');
  v_source_id text := p_job->>'source_id';
  v_user_id text := p_job->>'line_user_id';
BEGIN
  -- Serialize enqueue per conversation so the outstanding bound is exact
  -- under concurrent webhook requests.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ai_assistant_conversation:' || v_destination || ':'
      || coalesce(v_source_id, '') || ':' || coalesce(v_user_id, ''), 0));

  SELECT id INTO v_existing FROM public.ai_assistant_jobs
   WHERE line_event_id = p_job->>'line_event_id';
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'duplicate', 'job_id', v_existing);
  END IF;

  SELECT count(*) INTO v_outstanding FROM public.ai_assistant_jobs
   WHERE destination = v_destination AND source_id = v_source_id AND line_user_id = v_user_id
     AND status IN ('queued', 'running');
  IF v_outstanding >= greatest(coalesce(p_max_outstanding_per_conversation, 3), 1) THEN
    RETURN jsonb_build_object('outcome', 'rate_limited', 'job_id', NULL);
  END IF;

  SELECT count(*) INTO v_backlog FROM public.ai_assistant_jobs
   WHERE status IN ('queued', 'running');
  IF v_backlog >= greatest(coalesce(p_max_backlog, 500), 1) THEN
    RETURN jsonb_build_object('outcome', 'queue_full', 'job_id', NULL);
  END IF;

  INSERT INTO public.ai_assistant_jobs (
    line_event_id, raw_message_id, destination, source_type, source_id, line_user_id,
    question, asked_business_date, event_timestamp_ms, reply_token, reply_token_expires_at,
    max_attempts
  ) VALUES (
    p_job->>'line_event_id',
    p_job->>'raw_message_id',
    v_destination,
    p_job->>'source_type',
    v_source_id,
    v_user_id,
    p_job->>'question',
    (p_job->>'asked_business_date')::date,
    (p_job->>'event_timestamp_ms')::bigint,
    nullif(p_job->>'reply_token', ''),
    (p_job->>'reply_token_expires_at')::timestamptz,
    least(greatest(coalesce((p_job->>'max_attempts')::integer, 3), 1), 10)
  )
  ON CONFLICT (line_event_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_existing FROM public.ai_assistant_jobs
     WHERE line_event_id = p_job->>'line_event_id';
    RETURN jsonb_build_object('outcome', 'duplicate', 'job_id', v_existing);
  END IF;
  RETURN jsonb_build_object('outcome', 'queued', 'job_id', v_id);
END
$fn$;

CREATE OR REPLACE FUNCTION public.claim_ai_assistant_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 120,
  p_max_running integer DEFAULT 4
) RETURNS SETOF public.ai_assistant_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_running integer;
  v_slots integer;
BEGIN
  -- One claimer at a time keeps the live-lease cap exact across concurrent
  -- worker invocations (webhook kick + cron sweep). Claiming is short.
  PERFORM pg_advisory_xact_lock(hashtextextended('ai_assistant_jobs:claim', 0));

  -- A job whose lease kept expiring (worker crashing mid-job) is retired
  -- instead of being retried forever. Workers deliver a notice on the final
  -- attempt; this only catches crashes during that notice.
  UPDATE public.ai_assistant_jobs
     SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
         reply_token = NULL, last_error_code = 'attempts_exhausted',
         completed_at = now(), updated_at = now()
   WHERE status = 'running' AND lease_expires_at <= now()
     AND attempts >= max_attempts + 2;

  SELECT count(*) INTO v_running FROM public.ai_assistant_jobs
   WHERE status = 'running' AND lease_expires_at > now();
  v_slots := least(
    greatest(coalesce(p_limit, 1), 0),
    greatest(coalesce(p_max_running, 4) - v_running, 0),
    20);
  IF v_slots <= 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT j.id
      FROM public.ai_assistant_jobs j
     WHERE ((j.status = 'queued' AND j.available_at <= now())
         OR (j.status = 'running' AND j.lease_expires_at <= now()))
       AND NOT EXISTS (
         SELECT 1 FROM public.ai_assistant_jobs e
          WHERE e.destination = j.destination
            AND e.source_id = j.source_id
            AND e.line_user_id = j.line_user_id
            AND e.status IN ('queued', 'running')
            AND e.id <> j.id
            AND (e.event_timestamp_ms, e.created_at, e.id)
              < (j.event_timestamp_ms, j.created_at, j.id))
     ORDER BY j.available_at, j.created_at, j.id
     LIMIT v_slots
     FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE public.ai_assistant_jobs j
     SET status = 'running',
         attempts = j.attempts + 1,
         lease_token = gen_random_uuid(),
         lease_expires_at = now() + make_interval(
           secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900)),
         worker_id = left(p_worker_id, 120),
         started_at = coalesce(j.started_at, now()),
         updated_at = now()
    FROM candidates c
   WHERE j.id = c.id
  RETURNING j.*;
END
$fn$;

CREATE OR REPLACE FUNCTION public.set_ai_assistant_delivery(
  p_job_id uuid,
  p_lease_token uuid,
  p_from text[],
  p_to text,
  p_channel text DEFAULT NULL
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  WITH updated AS (
    UPDATE public.ai_assistant_jobs
       SET delivery_state = p_to,
           delivery_channel = coalesce(p_channel, delivery_channel),
           -- A spent reply token is never offered to anyone again.
           reply_token = CASE WHEN p_to IN ('reply_started', 'push_started') THEN NULL ELSE reply_token END,
           updated_at = now()
     WHERE id = p_job_id AND lease_token = p_lease_token AND status = 'running'
       AND delivery_state = ANY (p_from)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$fn$;

ALTER TABLE public.ai_assistant_jobs DROP COLUMN IF EXISTS push_started_at;

COMMIT;
