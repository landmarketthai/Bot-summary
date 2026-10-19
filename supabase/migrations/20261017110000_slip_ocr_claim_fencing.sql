-- P1 #4: atomic OCR claim + fencing token for slip_checks.
--
-- Before: SlipCheckService upserted PROCESSING over any existing slip_checks
-- row and later wrote the extraction / FAILED by check id alone. A redrive, a
-- duplicate queue delivery or a stale worker could therefore overwrite a
-- SUCCESSFUL check, including after the batch was finalized.
--
-- Now every OCR worker must first win claim_slip_check(): it inserts a
-- PROCESSING row, or re-claims ONLY a PROCESSING row whose lease expired, and
-- returns a fencing token (claim_token, bumped on every claim). The terminal
-- write (complete_slip_check / fail_slip_check) updates only when the token
-- matches, the lease is still valid, the row is still PROCESSING and (for
-- batched evidence) the batch is still collecting/closing. Terminal checks
-- (EXTRACTED / PARTIAL_EXTRACTED / NEED_REVIEW / FAILED) are never touched.
-- Un-batched single slips (batch_id NULL) follow the same rules without the
-- batch guard.
--
-- Additive and idempotent. Lock order is batch -> check everywhere.

BEGIN;

ALTER TABLE public.slip_checks
  ADD COLUMN IF NOT EXISTS claim_token integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz;

COMMENT ON COLUMN public.slip_checks.claim_token IS
  'Fencing token: bumped by claim_slip_check on every claim. complete/fail must present the current value.';
COMMENT ON COLUMN public.slip_checks.lease_until IS
  'OCR worker lease. A PROCESSING check may be re-claimed only after this passes (NULL = legacy row, reclaimable).';

-- ── claim ─────────────────────────────────────────────────────────────────────
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
    -- Share-lock the batch so finalization (which updates it) cannot interleave
    -- between this check and the claim write.
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

-- ── complete ──────────────────────────────────────────────────────────────────
-- p_fields carries the extraction columns; absent keys become NULL.
CREATE OR REPLACE FUNCTION public.complete_slip_check(
  p_check_id uuid,
  p_token    integer,
  p_status   text,
  p_fields   jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_batch_id uuid;
  v_bstatus  text;
  v_check    public.slip_checks%ROWTYPE;
BEGIN
  IF p_status NOT IN ('EXTRACTED', 'PARTIAL_EXTRACTED', 'NEED_REVIEW') THEN
    RAISE EXCEPTION 'complete_slip_check: invalid terminal status %', p_status;
  END IF;

  SELECT se.batch_id INTO v_batch_id
    FROM public.slip_checks sc JOIN public.slip_evidences se ON se.id = sc.evidence_id
   WHERE sc.id = p_check_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_batch_id IS NOT NULL THEN
    SELECT b.status INTO v_bstatus FROM public.slip_batches b WHERE b.id = v_batch_id FOR SHARE;
    IF v_bstatus IS NULL OR v_bstatus NOT IN ('collecting', 'closing') THEN
      RETURN jsonb_build_object('outcome', 'batch_not_open', 'batch_status', v_bstatus);
    END IF;
  END IF;

  UPDATE public.slip_checks sc
     SET status = p_status,
         slip_type = COALESCE(p_fields->>'slip_type', 'UNKNOWN'),
         gross_amount = (p_fields->>'gross_amount')::numeric,
         discount_amount = (p_fields->>'discount_amount')::numeric,
         paid_amount = (p_fields->>'paid_amount')::numeric,
         transfer_amount = (p_fields->>'transfer_amount')::numeric,
         reference_id = p_fields->>'reference_id',
         transaction_time = (p_fields->>'transaction_time')::timestamptz,
         sender_name = p_fields->>'sender_name',
         receiver_name = p_fields->>'receiver_name',
         receiver_account_tail = p_fields->>'receiver_account_tail',
         confidence = (p_fields->>'confidence')::numeric,
         extracted_json = p_fields->'extracted_json',
         failure_reason = NULL,
         lease_until = NULL
   WHERE sc.id = p_check_id
     AND sc.claim_token = p_token
     AND sc.status = 'PROCESSING'
     AND sc.lease_until IS NOT NULL
     AND sc.lease_until >= now();

  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'completed');
  END IF;

  SELECT * INTO v_check FROM public.slip_checks WHERE id = p_check_id;
  IF v_check.status <> 'PROCESSING' THEN
    RETURN jsonb_build_object('outcome', 'already_terminal', 'status', v_check.status);
  END IF;
  RETURN jsonb_build_object('outcome', 'stale_claim');
