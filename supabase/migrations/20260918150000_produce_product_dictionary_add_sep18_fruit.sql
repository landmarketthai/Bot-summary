-- Add 11 confirmed fruit identities from Production usage through 2026-09-18.
-- "เก่า" products are deliberately separate identities because they carry
-- different prices from the normal product; they must never be aliased back.
-- Forward-only, catalog-only, additive. Historical rows are not rewritten.

BEGIN;

DO $preflight$
DECLARE
  v_conflict text;
BEGIN
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม80')
       IS DISTINCT FROM 'องุ่นจักรพรรดิ์' THEN
    RAISE EXCEPTION 'ม80 predecessor mismatch; refusing to issue ม81-ม91';
  END IF;

  SELECT product_code INTO v_conflict
    FROM public.produce_product_codes
   WHERE product_code IN ('ม81','ม82','ม83','ม84','ม85','ม86','ม87','ม88','ม89','ม90','ม91')
   LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'new fruit code % is already issued', v_conflict;
  END IF;
  SELECT canonical_name INTO v_conflict
    FROM public.produce_product_codes
   WHERE canonical_name IN (
     'องุ่นไร้แดง','แอปเปิ้ลเขียว','สาลี่หิมะ','ไซมัสเก่า',
     'แก้วมังกรเก่า','เขียวมรกตเก่า','มังคุดเก่า','มะม่วงฟ้าลั่นเก่า',
     'เงาะเก่า','ลองกองเก่า','ทับทิมเก่า'
   )
   LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'fruit identity % already exists under another code', v_conflict;
  END IF;
END;
$preflight$;

INSERT INTO public.produce_product_codes
  (product_code, category_code, category_name, canonical_name, code_enabled)
VALUES
  ('ม81', 'ม', 'ผลไม้', 'องุ่นไร้แดง', true),
  ('ม82', 'ม', 'ผลไม้', 'แอปเปิ้ลเขียว', true),
  ('ม83', 'ม', 'ผลไม้', 'สาลี่หิมะ', true),
  ('ม84', 'ม', 'ผลไม้', 'ไซมัสเก่า', true),
  ('ม85', 'ม', 'ผลไม้', 'แก้วมังกรเก่า', true),
  ('ม86', 'ม', 'ผลไม้', 'เขียวมรกตเก่า', true),
  ('ม87', 'ม', 'ผลไม้', 'มังคุดเก่า', true),
  ('ม88', 'ม', 'ผลไม้', 'มะม่วงฟ้าลั่นเก่า', true),
  ('ม89', 'ม', 'ผลไม้', 'เงาะเก่า', true),
  ('ม90', 'ม', 'ผลไม้', 'ลองกองเก่า', true),
  ('ม91', 'ม', 'ผลไม้', 'ทับทิมเก่า', true);

DO $postflight$
DECLARE
  pair text[];
  v_name text;
  expected constant text[][] := ARRAY[
    ['ม81','องุ่นไร้แดง'], ['ม82','แอปเปิ้ลเขียว'], ['ม83','สาลี่หิมะ'],
    ['ม84','ไซมัสเก่า'], ['ม85','แก้วมังกรเก่า'], ['ม86','เขียวมรกตเก่า'],
    ['ม87','มังคุดเก่า'], ['ม88','มะม่วงฟ้าลั่นเก่า'], ['ม89','เงาะเก่า'],
    ['ม90','ลองกองเก่า'], ['ม91','ทับทิมเก่า']
  ];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY expected LOOP
    SELECT canonical_name INTO v_name
      FROM public.produce_product_codes
     WHERE product_code = pair[1] AND code_enabled = true;
    IF v_name IS DISTINCT FROM pair[2] THEN
      RAISE EXCEPTION '% canonical_name is %, expected %', pair[1], coalesce(v_name,'NULL'), pair[2];
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.produce_product_codes WHERE category_code = 'ม') <> 91 THEN
    RAISE EXCEPTION 'ม-category count mismatch after issuing ม81-ม91';
  END IF;
END;
$postflight$;

COMMIT;
