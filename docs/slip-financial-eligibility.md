# Slip financial eligibility: one rule for LINE and money totals

Status: PR #193 (draft). Not merged, not deployed. Production data was neither read nor changed.

## Where AI slip money is counted
Every AI-verified money total reads `aggregateGloballyAcceptedVerifiedTransfers` (`src/lib/reconciliation.ts`):

| Consumer | Figure |
|---|---|
| `reconcile()` | `ai_verified_total` → `transfer_reconciliations`, export, dashboard, LINE settlement message |
| White Sheet `load.ts` | `verifiedTransfers` |
| Daily settlement | `transferTotal` → `expected_cash` |
| Guided round close | `aiVerifiedTotal` and the per-slip rows |

## The rule (`src/lib/slips/financial-eligibility.ts` + the LINE outlier guard)
An AI slip counts only if it passes every check below. Otherwise it is pending, never auto-counted.

| Check | Same as LINE | Pending bucket |
|---|---|---|
| Verified status and `transfer_amount` present | yes | not loaded |
| Reference id present (BR-02) | yes (LINE now matches) | `pendingReference` |
| Global winner: earliest verified check per reference. A suspended winner never falls through to a later duplicate | in-batch + global | duplicate, not counted |
| Not suspended by the batch outlier guard: the same `computeValidationFlags` re-run on the same stored batch | yes | `pendingOutlier` |
| Printed date (Bangkok) within ±1 day of the business date; missing = not eligible; receipt time not used | yes | `pendingDate` |

The scope rule is unchanged. A round-bound slip belongs to its round however late the image arrives, and unbound slips use the 04:00 receipt window. Round-close rows now use exactly this scope and rules, so every `verified` row is in the total and nothing else is.

## Manual slip sessions: BLOCKER (pre-existing)
`manual_slip_entries` stores only an amount and the raw line. There is no reference and no link to `slip_checks`. If an operator keys a slip that the AI already counted, `checked_slip_total` counts it twice. `src/lib/reconciliation.test.ts` pins this as `it.failing`.

The shared rule makes the manual path the only way to settle a misread slip, so this risk now matters more. Fix options, none implemented:
1. **Process only (no code):** key manually only the slips listed as pending (`pendingDate` / `pendingOutlier` / no reference) in the White Sheet, settlement or round-close output. This is not enforceable.
2. **No migration:** require a reference in the manual line (e.g. `ยอด 50 อ้างอิง 0123`). Reconciliation would parse it from `raw_line`, and any entry whose reference equals a counted AI winner is excluded and flagged. Lines without a reference stay as today. This is partial protection that depends on operator input.
3. **Recommended, needs an approved migration:** a `manual_slip_entries.slip_check_id` (or reference) column, unique per check. The manual approval of a pending AI check is written as a link, with reviewer and reason, and is counted once in place of the AI check. This also gives the reviewer + reason audit trail.

## Thai Help Thai / G-Wallet accounting (proposal for review, not implemented)
What the receipt shows:

| Field | Meaning | Who pays | When the merchant receives it |
|---|---|---|---|
| `gross_amount` / headline `ยอดรับรวม` | sale value of the goods | customer + programme | — |
| `paid_amount` (`G-Wallet`) | customer's share | customer, from their wallet | into the merchant's programme wallet (not the bank transfer the seller reports) |
| `discount_amount` (`สิทธิโครงการฯ`) | programme subsidy | government | later, by programme settlement |

Today the LINE summary confirms the gross amount, but reconciliation never counts wallet slips (`transfer_amount IS NOT NULL`). So `expected_cash` treats the whole sale as cash the seller should hand over, which overstates expected cash.

Proposed policy:
- **Sales:** `gross_amount` is sale value. That is consistent with the White Sheet sales side.
- **Never mix into bank `transfer_total`.** Report a separate non-cash line, `wallet_receipts = paid_amount + discount_amount` (and show `gross_amount` only when both parts are absent).
- **`expected_cash = sales − bank transfers − wallet_receipts − owner_cash − expenses − wages`**, only after the settlement form or white sheet has a field for wallet receipts to reconcile against.
- **Same eligibility rule as bank slips:** reference, date, outlier, duplicate. The programme part is a receivable and could also be tracked separately.

This needs an accounting owner's approval and a settlement input for wallet receipts before any code change. Size of the effect: query 2 of the audit SQL.

## Historical audit
`docs/sql/slip-eligibility-historical-audit.sql` is SELECT-only, inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`, and aggregate-only (no names, account or reference ids).
- **Query 1:** per business date and market, counted before vs after, plus the excluded wrong-date, missing-date and outlier amounts.
- **Query 2:** wallet slips that were never counted.
- It is verified against the same PG rows as the TypeScript loaders (`financial-eligibility.pg.test.ts`).
- **Not run on Production.** That needs approval.
