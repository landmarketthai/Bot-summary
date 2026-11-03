# Release runbook: slip money integrity (#192 → #194 → #193 → credits)

**Nothing here is authorized yet.** Each 🔒 step needs explicit human approval. This work has never touched Production. This document replaces the earlier addenda. Where an older note says code-first is safe, it is wrong: **the order is schema first, with traffic stopped.**

## 1. What ships
| Step | Ref | Contents | Schema |
|---|---|---|---|
| 1 | PR #192 `fix/p0-slip-image-ordering-20261031` | LINE `#N` follows LINE send order | none |
| 2 | PR #194 `fix/p0-slip-pending-amounts-20261102` (on #192) | AI-read / confirmed / pending in the LINE summary | none |
| 3 | PR #193 `feat/slip-ocr-gemini-eval` (on #194) + 3a | shared eligibility (date / outlier / reference) in every money path; Gemini evaluation tooling only. **3a** = the round-close `excluded` status and the ingestion race test from the local branch. 3a must be in #193 before it ships. | none |
| 4 | local `feat/manual-slip-ai-approval-20261102` (needs a PR) | AI and manual reviews; persisted per-reference credits; finalizer fail-closed; settled-scope manual guard; maintenance stop | **M1–M7** |

Migrations of step 4, in order (all additive, no data changes):
- M1 `20261102120000_slip_check_approval_link`
- M2 `20261102130000_manual_slip_entry_review`
- M3 `20261102140000_slip_review_hardening`
- M4 `20261102150000_slip_reference_scope`
- M5 `20261102160000_finalization_claim_order`
- M6 `20261103100000_slip_reference_claims`
- M7 `20261103120000_financial_write_guards`

## 2. Compatibility rules (why the order matters)
- **Step-4 code fails closed without M6.** A settlement is never sent on the uncredited preview rule; that rule paid one ฿70 transfer as ฿140. Without the RPC every finalization ends `failed` and nothing is pushed. After M6 the retry credits and sends normally (test P0-A).
- **Old code on the new schema ignores credits.** It must never run after M6 holds credits, because it would recount derived ownership. So there is **no mixed-version window**: apply the migrations and deploy the code inside one maintenance window, with financial writes stopped (§4).
- **Persisted credits are never deleted or reassigned.** That holds in rollback too: every down file keeps `slip_reference_claims` and its rows.

## 3. Before the window 🔒
1. CI is green on every PR head: pg-tests (incl. `reference-claims`, `slip-check-approval`, `uat-manual-approval`, `image-ingestion`), unit, typecheck, lint and the Vercel build. The known baseline is 13 unit failures (manifest drift 7, finalize-slip-batches GET 3, morning brief, preflight, white-sheet review turns). Anything else blocks.
2. **Snapshot export (read-only):** `transfer_reconciliations` and `settlement_finalizations` for the audit window. #193 changes how a past day recomputes. The export is the only restore source for recomputed snapshots.
3. **Historical audit (read-only):** run `docs/sql/slip-eligibility-historical-audit.sql`. It returns aggregates only. Review it with the accounting owner. Re-running past days waits for that review.
4. **Preflight (read-only):**
   ```sql
   SELECT to_regclass('public.slip_check_approvals'), to_regclass('public.slip_reference_claims'), to_regclass('public.financial_maintenance'); -- all NULL
   SELECT count(*) FROM public.manual_slip_entries WHERE reference_id IS NOT NULL;  -- column absent before M1: expect error / 0
   SELECT column_name FROM information_schema.columns
    WHERE table_name IN ('slip_evidences','manual_slip_sessions','settlement_finalizations') AND column_name = 'accountability_round_id'; -- 3 rows
   SELECT status, count(*) FROM public.settlement_finalizations GROUP BY 1;  -- record it
   ```

## 4. Maintenance window: stop, migrate, deploy 🔒
**Stopping LINE delivery is not the same as stopping financial writes.** In this window, writes are stopped in two layers.
1. **Stop scheduled money jobs:** pause the pg_cron jobs that call the money routes (`finalize-slip-batches`, daily reports), e.g. `UPDATE cron.job SET active = false WHERE jobname IN (…)`. Record the job ids and their state.
2. **Wait until nothing is in flight:**
   ```sql
   SELECT count(*) FROM public.settlement_finalizations WHERE status = 'sending';               -- 0
   SELECT count(*) FROM public.slip_batches WHERE status IN ('closing','processing');           -- 0, or note them
   ```
3. **Apply M1 → M7 in order**, in one session. Before M7 exists, the DB switch does not exist either, so steps 1–2 are the stop.
4. **Engage the DB stop right after M7:** `UPDATE public.financial_maintenance SET paused = true, reason = 'release', changed_at = now(), changed_by = '<name>';`
   While it is on, the database refuses every money commit:
   - finalization entering `sending`/`sent`/`ambiguous`;
   - reference credits;
   - review decisions;
   - manual-slip capture.

   Evidence ingestion and OCR continue, so LINE events are kept and stay pending. This was rehearsed locally in test P0-C:
   - nothing committed while paused;
   - an in-flight row could still record its own outcome;
   - after resume the settlement was credited and sent exactly once.
