-- ROLLBACK for 20261017100000_slip_image_ingestion_ledger.sql
--
-- This file lives OUTSIDE supabase/migrations on purpose: the migration runner
-- must never apply it. It is run by hand, by an operator, after the protocol
-- below. It is exercised by src/lib/slips/schema-compat.pg.test.ts on a
-- disposable PostgreSQL 17.
--
-- ── Protocol ──────────────────────────────────────────────────────────────────
-- 1. Roll the APPLICATION back first (or pause LINE slip sessions). Rolling the
--    schema back under a running ledger-aware app is not supported: that app
--    fails explicitly (see "What the application does" below).
-- 2. Drain the ledger. This script REFUSES to run while any ledger row of a
--    collecting/closing batch is still in flight (received / ingesting /
--    retry_pending / unbound): the legacy path cannot see the ledger, so such an
--    image would be lost at finalization. Let the cron finish them
--    (finalize-slip-batches), or wait for the batches to finalize, then retry.
--    Check:  SELECT state, count(*) FROM public.slip_image_events
--             WHERE state IN ('received','ingesting','retry_pending','unbound')
--             GROUP BY 1;
--    Operator override (loss is then recorded, never silent):
--      SET slip_rollback.allow_inflight = 'on';   -- same session, before this file
--    The in-flight rows are copied to public.slip_image_events_rollback_audit.
-- 3. Run this file in ONE session:  psql -v ON_ERROR_STOP=1 -f <this file>
--    It is a single transaction: it either applies completely or not at all.
--
-- ── What it does ──────────────────────────────────────────────────────────────
--   * drops the capture trigger on line_webhook_event_queue and the bind trigger
--     on slip_batches (new queue receipts / sessions stop touching the ledger);
--   * drops every ledger RPC (all overloads, signature-agnostic) so a
--     ledger-aware app takes its explicit legacy path (42883/PGRST202);
--   * restores the 3-argument claim_closing_slip_batch exactly as migration
--     0024 defined it (no ledger wait, no image reconciliation);
--   * KEEPS public.slip_image_events (audit: which images were received and what
--     happened to each). Drop it only after an audit export:
--       -- DROP TABLE public.slip_image_events;
--   * archives slip_batches.open_event_ts_ms / close_event_ts_ms into
--     public.slip_batches_rollback_audit and then DROPS the two columns, so the
--     schema is again exactly the pre-migration schema. This is deliberate: a
--     ledger-aware application detects "pre-migration schema" by the absence of
--     these columns and then (a) refuses to open a session, (b) refuses to close
--     one, (c) lets the finalizer take the explicit legacy path. Leaving the
--     columns behind would make that application treat the missing accounting
--     RPC as an outage and park every batch in 'processing'.
--   * does NOT touch 20261017110000_slip_ocr_claim_fencing.sql (additive OCR
--     claim columns/functions; independent of the ledger, safe to leave).
--
-- ── What the application does on the rolled-back schema ──────────────────────
--   * images: begin_slip_image_attempt is missing -> "no_ledger" -> legacy attach
--     (the pre-incident behaviour, which is exactly the risk being accepted);
--   * finalizer: 4-argument claim missing -> falls back to the 3-argument one;
--     slip_batch_image_accounting missing -> reported as a legacy batch;
--   * session open and close FAIL EXPLICITLY (slip_ledger_schema_missing); roll
--     the application back with the schema, or re-apply the migration.
--
-- Limits that cannot be made safe by SQL alone:
--   * images whose queue event was already acknowledged but whose ledger row was
--     still retry_pending are not re-driven by the legacy path (override path
--     records them in the audit table; re-send or re-ingest them manually).

BEGIN;

DO $guard$
DECLARE
  v_inflight bigint := 0;
