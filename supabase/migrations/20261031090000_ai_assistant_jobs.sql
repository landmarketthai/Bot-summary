-- @Botsummary AI Assistant: durable asynchronous answer jobs, bounded
-- per-conversation memory and per-user/per-market access grants.
--
-- Why: the analyst answer (several model calls plus read-only tools, up to
-- 30 s) ran inline in the LINE webhook request and inside the ordered
-- per-source queue drain, delaying every later event of that chat. The
-- webhook now only enqueues a job here (idempotent by LINE webhookEventId) and
-- an independent, bounded worker answers it.
--
-- Guarantees (all enforced in SQL, mutations are RPC-only):
--   * enqueue is idempotent: one job per LINE event, redeliveries are
--     reported as duplicates; per-conversation outstanding jobs and the total
--     backlog are bounded;
--   * claim uses leases: a crashed worker's job is reclaimed once its lease
--     expires; the number of live leases (concurrent answers) is capped by
--     the caller's p_max_running, and claimers are serialized so the cap is
--     exact;
--   * one conversation (destination + chat + LINE user) is answered in LINE
--     order: a later question waits for the earlier one, so a follow-up such
--     as "แล้วของพี่ขวัญล่ะ?" sees the previous turn;
--   * every write after claim is fenced by the lease token, so a worker whose
--     lease was taken over can no longer record, deliver or complete;
--   * the answer is persisted BEFORE delivery, so a crash after the model
--     call never pays for the model again, and the delivery state records
--     whether a single-use reply token may already have been spent;
--   * stored error codes are short machine codes (CHECK), never provider text.
--
-- Nothing here is read by Produce, Slip, White Sheet or settlement code.

BEGIN;

