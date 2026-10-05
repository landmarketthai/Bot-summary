-- Add user-approved mushroom identity เห็ดเข็มทอง as ห06 (2026-10-05 audit).

BEGIN;

DO $preflight$
DECLARE
  v_name text;
BEGIN
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ห05')
       IS DISTINCT FROM 'เห็ดหอม' THEN
    RAISE EXCEPTION 'ห05 predecessor mismatch; refusing to issue ห06';
  END IF;

  SELECT canonical_name INTO v_name FROM public.produce_product_codes WHERE product_code = 'ห06';
  IF FOUND AND v_name IS DISTINCT FROM 'เห็ดเข็มทอง' THEN
    RAISE EXCEPTION 'ห06 already exists with identity %, expected เห็ดเข็มทอง', v_name;
  END IF;

  SELECT product_code INTO v_name
  FROM public.produce_product_codes
  WHERE canonical_name = 'เห็ดเข็มทอง' AND product_code <> 'ห06'
  LIMIT 1;
  IF v_name IS NOT NULL THEN
    RAISE EXCEPTION 'เห็ดเข็มทอง already exists under code %', v_name;
  END IF;
END;
$preflight$;

INSERT INTO public.produce_product_codes
  (product_code, category_code, category_name, canonical_name, code_enabled)
VALUES
  ('ห06', 'ห', 'เห็ด', 'เห็ดเข็มทอง', true)
ON CONFLICT (product_code) DO NOTHING;

DO $postflight$
DECLARE
  v_count integer;
  v_total integer;
  v_enabled integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.produce_product_codes
    WHERE product_code = 'ห06' AND category_code = 'ห' AND category_name = 'เห็ด'
      AND canonical_name = 'เห็ดเข็มทอง' AND code_enabled = true
  ) THEN
    RAISE EXCEPTION 'ห06 postflight mismatch';
  END IF;

  SELECT count(*) INTO v_count FROM public.produce_product_codes WHERE category_code = 'ห';
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'ห category count %, expected 6', v_count;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE code_enabled)
  INTO v_total, v_enabled FROM public.produce_product_codes;
  IF v_total <> 323 OR v_enabled <> 323 THEN
    RAISE EXCEPTION 'dictionary postflight mismatch: % rows / % enabled, expected 323 / 323', v_total, v_enabled;
  END IF;
END;
$postflight$;

COMMIT;
