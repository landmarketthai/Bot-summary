-- Quoted LINE slip amount correction.
--
-- The webhook supplies the current raw message and LINE's quoted message id.
-- This SECURITY DEFINER function is the only write path for the correction:
-- it resolves the quoted image by exact message id, source, and sender,
-- requires an existing RECEIVED slip evidence/check, locks that check, and
-- appends the human override before updating the effective amount. Raw OCR
-- remains in slip_checks.extracted_json.

CREATE TABLE IF NOT EXISTS public.slip_check_amount_corrections (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id                  uuid NOT NULL REFERENCES public.slip_checks(id) ON DELETE CASCADE,
  evidence_id               uuid NOT NULL REFERENCES public.slip_evidences(id) ON DELETE CASCADE,
  correction_raw_message_id uuid NOT NULL UNIQUE REFERENCES public.raw_messages(id) ON DELETE CASCADE,
  target_raw_message_id    uuid NOT NULL REFERENCES public.raw_messages(id) ON DELETE CASCADE,
  line_message_id           text NOT NULL,
  quoted_message_id         text NOT NULL,
  source_id                 text NOT NULL,
  source_type               text NOT NULL,
  line_user_id              text NOT NULL,
  corrected_field           text NOT NULL,
  original_amount           numeric(12,2),
  corrected_amount          numeric(12,2) NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT slip_check_amount_corrections_field_check
    CHECK (corrected_field IN ('transfer_amount', 'paid_amount')),
  CONSTRAINT slip_check_amount_corrections_amount_check
    CHECK (corrected_amount >= 0)
);

CREATE INDEX IF NOT EXISTS slip_check_amount_corrections_check_idx
  ON public.slip_check_amount_corrections (check_id, created_at DESC);

CREATE INDEX IF NOT EXISTS slip_check_amount_corrections_target_idx
  ON public.slip_check_amount_corrections (target_raw_message_id, created_at DESC);

ALTER TABLE public.slip_check_amount_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.slip_check_amount_corrections FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.slip_check_amount_corrections TO service_role;

