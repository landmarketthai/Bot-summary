-- Roll back the category-learning privilege hardening to the grants of
-- 20261022120000 / 20261023100000. Run first (before the ledger rollback).
-- This re-opens nothing beyond those earlier grants: inherited default-ACL
-- privileges revoked here are not re-granted.

BEGIN;

DROP TRIGGER IF EXISTS produce_category_decisions_no_truncate ON public.produce_category_decisions;
GRANT UPDATE ON public.produce_category_candidates TO service_role;

COMMIT;
