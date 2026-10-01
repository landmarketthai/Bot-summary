-- Reconcile ท27 (ทุเรียนแพค), already present in Production since 2026-09-24,
-- back into migration history. Existing exact row is accepted; conflicts fail.

BEGIN;

DO $preflight$
DECLARE
  v_name text;
BEGIN
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ท26')
       IS DISTINCT FROM 'ภูเขาไฟลูกค้าเคลม' THEN
    RAISE EXCEPTION 'ท26 predecessor mismatch; refusing to reconcile ท27';
  END IF;

  SELECT canonical_name INTO v_name FROM public.produce_product_codes WHERE product_code = 'ท27';
  IF FOUND AND v_name IS DISTINCT FROM 'ทุเรียนแพค' THEN
    RAISE EXCEPTION 'ท27 already exists with identity %, expected ทุเรียนแพค', v_name;
  END IF;

  SELECT product_code INTO v_name
  FROM public.produce_product_codes
  WHERE canonical_name = 'ทุเรียนแพค' AND product_code <> 'ท27'
  LIMIT 1;
  IF v_name IS NOT NULL THEN
    RAISE EXCEPTION 'ทุเรียนแพค already exists under code %', v_name;
  END IF;
END;
$preflight$;

INSERT INTO public.produce_product_codes
  (product_code, category_code, category_name, canonical_name, code_enabled)
VALUES
  ('ท27', 'ท', 'ทุเรียน', 'ทุเรียนแพค', true)
ON CONFLICT (product_code) DO NOTHING;

DO $postflight$
DECLARE
  v_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.produce_product_codes
    WHERE product_code = 'ท27' AND category_code = 'ท' AND category_name = 'ทุเรียน'
      AND canonical_name = 'ทุเรียนแพค' AND code_enabled = true
  ) THEN
    RAISE EXCEPTION 'ท27 postflight mismatch';
  END IF;

  SELECT count(*) INTO v_count FROM public.produce_product_codes WHERE category_code = 'ท';
  IF v_count <> 27 THEN
    RAISE EXCEPTION 'ท category count %, expected 27', v_count;
  END IF;
END;
$postflight$;

COMMIT;
