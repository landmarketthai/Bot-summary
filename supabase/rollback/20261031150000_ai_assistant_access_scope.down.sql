-- Roll back 20261031150000_ai_assistant_access_scope.sql only: restores the
-- record/load functions of 20261031090000 and removes group policies and
-- scope keys. Run before rolling back 20261031090000 itself.

BEGIN;

DROP FUNCTION IF EXISTS public.withhold_ai_assistant_answer(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.get_ai_assistant_group_policy(text);
DROP FUNCTION IF EXISTS public.record_ai_assistant_answer(uuid, uuid, text, text, jsonb, text[], jsonb, integer, integer, text, text);
DROP FUNCTION IF EXISTS public.load_ai_assistant_turns(text, text, text, bigint, uuid, text, integer);

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

REVOKE ALL ON FUNCTION public.record_ai_assistant_answer(uuid, uuid, text, text, jsonb, text[], jsonb, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_assistant_answer(uuid, uuid, text, text, jsonb, text[], jsonb, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.load_ai_assistant_turns(text, text, text, bigint, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_ai_assistant_turns(text, text, text, bigint, uuid, integer) TO service_role;

ALTER TABLE public.ai_assistant_conversation_turns DROP COLUMN IF EXISTS scope_key;
ALTER TABLE public.ai_assistant_jobs DROP COLUMN IF EXISTS delivery_target;
ALTER TABLE public.ai_assistant_jobs DROP COLUMN IF EXISTS answer_scope_key;
DROP TABLE IF EXISTS public.ai_assistant_group_policies;

COMMIT;
