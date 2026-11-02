-- @Botsummary AI Assistant: group disclosure policy and access-scope binding
-- (independent review of PR #191, P1-B and P1-C). Forward-only on top of
-- 20261031090000_ai_assistant_jobs.sql.
--
-- P1-B  An answer in a LINE group is seen by every member, so a member's
--       personal grant cannot authorize it. Groups are default-deny: only a
--       group with an active ai_assistant_group_policies row may receive data,
--       and only the categories and markets that row allows (intersected with
--       the asker's own scope). Otherwise the answer is sent 1:1 (when that is
--       enabled) or refused.
-- P1-C  Every recorded answer and conversation turn carries the access-scope
--       key it was produced under (SHA-256 hex of role, staff, markets, group
--       policy and delivery target). Memory is loaded only for the current
--       key, and a stored answer whose key no longer matches is withheld.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_assistant_group_policies (
  source_id              text PRIMARY KEY CHECK (btrim(source_id) <> ''),
  allow_financial        boolean NOT NULL DEFAULT false,
  allow_person_specific  boolean NOT NULL DEFAULT false,
  all_markets            boolean NOT NULL DEFAULT false,
  market_labels          text[] NOT NULL DEFAULT '{}',
  active                 boolean NOT NULL DEFAULT true,
  note                   text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_assistant_group_policy_market_scope CHECK (all_markets OR cardinality(market_labels) > 0)
);

COMMENT ON TABLE public.ai_assistant_group_policies IS
  'What @Botsummary may disclose IN a LINE group (seen by all members). No active row = nothing. RPC read only.';

ALTER TABLE public.ai_assistant_group_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_assistant_group_policies FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.ai_assistant_jobs
  ADD COLUMN IF NOT EXISTS answer_scope_key text
    CHECK (answer_scope_key IS NULL OR answer_scope_key ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS delivery_target text NOT NULL DEFAULT 'chat'
    CHECK (delivery_target IN ('chat', 'private'));

ALTER TABLE public.ai_assistant_conversation_turns
  ADD COLUMN IF NOT EXISTS scope_key text
    CHECK (scope_key IS NULL OR scope_key ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION public.get_ai_assistant_group_policy(p_source_id text)
RETURNS TABLE (
  source_id text,
  allow_financial boolean,
  allow_person_specific boolean,
  all_markets boolean,
  market_labels text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT g.source_id, g.allow_financial, g.allow_person_specific, g.all_markets, g.market_labels
    FROM public.ai_assistant_group_policies g
   WHERE g.source_id = p_source_id AND g.active;
$fn$;

DROP FUNCTION IF EXISTS public.record_ai_assistant_answer(uuid, uuid, text, text, jsonb, text[], jsonb, integer, integer);

CREATE OR REPLACE FUNCTION public.record_ai_assistant_answer(
  p_job_id uuid,
  p_lease_token uuid,
  p_answer text,
  p_kind text,
  p_usage jsonb,
  p_tool_names text[],
  p_turn_context jsonb,
  p_turn_ttl_seconds integer,
  p_max_turns integer,
  p_scope_key text,
  p_delivery_target text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_job public.ai_assistant_jobs;
BEGIN
  -- A data answer must be bound to the scope it was produced under.
  IF p_kind = 'answer' AND p_scope_key IS NULL THEN
    RAISE EXCEPTION 'record_ai_assistant_answer: an answer needs its access scope key'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.ai_assistant_jobs
     SET answer_text = p_answer,
         answer_kind = p_kind,
         usage = p_usage,
         tool_names = coalesce(p_tool_names, '{}'),
         answer_scope_key = p_scope_key,
         delivery_target = coalesce(p_delivery_target, 'chat'),
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
      business_date, context, event_timestamp_ms, expires_at, scope_key
    ) VALUES (
      v_job.id, v_job.destination, v_job.source_id, v_job.line_user_id,
      v_job.question, p_answer,
      coalesce((p_turn_context->>'business_date')::date, v_job.asked_business_date),
      coalesce(p_turn_context->'context', '{}'::jsonb),
      v_job.event_timestamp_ms,
      now() + make_interval(secs => least(greatest(coalesce(p_turn_ttl_seconds, 1800), 60), 86400)),
      p_scope_key
    )
    ON CONFLICT (job_id) DO NOTHING;

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

-- Replace a recorded answer that may no longer be shown (scope changed or
-- revoked) with a notice, and forget its conversation turn.
CREATE OR REPLACE FUNCTION public.withhold_ai_assistant_answer(
  p_job_id uuid,
  p_lease_token uuid,
  p_notice text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  UPDATE public.ai_assistant_jobs
     SET answer_text = p_notice,
         answer_kind = 'notice',
         answer_scope_key = NULL,
         tool_names = '{}',
         updated_at = now()
   WHERE id = p_job_id AND lease_token = p_lease_token AND status = 'running'
     AND answer_text IS NOT NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM public.ai_assistant_conversation_turns WHERE job_id = p_job_id;
  RETURN true;
END
$fn$;

DROP FUNCTION IF EXISTS public.load_ai_assistant_turns(text, text, text, bigint, uuid, integer);

CREATE OR REPLACE FUNCTION public.load_ai_assistant_turns(
  p_destination text,
  p_source_id text,
  p_line_user_id text,
  p_before_event_ms bigint,
  p_exclude_job_id uuid,
  p_scope_key text,
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
  -- Only turns produced under the CURRENT access scope: a downgrade, a
  -- revoked market or a changed group policy starts the memory afresh.
  SELECT t.question, t.answer, t.business_date, t.context, t.event_timestamp_ms
    FROM public.ai_assistant_conversation_turns t
   WHERE t.destination = coalesce(p_destination, '')
     AND t.source_id = p_source_id
     AND t.line_user_id = p_line_user_id
     AND t.scope_key = p_scope_key
     AND t.expires_at > now()
     AND t.event_timestamp_ms <= p_before_event_ms
     AND t.job_id <> p_exclude_job_id
   ORDER BY t.event_timestamp_ms DESC, t.id DESC
   LIMIT least(greatest(coalesce(p_limit, 4), 0), 8);
$fn$;

DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.get_ai_assistant_group_policy(text)',
    'public.record_ai_assistant_answer(uuid, uuid, text, text, jsonb, text[], jsonb, integer, integer, text, text)',
    'public.withhold_ai_assistant_answer(uuid, uuid, text)',
    'public.load_ai_assistant_turns(text, text, text, bigint, uuid, text, integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$$;

COMMIT;
