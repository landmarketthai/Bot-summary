-- Roll back the @Botsummary AI Assistant job queue, conversation memory and
-- access grants. No Produce, Slip, White Sheet or settlement object depends
-- on these. Pending jobs are discarded (their questions go unanswered).

BEGIN;

DROP FUNCTION IF EXISTS public.ai_assistant_queue_health();
DROP FUNCTION IF EXISTS public.prune_ai_assistant_history(integer, integer);
DROP FUNCTION IF EXISTS public.get_ai_assistant_user_grant(text);
DROP FUNCTION IF EXISTS public.load_ai_assistant_turns(text, text, text, bigint, integer);
DROP FUNCTION IF EXISTS public.retry_ai_assistant_job(uuid, uuid, integer, text);
DROP FUNCTION IF EXISTS public.complete_ai_assistant_job(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.set_ai_assistant_delivery(uuid, uuid, text[], text, text);
DROP FUNCTION IF EXISTS public.record_ai_assistant_answer(uuid, uuid, text, text, jsonb, text[], jsonb, integer, integer);
DROP FUNCTION IF EXISTS public.claim_ai_assistant_jobs(text, integer, integer, integer);
DROP FUNCTION IF EXISTS public.enqueue_ai_assistant_job(jsonb, integer, integer);
DROP TABLE IF EXISTS public.ai_assistant_conversation_turns;
DROP TABLE IF EXISTS public.ai_assistant_user_grants;
DROP TABLE IF EXISTS public.ai_assistant_jobs;

COMMIT;
