-- 2026-09-15 incident hardening. Replaces the inactivity sweeps so a refusal stamp
-- from an older generation cannot strand the current generation forever.

-- Inactivity-based lifecycle for OPEN pending Produce sessions.
--
-- WHAT THIS IS
-- ------------
-- Today the finalize cron only ever sees a session that was already CLOSED
-- (a non-NULL next_attempt_at written by close/append). An open, idle draft
-- that nobody closed lives forever: it holds the operator's active-session
-- lock (see cancel-active-draft.ts / session-capture.ts) and is invisible to
-- every existing sweep, warning recovery included, because every one of
-- them requires a close boundary to have been written first.
--
-- Two new sweeps, both keyed off pending_sessions.updated_at (already bumped
-- by append_pending_session / admit-and-defer / open-or-rotate on every real
-- piece of operator content — see 0032, 20260815081954, 0049):
--
--   sweep_pending_session_inactivity_warnings   updated_at <= now() - 25m
--   sweep_pending_session_inactivity_expiry     updated_at <= now() - 30m
--
-- Both share the SAME eligibility filter as an open, un-closed, live draft:
--   terminalized = false
--   close_event_timestamp_ms IS NULL AND close_requested_at IS NULL
--     (a closed session belongs to the existing finalizer/close-recovery
--     sweeps — this migration never touches one)
--   next_attempt_at IS NULL
--   close_refused_at IS NULL   (P1-B recover_stranded_plain_text_closes owns
--     those; they must stay actionable through that path)
--   finalization_status = 'pending'
--   finalization_started_at IS NULL
--   finalize_hold_until IS NULL
--   runtime_environment scoped exactly like recover_stranded_plain_text_closes
--     / claim_due_produce_notifications (production also matches legacy NULL)
--
-- WARNING SWEEP
-- -------------
-- Claims `inactivity_warning_sent_at IS NULL OR inactivity_warning_sent_at
-- < updated_at`. That inequality is the entire re-arm mechanism: any new
-- item bumps updated_at (making the row not-yet-inactive again), which
-- makes the stamped inactivity_warning_sent_at read as stale-but-earlier
-- than the fresh updated_at, so once the row goes inactive again a NEW
-- warning is owed. No hot-path RPC (append_pending_session,
-- admit_pending_session_event, open-or-rotate) is touched.
--
-- Setting inactivity_warning_sent_at deliberately does NOT bump updated_at.
-- Verified against every migration touching public.pending_sessions
-- (0009, 0031, 0032, 0044, 0048, 0049, 20260815081954, 20260817090200,
-- 20260817090300, 20260818090000, 20260825090000): the only trigger on this
-- table is pending_sessions_deferred_finalization_guard (BEFORE UPDATE OF
-- finalization_status), which only raises on an unresolved deferred event —
-- it never writes updated_at. Every updated_at value in this table is set
-- explicitly by the RPC doing the write, never by a generic trigger, so an
-- UPDATE that omits updated_at from its SET list leaves it untouched. No
-- explicit "updated_at = updated_at" workaround is needed.
--
-- EXPIRY SWEEP
-- ------------
-- Classifies by accepted item count, using public.pending_session_admission
-- as the DB-side proxy for "items were accepted" — see the function comment
-- below for why that table (not a parsed item count) is the authoritative
-- source available in SQL for BOTH entry paths.
--
--   0 admissions   -> terminalized, finalization_status = 'expired_empty_draft'
--                     (NEW status; CHECK widened below). No produce writes,
--                     no finalize, accumulated_text and every other evidence
--                     column left untouched.
--   >=1 admissions -> terminalized, finalization_status = 'failed_closed'
--                     (EXISTING status, deliberately reused so the row stays
--                     outside RESOLVED_PENDING_STATUSES and action-required
--                     in Data Quality), finalization_error reason
--                     'expired_incomplete'.
--
-- Neither branch calls try_finalize_pending_generation, writes a produce
-- row, or touches the session's accountability round. Both release the
-- operator's active-session lock purely through terminalized = true.
--
-- SCHEMA DRIFT
-- ------------
-- Production is known to be ahead of this repo's migration history on
-- pending_sessions in places. This migration adds exactly one column
-- (IF NOT EXISTS, nullable, no backfill) and preflights on every other
-- column/table it reads rather than assuming presence.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.pending_sessions') IS NULL THEN
    RAISE EXCEPTION '20260829090000: required table public.pending_sessions is missing';
  END IF;
  IF to_regclass('public.pending_session_admission') IS NULL THEN
    RAISE EXCEPTION
      '20260829090000: required table public.pending_session_admission is missing (0042-era baseline absent)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pending_sessions'
      AND column_name = 'finalization_status'
  ) THEN
    RAISE EXCEPTION '20260829090000: pending_sessions.finalization_status is missing; apply 0034 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pending_sessions'
      AND column_name = 'finalization_started_at'
  ) THEN
    RAISE EXCEPTION '20260829090000: pending_sessions.finalization_started_at is missing; apply 0034 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pending_sessions'
      AND column_name = 'finalize_hold_until'
  ) THEN
    RAISE EXCEPTION '20260829090000: pending_sessions.finalize_hold_until is missing; apply 0050 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pending_sessions'
      AND column_name = 'close_refused_at'
  ) THEN
    RAISE EXCEPTION '20260829090000: pending_sessions.close_refused_at is missing; apply 20260817090200 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pending_sessions'
      AND column_name = 'runtime_environment'
  ) THEN
    RAISE EXCEPTION '20260829090000: pending_sessions.runtime_environment is missing; apply 0061 first';
  END IF;
