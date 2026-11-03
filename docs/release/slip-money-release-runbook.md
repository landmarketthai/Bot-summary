# Release runbook: slip money integrity (#192 → #194 → #193 → manual approval)

**Nothing in this runbook is authorized yet.** Every step marked 🔒 needs explicit human approval. Production has not been touched by this work.

## 1. What ships, in order
| Step | Ref (verify before use) | Contents | Schema |
|---|---|---|---|
| 1 | PR #192 `fix/p0-slip-image-ordering-20261031` @ `8d88667` | LINE `#N` = LINE send order | none |
| 2 | PR #194 `fix/p0-slip-pending-amounts-20261102` @ `988ba4e` (stacked on #192) | AI-read / confirmed / pending in the LINE summary | none |
| 3 | PR #193 `feat/slip-ocr-gemini-eval` @ `d29cbf0` (stacked on #194) | Thai date parser, shared eligibility (date / outlier / reference) in every money path, Gemini **evaluation** tooling (not enabled) | none |
| 3a | **must be added to #193 before it ships**: commits from the local branch that fix #193 regressions — round-close `excluded` status (a wallet / outlier / missing-date slip no longer deadlocks ปิดรอบ via `ocr_pending`) and the ingestion race test | code + tests | none |
| 4 | local `feat/manual-slip-ai-approval-20261102` (not pushed; needs a PR) | AI approvals, manual-entry review, reference ownership, admin route `/api/admin/slip-reviews` | 3 migrations |

Migrations (step 4), in this order, all additive, each re-runnable except M1:
1. `20261102120000_slip_check_approval_link.sql` (M1): `slip_check_approvals`, `manual_slip_entries.reference_id`, review RPCs
2. `20261102130000_manual_slip_entry_review.sql` (M2): `requires_review`, manual-entry decisions, money-close lock trigger, append RPC (same signature)
3. `20261102140000_slip_review_hardening.sql` (M3): finalized = sending/sent/ambiguous, lock on re-claim UPDATE, round + day locks, ownership checks in RPCs, no direct writes by service_role

## 2. Required checks before each merge 🔒
- **CI green on the PR head:** `pg-tests` (incl. `financial-eligibility`, `slip-check-approval`, `uat-manual-approval`, `image-ingestion`), unit, typecheck, lint, Vercel build.
- **Known baseline (not caused by this work):** 13 unit failures on `main` `8a4cf4b` (7 migration-manifest drift, 3 finalize-slip-batches route, morning brief, preflight, white-sheet review turns). Any failure outside that list blocks the merge.

## 3. Database preflight (read-only) 🔒 before applying migrations
```sql
-- Nothing of ours exists yet:
SELECT to_regclass('public.slip_check_approvals');                              -- expect NULL
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'manual_slip_entries' AND column_name IN ('reference_id','requires_review'); -- expect 0 rows
-- Dependencies exist (P2E round columns, finalization statuses):
SELECT column_name FROM information_schema.columns
 WHERE table_name IN ('slip_evidences','manual_slip_sessions','settlement_finalizations')
   AND column_name = 'accountability_round_id';                                 -- expect 3 rows
SELECT to_regclass('public.accountability_rounds');                             -- expect not NULL
SELECT status, count(*) FROM public.settlement_finalizations GROUP BY 1;        -- snapshot for the record
-- No settlement is mid-flight (reviews and finalizations will share a lock):
SELECT count(*) FROM public.settlement_finalizations WHERE status = 'sending';  -- expect 0
```

## 4. Preserve existing financial snapshots
- Export `transfer_reconciliations` and `settlement_finalizations` (and the sent settlement messages if they are stored) **before** step 3 ships. #193 changes which AI slips count when a day is recomputed.
- Nothing here rewrites stored rows. However, `reconcile()` upserts `transfer_reconciliations` when it runs again for a past day, so re-running past days must wait until the historical audit has been reviewed.
- Reverting code does **not** restore a snapshot that was recomputed in the meantime. The export is the only restore source.

