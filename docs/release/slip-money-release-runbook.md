# Release runbook: slip money integrity (#192 → #194 → #193 → #195)

**Nothing here is authorized yet.** Each 🔒 step needs explicit human approval. This work has never touched Production. This document replaces the earlier addenda. Where an older note says code-first is safe, it is wrong: **the order is schema first, with traffic stopped.**

## 1. What ships
| Step | Ref | Contents | Schema |
|---|---|---|---|
| 1 | PR #192 `fix/p0-slip-image-ordering-20261031` | LINE `#N` follows LINE send order | none |
| 2 | PR #194 `fix/p0-slip-pending-amounts-20261102` (on #192) | AI-read / confirmed / pending in the LINE summary | none |
| 3 | PR #193 `feat/slip-ocr-gemini-eval` (on #194) | shared eligibility (date / outlier / reference) in every money path; Gemini evaluation tooling only. | none |
| 4 | PR #195 `feat/manual-slip-ai-approval-20261102` | **3a** (round-close `excluded` status and ingestion race test, shipped in #195); AI and manual reviews; persisted per-reference credits; finalizer fail-closed; settled-scope manual guard; immutable manual slips and credit stamps; M0 write stop including finalization DELETE, with pilot allowlist | **M0–M8** |

Migrations of step 4, in order (all additive; M0 inserts only its paused control row, with no financial-row changes):
- **M0 `20261102110000_financial_write_stop`: applied FIRST. Installs the stop already paused.** It guards `settlement_entries`, `transfer_reconciliations`, `manual_slip_sessions`, `manual_slip_entries`, finalizations entering `sending`/`sent`/`ambiguous`, and finalization DELETE, for code of every version.
- M1 `20261102120000_slip_check_approval_link`
- M2 `20261102130000_manual_slip_entry_review`
- M3 `20261102140000_slip_review_hardening`
- M4 `20261102150000_slip_reference_scope`
- M5 `20261102160000_finalization_claim_order`
- M6 `20261103100000_slip_reference_claims`
- M7 `20261103120000_financial_write_guards` (settled-scope/manual guards, immutable credit stamp, rollback gate)
- M8 `20261103130000_financial_release_blockers` (recorded credits freeze failed-scope reviews; positive non-NULL approval validation; refuse uncredited `sent`/`message_sent_at` writes). Apply after M7, never with M0: M0 must install before the credit column exists. Existing invalid approval amounts refuse installation for operator review; no financial rows are repaired automatically.

## 2. Compatibility rules (why the order matters)
- **Step-4 code fails closed without M6.** A settlement is never sent on the uncredited preview rule; that rule paid one ฿70 transfer as ฿140. Without the RPC every finalization ends `failed` and nothing is pushed. After M6 the retry credits and sends normally (test P0-A).
- **Old code on the new schema ignores credits.** It must never run after M6 holds credits, because it would recount derived ownership. So there is **no mixed-version window**: apply the migrations and deploy the code inside one maintenance window, with financial writes stopped (§4).
- **The stop is the database, not the cron.** Pausing cron does not stop old workers, LINE commands, admin routes or `/api/settlement`. M0 refuses their money writes in the database itself, before M1. The window starts when M0 commits; nothing earlier counts as a stop.
- **Strict schema-first.** Every step-4 migration is applied while paused, then the code is deployed, then the stop is released. Old workers that have not passed their database boundary meet the refusal and leave their settlements retryable. A worker already past that boundary can still push LINE. They must be **drained** (§4.2) so no old instance is live when the stop is released.
- **Persisted credits are never deleted or reassigned.** That holds in rollback too: every down file keeps `slip_reference_claims` and its rows.

