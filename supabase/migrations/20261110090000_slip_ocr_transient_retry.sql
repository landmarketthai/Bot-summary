-- Durable, bounded retry of TRANSIENT Gemini slip OCR failures (HTTP 429,
-- 5xx, timeout). No new queue: a deferred check simply stays PROCESSING with
-- its fencing token bumped and lease_until moved to the next retry time, so
-- the existing machinery drives the retry:
--
--   * claim_slip_check refuses it until lease_until passes (= the backoff);
--   * list_slip_ocr_redrive lists it once the lease passes (cron redrive);
--   * claim_closing_slip_batch's OCR gate keeps the batch open while it is
--     PROCESSING, but ONLY for the existing bounded OCR wait
--     (450 s + 420 s per 10 images). That wait is NOT extended here. A retry
--     that is not due before it never runs: the batch is force-finalized, the
--     check stays PROCESSING with failure_reason 'ocr_retry:<code>' (the
--     summary says so, nothing is counted), and every later claim/complete is
--     refused with batch_not_open. No retroactive money change after close.
--
-- defer_slip_check is the only writer of the retry state. It is fenced like
-- fail_slip_check (token + live lease + PROCESSING + batch collecting/closing)
-- and decides atomically between "deferred" and terminal FAILED:
--   * un-batched evidence (batch_id NULL) has no redrive -> FAILED;
--   * more than 4 deferrals (5 provider attempts) -> FAILED;
--   * next retry later than 24 h after the first transient failure -> FAILED;
--   * claim_slip_check also turns a due deferred check older than 24 h into
--     FAILED instead of re-claiming it.
-- Backoff after counted failure n: min(60 * 2^(n-1), 600) s, never shorter
-- than Retry-After (capped at 3600 s). Mirrored in ingest-policy.ts
-- (SLIP_INGEST_POLICY.ocr.transientRetry; ingest-policy.test.ts checks it).
--
-- Shared provider cooldown: a real 429 sets slip_ocr_provider_cooldown
-- ('gemini') to now() + max(Retry-After, 60 s). claim_slip_check returns it,
-- and the worker defers WITHOUT calling Gemini while it is active (such a
-- deferral is not counted as an attempt; the 24 h age bound still applies).
--
-- Additive and idempotent. Lock order stays batch -> check. All new/changed
-- functions are SECURITY DEFINER and service_role only.

BEGIN;

ALTER TABLE public.slip_checks
  ADD COLUMN IF NOT EXISTS ocr_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ocr_retry_first_at timestamptz;

COMMENT ON COLUMN public.slip_checks.ocr_retry_count IS
  'Transient OCR provider failures counted by defer_slip_check (cooldown skips are not counted).';
COMMENT ON COLUMN public.slip_checks.ocr_retry_first_at IS
  'First transient OCR deferral. Retries end 24 h after it.';

CREATE TABLE IF NOT EXISTS public.slip_ocr_provider_cooldown (
  provider       text PRIMARY KEY,
  cooldown_until timestamptz NOT NULL,
  last_reason    text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.slip_ocr_provider_cooldown IS
  'Cross-instance slip OCR provider cooldown after HTTP 429. Written only by defer_slip_check.';
ALTER TABLE public.slip_ocr_provider_cooldown ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.slip_ocr_provider_cooldown FROM PUBLIC, anon, authenticated;

-- ── claim (same signature; adds 24 h expiry + cooldown in the result) ────────
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
  v_cooldown timestamptz;
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

  -- A due deferred retry past the 24 h safety age ends as FAILED with its
  -- original transient reason instead of being claimed again.
  UPDATE public.slip_checks sc
     SET status = 'FAILED',
         failure_reason = left(substr(sc.failure_reason, length('ocr_retry:') + 1), 80),
         lease_until = NULL
   WHERE sc.evidence_id = p_evidence_id
     AND sc.status = 'PROCESSING'
     AND sc.failure_reason LIKE 'ocr_retry:%'
     AND sc.ocr_retry_first_at < now() - interval '24 hours'
     AND (sc.lease_until IS NULL OR sc.lease_until < now());

  INSERT INTO public.slip_checks AS sc (evidence_id, status, slip_type, failure_reason, claim_token, lease_until)
  VALUES (p_evidence_id, 'PROCESSING', 'UNKNOWN', NULL, 1, now() + v_lease)
  ON CONFLICT (evidence_id) DO UPDATE
     SET claim_token = sc.claim_token + 1,
         lease_until = now() + v_lease,
         -- Keep the retry marker while a deferred check is re-run, so a forced
         -- close mid-retry still reports it as a transient OCR failure.
         failure_reason = CASE WHEN sc.failure_reason LIKE 'ocr_retry:%' THEN sc.failure_reason END
   WHERE sc.status = 'PROCESSING'
     AND (sc.lease_until IS NULL OR sc.lease_until < now())
  RETURNING * INTO v_check;

  IF FOUND THEN
    SELECT c.cooldown_until INTO v_cooldown
      FROM public.slip_ocr_provider_cooldown c
     WHERE c.provider = 'gemini' AND c.cooldown_until > now();
    RETURN jsonb_build_object('claimed', true, 'check_id', v_check.id, 'token', v_check.claim_token,
                              'retry_count', v_check.ocr_retry_count,
                              'provider_cooldown_until', v_cooldown);
  END IF;

  SELECT * INTO v_check FROM public.slip_checks WHERE evidence_id = p_evidence_id;
  IF v_check.status = 'PROCESSING' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'leased', 'check_id', v_check.id);
  END IF;
  RETURN jsonb_build_object('claimed', false, 'reason', 'terminal', 'status', v_check.status,
                            'check_id', v_check.id);
