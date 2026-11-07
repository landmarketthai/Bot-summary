-- Shared, cross-instance request permits for rate-limited AI providers
-- (first user: Gemini slip OCR on the free tier, 15 RPM / 500 RPD per project).
--
-- Up to 10 OCR lanes on separate Vercel instances share one API key, so an
-- in-memory limiter cannot keep the project under quota. Every HTTP attempt
-- (retries included) must first win acquire_ai_provider_permit().
--
-- Semantics:
--   * Rolling minute: grants are counted in per-second buckets
--     (window_kind 'second', window_start = date_trunc('second', now)). A
--     request is admitted only if the buckets overlapping the last 60 s hold
--     fewer than p_rpm grants. "Overlapping" means window_start > now - 61 s:
--     a bucket covers [start, start + 1 s), so this counts every grant made in
--     (now - 60 s, now]. Guarantee: in ANY 60 s interval, grants <= p_rpm.
--     The cost is up to 1 s of extra conservatism, never a burst.
--   * Day: Gemini daily quotas reset at midnight America/Los_Angeles, so the
--     day window starts there (DST-aware via AT TIME ZONE).
--   * A permit increments BOTH the second bucket and the day window, or
--     NEITHER. A denial consumes nothing.
--   * Serialized per provider by pg_advisory_xact_lock, so concurrent callers
--     can never overshoot p_rpm / p_rpd.
--
-- Additive and idempotent: one new table + one function, no other schema.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_provider_rate_window (
  provider      text        NOT NULL,
  window_kind   text        NOT NULL CHECK (window_kind IN ('second', 'day')),
  window_start  timestamptz NOT NULL,
  request_count integer     NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (provider, window_kind, window_start)
);

COMMENT ON TABLE public.ai_provider_rate_window IS
  'Per-provider request counters (second = 1 s bucket of the rolling 60 s window, day = America/Los_Angeles day). Written only by acquire_ai_provider_permit.';

ALTER TABLE public.ai_provider_rate_window ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_provider_rate_window FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.acquire_ai_provider_permit(
  p_provider text,
  p_rpm      integer,
  p_rpd      integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_tz         constant text := 'America/Los_Angeles';
  v_now        timestamptz;
  v_second     timestamptz;
  v_day        timestamptz;
  v_next_day   timestamptz;
  v_rpm_used   integer;
  v_rpm_oldest timestamptz;
  v_rpd_used   integer;
BEGIN
  IF p_provider IS NULL OR btrim(p_provider) = '' OR p_rpm IS NULL OR p_rpm < 1
     OR p_rpd IS NULL OR p_rpd < 1 THEN
    RAISE EXCEPTION 'acquire_ai_provider_permit: invalid arguments'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ai_provider_rate_window:' || p_provider));

  -- Read the clock AFTER the lock: a caller that queued behind others must be
  -- judged against the window as it is when it actually takes the permit.
  v_now      := clock_timestamp();
  v_second   := date_trunc('second', v_now);
  v_day      := date_trunc('day', v_now AT TIME ZONE v_tz) AT TIME ZONE v_tz;
  v_next_day := (date_trunc('day', v_now AT TIME ZONE v_tz) + interval '1 day') AT TIME ZONE v_tz;

  SELECT coalesce(sum(request_count), 0), min(window_start)
    INTO v_rpm_used, v_rpm_oldest
    FROM public.ai_provider_rate_window
   WHERE provider = p_provider
     AND window_kind = 'second'
     AND window_start > v_now - interval '61 seconds';

  SELECT coalesce(max(request_count), 0)
    INTO v_rpd_used
    FROM public.ai_provider_rate_window
   WHERE provider = p_provider AND window_kind = 'day' AND window_start = v_day;

  -- Day first: no point waiting for the rolling minute when the day is spent.
  IF v_rpd_used >= p_rpd THEN
    RETURN jsonb_build_object(
      'granted', false, 'reason', 'rpd',
      'retry_after_ms', greatest(ceil(extract(epoch FROM v_next_day - v_now) * 1000), 1)::integer);
  END IF;
  IF v_rpm_used >= p_rpm THEN
    -- The oldest contributing bucket stops counting once start + 61 s passes.
    RETURN jsonb_build_object(
      'granted', false, 'reason', 'rpm',
      'retry_after_ms', greatest(ceil(extract(epoch FROM v_rpm_oldest + interval '61 seconds' - v_now) * 1000), 1)::integer);
  END IF;

  INSERT INTO public.ai_provider_rate_window AS w (provider, window_kind, window_start, request_count)
  VALUES (p_provider, 'second', v_second, 1),
         (p_provider, 'day',    v_day,    1)
  ON CONFLICT (provider, window_kind, window_start)
  DO UPDATE SET request_count = w.request_count + 1;

  -- Opportunistic cleanup (PK-indexed, a handful of rows per call).
  DELETE FROM public.ai_provider_rate_window
   WHERE provider = p_provider
     AND ((window_kind = 'second' AND window_start < v_now - interval '1 hour')
       OR (window_kind = 'day'    AND window_start < v_now - interval '40 days'));

  RETURN jsonb_build_object('granted', true, 'reason', 'ok', 'retry_after_ms', 0);
END;
$fn$;

COMMENT ON FUNCTION public.acquire_ai_provider_permit(text, integer, integer) IS
  'Atomically reserve one request against the rolling 60 s window (<= p_rpm in any 60 s) and the LA-day window of a provider. Returns {granted, reason: ok|rpm|rpd, retry_after_ms}.';

REVOKE ALL ON FUNCTION public.acquire_ai_provider_permit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_ai_provider_permit(text, integer, integer) TO service_role;

COMMIT;
