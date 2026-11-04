# Isolated UAT — slip money end to end (2026-11-03T04:44:35.210Z)

Local PostgreSQL 17, business date 2026-11-03 (slip date 3/11/2569). Real webhook, ledger, recovery, LINE summary builder, money loaders, round-close rows, admin route and review RPCs; simulated LINE download/Storage/OCR provider only.

| # | Scenario | Input | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|---|
| 1 | Failed download recovered; redelivered webhook not duplicated | 7 images, #3 download fails once, #1 delivered twice | `{"evidences":7,"distinctMessages":7}` | `{"evidences":7,"distinctMessages":7}` | PASS | slip_evidences / slip_image_events |
| 2 | LINE summary: confirmed vs readable-but-pending (outlier listed, not summed) | U1 batch | `{"confirmed":270,"pending":90}` | `{"confirmed":270,"pending":90}` | PASS | finalizer LINE push text (confirmed includes the ไทยช่วยไทย gross 100 — wallet policy pending) |
| 3 | Duplicate reference across markets | UAT-1 read in U1 and U2 | `{"u2LineConfirmedIsAbsent":true,"u2Money":0}` | `{"u2LineConfirmedIsAbsent":true,"u2Money":0}` | PASS | LINE U2 text + loader |
| 4 | Bank money before review: wrong date, no date, outlier, wallet all excluded | U1 | `{"attributed":170,"pendingDate":90,"pendingOutlier":50000}` | `{"attributed":170,"pendingDate":90,"pendingOutlier":50000}` | PASS | loadMarketScopedAiVerifiedTransfers |
| 5 | Manual: same reference as AI superseded; legacy counted; new unreferenced pending | 70(UAT-5) + 30 + 25(review) | `{"total":30,"superseded":1,"pending":25}` | `{"total":30,"superseded":1,"pending":25}` | PASS | loadMarketScopedManualSlipBreakdown |
| 6 | Non-admin cannot review | operator session | `{"status":403}` | `{"status":403}` | PASS | POST /api/admin/slip-reviews |
| 7 | Admin approves misdated AI slip (reviewer = verified admin) | approve UAT-2 at 50 | `{"status":200,"reviewer":"admin@uat.test","attributed":220}` | `{"status":200,"reviewer":"admin@uat.test","attributed":220}` | PASS | route + review_slip_check + loader |
| 8 | Repeated approval request is idempotent | same request twice | `{"status":200,"already":true}` | `{"status":200,"already":true}` | PASS | route |
| 9 | Checked total after reviews (AI + manual), counted once | after approvals | `{"ai":220,"manual":55,"checked":275}` | `{"ai":220,"manual":55,"checked":275}` | PASS | loaders used by White Sheet / settlement / round close |
| 10 | Round-close rows: verified rows sum to the AI money; excluded rows do not block | U1 rows | `{"verifiedSum":220,"blockingRows":0}` | `{"verifiedSum":220,"blockingRows":0}` | PASS | loadGuidedSlipRows |
| 11 | Reject excludes; revoke restores the automatic rule | UAT-4 reject then revoke | `{"afterReject":160,"afterRevoke":220}` | `{"afterReject":160,"afterRevoke":220}` | PASS | route + loader |
| 12 | Review after the round entered finalization is refused | approve UAT-3 after close | `{"status":409,"error":"slip_check_round_finalized","ai":220}` | `{"status":409,"error":"slip_check_round_finalized","ai":220}` | PASS | route + money-close lock |

**12/12 PASS**

## Credit scenarios: real `tryFinalizeSettlement`, mock LINE (`reference-claims.pg.test.ts`)

"Handed out" means the checked totals of the messages LINE actually delivered. A retry with the same retry key is not re-delivered.

