-- P0 (2026-10-08): never let a generation rotation erase unresolved Produce evidence.
--
-- pending_sessions holds ONE row per session_key (LINE group + user). When the
-- same user sends their next header, open_pending_plain_text_generation
-- (20260924090000) rotates that row IN PLACE: accumulated_text, finalization
-- status/error and accountability_round_id are overwritten. A ชั่งคืน the
-- finalizer refused (failed_closed) is exactly the evidence Sales, the Daily
-- Close preflight, the White Sheet and Settlement read to avoid reporting the
-- round as sold out — and the seller's next morning เบิก wiped it before the
-- 08:00 reports ran.
--
-- This migration only KEEPS evidence. It changes no RPC, no status and no
-- business row: an AFTER UPDATE trigger copies the retiring generation into an
-- append-only table whenever session_generation changes while that generation
-- was not resolved ('finalized' / 'duplicate' / 'expired_empty_draft', the
-- same set as RESOLVED_PENDING_STATUSES in src/lib/produce/round-return-status.ts).
-- Which retired generations count as an active failure is decided by the
-- read path, not here, so the audit trail stays complete.
--
-- Rollback: DROP TRIGGER pending_sessions_retain_unresolved_generation ON
-- public.pending_sessions; the table may be kept as audit history.

BEGIN;

CREATE TABLE IF NOT EXISTS public.pending_session_retired_generations (
  session_generation        uuid PRIMARY KEY,
  session_key               text NOT NULL,
  source_id                 text,
  line_user_id              text,
  accumulated_text          text NOT NULL,
  finalization_status       text,
  finalization_error        jsonb,
  accountability_round_id   uuid,
  business_date             date,
  staff_label               text,
  market_label              text,
  declared_transaction_type text,
  generation_created_at     timestamptz,
  close_requested_at        timestamptz,
  -- Only a refusal stamped for THIS generation (close_refused_session_generation).
  close_refused_at          timestamptz,
  retired_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_session_retired_generations_session_key_idx
  ON public.pending_session_retired_generations (session_key);

ALTER TABLE public.pending_session_retired_generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pending_session_retired_generations FROM PUBLIC;
REVOKE ALL ON TABLE public.pending_session_retired_generations FROM anon, authenticated;
-- Supabase grants service_role ALL on new public tables; reports only read.
REVOKE ALL ON TABLE public.pending_session_retired_generations FROM service_role;
GRANT SELECT ON TABLE public.pending_session_retired_generations TO service_role;

CREATE OR REPLACE FUNCTION public.pending_sessions_retain_unresolved_generation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(OLD.finalization_status, 'pending')
       NOT IN ('finalized', 'duplicate', 'expired_empty_draft')
     AND btrim(COALESCE(OLD.accumulated_text, '')) <> '' THEN
    INSERT INTO public.pending_session_retired_generations (
      session_generation, session_key, source_id, line_user_id, accumulated_text,
      finalization_status, finalization_error, accountability_round_id,
      business_date, staff_label, market_label, declared_transaction_type,
      generation_created_at, close_requested_at, close_refused_at
    ) VALUES (
      OLD.session_generation, OLD.session_key, OLD.source_id, OLD.line_user_id,
      OLD.accumulated_text, OLD.finalization_status, OLD.finalization_error,
      OLD.accountability_round_id, OLD.business_date, OLD.staff_label,
      OLD.market_label, OLD.declared_transaction_type, OLD.created_at,
      OLD.close_requested_at,
      CASE WHEN OLD.close_refused_session_generation = OLD.session_generation
           THEN OLD.close_refused_at END
    )
    ON CONFLICT (session_generation) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.pending_sessions_retain_unresolved_generation() FROM PUBLIC;

DROP TRIGGER IF EXISTS pending_sessions_retain_unresolved_generation ON public.pending_sessions;
CREATE TRIGGER pending_sessions_retain_unresolved_generation
  AFTER UPDATE OF session_generation ON public.pending_sessions
  FOR EACH ROW
  WHEN (OLD.session_generation IS NOT NULL
        AND OLD.session_generation IS DISTINCT FROM NEW.session_generation)
  EXECUTE FUNCTION public.pending_sessions_retain_unresolved_generation();

COMMIT;