END;
$preflight$;

-- ── 1) inactivity_warning_sent_at ────────────────────────────────────────────

ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS inactivity_warning_sent_at timestamptz;

COMMENT ON COLUMN public.pending_sessions.inactivity_warning_sent_at IS
  'Set by sweep_pending_session_inactivity_warnings when a LINE warning has been '
  'handed to the caller for this row. Re-armed implicitly: any activity bumps '
  'updated_at past this stamp, so the warning sweep claims the row again after a '
  'fresh 25-minute idle window. Never set together with updated_at.';

-- ── 2) widen finalization_status to admit 'expired_empty_draft' ─────────────
-- Dynamic lookup, not an assumed constraint name: production schema drift
-- means the inline CHECK added by 0034 may not carry Postgres's default
-- auto-generated name in every environment.

DO $widen$
DECLARE
  v_con name;
BEGIN
  SELECT c.conname INTO v_con
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'pending_sessions'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%finalization_status%';
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.pending_sessions DROP CONSTRAINT %I', v_con);
  END IF;
END;
$widen$;

ALTER TABLE public.pending_sessions
  ADD CONSTRAINT pending_sessions_finalization_status_check
  CHECK (finalization_status IN (
    'pending', 'processing', 'failed_closed', 'duplicate', 'finalized',
    'expired_empty_draft'
  ));

-- ── 3) warning sweep ─────────────────────────────────────────────────────────
--
-- P3 fix: the warning sweep had no upper bound, so a row already >= 30
-- minutes idle (expiry-eligible) could still receive the "5 minutes left"
-- push — factually wrong once expiry eligibility is reached, and possible
-- again on any later tick where the expiry sweep happened to skip the row.
-- p_expire_after is now a 4th parameter, matching the expiry sweep's own
-- parameter name and default, so both sweeps are configured from the same
-- pair of values by the caller.

-- Signature gained a 4th parameter (arity change) — CREATE OR REPLACE cannot
-- change arity, and any environment that already applied an earlier version
-- of this unmerged file must not be left with a stale 3-arg overload.
DROP FUNCTION IF EXISTS public.sweep_pending_session_inactivity_warnings(integer, text, interval);

