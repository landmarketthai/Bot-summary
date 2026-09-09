-- Add ป37 ปลาทู as a distinct market-observed SKU.
-- Do not fold it into ป19 ปลาทูมัน or ป20 ปลาทูหอม.

BEGIN;

DO $preflight$
DECLARE
  v_predecessor text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.produce_product_codes WHERE product_code = 'ป37') THEN
    RAISE EXCEPTION 'market fish SKU migration already applied: ป37 exists';
  END IF;

  SELECT canonical_name INTO v_predecessor
  FROM public.produce_product_codes WHERE product_code = 'ป36';
  IF NOT FOUND OR v_predecessor <> 'หอยเชลล์' THEN
    RAISE EXCEPTION 'ป36 is %, expected หอยเชลล์; refusing to issue ป37', coalesce(v_predecessor, 'NULL');
  END IF;

  IF EXISTS (SELECT 1 FROM public.produce_product_codes WHERE canonical_name = 'ปลาทู') THEN
    RAISE EXCEPTION 'ปลาทู already exists under another product_code';
  END IF;

  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ป19') <> 'ปลาทูมัน'
     OR (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ป20') <> 'ปลาทูหอม' THEN
    RAISE EXCEPTION 'ปลาทู neighbour identities ป19/ป20 are not as expected';
  END IF;
END;
$preflight$;

INSERT INTO public.produce_product_codes
  (product_code, category_code, category_name, canonical_name, code_enabled)
VALUES
  ('ป37', 'ป', 'ปลา / อาหารแห้ง / ของแห้ง', 'ปลาทู', true)
ON CONFLICT (product_code) DO NOTHING;
DO $postflight$
DECLARE
  v_total integer;
  v_enabled integer;
  v_count integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE code_enabled)
  INTO v_total, v_enabled FROM public.produce_product_codes;
  IF v_total <> 283 OR v_enabled <> 283 THEN
    RAISE EXCEPTION 'dictionary postflight mismatch: % rows / % enabled, expected 283 / 283', v_total, v_enabled;
  END IF;

  SELECT count(*) INTO v_count FROM public.produce_product_codes WHERE category_code = 'ป';
  IF v_count <> 37 THEN
    RAISE EXCEPTION 'ป category count %, expected 37', v_count;
  END IF;

  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ป37') <> 'ปลาทู' THEN
    RAISE EXCEPTION 'ป37 canonical_name mismatch';
  END IF;
END;
$postflight$;

COMMIT;