## 3. Before the window 🔒
1. CI is green on every PR head: pg-tests (incl. `reference-claims`, `slip-check-approval`, `uat-manual-approval`, `image-ingestion`), unit, typecheck, lint and the Vercel build. The known baseline is 13 unit failures (manifest drift 7, finalize-slip-batches GET 3, morning brief, preflight, white-sheet review turns). Anything else blocks.
2. **Snapshot export (read-only):** `transfer_reconciliations` and `settlement_finalizations` for the audit window. #193 changes how a past day recomputes. The export is the only restore source for recomputed snapshots.
3. **Historical audit (read-only):** run `docs/sql/slip-eligibility-historical-audit.sql`. It returns aggregates only. Review it with the accounting owner. Re-running past days waits for that review.
4. **Preflight (read-only):**
   ```sql
   SELECT to_regclass('public.slip_check_approvals'), to_regclass('public.slip_reference_claims'), to_regclass('public.financial_maintenance'); -- all NULL
   SELECT count(*) FROM public.manual_slip_entries WHERE reference_id IS NOT NULL;  -- column absent before M1: expect error / 0
   -- A re-run after M0 is normal: financial_maintenance exists and paused = true.
   SELECT column_name FROM information_schema.columns
    WHERE table_name IN ('slip_evidences','manual_slip_sessions','settlement_finalizations') AND column_name = 'accountability_round_id'; -- 3 rows
   SELECT status, count(*) FROM public.settlement_finalizations GROUP BY 1;  -- record it
   ```

## 4. Maintenance window: stop, migrate, deploy 🔒
**Stopping cron or LINE delivery is not stopping financial writes.** Old workers, LINE commands, admin reviews and `/api/settlement` write money without cron. The only stop that covers every writer is the database, so it goes in first.

1. **Apply M0 and verify it before anything else** (read-only checks after it):
   ```sql
   -- apply 20261102110000_financial_write_stop.sql, then:
   SELECT paused, pilot_sources FROM public.financial_maintenance;                 -- true, NULL
   SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%_financial_stop';          -- 5
   ```
   From the commit of M0 on, `settlement_entries`, `transfer_reconciliations`, `manual_slip_*`, finalizations entering `sending`/`sent`/`ambiguous`, and finalization DELETE refuse every new writer (error `financial_maintenance`), whatever its code version. A database write that already passed the check holds a share lock on the switch until its transaction ends, and the pause waits for it (test P0-2). **When M0 returns there is no overlapping uncommitted write to a guarded table.** A worker that committed `sending` before M0 may still be outside the database and must finish or be stopped in step 2 before M1. Evidence ingestion and OCR keep running and stay pending, so no LINE event is lost.
2. **Drain old workers** (required for attempts already past their database boundary):
   - pause the pg_cron jobs that call the money routes (`finalize-slip-batches`, daily reports), e.g. `UPDATE cron.job SET active = false WHERE jobname IN (…)`; record job ids and state;
   - wait until nothing is in flight:
     ```sql
     SELECT count(*) FROM public.settlement_finalizations WHERE status = 'sending';       -- 0
     SELECT count(*) FROM public.slip_batches WHERE status IN ('closing','processing');   -- 0, or note them
     ```
     A `sending` row left by an old worker is not credited (the credit RPC is absent), but that worker may already be between its claim and LINE. Let the known attempt finish, or stop that worker and wait for its claim to become stale; **do not apply M1 until the count is 0**. Record the outcome; failed/stale rows are retried by the new code after resume;
   - **BLOCKING GATE, operator action:** confirm in the hosting dashboard that no deployment other than the one being replaced serves traffic, and that the replaced deployment is the only old version. This cannot be proven from the repository. Until an operator records it, the release stays NO-GO.
3. **Apply M1 → M8 in order**, in one session, while paused. They are DDL only and idempotent.
4. **Verify the schema:**
   ```sql
   SELECT proname, prosecdef FROM pg_proc WHERE proname IN ('claim_slip_references','review_slip_check','review_manual_slip_entry','revoke_slip_check_review','assert_financial_writes_open');  -- 5 rows, all SECURITY DEFINER
   SELECT has_function_privilege('service_role', 'public.claim_slip_references(uuid, jsonb)', 'EXECUTE');    -- true
   SELECT has_function_privilege('anon', 'public.claim_slip_references(uuid, jsonb)', 'EXECUTE');            -- false
   SELECT has_table_privilege('service_role', 'public.slip_reference_claims', 'INSERT');                     -- false
   SELECT has_table_privilege('service_role', 'public.manual_slip_sessions', 'INSERT'),
          has_table_privilege('service_role', 'public.manual_slip_sessions', 'UPDATE'),
          has_table_privilege('service_role', 'public.manual_slip_entries', 'INSERT');                       -- true, false, false
   SELECT tgname FROM pg_trigger WHERE tgname IN ('manual_slip_sessions_scope_guard','manual_slip_entries_scope_guard','slip_check_approvals_maintenance_guard','settlement_finalizations_money_close_lock','slip_reference_claims_append_only','manual_slip_sessions_no_truncate','manual_slip_entries_no_truncate','settlement_finalizations_record_guard','settlement_finalizations_credit_guard'); -- 9 rows
   SELECT paused FROM public.financial_maintenance;   -- true
   ```
