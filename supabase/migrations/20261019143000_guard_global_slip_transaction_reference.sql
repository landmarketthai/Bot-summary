-- Global slip identity admission (including conservative near-image review).
-- No historical check or evidence row is deleted/rewritten.
-- Deploy migration before deploying the app that writes image fingerprints.
ALTER TABLE public.slip_evidences
  ADD COLUMN IF NOT EXISTS visual_hash_full text,
  ADD COLUMN IF NOT EXISTS visual_hash_center text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slip_evidences_visual_hash_full_format') THEN
    ALTER TABLE public.slip_evidences
      ADD CONSTRAINT slip_evidences_visual_hash_full_format
      CHECK (visual_hash_full IS NULL OR visual_hash_full ~ '^[0-9a-f]{16}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slip_evidences_visual_hash_center_format') THEN
    ALTER TABLE public.slip_evidences
      ADD CONSTRAINT slip_evidences_visual_hash_center_format
      CHECK (visual_hash_center IS NULL OR visual_hash_center ~ '^[0-9a-f]{16}$');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_global_slip_transaction_reference()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_reference text;
  v_sha text;
  v_full text;
  v_center text;
  v_key text;
  v_amount numeric;
BEGIN
  IF NEW.status NOT IN ('EXTRACTED', 'PARTIAL_EXTRACTED') THEN
    RETURN NEW;
  END IF;
  v_reference := NULLIF(btrim(NEW.reference_id), '');
  IF v_reference IS NULL THEN
    NEW.status := 'NEED_REVIEW';
    NEW.failure_reason := 'missing_transaction_reference_global';
    RETURN NEW;
  END IF;

  SELECT e.sha256, e.visual_hash_full, e.visual_hash_center
    INTO v_sha, v_full, v_center
  FROM public.slip_evidences e WHERE e.id = NEW.evidence_id;

  IF v_sha IS NOT NULL AND (v_sha = repeat('0', 64) OR length(v_sha) <> 64) THEN
    v_sha := NULL;
  END IF;

  -- Different visual hashes may still be near each other. This global visual
  -- mutex serializes candidate admissions, so Hamming lookup cannot race.
  -- Use lock ordering: visual mutex first, then lexically ordered exact keys.
  IF v_full IS NOT NULL OR v_center IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('slip-global-v1:visual-mutex', 0));
  END IF;
  FOR v_key IN
    SELECT k FROM (
      VALUES ('reference:' || v_reference), ('sha256:' || COALESCE(v_sha, ''))
    ) AS keys(k) WHERE k <> 'sha256:' ORDER BY k
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('slip-global-v1:' || v_key, 0));
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM public.slip_checks c
    WHERE c.id IS DISTINCT FROM NEW.id
      AND c.reference_id = v_reference
      AND c.status IN ('EXTRACTED', 'PARTIAL_EXTRACTED')
  ) THEN
    NEW.status := 'NEED_REVIEW';
    NEW.failure_reason := 'duplicate_transaction_reference_global';
    RETURN NEW;
  END IF;

  IF v_sha IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.slip_checks c
    JOIN public.slip_evidences e ON e.id = c.evidence_id
    WHERE c.id IS DISTINCT FROM NEW.id
      AND c.status IN ('EXTRACTED', 'PARTIAL_EXTRACTED')
      AND e.sha256 = v_sha
  ) THEN
    NEW.status := 'NEED_REVIEW';
    NEW.failure_reason := 'duplicate_image_sha256_global';
    RETURN NEW;
  END IF;

  -- Visual match alone is NOT proof of duplicate. Only hold for manual review
  -- when amount, slip kind and visible transaction time corroborate the image.
  -- Exact reference/SHA checks above remain global over all dates.
  v_amount := CASE
    WHEN NEW.slip_type IN ('THAI_HELP_THAI', 'GWALLET')
      THEN COALESCE(NEW.gross_amount, NEW.paid_amount + NEW.discount_amount, NEW.paid_amount)
    ELSE NEW.transfer_amount
  END;
  IF (v_full IS NOT NULL OR v_center IS NOT NULL)
     AND NEW.transaction_time IS NOT NULL
     AND v_amount IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.slip_checks c
       JOIN public.slip_evidences e ON e.id = c.evidence_id
       WHERE c.id IS DISTINCT FROM NEW.id
         AND c.status IN ('EXTRACTED', 'PARTIAL_EXTRACTED')
         AND c.slip_type = NEW.slip_type
         AND c.transaction_time IS NOT NULL
         AND abs(extract(epoch FROM (c.transaction_time - NEW.transaction_time))) <= 90
         AND (
           CASE WHEN c.slip_type IN ('THAI_HELP_THAI', 'GWALLET')
             THEN COALESCE(c.gross_amount, c.paid_amount + c.discount_amount, c.paid_amount)
             ELSE c.transfer_amount
           END
         ) = v_amount
         AND (
           (v_full IS NOT NULL AND e.visual_hash_full IS NOT NULL AND
             bit_count(('x' || v_full)::bit(64) # ('x' || e.visual_hash_full)::bit(64)) <= 6)
           OR (v_center IS NOT NULL AND e.visual_hash_center IS NOT NULL AND
             bit_count(('x' || v_center)::bit(64) # ('x' || e.visual_hash_center)::bit(64)) <= 6)
         )
     )
  THEN
    NEW.status := 'NEED_REVIEW';
    NEW.failure_reason := 'possible_near_duplicate_image_global';
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_global_slip_transaction_reference ON public.slip_checks;
CREATE TRIGGER guard_global_slip_transaction_reference
BEFORE INSERT OR UPDATE OF status, reference_id ON public.slip_checks
FOR EACH ROW EXECUTE FUNCTION public.guard_global_slip_transaction_reference();
REVOKE ALL ON FUNCTION public.guard_global_slip_transaction_reference() FROM PUBLIC;
