-- Slip money exception register. READ-ONLY, aggregates and ids only (no slip
-- images, no customer data). Run with a read-only role BEFORE accepting a
-- settlement and daily during the pilot. Every row is an exception an
-- operator must explain; an empty result means nothing to explain.
--
-- Window: business days from `register.from_day` (default: 7 days back):
--   SET register.from_day = '2026-11-01';
--
-- Checks:
--   E1 credited_not_delivered   credits recorded, settlement failed or stuck in sending > 10 min
--   E2 sent_without_credits     settlement sent after the credits migration but recorded no credits
--   E3 credit_exceeds_stored    credited amount > the reconciliation total the message was built from
--   E4 late_referenced_slip     verified referenced slip in a settled scope, not credited anywhere
--   E5 day_round_credit_split   round-bound slip credited by the legacy day settlement (or the reverse)
--   E6 manual_after_settlement  manual entry created after its scope settled
--   E7 live_vs_stored           stored reconciliation differs from the credited + unreferenced money
--                               (credited rows are final; compare with the White Sheet live view)

WITH params AS (
  SELECT coalesce(nullif(current_setting('register.from_day', true), '')::date, current_date - 7) AS from_day
),
fin AS (
  SELECT f.* FROM public.settlement_finalizations f, params p WHERE f.business_date >= p.from_day
),
credited AS (
  SELECT c.finalization_id, sum(c.amount) AS amount, count(*) AS refs
  FROM public.slip_reference_claims c JOIN fin f ON f.id = c.finalization_id
  GROUP BY c.finalization_id
),
ev AS (
  SELECT e.id, e.source_id, e.accountability_round_id,
         ((e.received_at AT TIME ZONE 'Asia/Bangkok') - interval '4 hours')::date AS receipt_day
  FROM public.slip_evidences e, params p
  WHERE ((e.received_at AT TIME ZONE 'Asia/Bangkok') - interval '4 hours')::date >= p.from_day
)
SELECT 'E1 credited_not_delivered' AS check_name, f.source_id, f.business_date, f.accountability_round_id,
       format('status=%s claimed_at=%s credited=%s', f.status, f.claimed_at, coalesce(c.amount, 0)) AS detail
FROM fin f LEFT JOIN credited c ON c.finalization_id = f.id
WHERE f.claims_recorded_at IS NOT NULL
  AND (f.status = 'failed' OR (f.status = 'sending' AND f.claimed_at < now() - interval '10 minutes'))

UNION ALL
SELECT 'E2 sent_without_credits', f.source_id, f.business_date, f.accountability_round_id,
       format('status=%s sent_at=%s', f.status, f.message_sent_at)
FROM fin f
WHERE f.status = 'sent' AND f.claims_recorded_at IS NULL
  AND f.message_sent_at > (SELECT min(created_at) FROM public.slip_reference_claims)

UNION ALL
SELECT 'E3 credit_exceeds_stored', f.source_id, f.business_date, f.accountability_round_id,
       format('credited=%s stored_checked=%s', c.amount, r.checked_slip_total)
FROM fin f JOIN credited c ON c.finalization_id = f.id
JOIN public.transfer_reconciliations r
  ON r.source_id = f.source_id AND r.business_date = f.business_date
 AND r.accountability_round_id IS NOT DISTINCT FROM f.accountability_round_id
WHERE round(c.amount * 100) > round(r.checked_slip_total * 100)

UNION ALL
SELECT 'E4 late_referenced_slip', f.source_id, f.business_date, f.accountability_round_id,
       format('check=%s ref=%s amount=%s', k.id, k.reference_id, k.transfer_amount)
FROM fin f
JOIN ev ON ev.source_id = f.source_id
       AND ((f.accountability_round_id IS NOT NULL AND ev.accountability_round_id = f.accountability_round_id)
         OR (f.accountability_round_id IS NULL AND ev.receipt_day = f.business_date))
JOIN public.slip_checks k ON k.evidence_id = ev.id
WHERE f.claims_recorded_at IS NOT NULL
  AND k.status IN ('EXTRACTED', 'PARTIAL_EXTRACTED') AND k.transfer_amount IS NOT NULL
  AND public.normalize_slip_reference(k.reference_id) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.slip_reference_claims c WHERE c.reference_id = public.normalize_slip_reference(k.reference_id))

UNION ALL
SELECT 'E5 day_round_credit_split', f.source_id, f.business_date, f.accountability_round_id,
       format('ref=%s check=%s evidence_round=%s', c.reference_id, c.slip_check_id, ev.accountability_round_id)
FROM public.slip_reference_claims c
JOIN fin f ON f.id = c.finalization_id
JOIN public.slip_checks k ON k.id = c.slip_check_id
JOIN ev ON ev.id = k.evidence_id
WHERE ev.accountability_round_id IS DISTINCT FROM f.accountability_round_id

UNION ALL
SELECT 'E6 manual_after_settlement', s.source_id, s.business_date, s.accountability_round_id,
       format('entry=%s amount=%s created=%s settled=%s', m.id, m.amount, m.created_at, coalesce(f.claims_recorded_at, f.claimed_at))
FROM public.manual_slip_entries m
JOIN public.manual_slip_sessions s ON s.id = m.session_id
JOIN fin f ON f.source_id = s.source_id AND f.business_date = s.business_date
          AND (f.accountability_round_id IS NULL OR f.accountability_round_id = s.accountability_round_id)
WHERE f.status IN ('sending', 'sent', 'ambiguous')
  AND m.created_at > coalesce(f.claims_recorded_at, f.claimed_at)

UNION ALL
SELECT 'E7 live_vs_stored', f.source_id, f.business_date, f.accountability_round_id,
       format('stored_checked=%s credited=%s unreferenced_manual_now=%s', r.checked_slip_total, coalesce(c.amount, 0), coalesce(u.amount, 0))
FROM fin f
JOIN public.transfer_reconciliations r
  ON r.source_id = f.source_id AND r.business_date = f.business_date
 AND r.accountability_round_id IS NOT DISTINCT FROM f.accountability_round_id
LEFT JOIN credited c ON c.finalization_id = f.id
LEFT JOIN LATERAL (
  SELECT sum(m.amount) AS amount
  FROM public.manual_slip_entries m JOIN public.manual_slip_sessions s ON s.id = m.session_id
  WHERE s.source_id = f.source_id AND s.business_date = f.business_date AND s.status = 'closed'
    AND (f.accountability_round_id IS NULL OR s.accountability_round_id = f.accountability_round_id)
    AND public.normalize_slip_reference(m.reference_id) IS NULL
) u ON true
WHERE f.status = 'sent' AND f.claims_recorded_at IS NOT NULL
  AND round((coalesce(c.amount, 0) + coalesce(u.amount, 0)) * 100) <> round(r.checked_slip_total * 100)

ORDER BY 1, 2, 3;
