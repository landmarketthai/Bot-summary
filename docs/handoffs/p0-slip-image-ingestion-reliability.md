# P0 — Slip image ingestion reliability (handoff + UAT)

Branch `fix/p0-slip-image-ingestion-20261017`, based on `origin/main` 11e2f43.
Nothing here has been applied to Production. Migration rollout and UAT are separate, explicitly approved steps.

## 1. Root cause (verified in code; line numbers are `origin/main` 11e2f43)

Incident: batch `d3ed6db7-822b-43fd-9fd0-06609a771a93` — 25 images received, 5 attached.
`src/lib/slips/incident-baseline.pg.test.ts` replays the timeline on the pre-fix schema and reproduces it exactly
(5 attached, 1 `DOWNLOAD_FAILED`, 19 images with no `slip_evidences` row, all 25 queue rows `processed`).

| # | Defect | Where |
|---|---|---|
| 1 | **One failed image blocks every later image.** A failed download/storage returns `error`, the drain releases the row to `pending` and `return processed` stops the loop. `claim_line_webhook_event` refuses to claim any row while an earlier row of the same source is `pending`/`processing`, so the 19 images behind image 6 wait for the 5-per-minute recovery sweep. | `webhook-service.ts` `drainOrderedSource` (4871-4883); `20260930090000_line_webhook_stale_queue_review.sql` claim `NOT EXISTS earlier` |
| 2 | **A failed image can never recover.** `slip_evidences.line_message_id` is `UNIQUE` and the failed attempt already inserted a row, so every retry re-downloads, then throws `slip_evidence insert failed` (unique violation). There was no attempt cap: the 8 attempts in the incident were just the sweeps that happened before step 4. | `evidence-service.ts` `insertEvidence` (132-164); `0019_slip_evidence_ingestion.sql` |
| 3 | **`จบสลิป` is not queued and the finalizer cannot see the queue.** The close command runs immediately and moves the batch to `closing`. `claim_closing_slip_batch` counts only evidences already attached to the batch, so "5 attached, all checks terminal" looks complete. | `webhook-service.ts` `processSlipClose` (4139+); `0024_slip_batch_closing.sql` |
| 4 | **Loss is acknowledged as success.** Once the batch left `closing`, a worker that finally ran found no active session, logged "image ignored", returned `saved`, and the queue row became `processed` — no download, no evidence row, no trace. | `webhook-service.ts` `processImageMessage` (3875-3916) |
| 5 | **Attribution by worker time, not message time.** The batch was chosen by `findActiveSession(sourceId)` when the worker ran, so a delayed image could join the wrong session (or none), and an image sent *after* `จบสลิป` could still attach to the closing batch. | `slip-session-service.ts` `findActiveSession`; `attach_evidence_to_slip_batch` accepts `closing` |
| 6 | `raw_messages.is_processed` was true only for the 5 stored images, so the "processed" queue status and the evidence data disagreed. | `evidence-service.ts` |

Sleeping or raising `CLOSE_MAX_SECONDS` would not fix any of these: the finalizer's `was_timeout` path (120 s) fires regardless of unattached images.

## 2. The fix

**Durable per-image ledger** `slip_image_events` (migration `20261017100000_slip_image_ingestion_ledger.sql`):

* One row per unique LINE image message received while a slip session is open, written by an `AFTER INSERT` trigger on `line_webhook_event_queue` — the **same transaction as the receipt**. A trigger failure only logs a warning; the receipt is never lost and the image falls back to the legacy path.
* Attribution is by **LINE event time** against the session window `[open_event_ts_ms, close_event_ts_ms]` (both stored from the LINE event, not server time). Delayed workers cannot change it. Image after the close → `excluded_after_close` (told to the seller). Image sent inside an already-finalized session → `late_after_finalize` (recorded).
* States: `received → ingesting → attached | retry_pending → … | failed_permanent`, plus `excluded_after_close`, `excluded_not_slip` (consumed by the white-sheet flow), `late_after_finalize`.
* Queue events are now **always acknowledged**; the outcome lives in the ledger, so a failed image never blocks the images behind it and no event is "processed" without an explicit outcome.

