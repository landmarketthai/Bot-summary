-- Financial write stop (release P0-1 / P0-2). Additive, re-runnable, no data
-- changes. Production apply required FIRST, before 20261102120000 (M1).
--
-- Why first: the stop must exist before any money schema changes, so code of
-- EVERY version (the deployed main as well as this branch) is refused at the
-- database while M1–M7 apply and the new code deploys. There is no window in
-- which an old worker, LINE command, admin review or /api/settlement can
-- commit money against a half-migrated schema.
--
-- 1. public.financial_maintenance (one row). A fresh install starts PAUSED:
--    applying this file is the stop. Resume is an explicit SQL UPDATE after
--    the release is verified (runbook §4). An existing row is left as is.
-- 2. pilot_sources: NULL = every source may write money; a non-NULL array =
--    only those LINE sources may (one-market pilot). Rows without a source
--    (legacy /api/settlement without source_id) are refused while it is set.
-- 3. assert_financial_writes_open(source) takes FOR SHARE on the row, so it
--    is held until the writing transaction ends. A pause (UPDATE of the row)
--    therefore waits for every write that already passed the check, and every
--    write that starts after the pause waits for it and then sees paused.
--    When the pause UPDATE returns, no guarded DB write transaction is in
--    progress. A delivery already authorized by an earlier committed credit
--    is outside that transaction; operators still drain workers (runbook).
-- 4. Guards on the money tables that exist before M1 (so old code is covered):
--      settlement_entries, transfer_reconciliations      every INSERT/UPDATE/DELETE
--      manual_slip_sessions, manual_slip_entries          every INSERT/UPDATE/DELETE
--      settlement_finalizations                           entering sending/sent/ambiguous
--    Leaving a handed-out status (sending → sent / failed) stays allowed, so
--    an in-flight settlement can record its outcome during a stop. Evidence
--    ingestion and OCR (slip_evidences, slip_checks, slip_batches) are not
--    guarded, so no LINE event is lost; they stay pending.
-- M7 adds the same guard to slip_check_approvals and claim_slip_references.

BEGIN;

CREATE TABLE IF NOT EXISTS public.financial_maintenance (
  singleton     boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  paused        boolean     NOT NULL DEFAULT true,
  pilot_sources text[],
  reason        text,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  changed_by    text
);
ALTER TABLE public.financial_maintenance ADD COLUMN IF NOT EXISTS pilot_sources text[];
INSERT INTO public.financial_maintenance (singleton, paused, reason, changed_by)
VALUES (true, true, 'installed by 20261102110000: resume only after the release is verified', 'migration')
ON CONFLICT DO NOTHING;
ALTER TABLE public.financial_maintenance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_maintenance FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.financial_maintenance TO service_role;

-- SECURITY DEFINER: FOR SHARE needs UPDATE privilege, which no API role has.
-- ponytail: one global row lock; per-source rows if write volume ever contends on it.
CREATE OR REPLACE FUNCTION public.assert_financial_writes_open(p_source text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_paused boolean;
  v_pilot text[];
BEGIN
  SELECT m.paused, m.pilot_sources INTO v_paused, v_pilot
  FROM public.financial_maintenance m WHERE m.singleton FOR SHARE;
  IF v_paused IS DISTINCT FROM false THEN   -- paused, or the row is missing: closed
    RAISE EXCEPTION 'financial_maintenance' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_pilot IS NOT NULL AND (p_source IS NULL OR NOT p_source = ANY (v_pilot)) THEN
    RAISE EXCEPTION 'financial_maintenance_pilot_scope' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;

-- Tables with their own source_id. An UPDATE checks both the old and the new
-- source, so a row cannot be moved into or out of an allowed source.
CREATE OR REPLACE FUNCTION public.guard_financial_source_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.assert_financial_writes_open(OLD.source_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.assert_financial_writes_open(NEW.source_id);
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_manual_slip_entry_financial_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.assert_financial_writes_open((SELECT s.source_id FROM public.manual_slip_sessions s WHERE s.id = OLD.session_id));
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.assert_financial_writes_open((SELECT s.source_id FROM public.manual_slip_sessions s WHERE s.id = NEW.session_id));
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_settlement_finalization_handout()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IN ('sending', 'sent', 'ambiguous')
     AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('sending', 'sent', 'ambiguous')) THEN
    PERFORM public.assert_financial_writes_open(NEW.source_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS settlement_entries_financial_stop ON public.settlement_entries;
CREATE TRIGGER settlement_entries_financial_stop
BEFORE INSERT OR UPDATE OR DELETE ON public.settlement_entries
FOR EACH ROW EXECUTE FUNCTION public.guard_financial_source_write();

DROP TRIGGER IF EXISTS transfer_reconciliations_financial_stop ON public.transfer_reconciliations;
CREATE TRIGGER transfer_reconciliations_financial_stop
BEFORE INSERT OR UPDATE OR DELETE ON public.transfer_reconciliations
FOR EACH ROW EXECUTE FUNCTION public.guard_financial_source_write();

DROP TRIGGER IF EXISTS manual_slip_sessions_financial_stop ON public.manual_slip_sessions;
CREATE TRIGGER manual_slip_sessions_financial_stop
BEFORE INSERT OR UPDATE OR DELETE ON public.manual_slip_sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_financial_source_write();

DROP TRIGGER IF EXISTS manual_slip_entries_financial_stop ON public.manual_slip_entries;
CREATE TRIGGER manual_slip_entries_financial_stop
BEFORE INSERT OR UPDATE OR DELETE ON public.manual_slip_entries
FOR EACH ROW EXECUTE FUNCTION public.guard_manual_slip_entry_financial_write();

DROP TRIGGER IF EXISTS settlement_finalizations_financial_stop ON public.settlement_finalizations;
CREATE TRIGGER settlement_finalizations_financial_stop
BEFORE INSERT OR UPDATE ON public.settlement_finalizations
FOR EACH ROW EXECUTE FUNCTION public.guard_settlement_finalization_handout();

-- The guards run as the writing role (service_role in Production), so it keeps EXECUTE.
REVOKE ALL ON FUNCTION public.assert_financial_writes_open(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_financial_writes_open(text) TO service_role;
REVOKE ALL ON FUNCTION public.guard_financial_source_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_manual_slip_entry_financial_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_settlement_finalization_handout() FROM PUBLIC, anon, authenticated;

COMMIT;