BEGIN
  IF to_regclass('public.slip_image_events') IS NULL THEN
    RAISE NOTICE 'slip_image_events does not exist: nothing to protect';
    RETURN;
  END IF;

  SELECT count(*) INTO v_inflight
    FROM public.slip_image_events ev
    LEFT JOIN public.slip_batches b ON b.id = ev.batch_id
   WHERE ev.state IN ('received', 'ingesting', 'retry_pending', 'unbound')
     AND (ev.batch_id IS NULL OR b.status IN ('collecting', 'closing'));

  IF v_inflight = 0 THEN
    RETURN;
  END IF;

  IF coalesce(current_setting('slip_rollback.allow_inflight', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'slip rollback refused: % in-flight image ledger row(s) on open batches would be lost by the legacy path. Drain them (cron finalize-slip-batches) or set slip_rollback.allow_inflight=on to record and accept the loss.',
      v_inflight
      USING ERRCODE = 'P0001';
  END IF;

  CREATE TABLE IF NOT EXISTS public.slip_image_events_rollback_audit (
    audited_at timestamptz NOT NULL DEFAULT now(),
    LIKE public.slip_image_events
  );
  ALTER TABLE public.slip_image_events_rollback_audit ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.slip_image_events_rollback_audit FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON TABLE public.slip_image_events_rollback_audit TO service_role;
  INSERT INTO public.slip_image_events_rollback_audit
  SELECT now(), ev.*
    FROM public.slip_image_events ev
    LEFT JOIN public.slip_batches b ON b.id = ev.batch_id
   WHERE ev.state IN ('received', 'ingesting', 'retry_pending', 'unbound')
     AND (ev.batch_id IS NULL OR b.status IN ('collecting', 'closing'));
  RAISE WARNING 'slip rollback forced with % in-flight image ledger row(s); recorded in public.slip_image_events_rollback_audit', v_inflight;
END
$guard$;

-- Keep the per-batch LINE times for audit, then restore the pre-migration shape.
DO $arch$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'slip_batches'
       AND column_name = 'open_event_ts_ms'
  ) THEN
    CREATE TABLE IF NOT EXISTS public.slip_batches_rollback_audit (
      batch_id          uuid        NOT NULL,
      open_event_ts_ms  bigint,
      close_event_ts_ms bigint,
      archived_at       timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.slip_batches_rollback_audit ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.slip_batches_rollback_audit FROM PUBLIC, anon, authenticated;
    GRANT SELECT ON TABLE public.slip_batches_rollback_audit TO service_role;
    EXECUTE 'INSERT INTO public.slip_batches_rollback_audit (batch_id, open_event_ts_ms, close_event_ts_ms)
             SELECT id, open_event_ts_ms, close_event_ts_ms FROM public.slip_batches
              WHERE open_event_ts_ms IS NOT NULL OR close_event_ts_ms IS NOT NULL';
  END IF;
END
$arch$;

-- Triggers first: nothing may write the ledger past this point.
DROP TRIGGER IF EXISTS trg_capture_slip_image_event ON public.line_webhook_event_queue;
DROP TRIGGER IF EXISTS trg_bind_unbound_slip_image_events ON public.slip_batches;

-- Every ledger function, all overloads, whatever signature the final migration
-- shipped with.
DO $drop$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN (
         'capture_slip_image_event',
         'receive_line_webhook_payload',
         'bind_unbound_slip_image_events',
         'resolve_slip_image_batch',
         'slip_image_event_ts',
         'begin_slip_image_attempt',
         'attach_slip_image_event',
         'fail_slip_image_event',
         'list_due_slip_image_events',
         'list_slip_ocr_redrive',
         'slip_batch_image_accounting',
         'slip_image_ledger_health',
         'claim_closing_slip_batch'
       )
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', r.sig);
  END LOOP;
END
$drop$;

-- The 3-argument claim, verbatim from migration 0024_slip_batch_closing.sql.
CREATE OR REPLACE FUNCTION public.claim_closing_slip_batch(
  p_batch_id       uuid,
  p_quiet_seconds  integer,
  p_max_seconds    integer
) RETURNS TABLE(claimed_id uuid, claimed_source_id text, was_timeout boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch     public.slip_batches%ROWTYPE;
  v_now       timestamptz := now();
  v_timed_out boolean;
  v_quiet_ok  boolean;
  v_ev_count  bigint;
  v_ck_count  bigint;
  v_pr_count  bigint;
BEGIN
  -- Lock the batch row; serializes against attach_evidence_to_slip_batch.
  SELECT * INTO v_batch
  FROM   public.slip_batches
  WHERE  id = p_batch_id AND status = 'closing'
  FOR UPDATE;

  IF NOT FOUND THEN RETURN; END IF;

  v_timed_out := v_now - COALESCE(v_batch.closing_at, v_batch.last_image_at)
                   >= make_interval(secs => p_max_seconds);
  v_quiet_ok  := v_now - v_batch.last_image_at
                   >= make_interval(secs => p_quiet_seconds);

  IF NOT v_timed_out AND NOT v_quiet_ok THEN RETURN; END IF;

  -- If not timed out, also require all checks to be terminal.
  IF NOT v_timed_out THEN
    SELECT COUNT(*) INTO v_ev_count
    FROM   public.slip_evidences
    WHERE  batch_id = p_batch_id;

    IF v_ev_count > 0 THEN
      SELECT COUNT(*) INTO v_ck_count
      FROM   public.slip_checks sc
      JOIN   public.slip_evidences se ON sc.evidence_id = se.id
      WHERE  se.batch_id = p_batch_id;

      IF v_ck_count < v_ev_count THEN RETURN; END IF;

      SELECT COUNT(*) INTO v_pr_count
      FROM   public.slip_checks sc
      JOIN   public.slip_evidences se ON sc.evidence_id = se.id
      WHERE  se.batch_id = p_batch_id AND sc.status = 'PROCESSING';

      IF v_pr_count > 0 THEN RETURN; END IF;
    END IF;
  END IF;

  -- All conditions satisfied — atomically claim the batch.
  UPDATE public.slip_batches
  SET    status = 'processing'
  WHERE  id = p_batch_id;

  RETURN QUERY SELECT v_batch.id, v_batch.source_id, v_timed_out;
END;
$$;

ALTER TABLE public.slip_batches
  DROP COLUMN IF EXISTS open_event_ts_ms,
  DROP COLUMN IF EXISTS close_event_ts_ms;

REVOKE ALL ON FUNCTION public.claim_closing_slip_batch(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_closing_slip_batch(uuid, integer, integer) TO service_role;

COMMIT;