CREATE OR REPLACE FUNCTION public.sweep_pending_session_inactivity_warnings(
  p_limit               integer,
  p_runtime_environment text,
  p_warn_after          interval DEFAULT interval '25 minutes',
  p_expire_after        interval DEFAULT interval '30 minutes'
) RETURNS TABLE (
  session_key         text,
  session_generation  uuid,
  line_user_id        text,
  source_id           text,
  updated_at          timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row public.pending_sessions%ROWTYPE;
BEGIN
  IF p_runtime_environment NOT IN ('production', 'preview', 'development') THEN
    RAISE EXCEPTION 'invalid runtime_environment: %', p_runtime_environment;
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.pending_sessions p
    WHERE p.terminalized = false
      AND p.close_event_timestamp_ms IS NULL
      AND p.close_requested_at IS NULL
      AND p.next_attempt_at IS NULL
      AND (p.close_refused_at IS NULL OR p.close_refused_session_generation IS DISTINCT FROM p.session_generation)
      AND p.finalization_status = 'pending'
      AND p.finalization_started_at IS NULL
      AND p.finalize_hold_until IS NULL
      AND p.updated_at <= clock_timestamp() - p_warn_after
      AND p.updated_at > clock_timestamp() - p_expire_after
      AND (p.inactivity_warning_sent_at IS NULL OR p.inactivity_warning_sent_at < p.updated_at)
      AND (
        (p_runtime_environment = 'production'
         AND (p.runtime_environment = 'production' OR p.runtime_environment IS NULL))
        OR p.runtime_environment = p_runtime_environment
      )
    ORDER BY p.updated_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)
  LOOP
    -- Re-check the claim predicate under the row lock. v_row already reflects
    -- the latest committed row at lock-acquisition time (Postgres re-fetches
    -- via EvalPlanQual when FOR UPDATE finds a concurrently modified row), so
    -- this is a readable, explicit guarantee rather than an implicit one: a
    -- concurrent append between the snapshot above and the lock being granted
    -- bumps updated_at, which this IF catches and skips.
    IF v_row.terminalized
       OR v_row.close_event_timestamp_ms IS NOT NULL
       OR v_row.close_requested_at IS NOT NULL
       OR v_row.next_attempt_at IS NOT NULL
       OR (v_row.close_refused_at IS NOT NULL AND v_row.close_refused_session_generation IS NOT DISTINCT FROM v_row.session_generation)
       OR v_row.finalization_status IS DISTINCT FROM 'pending'
       OR v_row.finalization_started_at IS NOT NULL
       OR v_row.finalize_hold_until IS NOT NULL
       OR v_row.updated_at > clock_timestamp() - p_warn_after
       OR v_row.updated_at <= clock_timestamp() - p_expire_after
       OR (v_row.inactivity_warning_sent_at IS NOT NULL
           AND v_row.inactivity_warning_sent_at >= v_row.updated_at)
    THEN
      CONTINUE;
    END IF;

    -- ponytail: the flag is set here, in the same sweep transaction that
    -- hands the row to the caller for a LINE push, not after a confirmed
    -- send. A push failure therefore costs at most one skipped advisory
    -- warning — re-armed by the next real activity, or superseded by the
    -- 30-minute expiry sweep — rather than risking a duplicate-warning storm
    -- from retrying a "did the push actually land" question. Advisory only,
    -- no financial impact.
    -- Table-qualified: this function's OUT parameters are named identically
    -- to the pending_sessions columns (session_key, session_generation), and
    -- an unqualified WHERE session_key = ... is ambiguous between the two.
    UPDATE public.pending_sessions ps
    SET inactivity_warning_sent_at = clock_timestamp()
    WHERE ps.session_key = v_row.session_key
      AND ps.session_generation = v_row.session_generation;

    session_key        := v_row.session_key;
    session_generation := v_row.session_generation;
    line_user_id        := v_row.line_user_id;
    source_id            := v_row.source_id;
    updated_at            := v_row.updated_at;
    RETURN NEXT;
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION public.sweep_pending_session_inactivity_warnings(integer, text, interval, interval) IS
  'Claims open, un-closed pending sessions idle for p_warn_after and stamps '
  'inactivity_warning_sent_at so the caller can push exactly one LINE warning per '
  'idle window. Never touches a closed, refused, or already-terminal row. Does not '
  'bump updated_at.';

