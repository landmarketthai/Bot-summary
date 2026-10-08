-- Supabase grants service_role ALL privileges by default on new public tables.
-- This transient review ledger needs only SELECT/INSERT/DELETE (no UPDATE/TRUNCATE).
BEGIN;
REVOKE ALL ON TABLE public.white_sheet_review_turns FROM service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.white_sheet_review_turns TO service_role;
COMMIT;
