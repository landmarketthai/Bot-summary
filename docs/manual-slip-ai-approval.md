# Manual slip ↔ AI slip: one transfer, counted once

Status: local branch `feat/manual-slip-ai-approval-20261102`, stacked on #193. **No PR. Not in the #193 release.** Migration `20261102120000_slip_check_approval_link.sql` is **not applied anywhere but local PG**. Production apply requires an approved deploy plan.

## Problem (pre-existing)
`manual_slip_entries` = amount + raw line. No reference, no link to `slip_checks`. Reconciliation adds `ai_verified_total + manual_slip_total`, so a slip keyed manually after the AI counted it is counted twice. Before this branch (PG, same rows):

| Case | Before | After |
|---|---|---|
| AI counted 70, manual entry for the same slip | 140 | 70 (when the entry carries the reference) |
| AI misread the date (pending), operator approves | not possible (only re-keying) | 50, counted once, with reviewer and reason |
| Operator rejects a wrong AI read | not possible | 0 |

## Model
1. **`slip_check_approvals`**: an operator decision **on an AI check**.
   - Fields: `approved` + amount, or `rejected`; `reason`, `reviewer`, `status`.
   - One active decision per check: partial unique index plus a `FOR UPDATE` on the check.
   - Append-only: a trigger forbids DELETE and every UPDATE except active → revoked (with revoker and reason).
   - This is the manual approval path. It **never creates a second money row**: the loader counts the approved amount in place of the AI read.
2. **`manual_slip_entries.reference_id`**, optional: separates "a slip that has no AI check" from "a slip the AI already has".
   - An entry whose reference is an AI-verified check is **not counted**; the AI check or its approval is the money row.
   - Legacy rows stay `NULL`. **Nothing is back-linked by guessing.**
3. **RPCs** (service role only):
   - `review_slip_check`, `revoke_slip_check_review`. They refuse when:
     - the check is not verified or has no transfer amount;
     - it has **no reference** (BR-02 route first);
     - it is **not the global winner** (a cross-market/batch duplicate);
     - the round/day is **already finalized** (`settlement_finalizations`);
     - a different live decision exists.
   - Same decision repeated = idempotent.

## Loader (one money row per transfer)
`aggregateGloballyAcceptedVerifiedTransfers`, for each global winner:
- rejected → 0;
- approved → `approved_amount`, past the date/outlier rules;
- otherwise → the #193 automatic rules.

Manual totals (`computeManualSlipTotal`, `loadMarketScopedManualSlipTotal`) skip entries whose reference is an AI-verified check.

Both are tolerant before the migration: a missing table/column means "no decisions / no references". Code can therefore ship before or after the migration, and the migration can be rolled back without breaking reads.

## What UNIQUE alone would NOT fix: the remaining limit
A manual entry **without** a reference has nothing tying it to an AI check. This covers every legacy row and today's LINE grammar (`ยอด 50`). If such an entry re-keys a slip the AI already counted, it is still counted twice. `reconciliation.test.ts` pins this (`it.failing`, "LIMIT").

Closing it needs the LINE UX below. A heuristic (same amount, same day) would be a guess, so it is not used.

## LINE UX proposal (not enabled; needs approval before use)
- **AI slip pending (date/outlier/review):** the operator does **not** key a manual slip. An admin approves or rejects the AI check, either from the admin dashboard pending list (recommended first) or later with a LINE admin command such as `อนุมัติสลิป #4 50 เหตุผล ภาพเป็น 29 ต.ค.`. `#N` is the verified LINE-order number from #192, and the command refuses `#N?`.
- **Slip with no image / no AI check:** `สลิปมือ` as today, plus a reference: `ยอด 50 อ้างอิง 0123456789`.
  - Phase 1: optional, and the bot warns when it is missing.
  - Phase 2: required, unless the operator types `ไม่มีอ้างอิง`. Such an entry is counted, but listed as "ตรวจซ้ำกับ AI ไม่ได้".
- The parser and the append RPC write `reference_id` only after this UX is approved; the column is unused until then.

## Tests
`slip-check-approval.pg.test.ts` (PG 17, real migration):
- approval of a misdated slip;
- approval plus a manual entry with the same reference;
- a manual entry referencing an auto-counted AI slip;
- reject and revoke;
- **concurrency** (two different decisions → one active; three identical → one row);
- **cross-market duplicate** refused;
- **no reference** refused;
- **after finalization** (no review, no revoke, no manual entry);
- append-only audit; legacy entries untouched;
- rollback keeps every decision row.

All 11 pass; on the #193 code without this branch, 6 fail (e.g. 140 instead of 70).

## Deploy order (for approval; nothing applied)
1. Release #192 → #194 → #193 (no migration).
2. Apply `20261102120000_slip_check_approval_link.sql` to Production. It is additive: a new table, a nullable column and new functions. No existing row changes.
3. Deploy this branch's code.
4. Enable the admin approval surface, then the LINE grammar (UX phases).

## Rollback
- **Code:** revert. The loaders ignore approvals and references, and money returns to the #193 rules.
- **Database:** `supabase/rollback/20261102120000_slip_check_approval_link.down.sql` drops the RPCs only. **Decision rows and `reference_id` are kept** (financial audit). Dropping them is a separate, approved step after export.
