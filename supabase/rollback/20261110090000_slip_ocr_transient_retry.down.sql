-- Rollback of 20261110090000_slip_ocr_transient_retry.sql.
--
-- Roll back the APPLICATION first (or together): code without defer_slip_check
-- support fails transient errors closed again. App code that still calls
-- defer_slip_check after this rollback gets "function missing" and fails the
-- check closed (FAILED), so nothing is counted either way.
--
-- Deferred checks still PROCESSING are ended as FAILED with their original
-- transient reason, so the restored claim cannot silently re-run them.

BEGIN;

UPDATE public.slip_checks
   SET status = 'FAILED',
       failure_reason = left(substr(failure_reason, length('ocr_retry:') + 1), 80),
       lease_until = NULL
 WHERE status = 'PROCESSING'
   AND failure_reason LIKE 'ocr_retry:%';

DROP FUNCTION IF EXISTS public.defer_slip_check(uuid, integer, text, integer, boolean);
DROP TABLE IF EXISTS public.slip_ocr_provider_cooldown;

-- Restore claim_slip_check exactly as in 20261017110000.
CREATE OR REPLACE FUNCTION public.claim_slip_check(
  p_evidence_id   uuid,
  p_lease_seconds integer DEFAULT 300
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_batch_id uuid;
  v_status   text;
  v_check    public.slip_checks%ROWTYPE;
  v_lease    interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 1));
BEGIN
  SELECT se.batch_id INTO v_batch_id
    FROM public.slip_evidences se WHERE se.id = p_evidence_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'evidence_not_found');
  END IF;

  IF v_batch_id IS NOT NULL THEN
    SELECT b.status INTO v_status FROM public.slip_batches b WHERE b.id = v_batch_id FOR SHARE;
    IF v_status IS NULL OR v_status NOT IN ('collecting', 'closing') THEN
      RETURN jsonb_build_object('claimed', false, 'reason', 'batch_not_open', 'batch_status', v_status);
    END IF;
  END IF;

  INSERT INTO public.slip_checks AS sc (evidence_id, status, slip_type, failure_reason, claim_token, lease_until)
  VALUES (p_evidence_id, 'PROCESSING', 'UNKNOWN', NULL, 1, now() + v_lease)
  ON CONFLICT (evidence_id) DO UPDATE
     SET claim_token = sc.claim_token + 1,
         lease_until = now() + v_lease,
         failure_reason = NULL
   WHERE sc.status = 'PROCESSING'
     AND (sc.lease_until IS NULL OR sc.lease_until < now())
  RETURNING * INTO v_check;

  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true, 'check_id', v_check.id, 'token', v_check.claim_token);
  END IF;

  SELECT * INTO v_check FROM public.slip_checks WHERE evidence_id = p_evidence_id;
  IF v_check.status = 'PROCESSING' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'leased', 'check_id', v_check.id);
  END IF;
  RETURN jsonb_build_object('claimed', false, 'reason', 'terminal', 'status', v_check.status,
                            'check_id', v_check.id);
END;
$fn$;

REVOKE ALL ON FUNCTION public.claim_slip_check(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_slip_check(uuid, integer) TO service_role;

ALTER TABLE public.slip_checks
  DROP COLUMN IF EXISTS ocr_retry_count,
  DROP COLUMN IF EXISTS ocr_retry_first_at;

COMMIT;