**Bounded, idempotent processing** (`src/lib/slips/image-ingestion.ts` + SQL RPCs):

* `begin_slip_image_attempt`: row lock (`SKIP LOCKED`), 120 s lease, attempt budget of 5 counted *at start* (a crashing worker still consumes budget).
* Failure → `fail_slip_image_event`: backoff 15 / 30 / 60 / 120 / 240 s, then `failed_permanent`. Errors are stored as short codes (`download_failed`, `storage_failed`, …), never provider text.
* `attach_slip_image_event`: idempotent (already attached → reconcile, never a second `batch_index`), refuses finalized/after-close, reuses the existing `attach_evidence_to_slip_batch` (so market attribution and accountability-round triggers behave as before).
* `SlipEvidenceService`: a retry reconciles with the existing `slip_evidences` row (keep `RECEIVED`, overwrite `*_FAILED`); storage upload is `upsert: true` (deterministic path per LINE message id). A stored image is never re-downloaded.
* Recovery: the existing `finalize-slip-batches` cron now runs `WebhookService.recoverSlipIngest()` before finalizing: drains queue sources holding never-started images, retries due ledger rows, re-drives OCR that never started (never re-runs a completed check).

**Finalizer** (`claim_closing_slip_batch`, now `…, p_ingest_max_seconds default 600`):

* Will not claim while any ledger row is `received`/`ingesting`/`retry_pending`, **bounded** by `SLIP_CLOSE_INGEST_MAX_SECONDS` (default 600 s, above the full retry budget of ~7.5 min). Images whose queue row went `failed`/`stale` count as permanently incomplete immediately.
* OCR timeout is measured from the later of close and last attach, so a long ingest does not eat the OCR budget.
* If anything is missing the summary says so and does **not** present the partial sum as complete:
  `⚠️ ยอดนี้ยังไม่ครบ ห้ามใช้เป็นยอดรวมทั้งหมด / รับรูปจาก LINE: N / เข้าชุดแล้ว: K / ยังไม่ครบ: M`; batch status is `review_needed` (or `failed`), `failed_count` includes missing images, and settlement stays blocked exactly as for any `review_needed` batch. Missing images are never counted as 0 baht.
* No change to extraction, validation guard, duplicate detection or settlement code. Output of `buildBatchSummaryMessage` is unchanged; the notice is appended only when `incomplete > 0`.
* Duplicate summaries remain impossible: unchanged atomic claim + `summary_sent_at` guard + batch-id LINE retry key.

**Observability**: structured logs (`slip image ingestion outcome`, `slip image attempt failed`, `finalizing active slip batch` with the accounting object — ids and counts only), `slip_batch_image_accounting(batch_id)` and `slip_image_ledger_health()`; the cron JSON now includes `imageRecovery` and `imageLedger`.

## 3. Production rollout requirements (NOT applied)

1. Apply `supabase/migrations/20261017100000_slip_image_ingestion_ledger.sql` **before or together with** the deploy. It is additive (new table, 2 columns on `slip_batches`, new functions, one trigger) and replaces `claim_closing_slip_batch` (drops the 3-arg version, installs a 4-arg version whose 4th arg has a default).
2. Rollout safety (tested): new code on the old DB falls back to the legacy path (`no_ledger`) and retries the 3-arg claim; old code on the new DB keeps working (default argument, ledger ignored).
3. Production records migrations 0051–0062 under timestamp versions (see memory `prod-migration-version-drift`): register this one under its timestamp, and re-verify the migration-history baseline tests when merging.
4. Confirm `finalize-slip-batches` is scheduled at ≤ 1 minute (scheduling lives outside the repo). The retry/backoff and the 600 s ingest bound assume that cadence.
5. Optional env: `SLIP_CLOSE_INGEST_MAX_SECONDS` (default 600). Existing `SLIP_CLOSE_QUIET_SECONDS` / `SLIP_CLOSE_MAX_SECONDS` unchanged.
6. **No backfill is included.** The historical incident batch must not be replayed. Any recovery of historical batches needs a separate dry-run-first script and explicit approval.

