# P0 failed-return sales integrity — 2026-10-08 (local-only)

## Scope and safety
Branch `fix/failed-return-sales-integrity-20261008`, base `9f0887936b76025cbf33e2aca446703808e9856b`.
No production write, migration, record repair, remote push, merge or deploy was performed.
Incident context (not re-verified here): 2026-10-07 pending session `4e0d5ed6-a3f3-4ee4-acd2-7faff90fa57b`, `failed_closed`, null round, partial capture. Separate 2026-09-22 incident needs independent investigation.

## Local mitigation
- Attempt safe round binding for partially parsed returns before early refusal / finalizer. Nothing failed is booked to produce items.
- Read-only fallback identifies active unbound returns with exact LINE source, date, seller and normalized market. Multiple candidate rounds are protected, not silently selected.
- Sales loader reuses lifecycle classification so a proven subsequent successful resend can clear a failed attempt; unidentifiable active returns demote confirmed sold quantities and value to pending.
- Legitimate withdrawals without any return attempt retain current sold-out business policy.
- Morning Brief LINE and financial-section PDF pages warn if SalesReport.valueAuthoritative is false.
- Settlement LINE hides shortage/excess and expected-remittance conclusions unless produce status is complete; submitted transfer/cash observations remain visible.

## Verified local tests (2026-10-08)
- Existing red regression demonstrated `none` for an unbound failed return; it became `blocked` after the change.
- P0-targeted tests: 15 passed, 0 failed.
- Sales/round/settlement/Morning Brief focused suite: 255 passed, 1 failed (separate existing PDF purchase-content assertion, isolated reproduction).
- Pending-finalizer and webhook-focused 7 suites: 0 failures.
- Typecheck: passed.
- ESLint: exit 0, 0 errors; 69 warnings reported before latest tests (existing unused symbols).
- `git diff --check`: passed at last check.
- Production build: compilation and TypeScript passed; Next.js prerender `/overview` failed because isolated worktree lacks Supabase environment configuration (`supabaseUrl is required`).

## Remaining release blockers — DO NOT DEPLOY
1. **Digital White Sheet / cash finalization** calculates independently from SalesReport and may still label failed returns as a trusted shortage/overage; must add round/failure-aware hard stop at page, LINE finalization and API boundaries, with regression tests.
2. **Legacy financial-summary/dashboard and daily summary** still use withdrawal-minus-zero without active failed-return reconciliation. Assess active routes and stop certification of figures until guarded.
3. **04:00 undated, unbound cross-day return** may be attributed to next business day by ingest event time; the previous day's return attempt is not proven. Must add a negative test and a no-guess cross-day guard.
4. **Morning Brief legacy purchase/PDF tests** have independent failures (PDF purchase status content and service section keys). Do not call whole regression green until separately baselined/fixed.
5. **Build** blocked by missing isolated-worktree runtime env. Do not use Production secrets just to green a build.
6. **Production evidence** needs read-only verification of the 7 Oct incident, separate 22 Sep case, and whether LINE/Morning Brief was actually sent incorrectly. No claim has been made that it was.
7. Complete smoke UAT and compare deployment against Production revision once access is restored; do not push or deploy without explicit authorization.

Any unresolved/ambiguous financial evidence must remain **รอตรวจสอบ** and must never be inferred as a confirmed sale.
