BEGIN;
ALTER FUNCTION public.enqueue_ai_assistant_job(jsonb, integer, integer) RESET lock_timeout;
COMMIT;