-- ── 4) expiry sweep ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.sweep_pending_session_inactivity_expiry(
  p_limit               integer,
  p_runtime_environment text,
  p_expire_after        interval DEFAULT interval '30 minutes'
) RETURNS TABLE (
  session_key              text,
  session_generation       uuid,
  line_user_id             text,
  source_id                text,
  accountability_round_id  uuid,
  outcome                  text,
  accepted_item_count      integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row             public.pending_sessions%ROWTYPE;
  v_admission_count integer;
  v_outcome         text;
BEGIN
  IF p_runtime_environment NOT IN ('production', 'preview', 'development') THEN
    RAISE EXCEPTION 'invalid runtime_environment: %', p_runtime_environment;
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.pending_sessions p
    WHERE p.terminalized = false
      AND p.close_event_timestamp_ms IS NULL
      AND p.close_requested_at IS NULL
      AND p.next_attempt_at IS NULL
      AND (p.close_refused_at IS NULL OR p.close_refused_session_generation IS DISTINCT FROM p.session_generation)
      AND p.finalization_status = 'pending'
      AND p.finalization_started_at IS NULL
      AND p.finalize_hold_until IS NULL
      AND p.updated_at <= clock_timestamp() - p_expire_after
      AND (
        (p_runtime_environment = 'production'
         AND (p.runtime_environment = 'production' OR p.runtime_environment IS NULL))
        OR p.runtime_environment = p_runtime_environment
      )
    ORDER BY p.updated_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)
  LOOP
    -- Re-check under the lock: this is what prevents expiring a session that
    -- just became active at the boundary (a concurrent append between the
    -- snapshot above and lock acquisition bumps updated_at, which this IF
    -- catches and skips — see the warning sweep's comment for why v_row is
    -- already the post-lock row).
    IF v_row.terminalized
       OR v_row.close_event_timestamp_ms IS NOT NULL
       OR v_row.close_requested_at IS NOT NULL
       OR v_row.next_attempt_at IS NOT NULL
       OR (v_row.close_refused_at IS NOT NULL AND v_row.close_refused_session_generation IS NOT DISTINCT FROM v_row.session_generation)
       OR v_row.finalization_status IS DISTINCT FROM 'pending'
       OR v_row.finalization_started_at IS NOT NULL
       OR v_row.finalize_hold_until IS NOT NULL
       OR v_row.updated_at > clock_timestamp() - p_expire_after
    THEN
      CONTINUE;
    END IF;

    -- Authoritative accepted-item count. Neither entry path persists a
    -- database-visible PARSED item list before finalization — parsing lives
    -- in TypeScript and only reaches SQL as try_finalize_pending_generation's
    -- p_items jsonb argument (0050_produce_finalization_hold.sql), which this
    -- sweep must never call (no produce writes, no round retirement). So
    -- there is no exact item count available in SQL, and this uses the same
    -- DB-side proxy check_pending_close_ready already relies on for parity:
    -- public.pending_session_admission. Every accepted LINE event, on BOTH
    -- entry paths, gets exactly one admission row inserted by
    -- append_pending_session before accumulated_text is touched (0032,
    -- reused by the plain-text reorder path in 20260815081954). A typed
    -- structured OPEN command deliberately inserts none (0049's
    -- postback-control-event rule: a typed open is control, not content), so
    -- admission count is zero exactly when no real operator item content was
    -- ever accepted for this generation — true for plain-text and structured
    -- sessions alike.
    SELECT count(*)::integer INTO v_admission_count
    FROM public.pending_session_admission a
    WHERE a.session_key = v_row.session_key
      AND a.session_generation = v_row.session_generation;

    -- Table-qualified for the same reason as the warning sweep above: the OUT
    -- parameters session_key/session_generation shadow the plain column names.
    IF v_admission_count = 0 THEN
      v_outcome := 'expired_empty_draft';
      UPDATE public.pending_sessions ps
      SET terminalized = true,
          next_attempt_at = NULL,
          finalized_at = clock_timestamp(),
          finalization_status = 'expired_empty_draft',
          finalization_error = COALESCE(v_row.finalization_error, '{}'::jsonb) || jsonb_build_object(
            'reason', 'inactivity_expired_empty',
            'accepted_item_count', v_admission_count,
            'inactive_since', v_row.updated_at,
            'expired_at', clock_timestamp()
          )
      WHERE ps.session_key = v_row.session_key
        AND ps.session_generation = v_row.session_generation;
    ELSE
      v_outcome := 'failed_closed';
      UPDATE public.pending_sessions ps
      SET terminalized = true,
          next_attempt_at = NULL,
          finalized_at = clock_timestamp(),
          finalization_status = 'failed_closed',
          finalization_error = COALESCE(v_row.finalization_error, '{}'::jsonb) || jsonb_build_object(
            'reason', 'expired_incomplete',
            'accepted_item_count', v_admission_count,
            'inactive_since', v_row.updated_at,
            'expired_at', clock_timestamp()
          )
      WHERE ps.session_key = v_row.session_key
        AND ps.session_generation = v_row.session_generation;
    END IF;

    session_key             := v_row.session_key;
    session_generation      := v_row.session_generation;
    line_user_id             := v_row.line_user_id;
    source_id                := v_row.source_id;
    accountability_round_id  := v_row.accountability_round_id;
    outcome                  := v_outcome;
    accepted_item_count      := v_admission_count;
    RETURN NEXT;
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION public.sweep_pending_session_inactivity_expiry(integer, text, interval) IS
  'Terminalizes open, un-closed pending sessions idle for p_expire_after. Zero '
  'admitted items -> expired_empty_draft (new, resolved status, no evidence '
  'deleted). One or more -> failed_closed/expired_incomplete (existing status, '
  'stays action-required). Never calls try_finalize_pending_generation, writes no '
  'produce row, and never touches the session''s accountability round.';

-- ── 5) grants ─────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.sweep_pending_session_inactivity_warnings(integer, text, interval, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_pending_session_inactivity_warnings(integer, text, interval, interval)
  TO service_role;

REVOKE ALL ON FUNCTION public.sweep_pending_session_inactivity_expiry(integer, text, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_pending_session_inactivity_expiry(integer, text, interval)
  TO service_role;

COMMIT;
