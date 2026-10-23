-- Least privilege for the category-learning tables.
--
-- 20261022120000 granted service_role SELECT (and UPDATE on candidates) but
-- never revoked what service_role inherits from Supabase's broad default ACL
-- (ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO service_role). With
-- that ACL a direct UPDATE could rewrite a rule without an audit decision and
-- TRUNCATE could erase the audit. After this migration service_role can only
-- READ these tables; every write goes through the validated SECURITY DEFINER
-- RPCs (observe / decide / claim / complete / requeue), owned by the
-- migration role. No business table is touched.

BEGIN;

REVOKE ALL ON public.produce_category_candidates FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.produce_category_rules      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.produce_category_decisions  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.produce_category_deliveries FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON public.produce_category_candidates TO service_role;
GRANT SELECT ON public.produce_category_rules      TO service_role;
GRANT SELECT ON public.produce_category_decisions  TO service_role;
GRANT SELECT ON public.produce_category_deliveries TO service_role;

-- The audit is append-only even for roles that still hold TRUNCATE (table
-- owner): row triggers do not fire on TRUNCATE, so guard it explicitly.
-- Rollback drops the table, which this trigger does not block.
CREATE TRIGGER produce_category_decisions_no_truncate
  BEFORE TRUNCATE ON public.produce_category_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.produce_category_decisions_append_only();

COMMIT;
