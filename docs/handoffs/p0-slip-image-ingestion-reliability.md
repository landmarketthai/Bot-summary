# PR #182 — slip-image reliability handoff

Status: uncommitted integration candidate; **UAT NO-GO**. No commit, push, merge, deployment, remote migration, Production access or real LINE delivery is authorized by this handoff.

- Actual worktree: `C:\GitHub\_worktrees\bot-summary-p0-slip-ingest-20261017` (the path `C:\GitHub_worktrees\...` does not exist).
- Branch: `fix/p0-slip-image-ingestion-20261017`.
- HEAD: `11854d80c3ffee2af1825ae5593bf2316b7eead5`; fixes are still working-tree changes.
- Comparison baseline: freshly fetched `origin/main` = `11e2f4342a900d6dcaf0107f47970ed2a2bc46e4`.
- Original independent findings: [Codex cross-check](p0-pr182-crosscheck-remediation-20261017.md).
- Integration evidence and disposition: [verification report](pr182-integration-verification-20261017.md). Read its final status and limitations; do not treat this handoff as proof that a test ran.

## Incident and required invariant

The supplied incident identifies batch `d3ed6db7-822b-43fd-9fd0-06609a771a93`, seller น้อย, market ราชพฤกษ์, 16/10/2569: 25 images, five attached, one failure and 19 without evidence, while all queue events eventually became processed. The baseline suite reproduces that shape with synthetic data and a simulated download failure. It does not replay or verify actual Production payloads. Never replay the historical batch.

The invariant is durable accounting for every received slip image before acknowledging it, with visible incomplete totals when recovery cannot finish. Accounting failure must not certify a partial sum as complete.

## Current implementation

1. `20261017100000_slip_image_ingestion_ledger.sql` creates an image receipt ledger, including `unbound` receipts when no session exists yet. A failed capture trigger aborts the queue receipt; it does not log-and-ignore the failure. Slip open/close commands now share the ordered source queue with images. Session creation, begin and closing claim bind/reconcile receipts by LINE time.
2. Image begin increments a bounded attempt counter. Attach/fail require that attempt number as their fencing token, so an older worker cannot invalidate a newer claim. Deterministic Storage paths use upsert for retries; a stored evidence row is reused.
3. Transient begin failures keep the queue event pending. Missing begin RPCs cannot invoke legacy attachment for a session whose database row has ledger-era columns. Genuinely pre-migration sessions retain an explicit legacy path, which does not provide the new guarantees; migration remains a prerequisite.
4. Finalization throws before delivery on accounting timeout, malformed data or a missing RPC on a migrated schema. Missing images add an explicit incomplete notice and failed count; successful neighbours are still processed.
5. `20261017110000_slip_ocr_claim_fencing.sql` adds atomic OCR claim/complete/fail functions. Terminal checks and finalized batches reject stale writes. A missing OCR claim RPC on a ledger database fails closed instead of using unfenced upsert.
6. Provider calls have time bounds. Cron recovery uses a 40-second overall cap within the 55-second application budget (60-second route duration minus 5-second teardown), leaving a 15-second finalization reserve. It starts ingest/OCR only when their cap fits the remaining time. The duration export is a numeric literal because Next.js must analyze it statically. The scheduler HTTP caller allows 70 seconds.

## Scheduler and the 2,160-second cutoff

The actual scheduler is `.github/workflows/finalize-slip-batches.yml`, every **300 seconds**. `vercel.json` has no cron. This patch does not install a one-minute scheduler or change any running scheduler.

`SLIP_CLOSE_INGEST_MAX_SECONDS` defaults to **2160 seconds (36 minutes)** in the application and SQL; `.env.example` matches. This is the ingest cutoff for an unresolved batch, not the scheduler period. The design models bursts up to 25 images, five ingest attempts with NO in-request retries, and bounded 5-minute cron lateness. More than 25 images, skipped/delayed GitHub schedules beyond the assumed bound, provider backpressure, or a worker crash before even the first attempt may exhaust the wait before every attempt runs. In that case the financial summary MUST visibly remain incomplete (`review_needed`/missing notice), never certify partial receipts as completed. This is a modeling bound, not an unconditional five-attempt guarantee. Cron output reports the policy assessment. Production environment values must be checked explicitly before rollout: if `SLIP_CLOSE_INGEST_MAX_SECONDS=1200` remains set there, it overrides this safer default. The product owner must approve the possible 36-minute wait and the 25-ingest/10-OCR concurrency before deployment.

## Migration and rollback contract — no operation is authorized here

For a separately approved isolated staging rehearsal:

1. Stop intake, cron and existing workers; inspect collecting/closing/processing work before changing versions. Do not rely on concurrent old/new workers being safe: old application code can still use unfenced OCR writes.
2. Apply **both** migrations, in order: `20261017100000_slip_image_ingestion_ledger.sql`, then `20261017110000_slip_ocr_claim_fencing.sql`; then deploy the matching application. Verify the ledger functions, OCR claim/complete/fail functions, backend-only privileges and actual scheduler cadence. The ledger-health flag alone does not prove the OCR migration is present.
3. New application session open/close on an old schema must fail explicitly; do not describe this as transparent backwards compatibility. The schema compatibility tests cover explicit failure, receipt reconciliation during upgrade, legacy attachments and guarded rollback.
4. Ledger rollback script: `supabase/rollback/20261017100000_slip_image_ingestion_ledger.down.sql`. It refuses unresolved images on open batches by default. The explicit override audits unresolved receipts and accepts a degraded legacy path; it is not a lossless rollback. Audit tables have RLS enabled and no public/client privileges.
5. The script retains the ledger for audit, archives batch LINE timestamps, removes ledger entry points and restores the three-argument closing claim. OCR claim columns/functions remain additive; there is no destructive OCR down migration. Coordinate the application version with rollback. Reapplying after rollback requires both migrations again, including restoration of the fenced OCR redrive definition.
6. No Production migration history is edited by these tests. Existing migration-history failures must not be “fixed” by guessing Production state.

## Verification and next owner

Tests use localhost PostgreSQL 17 disposable databases and mocked LINE/Storage/OCR. External fetch is blocked during local verification; package installation used only the package registry. The worktree now owns its declared dependency installation (Next.js 16.3.4); the former shared `C:\GitHub\Bot-summary\node_modules` remains unchanged.

The CI job `p0-slip-image-ingestion` requires PostgreSQL and runs seven PG suites plus twelve unit/caller suites. Its local execution is recorded in the verification report. Because no commit/push is authorized, the updated GitHub workflow has not run remotely and is not claimed green.

When the integration report is complete, stop implementation and hand the exact working tree plus source hashes/logs to a **fresh independent Codex session**. That session must inspect the diff and run its own checks; neither agent claims nor this remediation report replace evidence. UAT remains NO-GO until independent review and a separate explicit authorization. Do not send a real LINE message during review.

ส่งต่อ Independent Review แล้ว: Codex chat `PR #182 — Independent Review หลัง Integration Verification` (`01a149d5-2f02-71f3-9a11-b92dbde841ec`) เริ่มด้วย fresh prompt ไม่มี fork history และกำหนด read-only source พร้อมสร้างหลักฐานเอง การส่งต่อไม่ใช่ผลอนุมัติ review และ UAT ยัง NO-GO
