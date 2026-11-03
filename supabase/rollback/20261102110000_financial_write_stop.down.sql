-- Roll back 20261102110000 (the financial write stop). Run LAST, after the
-- down files of 20261103120000 … 20261102120000, with the old app code.
--
-- Refused while any reference credit exists: old code ignores persisted
-- credits and would recount derived ownership (one ฿70 transfer paid as
-- ฿140). With credits retained, the stop must stay installed and paused
-- until a forward fix ships; there is no safe "old code + money writes" state.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.slip_reference_claims') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.slip_reference_claims) THEN
    RAISE EXCEPTION 'financial_stop_rollback_refused: reference credits exist; keep financial_maintenance paused and ship a forward fix'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS settlement_entries_financial_stop ON public.settlement_entries;
DROP TRIGGER IF EXISTS transfer_reconciliations_financial_stop ON public.transfer_reconciliations;
DROP TRIGGER IF EXISTS manual_slip_sessions_financial_stop ON public.manual_slip_sessions;
DROP TRIGGER IF EXISTS manual_slip_entries_financial_stop ON public.manual_slip_entries;
DROP TRIGGER IF EXISTS settlement_finalizations_financial_stop ON public.settlement_finalizations;
DROP FUNCTION IF EXISTS public.guard_financial_source_write();
DROP FUNCTION IF EXISTS public.guard_manual_slip_entry_financial_write();
DROP FUNCTION IF EXISTS public.guard_settlement_finalization_handout();
DROP FUNCTION IF EXISTS public.assert_financial_writes_open(text);
DROP TABLE IF EXISTS public.financial_maintenance;

COMMIT;