## 5. Historical impact audit (read-only) 🔒 before step 3 ships
`docs/sql/slip-eligibility-historical-audit.sql` gives, per day and market: counted before vs after, plus the excluded wrong-date, missing-date and outlier amounts, and the wallet slips that were never counted. It contains aggregates only. Run it with a read-only role and review the result with the accounting owner.

## 6. Enablement order
1. Deploy #192 → #194 → #193 (+3a). Watch one market day.
2. 🔒 Apply M1, M2, M3 (in order, in one maintenance window, with no settlement in `sending`).
3. Deploy step 4 code. Its loaders also tolerate the schema before migration (verified: no migration / M1 only), so code-first is safe. Migration-first is the recommended order.
4. 🔒 Give admins the review screen / route. Reviews are admin-only (`requireAdminActor`); there is no per-market admin model, so any admin can review any market.
5. 🔒 LINE grammar for manual slips, phase 1 (optional `อ้างอิง`), then phase 2 (`requires_review` for an entry without a **full** reference). **Business decision needed:** what counts as a full reference (minimum length / format). Partial-reference matching is not implemented and must not be.

## 7. Smoke tests after each step (local commands; production equivalents are read-only)
- Local: `ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/slips/uat-manual-approval.pg.test.ts` (12 scenarios).
- Production, read-only, for the first market day: compare the LINE "ยอดยืนยัน" with settlement `transferTotal` for the same day/market. The difference must equal the wallet gross amounts plus the slips listed as pending/excluded.

## 8. Metrics / alerts that indicate wrong money
- The same full reference counted in more than one money row (`supersededByManualCount` > 0 is normal; a reference that is both a counted manual entry and an attributed AI row is a defect). Detect it with the audit SQL extended per reference.
- `settlement_finalizations` stuck in `sending` for more than 10 minutes. It now also blocks reviews for that round.
- A rising count of `excluded` / pending slips per day after #193 (expected: misdated, undated and wallet slips) with no matching approvals or manual slips. That is money nobody settled.
- Round close blocked by `ocr_pending` with no NEED_REVIEW slip (should no longer happen after 3a).

## 9. Rollback
| Situation | Action | Limits |
|---|---|---|
| step 4 code misbehaves | revert the code; keep the schema | The old code ignores decisions: **a rejected AI slip counts again**, an approved misdated slip is excluded again, and a `requires_review` manual entry counts as ordinary money. If phase 2 of the grammar is on, turn it off first. |
| schema must go | M3 down → M2 down → M1 down (`supabase/rollback/…down.sql`) | They drop functions and triggers only; every decision row, `reference_id` and `requires_review` is kept. M1 cannot be re-applied after its down file (it creates the table without IF NOT EXISTS). Re-forward from M2 instead, or drop the table after an approved export. |
| #193 misbehaves | revert #193 (+3a) | Money returns to the pre-#193 rules (misdated / undated / outlier AI slips count again). Recomputed snapshots stay recomputed (see §4). |

**Immediate-rollback triggers:** a reference counted twice in one day; LINE "ยอดยืนยัน" lower than settlement bank money for the same scope; reviews landing after a finalization reached `sent`; ปิดรอบ blocked for a reason no operator can resolve.

## 10. Human approvals required
- 🔒 Merge #192, #194, #193 (+3a), and open/merge a PR for step 4
- 🔒 Production read-only audit (§5) and snapshot export (§4)
- 🔒 Apply M1–M3 to Production
- 🔒 Wallet / Thai Help Thai accounting policy (not implemented; wallet amounts stay out of bank-transfer money)
- 🔒 Full-reference format for the LINE grammar (phase 2)
- 🔒 Gemini: evaluation only. No Production model change has been requested or made.

