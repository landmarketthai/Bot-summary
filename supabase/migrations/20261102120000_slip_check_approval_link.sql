-- Manual approval of an AI slip check, and an optional reference on manual
-- slip entries — so one transfer is counted ONCE across AI and manual paths.
--
-- Why: a manual_slip_entries row stores only an amount. When an operator
-- re-keyed a slip the AI had already counted, checked_slip_total counted it
-- twice, and nothing linked the two. The shared eligibility rule (#193) keeps
-- more AI slips pending, which made re-keying the normal way to settle them.
--
-- Model:
--   * slip_check_approvals — an operator decision ON an AI check (approved with
--     an amount, or rejected), with reviewer and reason. Separate from manual
--     entries: approving an AI slip never creates a second money row.
--     At most one ACTIVE decision per check; a decision is revoked, never
--     edited or deleted (append-only audit).
--   * manual_slip_entries.reference_id — optional printed reference for a
--     manual entry. Reconciliation will not count an entry whose reference is
--     already an AI-verified check. Existing rows stay NULL: nothing is
--     back-linked by guessing.
--
-- Additive only. Existing behaviour is unchanged until application code reads
-- the new table/column. Production apply required (after #193; see
-- docs/manual-slip-ai-approval.md for order and rollback).

BEGIN;

CREATE TABLE public.slip_check_approvals (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  slip_check_id    uuid          NOT NULL REFERENCES public.slip_checks(id) ON DELETE RESTRICT,
  decision         text          NOT NULL CHECK (decision IN ('approved', 'rejected')),
  approved_amount  numeric(12,2),
  reason           text          NOT NULL CHECK (length(btrim(reason)) > 0),
  reviewer         text          NOT NULL CHECK (length(btrim(reviewer)) > 0),
  status           text          NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_at       timestamptz,
  revoked_by       text,
  revoke_reason    text,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT slip_check_approvals_amount_shape CHECK (
    (decision = 'approved' AND approved_amount > 0)
    OR (decision = 'rejected' AND approved_amount IS NULL)
  ),
  CONSTRAINT slip_check_approvals_revoke_shape CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL
        AND length(btrim(coalesce(revoked_by, ''))) > 0
        AND length(btrim(coalesce(revoke_reason, ''))) > 0)
  )
);

-- One live decision per AI check, also under concurrent requests.
CREATE UNIQUE INDEX slip_check_approvals_one_active
  ON public.slip_check_approvals (slip_check_id) WHERE status = 'active';

ALTER TABLE public.slip_check_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.slip_check_approvals FROM PUBLIC, anon, authenticated;

-- Append-only: no DELETE; the only UPDATE is active -> revoked.
CREATE OR REPLACE FUNCTION public.guard_slip_check_approval_audit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'slip_check_approval_append_only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'revoked'
     OR NEW.slip_check_id IS DISTINCT FROM OLD.slip_check_id
     OR NEW.decision IS DISTINCT FROM OLD.decision
     OR NEW.approved_amount IS DISTINCT FROM OLD.approved_amount
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.reviewer IS DISTINCT FROM OLD.reviewer
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'slip_check_approval_only_revoke_allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER slip_check_approvals_append_only
BEFORE UPDATE OR DELETE ON public.slip_check_approvals
FOR EACH ROW EXECUTE FUNCTION public.guard_slip_check_approval_audit();

ALTER TABLE public.manual_slip_entries
  ADD COLUMN reference_id text
    CHECK (reference_id IS NULL OR length(btrim(reference_id)) > 0);

COMMENT ON COLUMN public.manual_slip_entries.reference_id IS
  'Optional printed reference of a manually keyed slip. An entry whose reference '
  'is an AI-verified slip_checks reference is not counted (the AI check or its '
  'approval is the single money row). NULL for every pre-existing entry.';

