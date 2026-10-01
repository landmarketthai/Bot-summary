-- Reconcile ผ130-ผ131 already present in Production since 2026-09-24 and add
-- the 11 user-approved vegetable/herb identities from the 2026-10-01 audit.
-- Existing exact rows are accepted; conflicting code/name reuse fails closed.

BEGIN;

DO $preflight$
DECLARE
  v_conflict text;
BEGIN
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ผ129')
       IS DISTINCT FROM 'มะเขือม่วง' THEN
    RAISE EXCEPTION 'ผ129 predecessor mismatch; refusing to issue/reconcile ผ130-ผ142';
  END IF;

  SELECT e.code INTO v_conflict
  FROM (VALUES
    ('ผ130','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','แตงกวาเล็ก'),
    ('ผ131','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','แตงล้าน'),
    ('ผ132','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','ใบยอ'),
    ('ผ133','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','หยวกกล้วย'),
    ('ผ134','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','ดอกกะเจียว'),
    ('ผ135','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','ผักกาดสลัด'),
    ('ผ136','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','ลิ้นฟ้า'),
    ('ผ137','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','พริกหวาน'),
    ('ผ138','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','ใบยี่หร่า'),
    ('ผ139','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','ผักบุ้งนา'),
    ('ผ140','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','พริกลาว'),
    ('ผ141','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','หน่อไม้ต้มเปลือก'),
    ('ผ142','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','หน่อไม้ต้มแท่ง')
  ) AS e(code, category_code, category_name, canonical_name)
  JOIN public.produce_product_codes p ON p.product_code = e.code
  WHERE p.category_code IS DISTINCT FROM e.category_code
     OR p.category_name IS DISTINCT FROM e.category_name
     OR p.canonical_name IS DISTINCT FROM e.canonical_name
     OR p.code_enabled IS DISTINCT FROM true
  LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'vegetable code % already exists with a different identity', v_conflict;
  END IF;

  SELECT p.canonical_name INTO v_conflict
  FROM public.produce_product_codes p
  JOIN (VALUES
    ('ผ130','แตงกวาเล็ก'),('ผ131','แตงล้าน'),('ผ132','ใบยอ'),('ผ133','หยวกกล้วย'),
    ('ผ134','ดอกกะเจียว'),('ผ135','ผักกาดสลัด'),('ผ136','ลิ้นฟ้า'),('ผ137','พริกหวาน'),
    ('ผ138','ใบยี่หร่า'),('ผ139','ผักบุ้งนา'),('ผ140','พริกลาว'),
    ('ผ141','หน่อไม้ต้มเปลือก'),('ผ142','หน่อไม้ต้มแท่ง')
  ) AS e(code, canonical_name) ON p.canonical_name = e.canonical_name
  WHERE p.product_code <> e.code
  LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'vegetable identity % already exists under another code', v_conflict;
  END IF;
END;
$preflight$;

INSERT INTO public.produce_product_codes
  (product_code, category_code, category_name, canonical_name, code_enabled)
VALUES
  ('ผ130', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'แตงกวาเล็ก', true),
  ('ผ131', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'แตงล้าน', true),
  ('ผ132', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'ใบยอ', true),
  ('ผ133', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'หยวกกล้วย', true),
  ('ผ134', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'ดอกกะเจียว', true),
  ('ผ135', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'ผักกาดสลัด', true),
  ('ผ136', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'ลิ้นฟ้า', true),
  ('ผ137', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'พริกหวาน', true),
  ('ผ138', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'ใบยี่หร่า', true),
  ('ผ139', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'ผักบุ้งนา', true),
  ('ผ140', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'พริกลาว', true),
  ('ผ141', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'หน่อไม้ต้มเปลือก', true),
  ('ผ142', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'หน่อไม้ต้มแท่ง', true)
ON CONFLICT (product_code) DO NOTHING;

DO $postflight$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.produce_product_codes
  WHERE product_code IN (
    'ผ130','ผ131','ผ132','ผ133','ผ134','ผ135','ผ136',
    'ผ137','ผ138','ผ139','ผ140','ผ141','ผ142'
  )
    AND category_code = 'ผ'
    AND category_name = 'ผัก / สมุนไพร / เครื่องประกอบอาหาร'
    AND code_enabled = true;
  IF v_count <> 13 THEN
    RAISE EXCEPTION 'vegetable dictionary mapping mismatch: % of 13 rows present', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.produce_product_codes WHERE category_code = 'ผ';
  IF v_count <> 142 THEN
    RAISE EXCEPTION 'ผ category count %, expected 142', v_count;
  END IF;
END;
$postflight$;

COMMIT;
