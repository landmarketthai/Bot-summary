-- TEST ONLY, fresh disposable PG17. This is not a Supabase platform installation.
-- pgcrypto schema/roles: produce_0049_bootstrap.sql and guided_menu_0051_bootstrap.sql.
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

DO $$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN %s', v_role,
        CASE WHEN v_role = 'service_role' THEN 'BYPASSRLS' ELSE 'NOBYPASSRLS' END);
    END IF;
    IF NOT EXISTS (
      SELECT FROM pg_roles WHERE rolname = v_role AND NOT rolcanlogin
        AND NOT rolsuper AND rolbypassrls = (v_role = 'service_role')
    ) THEN
      RAISE EXCEPTION 'Unsafe existing test role %, refusing to alter cluster role', v_role;
    END IF;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA extensions TO service_role;
-- Exact service-table default from guided_menu_0051_bootstrap.sql:26-28.
-- Set BEFORE replay; never blanket grant afterwards over narrowed evidence ACLs.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES
  TO service_role;

-- Metadata shim, not Storage API parity. Shape follows actual statements in
-- 0019_slip_evidence_ingestion.sql, 20260919152000_morning_brief_pdf_bucket.sql,
-- 20260922100000_settlement_sheet_ocr_drafts.sql and
-- 20260924032000_morning_brief_ref_json_mime.sql. No storage.objects/auth stubs.
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text,
  public boolean,
  file_size_limit bigint,
  allowed_mime_types text[]
);
