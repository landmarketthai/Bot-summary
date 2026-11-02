-- READ-ONLY aggregate audit: how much AI-verified slip money the shared
-- eligibility rule (PR #193, src/lib/slips/financial-eligibility.ts + the LINE
-- outlier guard) would have kept out of reconciliation / White Sheet /
-- settlement / round-close totals, per business date and market.
--
-- * SELECT only, inside a READ ONLY transaction; writes nothing.
-- * Aggregates only: no names, account numbers, reference ids or LINE ids.
-- * NOT YET RUN against Production. Running it needs explicit approval.
--
-- Mirrors the TypeScript rules (approximations noted):
--   business date   = accountability_rounds.business_date when bound, else the
--                     Bangkok 04:00 receipt cutoff (businessDateToUtcRange)
--   counted before  = verified status, transfer_amount NOT NULL, non-empty
--                     reference (BR-02), global winner = earliest created_at,id
--   date rule       = Bangkok date of transaction_time within 1 day of the
--                     business date; NULL = missing
--   outlier         = batch of >= 5 positive effective amounts, amount >= 5000
--                     and >= 10 x batch median (validation-guard.ts)
--   market          = market_label_normalized (storage column; the app
--                     re-normalizes in TypeScript, so treat as a grouping key)
-- Set the date range in params.

BEGIN TRANSACTION READ ONLY;

WITH params AS (
  SELECT date '2026-10-01' AS from_date, date '2026-11-02' AS to_date
),
ev AS (
  SELECT e.id,
         e.batch_id,
         coalesce(nullif(btrim(e.market_label_normalized), ''), '(ไม่ระบุตลาด)') AS market,
         coalesce(r.business_date,
                  ((e.received_at AT TIME ZONE 'Asia/Bangkok') - interval '4 hours')::date) AS business_date
  FROM public.slip_evidences e
  LEFT JOIN public.accountability_rounds r ON r.id = e.accountability_round_id
),
verified AS (
  SELECT c.id, c.evidence_id, nullif(btrim(c.reference_id), '') AS ref, c.transfer_amount,
         c.transaction_time, c.created_at, c.slip_type, c.gross_amount, c.paid_amount, c.discount_amount
  FROM public.slip_checks c
  WHERE c.status IN ('EXTRACTED', 'PARTIAL_EXTRACTED')
),
winners AS (
  SELECT DISTINCT ON (ref) id
  FROM verified
  WHERE ref IS NOT NULL
  ORDER BY ref, created_at, id
),
effective AS (                       -- selectEffectiveAmount
  SELECT v.id, ev.batch_id,
         CASE
           WHEN v.slip_type IN ('BANK_SLIP_QR', 'BANK_SLIP_NO_QR') THEN v.transfer_amount
           WHEN v.slip_type IN ('GWALLET', 'THAI_HELP_THAI') THEN coalesce(
             nullif(v.gross_amount, 0),
             CASE WHEN v.paid_amount > 0 AND v.discount_amount > 0 THEN v.paid_amount + v.discount_amount END,
             v.paid_amount)
         END AS amount
  FROM verified v JOIN ev ON ev.id = v.evidence_id
  WHERE ev.batch_id IS NOT NULL
),
batch_stats AS (
  SELECT batch_id, count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) AS median
  FROM effective WHERE amount > 0 GROUP BY batch_id
),
outliers AS (
  SELECT e.id
  FROM effective e JOIN batch_stats b USING (batch_id)
  WHERE e.amount > 0 AND b.n >= 5 AND e.amount >= 5000 AND b.median > 0 AND e.amount >= 10 * b.median
),
money AS (
  SELECT ev.business_date, ev.market, v.transfer_amount AS amount,
         v.ref IS NULL                         AS no_ref,
         v.id IN (SELECT id FROM winners)      AS winner,
         v.id IN (SELECT id FROM outliers)     AS outlier,
         CASE
           WHEN v.transaction_time IS NULL THEN 'missing'
           WHEN abs((v.transaction_time AT TIME ZONE 'Asia/Bangkok')::date - ev.business_date) > 1 THEN 'out_of_round'
         END AS date_problem
  FROM verified v JOIN ev ON ev.id = v.evidence_id
  WHERE v.transfer_amount IS NOT NULL
)
SELECT m.business_date,
       m.market,
       count(*) FILTER (WHERE NOT no_ref AND winner)                                         AS counted_before_n,
       coalesce(sum(amount) FILTER (WHERE NOT no_ref AND winner), 0)                         AS counted_before_amount,
       count(*) FILTER (WHERE NOT no_ref AND winner AND NOT outlier AND date_problem IS NULL) AS counted_after_n,
       coalesce(sum(amount) FILTER (WHERE NOT no_ref AND winner AND NOT outlier AND date_problem IS NULL), 0)
                                                                                             AS counted_after_amount,
       count(*) FILTER (WHERE NOT no_ref AND winner AND outlier)                             AS excluded_outlier_n,
       coalesce(sum(amount) FILTER (WHERE NOT no_ref AND winner AND outlier), 0)             AS excluded_outlier_amount,
       count(*) FILTER (WHERE NOT no_ref AND winner AND NOT outlier AND date_problem = 'out_of_round')
                                                                                             AS excluded_wrong_date_n,
       coalesce(sum(amount) FILTER (WHERE NOT no_ref AND winner AND NOT outlier AND date_problem = 'out_of_round'), 0)
                                                                                             AS excluded_wrong_date_amount,
       count(*) FILTER (WHERE NOT no_ref AND winner AND NOT outlier AND date_problem = 'missing')
                                                                                             AS excluded_missing_date_n,
       coalesce(sum(amount) FILTER (WHERE NOT no_ref AND winner AND NOT outlier AND date_problem = 'missing'), 0)
                                                                                             AS excluded_missing_date_amount,
       count(*) FILTER (WHERE no_ref)                                                        AS pending_no_reference_n_unchanged,
       count(*) FILTER (WHERE NOT no_ref AND NOT winner)                                     AS duplicate_reads_n_unchanged
FROM money m, params p
WHERE m.business_date BETWEEN p.from_date AND p.to_date
GROUP BY m.business_date, m.market
ORDER BY m.business_date, m.market;

-- Wallet slips (ไทยช่วยไทย / G-Wallet): never in the AI-verified transfer
-- total, before or after. Shown so the accounting-policy decision can be sized.
WITH params AS (
  SELECT date '2026-10-01' AS from_date, date '2026-11-02' AS to_date
)
SELECT coalesce(r.business_date, ((e.received_at AT TIME ZONE 'Asia/Bangkok') - interval '4 hours')::date) AS business_date,
       coalesce(nullif(btrim(e.market_label_normalized), ''), '(ไม่ระบุตลาด)')                              AS market,
       c.slip_type,
       count(*)                          AS checks_n,
       coalesce(sum(c.gross_amount), 0)    AS gross_sales_amount,
       coalesce(sum(c.paid_amount), 0)     AS customer_paid_amount,
       coalesce(sum(c.discount_amount), 0) AS programme_amount
FROM public.slip_checks c
JOIN public.slip_evidences e ON e.id = c.evidence_id
LEFT JOIN public.accountability_rounds r ON r.id = e.accountability_round_id
CROSS JOIN params p
WHERE c.status IN ('EXTRACTED', 'PARTIAL_EXTRACTED')
  AND c.slip_type IN ('GWALLET', 'THAI_HELP_THAI')
  AND coalesce(r.business_date, ((e.received_at AT TIME ZONE 'Asia/Bangkok') - interval '4 hours')::date)
      BETWEEN p.from_date AND p.to_date
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

ROLLBACK;