## Addendum: migration M4 and the second review
- **Migrations are now four:** add `20261102150000_slip_reference_scope.sql` (M4) after M3. Rollback order: M4 → M3 → M2 → M1 (each `.down.sql` keeps every row).
- **🔒 Approve the BR-02 rule change:** a reference that already exists on another slip can no longer be assigned to a pending check.
- **Monitor:** `settlement_finalizations` rows `failed` after a push attempt (limit 3 in `docs/manual-slip-ai-approval.md`), and AI references held by more than one check (limit 2).

## Addendum: migration M5 and the third review
- **Migrations are now five:** add `20261102160000_finalization_claim_order.sql` (M5) after M4. It adds `settlement_finalizations.money_claimed_at` and replaces the finalization trigger function, which now takes one global lock and stamps the claim time in the database. It also pins `normalize_slip_reference` to an explicit character list. Apply M1–M5 in one window, with no settlement in `sending`.
- **Rollback order:** revert the app code first, then M5 → M4 → M3 → M2 → M1. Every row is kept, including `money_claimed_at`.
- **🔒 Sign off the rule:** a cross-scope duplicate (an AI read and a manual entry with the same full reference) goes to the scope that finalizes first. See `docs/manual-slip-ai-approval.md`, third review.
- **Still gated:** the AI-vs-manual path stays dormant until LINE grammar phase 1 writes `manual_slip_entries.reference_id`. Nothing in Production writes it today.

## Addendum: M6 persisted credits (supersedes the round-4 blocker)
- **Migrations are now six:** add `20261103100000_slip_reference_claims.sql` (M6) after M5. It creates `slip_reference_claims` (append-only, RLS on, SELECT only for service_role), adds `settlement_finalizations.claims_recorded_at` and the `claim_slip_references` RPC, and makes reviews refuse targets whose reference is credited (`slip_reference_credited`, HTTP 409).
- **Order: schema first.** Apply M1–M6 in one window with no settlement in `sending`, then deploy the code.
  - New code without M6: the RPC is missing, so nothing is credited and the preview rule applies (proven: the `CLAIMS_BASELINE=1` run finalizes normally).
  - Old code with M6: credits are ignored.
- **Preflight (read-only):**
  - `SELECT to_regclass('public.slip_reference_claims')` → NULL before applying.
  - `SELECT count(*) FROM settlement_finalizations WHERE status = 'sending'` → 0.
  - `SELECT count(*) FROM manual_slip_entries WHERE reference_id IS NOT NULL` → 0 (no manual references exist yet).
- **Accounting impact:**
  - **History:** no history is recalculated. Finalizations before M6 have no credits.
  - **From the first settlement after deploy:**
    - Each referenced AI or manual money row is credited once.
    - A late image or entry with a reference, arriving in an already-settled scope, is pending instead of silently changing that day's live total.
    - A duplicate in another market is superseded.
  - **Unreferenced manual entries** are unchanged.
- **Rollback:** revert the code first, then M6 → M5 → M4 → M3 → M2 → M1.
  - The M6 down file keeps `slip_reference_claims` and every row (the audit record of what was credited). It drops only the RPC, the canonical-form check and the review guards.
- **Monitor:**
  - `SELECT count(*) FROM slip_reference_claims` grows with settlements.
  - `slip_reference_credited` refusals in the admin route logs.
  - Finalizations stuck in `failed` that hold credits (`claims_recorded_at IS NOT NULL`). Their retry re-sends the credited total.
- **🔒 Still to approve:**
  - BR-02 (an existing reference cannot be given to another check).
  - The full-reference format for LINE grammar phase 1. Grammar phase 1 is no longer blocked by the round-4 P1s.
  - Wallet policy.
  - Commit 3a in #193.
- **Finalizer row key (round 6):** the re-claim and re-fetch queries now always filter `(source, date, round ?? null)`. A no-round finalization can no longer take another round's `failed` row. This code-only fix also applies without M6.
- **Evidence:** `docs/uat/slip-money-uat.md` has the 12 UAT scenarios plus the credit scenarios through the real finalizer, all PASS.
