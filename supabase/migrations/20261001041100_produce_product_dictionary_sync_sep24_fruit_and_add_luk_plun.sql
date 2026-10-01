-- Reconcile the six fruit codes already present in Production since 2026-09-24
-- back into migration history, then add the user-approved distinct identity
-- ลูกพลุน as ม98. Existing exact rows are accepted; conflicting reuse fails.

BEGIN;

DO $preflight$
DECLARE
  v_conflict text;
BEGIN
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม91')
       IS DISTINCT FROM 'ทับทิมเก่า' THEN
    RAISE EXCEPTION 'ม91 predecessor mismatch; refusing to issue/reconcile ม92-ม98';
  END IF;

  SELECT e.code INTO v_conflict
  FROM (VALUES
    ('ม92','ม','ผลไม้','มะกอก'),
    ('ม93','ม','ผลไม้','ลูกพรุน'),
    ('ม94','ม','ผลไม้','เมล่อน'),
    ('ม95','ม','ผลไม้','องุ่นมีเม็ด'),
    ('ม96','ม','ผลไม้','แอปเปิ้ลเจ้าหญิง'),
    ('ม97','ม','ผลไม้','ลูกไหนดำแดง'),
    ('ม98','ม','ผลไม้','ลูกพลุน')
  ) AS e(code, category_code, category_name, canonical_name)
  JOIN public.produce_product_codes p ON p.product_code = e.code
  WHERE p.category_code IS DISTINCT FROM e.category_code
     OR p.category_name IS DISTINCT FROM e.category_name
     OR p.canonical_name IS DISTINCT FROM e.canonical_name
     OR p.code_enabled IS DISTINCT FROM true
  LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'fruit code % already exists with a different identity', v_conflict;
  END IF;

  SELECT p.canonical_name INTO v_conflict
  FROM public.produce_product_codes p
  JOIN (VALUES
    ('ม92','มะกอก'),('ม93','ลูกพรุน'),('ม94','เมล่อน'),('ม95','องุ่นมีเม็ด'),
    ('ม96','แอปเปิ้ลเจ้าหญิง'),('ม97','ลูกไหนดำแดง'),('ม98','ลูกพลุน')
  ) AS e(code, canonical_name) ON p.canonical_name = e.canonical_name
  WHERE p.product_code <> e.code
  LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'fruit identity % already exists under another code', v_conflict;
  END IF;
END;
$preflight$;

INSERT INTO public.produce_product_codes
  (product_code, category_code, category_name, canonical_name, code_enabled)
VALUES
  ('ม92', 'ม', 'ผลไม้', 'มะกอก', true),
  ('ม93', 'ม', 'ผลไม้', 'ลูกพรุน', true),
  ('ม94', 'ม', 'ผลไม้', 'เมล่อน', true),
  ('ม95', 'ม', 'ผลไม้', 'องุ่นมีเม็ด', true),
  ('ม96', 'ม', 'ผลไม้', 'แอปเปิ้ลเจ้าหญิง', true),
  ('ม97', 'ม', 'ผลไม้', 'ลูกไหนดำแดง', true),
  ('ม98', 'ม', 'ผลไม้', 'ลูกพลุน', true)
ON CONFLICT (product_code) DO NOTHING;

DO $postflight$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.produce_product_codes
  WHERE (product_code, canonical_name) IN (
    ('ม92','มะกอก'),('ม93','ลูกพรุน'),('ม94','เมล่อน'),('ม95','องุ่นมีเม็ด'),
    ('ม96','แอปเปิ้ลเจ้าหญิง'),('ม97','ลูกไหนดำแดง'),('ม98','ลูกพลุน')
  ) AND category_code = 'ม' AND category_name = 'ผลไม้' AND code_enabled = true;
  IF v_count <> 7 THEN
    RAISE EXCEPTION 'fruit dictionary mapping mismatch: % of 7 rows match', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.produce_product_codes WHERE category_code = 'ม';
  IF v_count <> 98 THEN
    RAISE EXCEPTION 'ม category count %, expected 98', v_count;
  END IF;
END;
$postflight$;

COMMIT;