## 4. Tests

```bash
# unit + everything non-PG
bun test ./src --path-ignore-patterns='**/*.pg.test.ts'
# real PostgreSQL 17 (local, disposable databases)
ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/slips/image-ingestion.pg.test.ts src/lib/slips/incident-baseline.pg.test.ts
```

`image-ingestion.pg.test.ts` runs the real `WebhookService`, `SlipImageIngestionService`, `SlipEvidenceService` and batch finalizer against the real migrations through `src/lib/slips/testing/pg-slip-harness.ts`; only the LINE download, Storage and OCR provider are simulated, and every assertion reads database state. Coverage map: 25-image burst + delayed workers + close with pending images + permanent 6th-image failure (reqs 1,2,4,5,6,14); temporary 6th failure (3); concurrent drains / finalizer race (7); redelivery + duplicate message ids (8); images after close, sequential sessions, two groups (9,13); worker crash (10); single summary (11).

## 5. Supervised UAT (separate approval — do not run during review)

Only group: **`Line ทดสอบบอท`**. Never use a real operational group.

0. **Verify the destination first** (read-only, official API; token from the environment, never pasted):
   ```bash
   curl -s -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" "https://api.line.me/v2/bot/group/$TEST_GROUP_ID/summary"
   ```
   `groupName` must equal exactly `Line ทดสอบบอท`. Otherwise stop.
1. Apply the migration to the **Preview/staging** database only; deploy the PR to Preview with Preview-only LINE credentials pointing at the test group.
2. **U1 burst**: open `ทดสอบ-ตลาดทดสอบ สลิปเงินโอน <วันนี้>`, send 25 distinct test slip images in < 60 s, send `จบสลิป` within ~10 s. Expect: one summary, `รับทั้งหมด`/`รับรูปจาก LINE` = 25, no `ยอดนี้ยังไม่ครบ` notice when all read.
3. **U2 close while pending**: same, but send `จบสลิป` immediately after the last image. Expect the same final count (the summary may arrive later, up to the retry budget).
4. **U3 after close**: after `จบสลิป`, send 2 more images. Expect the "late image" reply and the batch count unchanged; open a new session and confirm the next images join only the new session.
5. **U4 redelivery**: use the LINE console redelivery for one image webhook; expect no extra evidence or summary.
6. **U5 forced failure** (staging only, never in Production): temporarily block the `slip-evidence` bucket for one path or point `LINE content` at a bad token for one image; expect `retry_pending` then recovery, or after 5 attempts `failed_permanent` and a summary carrying the `⚠️ ยอดนี้ยังไม่ครบ` notice and `review_needed`.
7. Read-only reconciliation after each run (replace the batch id):
   ```sql
   select public.slip_batch_image_accounting('<batch_id>');   -- received_total = attached + failed + waiting + late ...
   select state, count(*) from slip_image_events where batch_id = '<batch_id>' group by 1;
   select public.slip_image_ledger_health();                   -- unresolved should drain to 0
   ```
8. Pass criteria: every sent image appears in the ledger with a terminal state; `received_total` equals the number sent; no duplicate `slip_evidences.line_message_id`; exactly one LINE summary per batch.

## 6. Known limitations / risks

* An image **attached** before a close command with an earlier LINE timestamp arrives (extreme reorder) is not detached; detach logic was judged riskier for financial totals than the tiny window it closes.
* Retry order can differ from send order (`batch_index` is attach order).
* An image sent before the open command gets no ledger row and keeps the legacy behaviour (attached to the then-active session, without the new guarantees).
* `late_after_finalize` images are *recorded and reported to the operator*, but the already-sent summary is not re-issued; a re-summary flow is out of scope (P1).
* Ledger depends on the trigger at receipt; if the trigger ever fails the image takes the legacy path (still ingested, but without the new guarantees).
* Throughput is unchanged (one image at a time per source); the fix is correctness under delay, not speed.