5. **Deploy the code** in this order: #192 → #194 → #193 → #195 (includes 3a). Check that the deployed SHA is the approved head. Still paused: the new code's money writes are refused too, so a bad deploy cannot send.
6. **Release the stop, one market first** (the pilot allowlist, §5):
   ```sql
   UPDATE public.financial_maintenance
      SET paused = false, pilot_sources = ARRAY['<pilot LINE source id>'], reason = 'pilot', changed_at = now(), changed_by = '<name>';
   ```
   With `pilot_sources` set, only those LINE sources can write money. **Every other source, and every write without a source (legacy `/api/settlement` with no `source_id`), is refused by the database** (`financial_maintenance_pilot_scope`). They are not a silent "off": the refusal is the visible signal, and their evidence stays pending. Re-activate the pg_cron jobs only after this, and expect the other markets' settlements to be `failed`/retried until §5 widens the allowlist.
7. **Record `register.cutover_at`** (the time of step 6) for exception check E2.
8. **Widen or finish the pilot:** `UPDATE public.financial_maintenance SET pilot_sources = ARRAY[…]` (add sources) or `= NULL` (all sources). Do this only after the pilot GO/NO-GO (§5) holds.

**Emergency stop at any time:** `UPDATE public.financial_maintenance SET paused = true, reason = '<why>', changed_at = now(), changed_by = '<name>';` It waits for guarded database transactions and returns when none are left. It does not retract a LINE delivery already authorized by a credit committed before the stop, so drain workers before changing schema or code. The statement is the only database control; no API role can write the row.

## 5. Pilot GO/NO-GO checklist (all must be YES) 🔒
- [ ] Approvals are recorded: merge of each PR, the Production migrations, BR-02, the cross-scope rule (the first finalizer keeps a duplicate), and wallet policy (wallet amounts stay out of bank money).
- [ ] Snapshot exported and historical audit reviewed by the accounting owner.
- [ ] **The accounting owner explicitly authorized this pilot release.** Review alone is not authorization.
- [ ] §4.1 and §4.4 verification as expected; deployed SHA = approved head.
- [ ] **Operator recorded the old-deployment drain (§4.2 gate).**
- [ ] No settlement in `sending` and no batch in processing at resume.
- [ ] `pilot_sources` holds exactly the pilot source(s) (§4.6) and the other markets' refusals are explained to their operators.
- [ ] Exception register (§6) is empty for the pilot market after the first settlement, or every row is explained.
- [ ] The operator knows the emergency stop and who may run it.
- [ ] LINE grammar phase 1 (manual references) stays **off** for the pilot. Its full-reference format is still undecided.
- [ ] **Hosted CI is green on the exact release SHA.** Local PG results are not a substitute; this was never verified for this branch.

**NO-GO** if any box is unchecked, if E2/E3/E7 shows any row, or if a settlement is sent without `claims_recorded_at`.

**What the allowlist does and does not isolate.** It isolates **writes**: settlements, reconciliation snapshots, finalizations, manual-slip capture, reviews and credits, by LINE `source_id`. It does not isolate reads or evidence ingestion, and it does not separate two markets that share one LINE group/source id (one source is one pilot unit). A market is "one source" only if its group is.

## 6. Accounting exception register (read-only)
Run `docs/sql/slip-money-exception-register.sql` (`SET register.from_day = '…'` and `SET register.cutover_at = '<§4.7>'` first) before accepting each settlement and daily during the pilot. Without `cutover_at`, E2 lists every sent settlement in the window that has no credits, including pre-release ones. The query is tested against PostgreSQL (E1–E7, each with a positive case and a negative twin) in `reference-claims.pg.test.ts`.