-- ── Jobs ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_assistant_jobs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_event_id           text NOT NULL CHECK (btrim(line_event_id) <> ''),
  raw_message_id          text,
  destination             text NOT NULL,
  source_type             text NOT NULL CHECK (source_type IN ('user', 'group', 'room')),
  source_id               text NOT NULL CHECK (btrim(source_id) <> ''),
  line_user_id            text NOT NULL CHECK (btrim(line_user_id) <> ''),
  question                text NOT NULL CHECK (char_length(btrim(question)) BETWEEN 1 AND 1000),
  -- Bangkok business date (04:00 cutoff) of the LINE event, fixed at enqueue:
  -- "วันนี้" means the day the question was asked, even when a retry runs later.
  asked_business_date     date NOT NULL,
  event_timestamp_ms      bigint NOT NULL CHECK (event_timestamp_ms > 0),
  reply_token             text,
  reply_token_expires_at  timestamptz,
  status                  text NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempts                integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts            integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at            timestamptz NOT NULL DEFAULT now(),
  lease_token             uuid,
  lease_expires_at        timestamptz,
  worker_id               text CHECK (worker_id IS NULL OR char_length(worker_id) <= 120),
  answer_text             text CHECK (answer_text IS NULL OR char_length(answer_text) <= 5000),
  answer_kind             text CHECK (answer_kind IS NULL OR answer_kind IN ('answer', 'notice')),
  delivery_state          text NOT NULL DEFAULT 'pending'
                          CHECK (delivery_state IN (
                            'pending', 'reply_started', 'push_started',
                            'delivered', 'uncertain', 'undeliverable')),
  delivery_channel        text CHECK (delivery_channel IS NULL OR delivery_channel IN ('reply', 'push')),
  -- Stable for the job's whole life: a push retried after an ambiguous
  -- failure or a crash reuses it and LINE de-duplicates (HTTP 409).
  delivery_retry_key      uuid NOT NULL DEFAULT gen_random_uuid(),
  last_error_code         text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_.:-]{1,80}$'),
  usage                   jsonb,
  tool_names              text[] NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  started_at              timestamptz,
  completed_at            timestamptz,
  CONSTRAINT ai_assistant_jobs_line_event_unique UNIQUE (line_event_id),
  CONSTRAINT ai_assistant_jobs_lease_shape CHECK (
    (status = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT ai_assistant_jobs_answer_shape CHECK ((answer_text IS NULL) = (answer_kind IS NULL)),
  CONSTRAINT ai_assistant_jobs_terminal_shape CHECK (
    (status IN ('completed', 'failed')) = (completed_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.ai_assistant_jobs IS
  '@Botsummary AI answer jobs. Webhook enqueues, bounded workers claim with leases; mutations are RPC-only.';

CREATE INDEX IF NOT EXISTS ai_assistant_jobs_claimable_idx
  ON public.ai_assistant_jobs (available_at, created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS ai_assistant_jobs_conversation_open_idx
  ON public.ai_assistant_jobs (destination, source_id, line_user_id, event_timestamp_ms)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS ai_assistant_jobs_completed_idx
  ON public.ai_assistant_jobs (completed_at)
  WHERE completed_at IS NOT NULL;

ALTER TABLE public.ai_assistant_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_assistant_jobs FROM PUBLIC, anon, authenticated, service_role;

-- ── Conversation memory ──────────────────────────────────────────────────────
-- Scoped by destination + chat + LINE user: another user in the same group,
-- or the same user in another chat, never shares turns. Bounded per
-- conversation and expiring; read only through load_ai_assistant_turns, which
-- requires all three keys.

CREATE TABLE IF NOT EXISTS public.ai_assistant_conversation_turns (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id         uuid NOT NULL UNIQUE REFERENCES public.ai_assistant_jobs (id) ON DELETE CASCADE,
  destination    text NOT NULL,
  source_id      text NOT NULL CHECK (btrim(source_id) <> ''),
  line_user_id   text NOT NULL CHECK (btrim(line_user_id) <> ''),
  question       text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 1000),
  answer         text NOT NULL CHECK (char_length(answer) BETWEEN 1 AND 5000),
  business_date  date NOT NULL,
  context        jsonb NOT NULL DEFAULT '{}'::jsonb
                 CHECK (jsonb_typeof(context) = 'object' AND pg_column_size(context) <= 4096),
  event_timestamp_ms bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);

COMMENT ON TABLE public.ai_assistant_conversation_turns IS
  'Bounded, expiring @Botsummary context per destination + chat + LINE user. RPC-only.';

CREATE INDEX IF NOT EXISTS ai_assistant_turns_conversation_idx
  ON public.ai_assistant_conversation_turns (destination, source_id, line_user_id, event_timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS ai_assistant_turns_expiry_idx
  ON public.ai_assistant_conversation_turns (expires_at);

ALTER TABLE public.ai_assistant_conversation_turns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_assistant_conversation_turns FROM PUBLIC, anon, authenticated, service_role;

-- ── Access grants ────────────────────────────────────────────────────────────
-- Who may ask what. No grant (and not on the env supervisor allowlist) means
-- no data. staff: own documents only (staff_label), within their markets, no
-- settlement. supervisor: every staff member within their markets.

CREATE TABLE IF NOT EXISTS public.ai_assistant_user_grants (
  line_user_id   text PRIMARY KEY CHECK (btrim(line_user_id) <> ''),
  role           text NOT NULL CHECK (role IN ('supervisor', 'staff')),
  staff_label    text CHECK (staff_label IS NULL OR btrim(staff_label) <> ''),
  all_markets    boolean NOT NULL DEFAULT false,
  market_labels  text[] NOT NULL DEFAULT '{}',
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_assistant_grants_staff_label CHECK (role <> 'staff' OR staff_label IS NOT NULL),
  CONSTRAINT ai_assistant_grants_market_scope CHECK (all_markets OR cardinality(market_labels) > 0)
);

COMMENT ON TABLE public.ai_assistant_user_grants IS
  '@Botsummary per-user role and market scope. Managed by an administrator; read by RPC only.';

ALTER TABLE public.ai_assistant_user_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_assistant_user_grants FROM PUBLIC, anon, authenticated, service_role;

-- ── RPCs ─────────────────────────────────────────────────────────────────────

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

CREATE OR REPLACE FUNCTION public.record_ai_assistant_answer(
  p_job_id uuid,
  p_lease_token uuid,
  p_answer text,
  p_kind text,
  p_usage jsonb DEFAULT NULL,
  p_tool_names text[] DEFAULT '{}',
  p_turn_context jsonb DEFAULT NULL,
  p_turn_ttl_seconds integer DEFAULT 1800,
  p_max_turns integer DEFAULT 6
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_job public.ai_assistant_jobs;
BEGIN
  UPDATE public.ai_assistant_jobs
     SET answer_text = p_answer,
         answer_kind = p_kind,
         usage = p_usage,
         tool_names = coalesce(p_tool_names, '{}'),
         -- Delivery runs after this; give it a fresh minute of lease.
         lease_expires_at = greatest(lease_expires_at, now() + interval '60 seconds'),
         updated_at = now()
   WHERE id = p_job_id AND lease_token = p_lease_token AND status = 'running'
     AND answer_text IS NULL
  RETURNING * INTO v_job;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_kind = 'answer' AND p_turn_context IS NOT NULL THEN
    INSERT INTO public.ai_assistant_conversation_turns (
      job_id, destination, source_id, line_user_id, question, answer,
      business_date, context, event_timestamp_ms, expires_at
    ) VALUES (
      v_job.id, v_job.destination, v_job.source_id, v_job.line_user_id,
      v_job.question, p_answer,
      coalesce((p_turn_context->>'business_date')::date, v_job.asked_business_date),
      coalesce(p_turn_context->'context', '{}'::jsonb),
      v_job.event_timestamp_ms,
      now() + make_interval(secs => least(greatest(coalesce(p_turn_ttl_seconds, 1800), 60), 86400))
    )
    ON CONFLICT (job_id) DO NOTHING;

    -- Keep each conversation bounded: expired turns and all but the newest
    -- p_max_turns are removed.
    DELETE FROM public.ai_assistant_conversation_turns t
     WHERE t.destination = v_job.destination
       AND t.source_id = v_job.source_id
       AND t.line_user_id = v_job.line_user_id
       AND (t.expires_at <= now()
         OR t.id NOT IN (
           SELECT k.id FROM public.ai_assistant_conversation_turns k
            WHERE k.destination = v_job.destination
              AND k.source_id = v_job.source_id
              AND k.line_user_id = v_job.line_user_id
            ORDER BY k.event_timestamp_ms DESC, k.id DESC
            LIMIT least(greatest(coalesce(p_max_turns, 6), 1), 20)));
  END IF;
  RETURN true;
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

CREATE OR REPLACE FUNCTION public.complete_ai_assistant_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_status text,
  p_error_code text DEFAULT NULL
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  WITH updated AS (
    UPDATE public.ai_assistant_jobs
       SET status = p_status,
           lease_token = NULL,
           lease_expires_at = NULL,
           reply_token = NULL,
           last_error_code = coalesce(p_error_code, last_error_code),
           completed_at = now(),
           updated_at = now()
     WHERE id = p_job_id AND lease_token = p_lease_token AND status = 'running'
       AND p_status IN ('completed', 'failed')
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$fn$;

CREATE OR REPLACE FUNCTION public.retry_ai_assistant_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_delay_seconds integer,
  p_error_code text
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  WITH updated AS (
    UPDATE public.ai_assistant_jobs
       SET status = 'queued',
           lease_token = NULL,
           lease_expires_at = NULL,
           available_at = now() + make_interval(
             secs => least(greatest(coalesce(p_delay_seconds, 5), 0), 3600)),
           last_error_code = p_error_code,
           updated_at = now()
     WHERE id = p_job_id AND lease_token = p_lease_token AND status = 'running'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$fn$;

-- Turns of the asking job's conversation, excluding the job itself. Every
-- stored turn belongs to an EARLIER job (a later job of the same conversation
-- cannot be claimed while an earlier one is open), so equal LINE timestamps
-- are kept; the timestamp bound is defence in depth.
CREATE OR REPLACE FUNCTION public.load_ai_assistant_turns(
  p_destination text,
  p_source_id text,
  p_line_user_id text,
  p_before_event_ms bigint,
  p_exclude_job_id uuid,
  p_limit integer DEFAULT 4
) RETURNS TABLE (
  question text,
  answer text,
  business_date date,
  context jsonb,
  event_timestamp_ms bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT t.question, t.answer, t.business_date, t.context, t.event_timestamp_ms
    FROM public.ai_assistant_conversation_turns t
   WHERE t.destination = coalesce(p_destination, '')
     AND t.source_id = p_source_id
     AND t.line_user_id = p_line_user_id
     AND t.expires_at > now()
     AND t.event_timestamp_ms <= p_before_event_ms
     AND t.job_id <> p_exclude_job_id
   ORDER BY t.event_timestamp_ms DESC, t.id DESC
   LIMIT least(greatest(coalesce(p_limit, 4), 0), 8);
$fn$;

CREATE OR REPLACE FUNCTION public.get_ai_assistant_user_grant(p_line_user_id text)
RETURNS TABLE (
  line_user_id text,
  role text,
  staff_label text,
  all_markets boolean,
  market_labels text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT g.line_user_id, g.role, g.staff_label, g.all_markets, g.market_labels
    FROM public.ai_assistant_user_grants g
   WHERE g.line_user_id = p_line_user_id AND g.active;
$fn$;

-- Bounded retention: answers and questions of finished jobs are purged after
-- p_job_retention_days; expired turns are deleted. Called by the worker cron.
CREATE OR REPLACE FUNCTION public.prune_ai_assistant_history(
  p_job_retention_days integer DEFAULT 14,
  p_limit integer DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_turns integer;
  v_jobs integer;
BEGIN
  DELETE FROM public.ai_assistant_conversation_turns
   WHERE id IN (
     SELECT id FROM public.ai_assistant_conversation_turns
      WHERE expires_at <= now()
      LIMIT least(greatest(coalesce(p_limit, 500), 1), 5000));
  GET DIAGNOSTICS v_turns = ROW_COUNT;

  DELETE FROM public.ai_assistant_jobs
   WHERE id IN (
     SELECT id FROM public.ai_assistant_jobs
      WHERE completed_at IS NOT NULL
        AND completed_at < now() - make_interval(
          days => least(greatest(coalesce(p_job_retention_days, 14), 1), 365))
      LIMIT least(greatest(coalesce(p_limit, 500), 1), 5000));
  GET DIAGNOSTICS v_jobs = ROW_COUNT;

  RETURN jsonb_build_object('expired_turns_deleted', v_turns, 'old_jobs_deleted', v_jobs);
END
$fn$;

CREATE OR REPLACE FUNCTION public.ai_assistant_queue_health()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT jsonb_build_object(
    'queued', count(*) FILTER (WHERE status = 'queued'),
    'running', count(*) FILTER (WHERE status = 'running' AND lease_expires_at > now()),
    'expired_leases', count(*) FILTER (WHERE status = 'running' AND lease_expires_at <= now()),
    'failed_24h', count(*) FILTER (WHERE status = 'failed' AND completed_at > now() - interval '24 hours'),
    'completed_24h', count(*) FILTER (WHERE status = 'completed' AND completed_at > now() - interval '24 hours'),
    'undelivered_24h', count(*) FILTER (
      WHERE delivery_state IN ('uncertain', 'undeliverable') AND completed_at > now() - interval '24 hours'),
    'oldest_queued_age_seconds', floor(extract(epoch FROM now() - min(created_at) FILTER (
      WHERE status IN ('queued', 'running'))))::bigint
  )
  FROM public.ai_assistant_jobs;
$fn$;

DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.enqueue_ai_assistant_job(jsonb, integer, integer)',
    'public.claim_ai_assistant_jobs(text, integer, integer, integer)',
    'public.record_ai_assistant_answer(uuid, uuid, text, text, jsonb, text[], jsonb, integer, integer)',
    'public.set_ai_assistant_delivery(uuid, uuid, text[], text, text)',
    'public.complete_ai_assistant_job(uuid, uuid, text, text)',
    'public.retry_ai_assistant_job(uuid, uuid, integer, text)',
    'public.load_ai_assistant_turns(text, text, text, bigint, uuid, integer)',
    'public.get_ai_assistant_user_grant(text)',
    'public.prune_ai_assistant_history(integer, integer)',
    'public.ai_assistant_queue_health()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$$;

COMMIT;
