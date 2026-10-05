-- Add the user-approved vegetable/herb identities ผ143-ผ148 from the
-- 2026-10-05 Production alias audit. Each is a distinct product, not an alias:
-- none has an existing canonical with the same meaning.
--   ลูกมะอึก (not the one-off typo ลูกมะอึ) and สลัดคอตใบแข็ง (matching the
--   สลัดคอต / สลัดคอตนิ่ม naming, not ผักสลัดคอตใบแข็ง) were confirmed by
--   the user; the variant spellings resolve through PRODUCT_ALIASES.
--   หน่อไม้ต้มเหลืองกลม / หน่อไม้ต้มเหลืองซอย stay separate from
--   หน่อไม้ต้มกลม (ผ120) / หน่อไม้ต้มซอย (ผ121).
--   ใบกะเพราแดง stays separate from ใบกะเพรา (ผ96) and ใบกะเพราขาว (ผ127).
-- Existing exact rows are accepted; conflicting code/name reuse fails closed.

BEGIN;

DO $preflight$
DECLARE
  v_conflict text;
BEGIN
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ผ142')
       IS DISTINCT FROM 'หน่อไม้ต้มแท่ง' THEN
    RAISE EXCEPTION 'ผ142 predecessor mismatch; refusing to issue ผ143-ผ148';
  END IF;

  SELECT e.code INTO v_conflict
  FROM (VALUES
    ('ผ143','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','ผักโป้ยเล่ง'),
    ('ผ144','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','สลัดคอตใบแข็ง'),
    ('ผ145','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','ลูกมะอึก'),
    ('ผ146','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','หน่อไม้ต้มเหลืองกลม'),
    ('ผ147','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','หน่อไม้ต้มเหลืองซอย'),
    ('ผ148','ผ','ผัก / สมุนไพร / เครื่องประกอบอาหาร','ใบกะเพราแดง')
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
    ('ผ143','ผักโป้ยเล่ง'),('ผ144','สลัดคอตใบแข็ง'),('ผ145','ลูกมะอึก'),
    ('ผ146','หน่อไม้ต้มเหลืองกลม'),('ผ147','หน่อไม้ต้มเหลืองซอย'),
    ('ผ148','ใบกะเพราแดง')
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
  ('ผ143', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'ผักโป้ยเล่ง', true),
  ('ผ144', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'สลัดคอตใบแข็ง', true),
  ('ผ145', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'ลูกมะอึก', true),
  ('ผ146', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'หน่อไม้ต้มเหลืองกลม', true),
  ('ผ147', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'หน่อไม้ต้มเหลืองซอย', true),
  ('ผ148', 'ผ', 'ผัก / สมุนไพร / เครื่องประกอบอาหาร', 'ใบกะเพราแดง', true)
ON CONFLICT (product_code) DO NOTHING;

DO $postflight$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.produce_product_codes WHERE category_code = 'ผ';
  IF v_count <> 148 THEN
    RAISE EXCEPTION 'ผ category count %, expected 148', v_count;
  END IF;
END;
$postflight$;

COMMIT;