-- Raises when the money of the slip's round/day is already finalized.
CREATE OR REPLACE FUNCTION public.assert_slip_check_round_open(p_check_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source text;
  v_round uuid;
  v_received timestamptz;
BEGIN
  SELECT e.source_id, e.accountability_round_id, e.received_at
  INTO v_source, v_round, v_received
  FROM public.slip_checks c JOIN public.slip_evidences e ON e.id = c.evidence_id
  WHERE c.id = p_check_id;

  IF v_round IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.settlement_finalizations WHERE accountability_round_id = v_round) THEN
      RAISE EXCEPTION 'slip_check_round_finalized' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM public.settlement_finalizations
    WHERE source_id = v_source
      AND accountability_round_id IS NULL
      AND business_date = ((v_received AT TIME ZONE 'Asia/Bangkok') - interval '4 hours')::date
  ) THEN
    RAISE EXCEPTION 'slip_check_round_finalized' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_slip_check(
  p_check_id uuid,
  p_decision text,
  p_amount   numeric,
  p_reason   text,
  p_reviewer text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_ref text;
  v_transfer numeric;
  v_created timestamptz;
  v_existing public.slip_check_approvals%ROWTYPE;
  v_id uuid;
BEGIN
  -- Serializes every decision on this check (with the partial unique index).
  SELECT status, nullif(btrim(reference_id), ''), transfer_amount, created_at
  INTO v_status, v_ref, v_transfer, v_created
  FROM public.slip_checks WHERE id = p_check_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'slip_check_not_found:%', p_check_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status NOT IN ('EXTRACTED', 'PARTIAL_EXTRACTED') OR v_transfer IS NULL THEN
    RAISE EXCEPTION 'slip_check_not_reviewable' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- BR-02: a check without a reference is resolved through the reference route first.
  IF v_ref IS NULL THEN
    RAISE EXCEPTION 'slip_check_reference_required' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Only the global winner of a reference carries its money (same order as
  -- resolveGloballyAcceptedCheckIds); approving a duplicate would double-count.
  IF EXISTS (
    SELECT 1 FROM public.slip_checks o
    WHERE btrim(o.reference_id) = v_ref
      AND o.status IN ('EXTRACTED', 'PARTIAL_EXTRACTED')
      AND (o.created_at, o.id) < (v_created, p_check_id)
  ) THEN
    RAISE EXCEPTION 'slip_check_is_duplicate' USING ERRCODE = 'unique_violation';
  END IF;
  PERFORM public.assert_slip_check_round_open(p_check_id);

  SELECT * INTO v_existing FROM public.slip_check_approvals
  WHERE slip_check_id = p_check_id AND status = 'active';
  IF FOUND THEN
    IF v_existing.decision = p_decision
       AND v_existing.approved_amount IS NOT DISTINCT FROM p_amount THEN
      RETURN jsonb_build_object('approval_id', v_existing.id, 'already', true);
    END IF;
    RAISE EXCEPTION 'slip_check_already_reviewed' USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO public.slip_check_approvals (slip_check_id, decision, approved_amount, reason, reviewer)
  VALUES (p_check_id, p_decision, CASE WHEN p_decision = 'approved' THEN p_amount END, p_reason, p_reviewer)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('approval_id', v_id, 'already', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_slip_check_review(
  p_approval_id uuid,
  p_revoked_by  text,
  p_reason      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_check uuid;
BEGIN
  SELECT slip_check_id INTO v_check FROM public.slip_check_approvals
  WHERE id = p_approval_id AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'slip_check_review_not_active' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM 1 FROM public.slip_checks WHERE id = v_check FOR UPDATE;
  PERFORM public.assert_slip_check_round_open(v_check);
  UPDATE public.slip_check_approvals
  SET status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_revoked_by, revoke_reason = p_reason
  WHERE id = p_approval_id;
  RETURN jsonb_build_object('revoked', true);
END;
$$;

REVOKE ALL ON FUNCTION public.review_slip_check(uuid, text, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_slip_check(uuid, text, numeric, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.revoke_slip_check_review(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_slip_check_review(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.assert_slip_check_round_open(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_slip_check_approval_audit() FROM PUBLIC, anon, authenticated;

COMMIT;
