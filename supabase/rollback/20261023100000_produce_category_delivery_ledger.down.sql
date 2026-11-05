-- Roll back the per-recipient delivery ledger. Run after the privilege
-- hardening rollback and before 20261022130000's rollback. Delivery history
-- is dropped; candidates, rules and decisions stay.

BEGIN;

DROP FUNCTION IF EXISTS public.produce_category_delivery_health();
DROP FUNCTION IF EXISTS public.requeue_produce_category_deliveries(text);
DROP FUNCTION IF EXISTS public.complete_produce_category_delivery(uuid, integer, text, uuid, text, integer, text, integer);
DROP FUNCTION IF EXISTS public.claim_produce_category_deliveries(text[], integer, integer, integer);
DROP TABLE IF EXISTS public.produce_category_deliveries;

COMMIT;
