-- Cancel only a still-collecting transfer-slip batch. Preserve its raw
-- evidence and bank extraction for audit, but remove all currently verified
-- checks from financial and duplicate-winner accounting in the same transaction.
ALTER TABLE public.slip_batches
  DROP CONSTRAINT IF EXISTS slip_batches_status_check;
ALTER TABLE public.slip_batches
  ADD CONSTRAINT slip_batches_status_check
    CHECK (status IN (
      'collecting', 'closing', 'processing', 'completed',
      'review_needed', 'failed', 'cancelled'
    ));

-- A background OCR worker can finish after a cancellation. Never let an
-- extracted check from that cancelled batch become financially verified again.
CREATE OR REPLACE FUNCTION public.guard_cancelled_slip_check()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NEW.status IN ('EXTRACTED', 'PARTIAL_EXTRACTED') AND EXISTS (
    SELECT 1 FROM public.slip_evidences ev
    JOIN public.slip_batches b ON b.id = ev.batch_id
    WHERE ev.id = NEW.evidence_id AND b.status = 'cancelled'
  ) THEN
    NEW.extracted_json := jsonb_set(
      COALESCE(NEW.extracted_json, '{}'::jsonb),
      '{cancelled_batch_original_status}', to_jsonb(NEW.status), true
    );
    NEW.status := 'NEED_REVIEW';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.guard_cancelled_slip_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_cancelled_slip_check() TO service_role;
DROP TRIGGER IF EXISTS trg_guard_cancelled_slip_check ON public.slip_checks;
CREATE TRIGGER trg_guard_cancelled_slip_check
  BEFORE INSERT OR UPDATE ON public.slip_checks
  FOR EACH ROW EXECUTE FUNCTION public.guard_cancelled_slip_check();

-- The row lock serializes cancellation with image attachment and closing.
-- The status gate prevents undoing any closing/processing/settled batch.
CREATE OR REPLACE FUNCTION public.cancel_collecting_slip_batch(
  p_source_id text, p_sender_id text, p_event_ts_ms bigint
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_batch record;
BEGIN
  SELECT id, status, sender_id INTO v_batch
  FROM public.slip_batches
  WHERE source_id = p_source_id AND status IN ('collecting', 'closing')
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

  IF NOT FOUND THEN RETURN 'no_active'; END IF;
  IF p_sender_id IS NULL OR v_batch.sender_id IS NULL
      OR v_batch.sender_id <> p_sender_id THEN RETURN 'not_owner'; END IF;
  IF v_batch.status <> 'collecting' THEN RETURN 'already_closing'; END IF;

  UPDATE public.slip_batches SET
    status = 'cancelled',
    close_event_ts_ms = COALESCE(p_event_ts_ms,
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
  WHERE id = v_batch.id AND status = 'collecting';

  -- Deverify previously extracted checks. Raw images, amounts, reference IDs,
  -- and original status in extracted_json are retained for investigation.
  UPDATE public.slip_checks sc SET
    extracted_json = jsonb_set(
      COALESCE(sc.extracted_json, '{}'::jsonb),
      '{cancelled_batch_original_status}', to_jsonb(sc.status), true
    ),
    status = 'NEED_REVIEW'
  WHERE sc.evidence_id IN (
    SELECT ev.id FROM public.slip_evidences ev WHERE ev.batch_id = v_batch.id
  )
  AND sc.status IN ('EXTRACTED', 'PARTIAL_EXTRACTED');

  RETURN 'cancelled';
END;
$fn$;

REVOKE ALL ON FUNCTION public.cancel_collecting_slip_batch(text, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_collecting_slip_batch(text, text, bigint) TO service_role;
