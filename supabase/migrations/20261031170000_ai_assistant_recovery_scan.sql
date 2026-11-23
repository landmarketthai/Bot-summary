-- @Botsummary recovery sweep: deterministic paging and progress across sweeps.
-- Forward-only on top of 20261031160000. Read-only on raw_messages.
--
-- The sweep (run by the assistant worker cron) enqueues @Botsummary questions
-- whose enqueue failed. Paging by created_at alone skipped rows that share a
-- timestamp, and every sweep restarted at the window start, so more than one
-- sweep's worth of unprocessed rows ahead of a question hid it until it left
-- the eligibility window.
--
-- list_ai_assistant_recovery_candidates
--   Composite keyset (created_at, id), strictly after the given key, ordered
--   by (created_at, id): ties are visited once each, never repeated.
--   Only rows that can be a question are returned: the text contains '@'
--   (every literal "@Botsummary" prefix does) or the message mentions the
--   bot (mentionee userId = destination). Produce / slip / white-sheet texts
--   without '@' are never read by the sweep. The application still applies
--   the exact question parser, allowlist and white-sheet checks.
--   Range-bounded by the existing partial index idx_raw_messages_unprocessed
--   (created_at WHERE is_processed = false); at most 200 rows per call.
--
-- ai_assistant_recovery_cursor (one row) + get/set
--   Where the previous sweep stopped. A sweep resumes after it; when a sweep
--   reaches the end of the window the cursor is cleared and the next sweep
--   starts at the window start again (round robin), so deferred rows are
--   retried and every candidate is visited within ceil(candidates / rows per
--   sweep) sweeps. A cursor older than the window start is ignored.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_assistant_recovery_cursor (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  after_created_at timestamptz NOT NULL,
  after_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_assistant_recovery_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_assistant_recovery_cursor FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_ai_assistant_recovery_candidates(
  p_since timestamptz,
  p_until timestamptz,
  p_after_created_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50
) RETURNS TABLE (
  id uuid,
  destination text,
  source_id text,
  payload jsonb,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT r.id, r.destination, r.source_id, r.payload, r.created_at
    FROM public.raw_messages r
   WHERE r.is_processed = false
     AND r.event_type = 'message'
     AND r.message_type = 'text'
     AND r.created_at >= greatest(p_since, coalesce(p_after_created_at, p_since))
     AND r.created_at <= p_until
     AND (p_after_created_at IS NULL OR p_after_id IS NULL
          OR (r.created_at, r.id) > (p_after_created_at, p_after_id))
     AND (
       strpos(coalesce(r.raw_text, r.payload->'message'->>'text', ''), '@') > 0
       OR (r.payload->'message'->'mention'->'mentionees')
            @> jsonb_build_array(jsonb_build_object('userId', r.destination))
     )
   ORDER BY r.created_at, r.id
   LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
$fn$;

CREATE OR REPLACE FUNCTION public.get_ai_assistant_recovery_cursor()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT jsonb_build_object('after_created_at', c.after_created_at, 'after_id', c.after_id)
    FROM public.ai_assistant_recovery_cursor c
   WHERE c.id;
$fn$;

CREATE OR REPLACE FUNCTION public.set_ai_assistant_recovery_cursor(
  p_after_created_at timestamptz,
  p_after_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_after_created_at IS NULL OR p_after_id IS NULL THEN
    DELETE FROM public.ai_assistant_recovery_cursor WHERE id;
    RETURN false;
  END IF;
  INSERT INTO public.ai_assistant_recovery_cursor (id, after_created_at, after_id, updated_at)
  VALUES (true, p_after_created_at, p_after_id, now())
  ON CONFLICT (id) DO UPDATE
    SET after_created_at = EXCLUDED.after_created_at,
        after_id = EXCLUDED.after_id,
        updated_at = now();
  RETURN true;
END
$fn$;

DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.list_ai_assistant_recovery_candidates(timestamptz, timestamptz, timestamptz, uuid, integer)',
    'public.get_ai_assistant_recovery_cursor()',
    'public.set_ai_assistant_recovery_cursor(timestamptz, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$$;

COMMIT;