END;
$fn$;

-- ── defer ─────────────────────────────────────────────────────────────────────
-- p_reason: the transient failure code (e.g. extractor_http_rate_limit).
-- p_retry_after_seconds: provider Retry-After or remaining cooldown (NULL = none).
-- p_count_attempt: false when no provider call was made (cooldown skip).
CREATE OR REPLACE FUNCTION public.defer_slip_check(
  p_check_id            uuid,
  p_token               integer,
  p_reason              text,
  p_retry_after_seconds integer DEFAULT NULL,
  p_count_attempt       boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  c_max_retries  constant integer := 4;
  c_base         constant integer := 60;
  c_cap          constant integer := 600;
  c_retry_after  constant integer := 3600;
  c_max_age      constant interval := interval '24 hours';
  c_cooldown_min constant integer := 60;
  v_reason   text := left(coalesce(nullif(btrim(p_reason), ''), 'unknown_extraction_failure'), 60);
  v_ra       integer := least(greatest(coalesce(p_retry_after_seconds, 0), 0), c_retry_after);
  v_batch_id uuid;
  v_bstatus  text;
  v_check    public.slip_checks%ROWTYPE;
  v_count    integer;
  v_first    timestamptz;
  v_delay    integer;
  v_why      text;
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

  SELECT * INTO v_check FROM public.slip_checks WHERE id = p_check_id FOR UPDATE;
  IF v_check.status <> 'PROCESSING' THEN
    RETURN jsonb_build_object('outcome', 'already_terminal', 'status', v_check.status);
  END IF;
  IF v_check.claim_token <> p_token OR v_check.lease_until IS NULL OR v_check.lease_until < now() THEN
    RETURN jsonb_build_object('outcome', 'stale_claim');
  END IF;

  -- Only a provider-confirmed 429 cools the provider down for every worker.
  IF p_count_attempt AND v_reason = 'extractor_http_rate_limit' THEN
    INSERT INTO public.slip_ocr_provider_cooldown AS c (provider, cooldown_until, last_reason, updated_at)
    VALUES ('gemini', now() + make_interval(secs => greatest(v_ra, c_cooldown_min)), v_reason, now())
    ON CONFLICT (provider) DO UPDATE
       SET cooldown_until = greatest(c.cooldown_until, EXCLUDED.cooldown_until),
           last_reason = EXCLUDED.last_reason,
           updated_at = now();
  END IF;

  v_count := v_check.ocr_retry_count + CASE WHEN p_count_attempt THEN 1 ELSE 0 END;
  v_first := coalesce(v_check.ocr_retry_first_at, now());
  v_delay := greatest(v_ra, least(c_base * (2 ^ (greatest(v_count, 1) - 1))::integer, c_cap));

  v_why := CASE
    WHEN v_batch_id IS NULL THEN 'unbatched'
    WHEN v_count > c_max_retries THEN 'max_attempts'
    WHEN now() + make_interval(secs => v_delay) > v_first + c_max_age THEN 'max_age'
  END;

  IF v_why IS NOT NULL THEN
    UPDATE public.slip_checks
       SET status = 'FAILED', failure_reason = v_reason, lease_until = NULL,
           ocr_retry_count = v_count, ocr_retry_first_at = v_first
     WHERE id = p_check_id;
    RETURN jsonb_build_object('outcome', 'failed', 'reason', v_why, 'retry_count', v_count);
  END IF;

  -- Bumping the token fences the deferring worker; nobody holds the new token
  -- until claim_slip_check re-claims after lease_until.
  UPDATE public.slip_checks
     SET claim_token = claim_token + 1,
         lease_until = now() + make_interval(secs => v_delay),
         failure_reason = 'ocr_retry:' || v_reason,
         ocr_retry_count = v_count,
         ocr_retry_first_at = v_first
   WHERE id = p_check_id;
  RETURN jsonb_build_object('outcome', 'deferred', 'retry_count', v_count,
                            'retry_at', now() + make_interval(secs => v_delay), 'delay_seconds', v_delay);
END;
$fn$;

REVOKE ALL ON FUNCTION public.claim_slip_check(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.defer_slip_check(uuid, integer, text, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_slip_check(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.defer_slip_check(uuid, integer, text, integer, boolean) TO service_role;

COMMIT;
