-- Reviewed spellings of the vegetable market พาซิโอ้ผัก (paseo_vegetable).
--
-- Canonical label stays พาซิโอ้ผัก. Only contiguous spellings that already
-- carry the ผัก qualifier are added, so none can collide with พาซิโอ้,
-- พาซิโอ้ผลไม้ or พาซิโอ้ทุเรียน:
--   * พาซีโอ้ผัก      — same ซี spelling already reviewed for พาซิโอ้ (20260815213206)
--   * ตลาดพาซิโอ้ผัก — mirrors the reviewed ตลาดพาซิโอ้ผลไม้ (0055); cleanMarketName
--                     keeps the ตลาด prefix, so it needs its own row
-- พาสิโอ้ผัก / พาชิโอ้ผัก are already seeded by 0055.
--
-- Deliberately NOT added: space-separated forms such as "พาซิโอ้ ผัก".
-- cleanMarketName strips transaction words, so "พาซิโอ้ เบิกผัก" (withdraw
-- vegetables, market พาซิโอ้) normalizes to exactly "พาซิโอ้ ผัก"; aliasing it
-- would silently move general พาซิโอ้ rounds into the vegetable market.
--
-- The TypeScript mirror REVIEWED_MARKET_ALIASES (src/lib/market.ts) carries
-- the same two rows; market-alias-registry.test.ts enforces parity.

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.line_guided_menu_markets
    WHERE market_code = 'paseo_vegetable' AND label = 'พาซิโอ้ผัก' AND active IS TRUE
  ) THEN
    RAISE EXCEPTION 'reviewed market paseo_vegetable (พาซิโอ้ผัก) is missing or inactive';
  END IF;
END;
$preflight$;

INSERT INTO public.line_guided_menu_market_aliases (alias_label, market_code, active)
VALUES
  ('พาซีโอ้ผัก', 'paseo_vegetable', true),
  ('ตลาดพาซิโอ้ผัก', 'paseo_vegetable', true)
ON CONFLICT (alias_label) DO NOTHING;

DO $verify$
BEGIN
  IF (
    SELECT count(*) FROM public.line_guided_menu_market_aliases
    WHERE alias_label IN ('พาซีโอ้ผัก', 'ตลาดพาซิโอ้ผัก')
      AND market_code = 'paseo_vegetable'
      AND active IS TRUE
  ) <> 2 THEN
    RAISE EXCEPTION 'reviewed พาซิโอ้ผัก aliases differ from the reviewed baseline';
  END IF;
  IF public.accountability_round_market_code('พาซีโอ้ผัก') IS DISTINCT FROM 'paseo_vegetable' THEN
    RAISE EXCEPTION 'พาซีโอ้ผัก does not resolve to paseo_vegetable';
  END IF;
END;
$verify$;

COMMIT;