| Scenario | Before | Expected handed out | Actual handed out | Reference | Credited owner | Finalized totals unchanged | Result |
|---|---|---|---|---|---|---|---|
| P1-1 late claim vs legacy day stamp | 0 | 70 | 70 | P11-R | P11-CA | yes | PASS |
| P1-2 push timeout then retry | 0 | 70 | 70 | P12-R | P12-CA | yes | PASS |
| P1-2b owner push timeout, credit kept | 0 | 70 | 70 | P2B-R | P2B-CB | yes | PASS |
| P1-3 reject AI then approve M2 (approval: manual_entry_is_duplicate) | 0 | 70 | 70 | P13-R | P13-CA | yes | PASS |
| cross-market AI vs manual (AI earlier) | 0 | 55 | 55 | XA-R | XA-B | yes | PASS |
| concurrent credit of one reference | 0 | 1 | 1 | CC-R | CC-1 | yes | PASS |
| manual session closed after settlement | 0 | 61 | 61 | SC-R | SC-A | yes | PASS |
| late image after settlement | 20 | 20 | 20 | LT-R2 | — | yes | PASS |
| round 5 A: day view vs round view overlap | 0 | 70 | 70 | OV-R | OV-S | yes | PASS |
| round 5 B: retry after delivered push | 70 | 70 | 70 | RT-Y | — | yes | PASS |
| round 6: no-round retry vs another round's failed row | 70 | 70 | 70 | XR-R | XR-S | yes | PASS |
| P0-A no credit RPC: fail closed, then recover | 0 | 70 | 70 | NA-R | NA-B | yes | PASS |
| P0-B late manual ฿30 after settlement | 70 | 70 | 70 | — | refused | yes | PASS |
| P0-C maintenance stop then resume | 0 | 70 | 70 | MT-R | MT-A | yes | PASS |

**Before the fix:**
- **HEAD 0788766** (derived ownership, the same real-finalizer scenarios): P1-1, P1-2 and P1-3 each hand out ฿140 for one ฿70 transfer, and the finalized totals change.
- **New code without the credits table** (baseline run): 6 of 8 scenarios still fail:
  - P1-3: ฿140.
  - Session closed after settlement: ฿122.
  - Late image: ฿45 instead of ฿20.
  - Day/round overlap: ฿140.
  - Retry after a delivered push: the snapshot moved.

## Coverage of the required UAT flows

| Flow | Evidence (all real PostgreSQL 17 unless noted) |
|---|---|
| 1 Correct bank slip → confirmed | rows 2, 4 above |
| 2 Wrong printed date → pending → admin correction | rows 4, 7 |
| 3 Missing date/time → pending | rows 2, 4, 12 |
| 4 High-value outlier → pending | rows 2, 4; `financial-eligibility.pg.test.ts` |
| 5 Duplicate reference across markets | row 3; `slip-check-approval.pg.test.ts` (cross-market approval refused) |
| 6 AI + Manual duplicate reference | row 5; `reference-ownership.test.ts` (10 cases); `slip-check-approval.pg.test.ts` |
| 7 New manual entry without reference | rows 5, 9 |
| 8 Approve / Reject / Revoke | rows 7, 11 |
| 9 Concurrent approval and closing a round | row 12; `slip-check-approval.pg.test.ts` close-race tests (in-flight INSERT and failed→sending UPDATE hold the lock; the review waits, then refuses) |
| 10 Late-arriving image bound to a round | `review-slip-scope.test.ts` (fake DB: round-bound late image listed and counted) |
| 11 Failed image ingestion followed by recovery | row 1; `image-ingestion.pg.test.ts` bounded-pass test (15 then 10, never finalized early) |
| 12 Legacy unreferenced manual entry | row 5 (counted, known limitation); `slip-check-approval.pg.test.ts` |
| 13 Repeated webhooks / API requests | rows 1, 8 |
| 14 Code/schema version mismatch | `slip-check-approval.pg.test.ts` (new code on no migration / M1 only); old-code probe (#193 code on M1, M1+M2, M1+M2+M3: 3/3); M0–M7 forward + rollback chain M7 → M6 → M5 → M4 → M3 → M2 → M1 in `slip-check-approval.pg.test.ts` (M0 down refuses while credits exist); pre-M1 stop, locked stop, immutable manual slips, E1–E7 register and pilot allowlist in `reference-claims.pg.test.ts` |
| 15 Settlement and White Sheet totals compared with LINE | rows 2, 9, 10. LINE "ยอดยืนยัน" (270) = bank money (170 before review) + the ไทยช่วยไทย gross (100): wallet amounts are confirmed in LINE but never bank-transfer money, pending the wallet accounting decision |