| Check | Meaning | Operator action |
|---|---|---|
| E1 credited_not_delivered | credits recorded, settlement `failed` or stuck in `sending` > 10 min | Check LINE delivery. The retry re-sends the same credited total. Never move the credits. |
| E2 sent_without_credits | sent at or after `cutover_at` without credits | **Stop (§4 emergency stop).** Code/schema mismatch. |
| E3 credit_exceeds_stored | credited > reconciled total | **Stop.** Defect. |
| E4 late_referenced_slip | verified referenced slip in a settled scope, credited nowhere | Money not in any settlement. Handle by accounting decision outside that scope. |
| E5 day_round_credit_split | a round-bound slip credited by the legacy-day settlement (or the reverse) | Explain which message carried it; the round White Sheet will not show it. |
| E6 manual_after_settlement | manual entry created after its scope settled (handed out, or credited and then failed) | Legacy rows only. After M7 this must stay empty; a new row means **stop**. |
| E7 live_vs_stored | stored total ≠ credited + unreferenced manual | Explain (rejected or requires-review unreferenced entries), otherwise **stop**. |

## 7. Rollback 🔒
**Rule: never run the old code on a schema that holds credits.** Old code ignores persisted credits and recounts derived ownership (one ฿70 transfer paid as ฿140). Both rollback paths below keep the stop installed and paused until a forward fix ships.

| Situation | Action | Limits |
|---|---|---|
| step-4 code misbehaves | **Pause first** (§4 emergency stop). **Keep the schema, M0 included.** Fix forward and redeploy new code. Redeploying the previous code is allowed **only while `SELECT count(*) FROM public.slip_reference_claims` is 0**; with credits it is forbidden, and the stop stays on until the fix ships. | Old code ignores decisions and credits. |
| schema must go | Only while `slip_reference_claims` is empty. Pause, code first, then the down files M8 → M7 → M6 → … → M1 → **M0 last** (`supabase/rollback/…down.sql`). The M8 and M7 down files **refuse first with `financial_guards_rollback_refused` while any credit exists**; M0 down has a second refusal (`financial_stop_rollback_refused`). All are tested. M8 down retains the corrected approval validation. With credits there is no schema rollback; use a forward fix. | No row is deleted. Credits, decisions, `reference_id`, `requires_review` and the stamps stay. M1 cannot be re-applied after its down file. |
| #193 misbehaves | revert #193 only; 3a belongs to #195 | Misdated/undated/outlier AI slips count again. Recomputed snapshots stay recomputed (§3.2). |

**Day vs round scope (asymmetric by design).** A legacy-day settlement (no round) settles *every* round of that source and day: manual slips for any of them are then refused. A round settlement settles only that round and does not freeze the day scope. Manual capture/review paths take the round key then the day key; day capture/review takes the day key, so those paths meet. Finalization uses a global claim-order key plus its own scope key, and the credit RPC locks the maintenance row before its finalization row. Do not assume all write paths use identical locks. Consequence for operators: finalizing the day-level message early closes the manual-slip door for rounds still open that day (visible as `manual_slip_scope_settled`).

**Immediate rollback or stop triggers:**
- any E2, E3 or E7 row;
- a reference credited in two messages;
- LINE "ยอดยืนยัน" lower than the settlement bank money for the same scope;
- a review landing after `sent`;
- ปิดรอบ blocked for a reason no operator can resolve.

## 8. Residual risks accepted for the pilot (documented)
- **Unreferenced manual entries** cannot be matched to an AI read. The same slip entered both ways counts twice. This happens in Production today and is not new. The fix needs LINE grammar phase 1 (references) and its approval.
- **A scope freezes once it credits**, even when the failure happens before any push. A referenced slip of that scope arriving later stays late (E4) and the message under-counts.
- **AI-vs-AI duplicates follow the earliest read** until one of them is credited.
- **Day/round double finalization of the same evidence**: the first one credits it; the other view shows it as superseded (E5).
- **The DB stop does not halt evidence ingestion.** This is by design, so events are kept. Pausing pg_cron is a separate, secondary step.
- **LINE is outside the database transaction.** Current code rechecks the existing credit RPC (stop/pilot, locked `sending` row, immutable recorded credits) immediately before push. A stop after that transaction commits cannot retract the authorized push. Old binaries never make this recheck: M8 refuses their uncredited `sent` status or delivery stamp, but cannot prevent a LINE push they already reached. Keep the stop paused and drain/stop every old worker and deployment before resume; a rejected status write is not evidence that no message was delivered.
- **Operator-proven, not repo-proven:** that no unlisted old deployment or direct-SQL client writes money (§4.2 gate). Roles other than `service_role` with table privileges are refused by the same triggers, but a superuser disabling triggers is outside any guard.
