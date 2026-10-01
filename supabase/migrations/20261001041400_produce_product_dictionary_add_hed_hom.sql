-- Add user-approved mushroom identity เห็ดหอม as ห05.

BEGIN;

DO $preflight$
DECLARE
  v_name text;
BEGIN
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ห04')
       IS DISTINCT FROM 'เห็ดออรินจิ' THEN
    RAISE EXCEPTION 'ห04 predecessor mismatch; refusing to issue ห05';
  END IF;

  SELECT canonical_name INTO v_name FROM public.produce_product_codes WHERE product_code = 'ห05';
  IF FOUND AND v_name IS DISTINCT FROM 'เห็ดหอม' THEN
    RAISE EXCEPTION 'ห05 already exists with identity %, expected เห็ดหอม', v_name;
  END IF;

  SELECT product_code INTO v_name
  FROM public.produce_product_codes
  WHERE canonical_name = 'เห็ดหอม' AND product_code <> 'ห05'
  LIMIT 1;
  IF v_name IS NOT NULL THEN
    RAISE EXCEPTION 'เห็ดหอม already exists under code %', v_name;
  END IF;
END;
$preflight$;

INSERT INTO public.produce_product_codes
  (product_code, category_code, category_name, canonical_name, code_enabled)
VALUES
  ('ห05', 'ห', 'เห็ด', 'เห็ดหอม', true)
ON CONFLICT (product_code) DO NOTHING;

DO $postflight$
DECLARE
  v_count integer;
  v_total integer;
  v_enabled integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.produce_product_codes
    WHERE product_code = 'ห05' AND category_code = 'ห' AND category_name = 'เห็ด'
      AND canonical_name = 'เห็ดหอม' AND code_enabled = true
  ) THEN
    RAISE EXCEPTION 'ห05 postflight mismatch';
  END IF;

  SELECT count(*) INTO v_count FROM public.produce_product_codes WHERE category_code = 'ห';
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'ห category count %, expected 5', v_count;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE code_enabled)
  INTO v_total, v_enabled FROM public.produce_product_codes;
  IF v_total <> 316 OR v_enabled <> 316 THEN
    RAISE EXCEPTION 'dictionary postflight mismatch: % rows / % enabled, expected 316 / 316', v_total, v_enabled;
  END IF;
END;
$postflight$;

COMMIT;
