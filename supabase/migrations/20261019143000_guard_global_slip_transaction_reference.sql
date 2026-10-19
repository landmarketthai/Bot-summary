-- Global slip identity admission: transaction reference and identical image bytes.
-- This protects concurrent submissions from different LINE groups/markets. Historical
-- duplicate rows are preserved and remain handled by read-time winner resolution.
CREATE OR REPLACE FUNCTION public.guard_global_slip_transaction_reference()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_reference text;
  v_sha text;
  v_key text;
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

  SELECT e.sha256 INTO v_sha
  FROM public.slip_evidences e WHERE e.id = NEW.evidence_id;
  IF v_sha IS NOT NULL AND (v_sha = repeat('0', 64) OR length(v_sha) != 64) THEN
    v_sha := NULL;
  END IF;

  -- Lock the identities in lexical order to prevent ref/hash lock inversion.
  -- Advisory locks are transaction-scoped and serialize competing workers.
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

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_global_slip_transaction_reference ON public.slip_checks;
CREATE TRIGGER guard_global_slip_transaction_reference
BEFORE INSERT OR UPDATE OF status, reference_id ON public.slip_checks
FOR EACH ROW EXECUTE FUNCTION public.guard_global_slip_transaction_reference();
REVOKE ALL ON FUNCTION public.guard_global_slip_transaction_reference() FROM PUBLIC;
