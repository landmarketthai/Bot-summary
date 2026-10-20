# PR #182 — Independent Codex cross-check, 17 Oct 2026

Reviewed exact commit 11854d80c3ffee2af1825ae5593bf2316b7eead5. Verdict FAIL. Work ONLY in isolated worktree; NO Production, real LINE, UAT, migration application outside disposable local PG, merge, push or deploy. Prioritize correctness and safety. Review evidence is reproduced against code in disposable PG17/memory, not Production. Every defect below needs a regression test and clear disposition.

## 3 P0 (must fix prior to any UAT)

1. Accounting RPC failure/throw in src/lib/slips/batch-finalizer.ts:685 returns null; missingImages=accounting?.incomplete??0 at ~612. Reproduced with 2 received, 1 attached/OCR success, 1 failed_permanent and RPC error 57014 -> summary without missing notice, status completed, failed_count=0. **Fail closed**: no financial summary/complete status while accounting unavailable on ledger-enabled DB. Distinguish legacy schema from transient errors with appropriate deployment prerequisite. Add real-finalizer tests for both RPC errors and throws.

2. Same webhook containing [open session, image1, image2, image3]: processEvents() queues receipts BEFORE executing open command, trigger finds no existing batch -> no ledger, legacy path. Reproduced 0 ledger, 1 evidence, image3 lost, all queue processed, completed summary, when second image fails. **Durably record ALL relevant image receipts** even before the session exists and bind to session by LINE ordering/timestamps after the open. Don't rely on session existing at queue insertion. Add real processEvents test for same webhook payload with middle failure.

3. Trigger insert failure caught via EXCEPTION WHEN OTHERS -> queue receipt proceeds without ledger; begin_slip_image_attempt() any error including RPC timeout -> no_ledger/legacy. Reproduced 3 images, middle failure => invisible lost image, completed; begin timeout on post-close image lets it attach old batch. **No legacy fallback for transient DB errors** and no silent discard. Ensure finalizer reconciles all eligible receipts, and unsupported legacy schema is explicit operational gate. Add failed-trigger and RPC-error regressions.

## 5 P1

4. list_slip_ocr_redrive() is read-only list without atomic claim/lease, SlipCheckService upsert writes PROCESSING/FAILED over successful previous check; concurrent workers stale after finalize can overwrite checks. Add atomic claim/fencing and guard terminal/finalized updates. Test real SlipCheckService with concurrent workers.

5. Scheduler actually .github/workflows/finalize-slip-batches.yml every 5 min, vercel.json crons=[]; stated <=1 min does not exist. With recovery at 0/300/600 s, only 3 of 5 attempts before 600s forced finalize. Scheduled GitHub Actions may be delayed hours. Design truthful/compatible scheduler and retry policy, document actual bound, CI for cadence/time simulation; do not change Production scheduler or deploy.

6. begin lease lacks ownership token: after A expires and B starts, stale A fail clears B lease; C can claim attempt3. Add claim_token/fencing to begin/attach/fail RPC and tests.

7. Dual schema compatibility claim false: new app on old schema fails opening/closing because new columns absent; old app on new schema ignores receipt ledger and claim won't finalize until >600s. Enforce migration prerequisite or robust graceful handling plus safe rollback protocol with in-flight batches. Test both new+old schema and old+new schema lifecycle; avoid false compat claims.

8. recoverSlipIngest({budgetMs}) only checks between I/O, not hanging LINE download/storage/OCR. 50ms budget took 259ms for 200ms download, cron can exceed 30s. Bound actual I/O with abort/timeout and reserve finalizer time; test hanging/slow providers.

## Existing useful evidence
- 25 received / 5 attached / 19 lost / queue processed incident baseline reproduced with fixtures, not actual Production payload.
- 30-image test where image6 fails permanently, 29 attached passed. Storage interrupted then recovered without duplicate passed. Two finalizers send one summary passed. Four new test files 25 pass; slip regression 297 pass; 11 GitHub Actions jobs pass but **CI does not run the two new PG suites**.
- Full test 21 known failures vs main NOT independently reverified.
- Migration additive transaction and permissions positive, but trigger warning undermines atomic receipt guarantee.
- Do not touch historical incident batch or replay real events.

## Acceptance
Implement safety-first P0; fix P1 or identify blocked items; tests CI gate including both new PG suites; TypeScript/lint/test results; no sneaky permissive failure/zero-count handling. Report exact paths, commits, tests, residual risks and GO/NO-GO. Do not push/commit without explicit separate direction.
## Integration continuation

The original findings above remain the historical review record. Current remediation, independently executed integration checks, additional fixes and remaining blockers are recorded in [pr182-integration-verification-20261017.md](pr182-integration-verification-20261017.md). No commit/push/deploy/UAT has been authorized. A new independent reviewer must validate the exact uncommitted candidate rather than accept the fixing agents' conclusions.
