-- Exact order of settlement claims, for reference ownership. Forward-only,
-- re-runnable, no data changes. Production apply required, after
-- 20261102150000.
--
-- Two scopes (rounds / days / markets) can hold claims on the same full
-- reference: the same transfer imaged in one group and keyed in another. The
-- scope that finalized FIRST is the one that counted it
-- (src/lib/slips/reference-ownership.ts), so the claim order must be exact and
-- every claimant must see the claims made before it:
--   * money_claimed_at is stamped by the database when a row ENTERS a
--     finalized status (sending / sent / ambiguous). It is kept while the row
--     stays finalized (sending → sent; the stale re-claim only touches
--     claimed_at and does not fire this trigger), cleared when the row leaves
--     (failed / pending), and stamped again on the failed → sending re-claim.
--   * One global advisory key is taken before the scope key, so claims are
--     serialized: a stamp is later than every claim already committed, and an
--     earlier claim is visible to every later claimant. Reviews never take
--     this key, so the existing order (round key, then day keys) cannot
--     deadlock with it.
-- Rows finalized before this migration keep money_claimed_at NULL; the app
-- falls back to claimed_at for them.
--
-- Also: normalize_slip_reference() removes an explicit character list, the
-- exact set of the TypeScript normalizer (JS \s plus zero-width spaces).
-- 20261102150000 used [[:space:]], whose members depend on the server's
-- ctype provider (it can also remove U+0085 / U+180E). Any difference lets a
-- manual reference miss the AI read of the same transfer.

BEGIN;

CREATE OR REPLACE FUNCTION public.normalize_slip_reference(p_reference text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT nullif(regexp_replace(coalesce(p_reference, ''),
    E'[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200D\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]', '', 'g'), '');
$$;
REVOKE ALL ON FUNCTION public.normalize_slip_reference(text) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.settlement_finalizations ADD COLUMN IF NOT EXISTS money_claimed_at timestamptz;

CREATE OR REPLACE FUNCTION public.lock_settlement_finalization_money()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- ponytail: one global key; claims are a few per market per day. Per-reference keys if it ever contends.
  PERFORM pg_advisory_xact_lock(hashtextextended('money-close:claim-order', 0));
  PERFORM public.lock_money_close(NEW.source_id, NEW.business_date, NEW.accountability_round_id);
  IF NEW.status IN ('sending', 'sent', 'ambiguous') THEN
    IF TG_OP = 'INSERT' OR OLD.status NOT IN ('sending', 'sent', 'ambiguous') THEN
      NEW.money_claimed_at := clock_timestamp();
    ELSE
      NEW.money_claimed_at := OLD.money_claimed_at;
    END IF;
  ELSE
    NEW.money_claimed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_settlement_finalization_money() FROM PUBLIC, anon, authenticated;

COMMIT;
