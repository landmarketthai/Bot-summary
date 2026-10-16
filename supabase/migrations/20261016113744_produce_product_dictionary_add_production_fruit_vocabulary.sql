-- Production fruit vocabulary review 2026-10-16: four distinct new identities.
-- Catalog-only. Existing exact rows are accepted; mismatches abort everything.
-- No historical rows, financial data, aliases, schema or existing codes change.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Keep both checks and insertion on the same catalog state, including name conflicts.
LOCK TABLE public.produce_product_codes IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_conflict text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.produce_product_codes
    WHERE product_code = 'ม98' AND category_code = 'ม' AND category_name = 'ผลไม้'
      AND canonical_name = 'ลูกพลุน' AND code_enabled = true
  ) THEN
    RAISE EXCEPTION 'ม98 predecessor mismatch; refusing to issue ม99-ม102';
  END IF;

  -- Accept a clean baseline, a partial exact application, or an exact rerun only.
  IF (SELECT count(*) FROM public.produce_product_codes
      WHERE category_code = 'ม' AND product_code NOT IN ('ม99','ม100','ม101','ม102')) <> 98
     OR EXISTS (
       SELECT 1 FROM generate_series(1, 98) AS expected(n)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.produce_product_codes p
         WHERE p.product_code = 'ม' || CASE WHEN n < 10 THEN '0' || n::text ELSE n::text END
           AND p.category_code = 'ม'
       )
     ) THEN
    RAISE EXCEPTION 'expected existing fruit codes ม01..ม98; review Production catalog drift';
  END IF;

  SELECT e.code INTO v_conflict
  FROM (VALUES
    ('ม99','ม','ผลไม้','ส้มจีน'),
    ('ม100','ม','ผลไม้','ส้มสายน้ำผึ้ง'),
    ('ม101','ม','ผลไม้','กล้วยเล็บมือนาง'),
    ('ม102','ม','ผลไม้','มะขามป้อม')
  ) AS e(code, category_code, category_name, canonical_name)
  JOIN public.produce_product_codes p ON p.product_code = e.code
  WHERE p.category_code IS DISTINCT FROM e.category_code
     OR p.category_name IS DISTINCT FROM e.category_name
     OR p.canonical_name IS DISTINCT FROM e.canonical_name
     OR p.code_enabled IS DISTINCT FROM true
  LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'fruit code % already exists with a different identity or enabled state', v_conflict;
  END IF;

  SELECT p.canonical_name INTO v_conflict
  FROM public.produce_product_codes p
  JOIN (VALUES
    ('ม99','ส้มจีน'),('ม100','ส้มสายน้ำผึ้ง'),
    ('ม101','กล้วยเล็บมือนาง'),('ม102','มะขามป้อม')
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
  ('ม99', 'ม', 'ผลไม้', 'ส้มจีน', true),
  ('ม100', 'ม', 'ผลไม้', 'ส้มสายน้ำผึ้ง', true),
  ('ม101', 'ม', 'ผลไม้', 'กล้วยเล็บมือนาง', true),
  ('ม102', 'ม', 'ผลไม้', 'มะขามป้อม', true)
ON CONFLICT (product_code) DO NOTHING;

DO $postflight$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.produce_product_codes
  WHERE (product_code, canonical_name) IN (
    ('ม99','ส้มจีน'),('ม100','ส้มสายน้ำผึ้ง'),
    ('ม101','กล้วยเล็บมือนาง'),('ม102','มะขามป้อม')
  ) AND category_code = 'ม' AND category_name = 'ผลไม้' AND code_enabled = true;
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'fruit dictionary mapping mismatch: % of 4 rows match', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.produce_product_codes WHERE category_code = 'ม';
  IF v_count <> 102 THEN
    RAISE EXCEPTION 'ม category count %, expected 102', v_count;
  END IF;
END;
$postflight$;

COMMIT;
