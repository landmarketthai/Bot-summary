-- Roll back only the durable slip ingest alert surface. The underlying image
-- ledger, OCR fencing and finalization safety remain intact.

BEGIN;

DROP FUNCTION IF EXISTS public.complete_slip_ingest_health_alert(text, uuid, boolean, integer, text);
DROP FUNCTION IF EXISTS public.claim_slip_ingest_health_alert(text, integer, integer, integer, integer);
DROP FUNCTION IF EXISTS public.slip_ingest_alert_health(integer, integer);
DROP TABLE IF EXISTS public.slip_ingest_alert_states;

COMMIT;
