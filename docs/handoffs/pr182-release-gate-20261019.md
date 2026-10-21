# PR #182 — Release gate (19 Oct 2026)

Candidate: branch `fix/p0-slip-image-ingestion-20261017`, commit `d45b739` (pushed to feature branch only).
Nothing merged, deployed, migrated or configured remotely.

## 1. Engineering evidence on `d45b739` (local, disposable PostgreSQL 17, mocked LINE/OCR/Storage)

| Gate | Result |
|---|---|
| Slip PostgreSQL suites (9 files) | 112 pass / 0 fail |
| Queue PostgreSQL suites (`migration-0060`, stale queue) | 24 pass / 0 fail |
| CI unit/caller step run locally (20 files, one process) | 367 pass / 0 fail |
| Full non-PG `bun test ./src` | 5379 pass / 24 fail: 21 are the known `origin/main` baseline set; 3 are `finalize-slip-batches/route.test.ts`, which pass in their own process and fail only in the bare run because other route tests `mock.module("@/lib/supabase/server")` process-wide (CI runs it isolated) |
| TypeScript `tsc --noEmit` | exit 0 |
| ESLint `src` | 0 errors, 70 warnings (pre-existing) |
| `next build --webpack` (placeholder env) | exit 0 |
| `git diff --check` | clean |
| Merge with current `origin/main` | clean (main has not advanced past the base) |

Close-out fixes in this commit (regressions found in the full suite, not in the earlier focused gates):
1. Legacy unit doubles without `claim_line_webhook_event` / `receive_line_webhook_payload` threw instead of taking the per-event path (production never returns "unexpected rpc"; real errors still fail closed).
2. The ordered-queue classification for a whole payload ran before any receipt, so a `อ่านใบขาว` command earlier in the same payload no longer owned the sender's later texts. It now runs in LINE order and later texts from that sender inherit the ordered path.
3. The white-sheet test double's queue-RPC allowlist now includes `receive_line_webhook_payload`.
4. These six webhook suites were added to the CI gate (CI had no repo-wide unit run).

Load test numbers are from mocks: they prove concurrency control and accounting, NOT provider capacity, quota or cost.

## 2. Isolated staging rehearsal (needs owner approval: creates or changes a remote environment)

Prerequisites: a Supabase project or branch that is NOT Production, a Vercel Preview with its own env, a test LINE channel (or mocked provider) whose only group is `Line ทดสอบบอท`, verified by `GET /v2/bot/group/{groupId}/summary` before any message.

1. Migration preflight on staging: list applied migrations; confirm `20261017100000`, `20261017110000`, `20261019120000` are absent and their dependencies (queue `0060`+, `20260930090000`, `0024`, `0039`) are present. Apply the three in order, by explicit file. No `supabase db push`.
2. Env on Preview: `SLIP_CLOSE_INGEST_MAX_SECONDS=2160`, `SLIP_LEDGER_ALERT_ENABLED=true` with `SLIP_LEDGER_ALERT_LINE_TARGET` empty (dry-run, log only), test LINE token only.
3. Run: 25-image burst then `จบสลิป`; same with close sent immediately; `[open, images…, close]` in one payload; LINE redelivery; one forced storage failure; a skipped scheduler run (trigger the cron route manually instead of the schedule).
4. Verify per batch: `slip_batch_image_accounting(batch)` equals images sent; one summary; never `completed` with missing images; alert dry-run log fires for the forced failure and not twice.
5. Rollback rehearsal: alert flag off → `20261019120000` down → app rollback → ledger down (guarded) on a drained ledger; confirm the legacy path finalizes.
6. Record provider rate-limit responses, function memory and duration for the burst.

## 3. Production preflight (for the release decision)

- Apply order: 3 migrations (in order, explicitly) → deploy app → set env → enable alert last.
- Effective env to set and verify in Production runtime: `SLIP_CLOSE_INGEST_MAX_SECONDS=2160` (currently absent; code default must not be assumed), `SLIP_LEDGER_ALERT_ENABLED`, `SLIP_LEDGER_ALERT_LINE_TARGET` (an approved internal group, never a seller group), existing `CRON_SECRET`.
- Production records migrations under timestamp versions (known drift): register these three under their filename timestamps and re-check the migration-history manifest tests at merge time.
- Scheduler: `finalize-slip-batches` every 5 min (curl `--max-time` raised to 70 s); new `slip-ledger-alert` workflow every 10 min. Scheduled workflows run from `main` only, so nothing runs until merge.
- Expected downtime: none for migrations (additive, transactional). Behaviour change: a batch with a stuck image waits up to 36 min, then sends a summary marked incomplete (`review_needed`); settlement stays blocked for such batches as for any `review_needed` batch.
- Rollback: reverse order (alert off → alert down → app → guarded ledger down). OCR fencing migration stays (do not mix old/new OCR workers).
- Monitoring: `slip_image_ledger_health()`, cron JSON `imageRecovery` / `imageLedger`, alert route logs.

## 4. Owner decisions needed (one approval round)

1. Approve the isolated staging rehearsal (section 2), including which Supabase project/branch and LINE test channel to use and any cost.
2. After staging passes: approve merge to `main`, the three Production migrations, Production env values (incl. the alert recipient), and deploy, as one release.