CREATE OR REPLACE FUNCTION public.apply_slip_amount_correction(
  p_raw_message_id    uuid,
  p_line_message_id   text,
  p_quoted_message_id text,
  p_source_id         text,
  p_source_type       text,
  p_line_user_id      text,
  p_amount            numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current       public.raw_messages%ROWTYPE;
  v_target        public.raw_messages%ROWTYPE;
  v_evidence      public.slip_evidences%ROWTYPE;
  v_check         public.slip_checks%ROWTYPE;
  v_existing      public.slip_check_amount_corrections%ROWTYPE;
  v_target_count  integer;
  v_evidence_count integer;
  v_field         text;
  v_new_status    text;
BEGIN
  IF p_line_user_id IS NULL OR btrim(p_line_user_id) = '' OR p_amount IS NULL OR p_amount < 0 THEN
    RETURN jsonb_build_object('kind', 'ignored', 'reason', 'invalid_identity_or_amount');
  END IF;

  -- Bind the write to the current text message captured by this webhook.
  SELECT * INTO v_current
  FROM public.raw_messages
  WHERE id = p_raw_message_id
    AND source_id = p_source_id
    AND source_type::text = p_source_type
    AND user_id = p_line_user_id
    AND message_id = p_line_message_id
    AND message_type = 'text'::public.line_message_type;

  IF NOT FOUND
     OR v_current.payload #>> '{message,quotedMessageId}' IS DISTINCT FROM p_quoted_message_id THEN
    RETURN jsonb_build_object('kind', 'ignored', 'reason', 'current_message_identity_mismatch');
  END IF;

  -- Exact quoted target only. A missing, ambiguous, different-source, or
  -- different-sender target is deliberately not recoverable by timestamp.
  SELECT count(*) INTO v_target_count
  FROM public.raw_messages
  WHERE message_id = p_quoted_message_id
    AND source_id = p_source_id
    AND source_type::text = p_source_type
    AND user_id = p_line_user_id
    AND message_type = 'image'::public.line_message_type;

  IF v_target_count <> 1 THEN
    RETURN jsonb_build_object('kind', 'ignored', 'reason', 'quoted_target_not_exact');
  END IF;

  SELECT * INTO v_target
  FROM public.raw_messages
  WHERE message_id = p_quoted_message_id
    AND source_id = p_source_id
    AND source_type::text = p_source_type
    AND user_id = p_line_user_id
    AND message_type = 'image'::public.line_message_type;

  SELECT count(*) INTO v_evidence_count
  FROM public.slip_evidences
  WHERE raw_message_id = v_target.id
    AND source_id = p_source_id
    AND source_type = p_source_type
    AND line_user_id = p_line_user_id
    AND status = 'RECEIVED';

  IF v_evidence_count <> 1 THEN
    RETURN jsonb_build_object('kind', 'ignored', 'reason', 'quoted_target_not_slip_evidence');
  END IF;

  SELECT * INTO v_evidence
  FROM public.slip_evidences
  WHERE raw_message_id = v_target.id
    AND source_id = p_source_id
    AND source_type = p_source_type
    AND line_user_id = p_line_user_id
    AND status = 'RECEIVED';

  -- Serialize competing corrections for this exact evidence/check.
  SELECT * INTO v_check
  FROM public.slip_checks
  WHERE evidence_id = v_evidence.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'ignored', 'reason', 'slip_check_not_ready');
  END IF;

  IF v_check.status NOT IN ('EXTRACTED', 'PARTIAL_EXTRACTED', 'NEED_REVIEW') THEN
    RETURN jsonb_build_object('kind', 'ignored', 'reason', 'slip_check_not_reviewable');
  END IF;

  IF v_check.slip_type IN ('BANK_SLIP_QR', 'BANK_SLIP_NO_QR') THEN
    v_field := 'transfer_amount';
  ELSIF v_check.slip_type IN ('THAI_HELP_THAI', 'GWALLET') THEN
    v_field := 'paid_amount';
  ELSE
    RETURN jsonb_build_object('kind', 'ignored', 'reason', 'slip_type_not_amount_correctable');
  END IF;

  -- LINE redelivery is normally stopped by raw_messages.line_event_id. This
  -- unique raw-message audit key makes the mutation idempotent even if the
  -- correction service is called twice after that boundary.
  SELECT * INTO v_existing
  FROM public.slip_check_amount_corrections
  WHERE correction_raw_message_id = p_raw_message_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'kind', 'already_applied',
      'check_id', v_existing.check_id,
      'evidence_id', v_existing.evidence_id,
      'corrected_field', v_existing.corrected_field,
      'corrected_amount', v_existing.corrected_amount
    );
  END IF;

  IF v_field = 'transfer_amount' THEN
    v_new_status := CASE
      WHEN p_amount IS NOT NULL AND v_check.transaction_time IS NOT NULL AND v_check.reference_id IS NOT NULL
        THEN 'EXTRACTED'
      WHEN p_amount IS NOT NULL
        AND (v_check.transaction_time IS NOT NULL OR v_check.reference_id IS NOT NULL OR v_check.receiver_name IS NOT NULL)
        THEN 'PARTIAL_EXTRACTED'
      ELSE 'NEED_REVIEW'
    END;
  ELSE
    v_new_status := CASE
      WHEN v_check.gross_amount IS NOT NULL
        AND v_check.discount_amount IS NOT NULL
        AND p_amount IS NOT NULL
        AND v_check.transaction_time IS NOT NULL
        AND v_check.reference_id IS NOT NULL
        THEN 'EXTRACTED'
      WHEN p_amount IS NOT NULL
        AND (v_check.transaction_time IS NOT NULL OR v_check.reference_id IS NOT NULL OR v_check.receiver_name IS NOT NULL)
        THEN 'PARTIAL_EXTRACTED'
      ELSE 'NEED_REVIEW'
    END;
  END IF;

  INSERT INTO public.slip_check_amount_corrections (
    check_id, evidence_id, correction_raw_message_id, target_raw_message_id,
    line_message_id, quoted_message_id, source_id, source_type, line_user_id,
    corrected_field, original_amount, corrected_amount
  ) VALUES (
    v_check.id, v_evidence.id, p_raw_message_id, v_target.id,
    p_line_message_id, p_quoted_message_id, p_source_id, p_source_type, p_line_user_id,
    v_field,
    CASE WHEN v_field = 'transfer_amount' THEN v_check.transfer_amount ELSE v_check.paid_amount END,
    p_amount
  );

  IF v_field = 'transfer_amount' THEN
    UPDATE public.slip_checks
    SET transfer_amount = p_amount, status = v_new_status
    WHERE id = v_check.id AND evidence_id = v_evidence.id;
  ELSE
    UPDATE public.slip_checks
    SET paid_amount = p_amount, status = v_new_status
    WHERE id = v_check.id AND evidence_id = v_evidence.id;
  END IF;

  RETURN jsonb_build_object(
    'kind', 'applied',
    'check_id', v_check.id,
    'evidence_id', v_evidence.id,
    'corrected_field', v_field,
    'corrected_amount', p_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_slip_amount_correction(uuid, text, text, text, text, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_slip_amount_correction(uuid, text, text, text, text, text, numeric)
  TO service_role;
