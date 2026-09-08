-- Produce Product Code Dictionary — six new ผลไม้ (ม) codes: ม75–ม80.
--
--   ม75 มันแกว          ม76 องุ่นไร้ออส
--   ม77 แอปเปิ้ลแคระ     ม78 เมล่อนกล่อง
--   ม79 องุ่นลิ้นจี่      ม80 องุ่นจักรพรรดิ์
--
-- Forward-only, catalog-only, additive. No historical produce_transactions /
-- produce_items / produce_sessions row is read, rewritten or backfilled by
-- this migration. No existing product_code row is touched: these are six
-- ordinary INSERTs, contiguous past the last released ม-code (ม74 = พุทราจีน,
-- from 20260901093000). The identity guard installed by 20260813115826
-- (produce_product_codes_identity_guard) is never disabled here: this migration
-- makes no rename.
--
-- Each of the six is a DISTINCT canonical product. They are deliberately NOT
-- folded into, aliased to, or treated as spelling variants of the near-neighbour
-- rows they must never merge with:
--
--   ม77 แอปเปิ้ลแคระ  is NOT ม62 แอปเปิ้ล
--   ม76 องุ่นไร้ออส    is NOT ม58 องุ่นไร้เม็ด
--   ม79 องุ่นลิ้นจี่    is NOT ม71 ลิ้นจี่
--
-- None of those rows is touched, and no application-layer alias is introduced
-- here. PRODUCT_ALIASES in src/lib/summary/remaining-fruit.ts folds BUSINESS
-- IDENTITY, not just report labels, so an alias there would silently merge a
-- product's stock and money with a different one. Canonical spelling only.
--
-- เมล่อนกล่อง carries the packaging word กล่อง as part of its own registered
-- identity, exactly like ผลไม้กล่อง / ทุเรียนกล่อง / หมอนทองกล่อง / ก้านยาวกล่อง.
-- canonicalProduceProductName (src/lib/produce/product-vocabulary.ts) already
-- guards this: a full name that IS approved wins over any endsWith("กล่อง")
-- strip, so registering เมล่อนกล่อง keeps it its own product rather than folding
-- it into a (non-existent) เมล่อน row.
--
-- The confirmed typo องุ่นคินสัน → ม68 องุ่นคิมสัน is handled at the application
-- layer (PRODUCT_ALIASES), NOT here: it is a spelling variant of an existing
-- identity, not a new code, so it must never mint a row.

BEGIN;

-- ── Preflight: fail loudly, mutate nothing until every assumption holds ──────
DO $preflight$
DECLARE
  v_current_name text;
  v_conflict     text;
