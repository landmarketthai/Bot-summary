-- Add 11 distinct market-observed vegetable/herb SKUs, ผ119–ผ129.
-- Forward-only and additive: no historical produce rows are rewritten.
-- These names encode a real product/form distinction and must not be folded
-- into nearby dictionary identities by fuzzy matching.

BEGIN;

DO $preflight$
DECLARE
  v_predecessor text;
  v_conflict text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.produce_product_codes WHERE product_code = 'ผ119') THEN
    RAISE EXCEPTION 'market vegetable SKU migration already applied: ผ119 exists';
  END IF;

  SELECT canonical_name INTO v_predecessor
  FROM public.produce_product_codes WHERE product_code = 'ผ118';
  IF NOT FOUND OR v_predecessor <> 'ข้าวคั่ว' THEN
    RAISE EXCEPTION 'ผ118 is %, expected ข้าวคั่ว; refusing to issue ผ119–ผ129', coalesce(v_predecessor, 'NULL');
  END IF;

  SELECT canonical_name INTO v_conflict
  FROM public.produce_product_codes
  WHERE canonical_name IN (
    'ผักกาดลุ้ย', 'หน่อไม้ต้มกลม', 'หน่อไม้ต้มซอย', 'แตงกวาใหญ่',
    'ฟักทองชิ้น', 'มะเขือยาวเขียว', 'มะระลูกใหญ่', 'ผักแพว',
    'ใบกะเพราขาว', 'สลัดคอตนิ่ม', 'มะเขือม่วง'
  ) LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION '% already exists under another product_code', v_conflict;
  END IF;
END;
$preflight$;
INSERT INTO public.produce_product_codes
  (product_code, category_code, category_name, canonical_name, code_enabled)
VALUES
  ('ผ119', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'ผักกาดลุ้ย', true),
  ('ผ120', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'หน่อไม้ต้มกลม', true),
  ('ผ121', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'หน่อไม้ต้มซอย', true),
  ('ผ122', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'แตงกวาใหญ่', true),
  ('ผ123', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'ฟักทองชิ้น', true),
  ('ผ124', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'มะเขือยาวเขียว', true),
  ('ผ125', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'มะระลูกใหญ่', true),
  ('ผ126', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'ผักแพว', true),
  ('ผ127', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'ใบกะเพราขาว', true),
  ('ผ128', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'สลัดคอตนิ่ม', true),
  ('ผ129', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'มะเขือม่วง', true)
ON CONFLICT (product_code) DO NOTHING;

DO $postflight$
DECLARE
  v_total integer;
  v_enabled integer;
  v_count integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE code_enabled)
  INTO v_total, v_enabled FROM public.produce_product_codes;
  IF v_total <> 282 OR v_enabled <> 282 THEN
    RAISE EXCEPTION 'dictionary postflight mismatch: % rows / % enabled, expected 282 / 282', v_total, v_enabled;
  END IF;

  SELECT count(*) INTO v_count FROM public.produce_product_codes WHERE category_code = 'ผ';
  IF v_count <> 129 THEN
    RAISE EXCEPTION 'ผ category count %, expected 129', v_count;
  END IF;
  SELECT count(*) INTO v_count
  FROM public.produce_product_codes
  WHERE (product_code, canonical_name) IN (
    ('ผ119', 'ผักกาดลุ้ย'),('ผ120', 'หน่อไม้ต้มกลม'),('ผ121', 'หน่อไม้ต้มซอย'),
    ('ผ122', 'แตงกวาใหญ่'),('ผ123', 'ฟักทองชิ้น'),('ผ124', 'มะเขือยาวเขียว'),
    ('ผ125', 'มะระลูกใหญ่'),('ผ126', 'ผักแพว'),('ผ127', 'ใบกะเพราขาว'),
    ('ผ128', 'สลัดคอตนิ่ม'),('ผ129', 'มะเขือม่วง')
  );
  IF v_count <> 11 THEN
    RAISE EXCEPTION 'market vegetable SKU mapping mismatch: % of 11 rows match', v_count;
  END IF;
END;
$postflight$;

COMMIT;
