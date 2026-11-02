BEGIN;
-- Bound contention on the AI-only queue without changing its serialization rules.
ALTER FUNCTION public.enqueue_ai_assistant_job(jsonb, integer, integer) SET lock_timeout = '1s';
COMMIT;