BEGIN
  -- Idempotency anchor: the first of the new codes must be free.
  IF EXISTS (SELECT 1 FROM public.produce_product_codes WHERE product_code = 'ม75') THEN
    RAISE EXCEPTION
      'produce_product_dictionary_add_unclassified_fruit already applied: ม75 already exists';
  END IF;

  -- The predecessor must be exactly where this migration believes it is;
  -- otherwise ม75–ม80 are not the next contiguous codes.
  SELECT canonical_name INTO v_current_name
    FROM public.produce_product_codes WHERE product_code = 'ม74';
  IF NOT FOUND OR v_current_name <> 'พุทราจีน' THEN
    RAISE EXCEPTION
      'ม74 is not พุทราจีน (found %) — 20260901093000 is not applied as expected, refusing to issue ม75–ม80',
      coalesce(v_current_name, 'NULL');
  END IF;

  -- None of the six identities may already exist under any code: a duplicate
  -- canonical_name is a second product identity, the exact thing to avoid.
  SELECT canonical_name INTO v_conflict
    FROM public.produce_product_codes
   WHERE canonical_name IN
     ('มันแกว','องุ่นไร้ออส','แอปเปิ้ลแคระ','เมล่อนกล่อง','องุ่นลิ้นจี่','องุ่นจักรพรรดิ์')
   LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION '% already exists under a different product_code', v_conflict;
  END IF;

  -- The near-neighbour identities these six must stay distinct from have to be
  -- exactly where this migration believes they are; otherwise the "distinct
  -- product" claim is unverified.
  IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม62') <> 'แอปเปิ้ล'
     OR (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม58') <> 'องุ่นไร้เม็ด'
     OR (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม71') <> 'ลิ้นจี่'
     OR (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม68') <> 'องุ่นคิมสัน' THEN
    RAISE EXCEPTION
      'the neighbour rows ม62/ม58/ม71/ม68 are not as expected — refusing to add lookalike identities blind';
  END IF;
END;
$preflight$;

-- ── The six new rows ──────────────────────────────────────────────────────────
-- ON CONFLICT DO NOTHING makes a redeploy a no-op rather than an UPDATE (which
-- the identity guard would refuse anyway).
INSERT INTO public.produce_product_codes
  (product_code, category_code, category_name, canonical_name, code_enabled)
VALUES
  ('ม75', 'ม', 'ผลไม้', 'มันแกว', true),
  ('ม76', 'ม', 'ผลไม้', 'องุ่นไร้ออส', true),
  ('ม77', 'ม', 'ผลไม้', 'แอปเปิ้ลแคระ', true),
  ('ม78', 'ม', 'ผลไม้', 'เมล่อนกล่อง', true),
  ('ม79', 'ม', 'ผลไม้', 'องุ่นลิ้นจี่', true),
  ('ม80', 'ม', 'ผลไม้', 'องุ่นจักรพรรดิ์', true)
ON CONFLICT (product_code) DO NOTHING;

-- ── Postflight: prove the end state before committing ────────────────────────
DO $postflight$
DECLARE
  v_total   integer;
  v_enabled integer;
  v_mcount  integer;
  r         record;
  expected  constant text[][] := ARRAY[
    ['ม75','มันแกว'], ['ม76','องุ่นไร้ออส'], ['ม77','แอปเปิ้ลแคระ'],
    ['ม78','เมล่อนกล่อง'], ['ม79','องุ่นลิ้นจี่'], ['ม80','องุ่นจักรพรรดิ์']
  ];
  pair      text[];
  v_name    text;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE code_enabled)
    INTO v_total, v_enabled
    FROM public.produce_product_codes;

  IF v_total <> 271 OR v_enabled <> 271 THEN
    RAISE EXCEPTION
      'produce_product_codes postflight mismatch: % rows / % enabled, expected 271 / 271',
      v_total, v_enabled;
  END IF;

  SELECT count(*) INTO v_mcount
    FROM public.produce_product_codes WHERE category_code = 'ม';
  IF v_mcount <> 80 THEN
    RAISE EXCEPTION 'ม-category count is %, expected 80', v_mcount;
  END IF;

  FOREACH pair SLICE 1 IN ARRAY expected LOOP
    SELECT canonical_name INTO v_name
      FROM public.produce_product_codes WHERE product_code = pair[1];
    IF v_name IS DISTINCT FROM pair[2] THEN
      RAISE EXCEPTION '% canonical_name is %, expected %', pair[1], coalesce(v_name, 'NULL'), pair[2];
    END IF;
  END LOOP;

  -- Untouched neighbours: every lookalike keeps its own identity. If any of
  -- these moved, this migration merged two products and must not commit.
  FOR r IN
    SELECT * FROM (VALUES
      ('ม62','แอปเปิ้ล'), ('ม58','องุ่นไร้เม็ด'), ('ม71','ลิ้นจี่'),
      ('ม68','องุ่นคิมสัน'), ('ม74','พุทราจีน')
    ) AS n(code, name)
  LOOP
    IF (SELECT canonical_name FROM public.produce_product_codes WHERE product_code = r.code) <> r.name THEN
      RAISE EXCEPTION '% (%) moved — this migration must not touch it', r.code, r.name;
    END IF;
  END LOOP;
END;
$postflight$;

COMMIT;
