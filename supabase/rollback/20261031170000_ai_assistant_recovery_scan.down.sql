-- Roll back 20261031170000_ai_assistant_recovery_scan.sql only: drops the
-- recovery candidate RPC, the cursor RPCs and the cursor table. raw_messages
-- is untouched. Run before rolling back 20261031160000. The application
-- version that calls these RPCs must be rolled back first.

BEGIN;

DROP FUNCTION IF EXISTS public.set_ai_assistant_recovery_cursor(timestamptz, uuid);
DROP FUNCTION IF EXISTS public.get_ai_assistant_recovery_cursor();
DROP FUNCTION IF EXISTS public.list_ai_assistant_recovery_candidates(timestamptz, timestamptz, timestamptz, uuid, integer);
DROP TABLE IF EXISTS public.ai_assistant_recovery_cursor;

COMMIT;
