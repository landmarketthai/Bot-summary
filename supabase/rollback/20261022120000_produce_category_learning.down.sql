-- Roll back the self-learning category dictionary entirely. Run after
-- 20261022130000_produce_category_announce_queue.down.sql.
--
-- Safe for business data: these tables only hold CATEGORY candidates, admin
-- category rules and their audit. No transaction, quantity, price, total,
-- fingerprint, product code or alias depends on them; reports fall back to the
-- rules shipped in code (approvedCategoryFor -> BUSINESS_CATEGORY_POLICY).
--
-- The decision audit is dropped with the tables. Export it first if it must
-- be kept:  \copy public.produce_category_decisions TO 'decisions.csv' CSV HEADER

BEGIN;

DROP FUNCTION IF EXISTS public.decide_produce_category_candidate(uuid, integer, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.observe_produce_category_candidate(text, text, text, text, text, integer, integer, date, date, text[]);
DROP TABLE IF EXISTS public.produce_category_rules;
DROP TABLE IF EXISTS public.produce_category_decisions;
DROP FUNCTION IF EXISTS public.produce_category_decisions_append_only();
DROP TABLE IF EXISTS public.produce_category_candidates;

COMMIT;