END;
$fn$;

-- ── fail ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fail_slip_check(
  p_check_id uuid,
  p_token    integer,
  p_reason   text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_batch_id uuid;
  v_bstatus  text;
  v_check    public.slip_checks%ROWTYPE;
BEGIN
  SELECT se.batch_id INTO v_batch_id
    FROM public.slip_checks sc JOIN public.slip_evidences se ON se.id = sc.evidence_id
   WHERE sc.id = p_check_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_batch_id IS NOT NULL THEN
    SELECT b.status INTO v_bstatus FROM public.slip_batches b WHERE b.id = v_batch_id FOR SHARE;
    IF v_bstatus IS NULL OR v_bstatus NOT IN ('collecting', 'closing') THEN
      RETURN jsonb_build_object('outcome', 'batch_not_open', 'batch_status', v_bstatus);
    END IF;
  END IF;

  UPDATE public.slip_checks sc
     SET status = 'FAILED',
         failure_reason = left(coalesce(nullif(btrim(p_reason), ''), 'unknown_extraction_failure'), 80),
         lease_until = NULL
   WHERE sc.id = p_check_id
     AND sc.claim_token = p_token
     AND sc.status = 'PROCESSING'
     AND sc.lease_until IS NOT NULL
     AND sc.lease_until >= now();

  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'failed');
  END IF;

  SELECT * INTO v_check FROM public.slip_checks WHERE id = p_check_id;
  IF v_check.status <> 'PROCESSING' THEN
    RETURN jsonb_build_object('outcome', 'already_terminal', 'status', v_check.status);
  END IF;
  RETURN jsonb_build_object('outcome', 'stale_claim');
END;
$fn$;

-- ── redrive list: honour the lease ────────────────────────────────────────────
-- Same signature as the ledger migration. A PROCESSING check is re-driven only
-- once its lease has expired (legacy rows without a lease: 5 minutes stale).
CREATE OR REPLACE FUNCTION public.list_slip_ocr_redrive(
  p_limit integer DEFAULT 10
) RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT ev.evidence_id
    FROM public.slip_image_events ev
    JOIN public.slip_batches b ON b.id = ev.batch_id
    LEFT JOIN public.slip_checks sc ON sc.evidence_id = ev.evidence_id
   WHERE ev.state = 'attached'
     AND b.status IN ('collecting', 'closing')
     AND (
       (sc.id IS NULL AND ev.resolved_at < now() - interval '90 seconds')
       OR (sc.status = 'PROCESSING' AND (
             (sc.lease_until IS NOT NULL AND sc.lease_until < now())
          OR (sc.lease_until IS NULL AND sc.updated_at < now() - interval '5 minutes')))
     )
   -- Fair: least-claimed first, so a job that keeps timing out cannot take a
   -- redrive lane every sweep ahead of evidence that was never tried.
   ORDER BY COALESCE(sc.claim_token, 0), ev.resolved_at, ev.evidence_id
   LIMIT greatest(1, least(coalesce(p_limit, 10), 50));
$fn$;

REVOKE ALL ON FUNCTION public.claim_slip_check(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_slip_check(uuid, integer, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_slip_check(uuid, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_slip_ocr_redrive(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_slip_check(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_slip_check(uuid, integer, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_slip_check(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_slip_ocr_redrive(integer) TO service_role;

COMMIT;