5. **Verify the schema:**
   ```sql
   SELECT proname, prosecdef FROM pg_proc WHERE proname IN ('claim_slip_references','review_slip_check','review_manual_slip_entry','revoke_slip_check_review');  -- 4 rows, all SECURITY DEFINER
   SELECT has_function_privilege('service_role', 'public.claim_slip_references(uuid, jsonb)', 'EXECUTE');    -- true
   SELECT has_function_privilege('anon', 'public.claim_slip_references(uuid, jsonb)', 'EXECUTE');            -- false
   SELECT has_table_privilege('service_role', 'public.slip_reference_claims', 'INSERT');                     -- false
   SELECT tgname FROM pg_trigger WHERE tgname IN ('manual_slip_sessions_scope_guard','manual_slip_entries_scope_guard','slip_check_approvals_maintenance_guard','settlement_finalizations_money_close_lock','slip_reference_claims_append_only'); -- 5 rows
   SELECT paused FROM public.financial_maintenance;   -- true
   ```
6. **Deploy the code** in this order: #192 → #194 → #193 (+3a) → step 4. Check that the deployed SHA is the approved head.
7. **Resume:**
   - `UPDATE public.financial_maintenance SET paused = false, reason = NULL, changed_at = now();`
   - re-activate the pg_cron jobs;
   - watch the first settlement of the pilot market.

## 5. Pilot GO/NO-GO checklist (all must be YES) 🔒
- [ ] Approvals are recorded: merge of each PR, the Production migrations, BR-02, the cross-scope rule (the first finalizer keeps a duplicate), and wallet policy (wallet amounts stay out of bank money).
- [ ] Snapshot exported and historical audit reviewed by the accounting owner.
- [ ] §4.5 verification all as expected; deployed SHA = approved head.
- [ ] No settlement in `sending` and no batch in processing at resume.
- [ ] Exception register (§6) is empty for the pilot market after the first settlement, or every row is explained.
- [ ] The operator knows the stop command (§4.4) and who may run it.
- [ ] LINE grammar phase 1 (manual references) stays **off** for the pilot. Its full-reference format is still undecided.

**NO-GO** if any box is unchecked, if E2/E3/E7 shows any row, or if a settlement is sent without `claims_recorded_at`.

## 6. Accounting exception register (read-only)
Run `docs/sql/slip-money-exception-register.sql` (`SET register.from_day = '…'` first) before accepting each settlement and daily during the pilot. The query is tested against PostgreSQL in `reference-claims.pg.test.ts`.

| Check | Meaning | Operator action |
|---|---|---|
| E1 credited_not_delivered | credits recorded, settlement `failed` or stuck in `sending` > 10 min | Check LINE delivery. The retry re-sends the same credited total. Never move the credits. |
| E2 sent_without_credits | sent after M6 without credits | **Stop (§4.4).** Code/schema mismatch. |
| E3 credit_exceeds_stored | credited > reconciled total | **Stop.** Defect. |
| E4 late_referenced_slip | verified referenced slip in a settled scope, credited nowhere | Money not in any settlement. Handle by accounting decision outside that scope. |
| E5 day_round_credit_split | a round-bound slip credited by the legacy-day settlement (or the reverse) | Explain which message carried it; the round White Sheet will not show it. |
| E6 manual_after_settlement | manual entry created after its scope settled | Legacy rows only. After M7 this must stay empty; a new row means **stop**. |
| E7 live_vs_stored | stored total ≠ credited + unreferenced manual | Explain (rejected or requires-review unreferenced entries), otherwise **stop**. |

## 7. Rollback (traffic stopped, §4.1–4.4 first) 🔒
| Situation | Action | Limits |
|---|---|---|
| step-4 code misbehaves | Keep the DB stop on, redeploy the previous code, keep the schema. **Keep the stop on while old code runs on a schema with credits.** Old code recounts derived ownership; either accept that for the affected days or keep money writes stopped until a fix ships. | Old code ignores decisions and credits. |
| schema must go | Code first, then the down files M7 → M6 → M5 → M4 → M3 → M2 → M1 (`supabase/rollback/…down.sql`). | No row is deleted. Credits, decisions, `reference_id`, `requires_review` and the stamps stay. M1 cannot be re-applied after its down file. The M7 down drops the switch, so resume traffic only after §4 is complete. |
| #193 misbehaves | revert #193 (+3a) | Misdated/undated/outlier AI slips count again. Recomputed snapshots stay recomputed (§3.2). |

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
- **The DB stop does not halt evidence ingestion.** This is by design, so events are kept. Pausing pg_cron is a separate step.
