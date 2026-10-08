# Sold-out risk: can a FAILED ชั่งคืน be reported as a sold-out day?

Read-only analysis. No sales rule, code, or data was changed. Base: worktree `feat/ai-consultant-phase1-3` @ `1aadf02`.
Not examined: uncommitted edits in `C:\GitHub\Bot-summary` (e.g. `webhook-service.ts`, `pending-session-finalizer.ts`); if production runs those, re-check section 2.

## 1. Verdict

**Yes, in one realistic variant, and several consumers have no guard at all.** The answer hinges on one fact the code cannot tell us:
**is the failed pending row bound to the withdrawal's `accountability_round_id`?**

| Variant | Pending row's `accountability_round_id` | P1 Sales row result | Day-level result |
|---|---|---|---|
| **B. Round-linked** (P4A gate block / review refused after bind) | = withdrawal round | `QUANTITY_BLOCKED`, `soldQuantity=null`, value `PENDING_REVIEW` (correct, "รอข้อมูลคืน") | scope blocker `unresolved_pending_session` too |
| **A. Unbound** (parser-level rejection, e.g. malformed item 22, on a plain-text close) | **NULL** | **`TRUSTED`, sold = withdrawn, "ถือว่าขายหมด", full 13,992 as "confirmed"** | only a day-wide banner + "partial" headline; row/market figure unchanged |

Why variant A exists: in the plain-text close path, parser errors stage `partial_capture` and return **before** `bindPlainTextRound` (`src/lib/line/webhook-service.ts:2859-2898` at HEAD; the bind is at `:2899`; the working tree has another agent's uncommitted edits shifting these by ~30 lines). The deferred finalizer only binds when `validationErrors.length === 0` (`src/lib/line/pending-session-finalizer.ts:552`). `close_refused_unresolved` then terminalizes the row without ever setting a round (`supabase/migrations/20260817080439_produce_pending_supersession_and_close_recovery.sql:196-243`). "23 accepted, item 22 rejected" fits either variant; production data is needed (section 8, Q1).

I reproduced both variants with a throwaway filter-aware fake (`C:\Users\User\AppData\Local\Temp\claude\soldout-scratch\incident.test.ts`, 2 withdrawal items, 5,322.00 THB, header date 7/10/69):

- B: rows `QUANTITY_BLOCKED`, `all.expected=0`, `pending=532200` satang, `valueAuthoritative=false`, LINE says "⛔ ยังปิดยอดไม่ได้ ... รอข้อมูลคืน".
- A: rows `TRUSTED`, `sold=withdrawn`, `isSoldOutByAbsentReturn=true`, `all.expected=532200`, scope blocker count 1, `quantityAuthoritative=false`. LINE headline says "⚠️ ยอดที่ตรวจสอบได้บางส่วน" but also prints "✅ ถือว่าขายหมดเพราะไม่มีรายการคืน — 2 รายการ" and the market block shows "ยอดที่ยืนยันแล้ว 5,322.00 บาท" (= whole withdrawal).
- Morning Brief, variant A: "ยอดขายรวม 5,322.00 บาท" and "ผลไม้ — ยอดขาย 5,322.00 บาท" with **no caveat at all**.

## 2. Mechanism details (cite)

- Round-level classification reads pending rows **only by round id**: `round-return-status.ts:238` (`.in("accountability_round_id", chunk)`), `:241` (`if (!row.accountability_round_id) continue`). A null-round failed return can never make a round `blocked`; the round stays `none` = "legit sold-out" (`:105`). `none` is also deliberately not a data-quality issue (`data-quality/sources/preflight-source.ts`, `missing_successful_return` warning maps to `null`).
- Sales row-level incompleteness needs a round id: `calculate.ts:776-778` (`returnEvidenceIncomplete` requires `accountabilityRoundId !== null && incompleteRounds.has`). `failure-lifecycle.ts:222-237` (`activeIncompleteReturnRoundIds`) also requires a non-null round. Otherwise `sold = withdrawn - 0` (`calculate.ts:783`), status `TRUSTED`.
- The only catch for an unbound attempt is the **scope blocker**: `load.ts:385-391` -> `calculate.ts:917,973-979` flips `quantityAuthoritative/valueAuthoritative` on every total but never touches an identity row's `status`, `soldQuantity` or `expectedSalesSatang`.
- Scope-blocker date attribution (`load.ts:496-565`, `:557-560`): by header date in `accumulated_text`, else first LINE ingest timestamp, else `created_at`. No `created_at` window, no `terminalized` filter, no `runtime_environment` filter (so preview/dev rows can only over-block, never under-block). Returns often carry **no date line** (`parser.test.ts` EXAMPLE_1), so the date is the 04:00-cutoff day of the first event. A return first sent after 04:00 on the next day, unbound and undated, is attributed to the wrong day: scratch S3 shows the 10-07 report fully authoritative/sold-out and the 10-08 report wrongly blocked.
- Round-linked rows are robust to date mistakes: scratch S4 (header mistyped as 8/10/69) still gives `QUANTITY_BLOCKED` via the round, though the scope blocker is lost.
- `failed_closed` terminalized rows are never filtered out; `close_refused_unresolved`, `user_cancelled`, `superseded` are all treated as unresolved on purpose (`cancel-active-draft.ts:128-142`). Cancelled rounds make attempts `abandoned` only in the failure-lifecycle path (`failure-lifecycle.ts:174-184`), not in `loadRoundReturnStatuses`.
- `reconcile()` gate for failed_closed (`reconciliation.ts:413-447`) requires `close_event_timestamp_ms IS NOT NULL`, but `recover_stranded_plain_text_closes` only touches rows where it **is NULL** (migration `:210`). It also filters by round id. So `close_refused_unresolved` rows never trip this gate.

## 3. Per-consumer table

Class: (a) correctly flagged/blocked, (b) silently sold = withdrawn, (c) partly flagged / other.

| Consumer | File:line | Round-linked (B) | Unbound (A) | Class |
|---|---|---|---|---|
| P1 Sales calculator | `sales/calculate.ts:760-783, 815-830, 917-979` | row `QUANTITY_BLOCKED`, value pending | row `TRUSTED`, sold=withdrawn; only totals demoted | B: a / A: **b** (with day banner) |
| P1 loader | `sales/load.ts:1270, 1293-1297` | round `blocked` + failure attempt both flag | round `none`; only scope blocker | as above |
| Round return status | `produce/round-return-status.ts:91-109, 187-266` | `blocked` | `none` | B: a / A: **b** |
| Failure lifecycle / scope scan | `produce/failure-lifecycle.ts:222`, `sales/load.ts:496-565` | active, bound | active, unbound, date-dependent | a (date caveat) |
| Daily Close Preflight | `produce/daily-close-preflight.ts:224-246, 497-540` | round `blocked` | round `ready`+warning, **day-level blocker** `active_failed_produce_session` scoped by source markets | a (both) |
| Sales cron 08:10 | `app/api/cron/daily-sales-summary/route.ts:113-137, 168` | blocked wording | partial wording, sold-out label kept | B: a / A: c |
| Morning Brief sales + produceFinancial | `summary/morning-brief-service.ts:160`, `morning-brief.ts:139-189`, `morning-brief-message.ts:85-105` | headline includes pending as "ยอดขายรวม" (with "รอตรวจ" split); `incompleteReturnIssueCount` and `valueAuthoritative` are computed but **never rendered** | **no caveat at all** | B: c / A: **b** |
| Stock 08:00 (good-return value) | `app/api/cron/daily-stock-summary/route.ts:176-186, 213`, `summary/daily-good-return-value.ts:356-366` | "ยังสรุปว่าขายหมดไม่ได้" when no good returns anywhere | says "สินค้าที่ไม่ได้คืนถือว่าขายออกแล้ว" if day has no good returns and no flagged round; the active-failure notice is appended separately | B: a / A: c |
| Purchase planning | `summary/purchase-planning-service.ts:169-182, 223-232` | incomplete round | `hasUnattributedIncompleteReturns` explicitly fail-closed for null-round attempts | a (both) |
| Settlement finalizer (legacy ยอดส่ง) | `settlement-finalizer.ts:303 (reconcile), 326-380`, `settlement/produce-value-status.ts:99-147` | status `blocked` | `blocked` via source-scoped integrity blocker; **but** message still prints numeric "ผลตรวจ: ขาด X" and "เงินสดที่ควรเหลือส่งเจ๊" from ยอดส่ง = full withdrawal; only a footer + "⚠️ ยังไม่ยืนยัน" marks (`line/settlement-message.ts:40-60,160-185`; only `invalid` suppresses numbers) | c |
| `/api/settlement` | `app/api/settlement/route.ts:139-165` | same as above | same | c |
| New settlement (expected cash) | `settlement/daily-financial-settlement.ts:15-19,164-172` | not produce-derived: `expected_cash` uses hand-entered `white_sheet_sales` | same; `produceCrossCheck` has **no caller** | a (immune, but blind: no produce-incomplete note) |
| AI analyst tools | `ai/readonly-tools.ts:203-218, 221-254, 322-353, 355-479, 481-502` | exposes `status`, `reasons`, `soldQuantity=null`, `quantityAuthoritative=false`; `calculatedSalesBaht` still includes pending value | rows look `TRUSTED` with sold=withdrawn; only `scopeBlockers`/`quantityAuthoritative=false` and `get_pending_items` warn; row-level `returnEvidenceIncomplete` and sold-out flag are not exposed | B: c / A: c-b |
| Data quality inbox | `data-quality/sources/preflight-source.ts` | `produce_no_return` (blocker) | `produce_stale_failed_session` | a (relies on preflight) |
| **Digital White Sheet** | `white-sheet/load.ts:341-433`, `white-sheet/calculate.ts:310-345,423-480`, `white-sheet/compose.ts:98-133,184-192`, `line/white-sheet-close-service.ts:233-262` | **no pending/round-return awareness**: `expectedSales` = full withdrawal, `expectedCash`/`difference` derived, reply is `trusted: true` unless hard-stop warnings (duplicates, missing price, slips) | same | **b** |
| Legacy per-seller net (financial-summary page, report-summary, PDFs, `summary/report.ts:101`) | `(dashboard)/financial-summary/page.tsx:64-120`, `components/financial-summary/FinancialTable.tsx:186-219` | no guard (only `returns_exceed_withdrawal`) | same | **b** |
| Legacy daily summary (cron + LINE + `daily_summaries.net_sales`) | `line/daily-summary-service.ts:25-66`, `app/api/cron/daily-summary/route.ts:44-76`, `line/daily-summary-message.ts:84` | `ยอดส่ง` = เบิก-คืน-เสีย, no guard | same | **b** (whether still scheduled: open question Q5) |
| P3 profitability RPC | `supabase/migrations/20260809075951_p3_profitability_snapshots.sql:464-470, 609-621` | `pending_produce_sessions` -> INCOMPLETE | pending row not found by round id -> may CERTIFY sold = issued | B: a / A: **b** (latent: no app caller of `recordSnapshot`) |
| Transfer `reconcile()` gate | `reconciliation.ts:413-447` | not triggered by `close_refused_unresolved` (null `close_event_timestamp_ms`) | same | b-adjacent (does not stop transfer submission) |

Adjacent effect, opposite direction: the 23 accepted items live only in `pending_sessions.partial_capture` (`20261001065443_pending_produce_partial_capture.sql`), so good-return value, house stock and Morning Brief "ชั่งคืนดี" understate what physically came back while sales are overstated.

## 4. Duplicated `RESOLVED_PENDING_STATUSES`

Three copies of the same rule, no parity test:

1. `src/lib/sales/load.ts:93` (private const) -> used in the SQL prefilter (`:529-531`) and client check (`:538`).
2. `src/lib/produce/round-return-status.ts:67` (exported) -> `:244`.
3. SQL: P3 migration `:609-621`, hard-coded `NOT IN ('finalized','duplicate')`. It has no `expired_empty_draft`, so it is stricter; harmless, but a third drift point.

Tests: `round-return-status.test.ts:119-127` asserts only its own copy; `sales/load.test.ts:504-514` asserts the filter string of the other. A new `finalization_status` added to one copy would silently diverge: it would be resolved for Sales scope blockers yet blocking (or the reverse) for round state.

## 5. Existing tests and the gap

Covered:

- `produce/round-return-status.test.ts`: "Test 3 — withdrawal with no return evidence at all stays the sold-out case" (:56), "Test 4 — a closed-and-refused return is blocked, never absent" (:64), "a failed_closed finalization is blocked even with no closer text" (:75), "Test 5 — open document is pending" (:83), "Test 6 — a persisted return outranks any leftover evidence" (:91). These test the **pure** classifier only. `loadRoundReturnStatuses` itself has no direct test (the name appears only in a comment).
- `sales/round-return-sold-out.test.ts`: Tests 3/4/5 and "a legacy row carries no round, so the guard cannot reach it" (:146). This documents, but does not question, the null-round gap.
- `sales/load.test.ts`: "failed_closed stays visible even though finalized_at is set" (:494), "a failed_closed session the operator corrected and re-sent stops blocking" (:516), "an active failed return after an earlier persisted zero return suppresses sold-out" (:611, round-linked **and** a persisted zero-return row), "a persisted return that omitted a withdrawn product..." (:653), "...round was retired is not an active problem" (:739).
- `produce/daily-close-preflight.test.ts`: "an active failure no round can claim is reported at day level" (:457), "an open, never-closed return document blocks its round" (:449), source-scoping tests (:472-545).
- `summary/purchase-planning.test.ts:663,674`: `hasUnattributedIncompleteReturns`.

**Missing tests (describe only, do not add under this task):**

1. `loadSalesReport` end-to-end, **withdrawal-only round, no return rows at all** + pending row `finalization_status='failed_closed'`, `terminalized=true`, `finalization_error.reason='close_refused_unresolved'`, `partial_capture` non-null, **bound** to the withdrawal round -> expect every identity `QUANTITY_BLOCKED`, `soldQuantity=null`, `valueStatus='PENDING_REVIEW'`, `returnEvidenceIncomplete=true`, `allMarkets.expectedSalesSatang=0`. (Existing :611 always has a persisted return row, so the `loadRoundReturnStatuses` -> `blocked` path is never driven from a pending row alone.)
2. Same fixture, **round id NULL** (plain-text parser-rejection shape). Needs a decision-test: today it yields `TRUSTED` sold-out rows + scope blocker. The test should pin the *intended* behaviour (see fix F1) so that it cannot regress silently either way.
3. Same unbound row with no header date and first ingest timestamp after the 04:00 cutoff of D+1: assert D is not silently clean.
4. Parity test: `load.ts` set equals `round-return-status.ts` set (and the SQL list).
5. White Sheet: a round with persisted withdrawal + failed_closed return must not produce `trusted: true` / a numeric `difference` in `loadDigitalWhiteSheetPageModel`.
6. Morning Brief: `buildMorningBriefBlocks` must show a partial caveat when `valueAuthoritative=false` or `incompleteReturnIssueCount>0`.
7. Filter fidelity: `sales/load.test.ts` `fakeSupabase` ignores `.eq/.in` filters, so a round-id mismatch (my scratch S5) and cancelled-round filtering cannot be tested faithfully. (The scratch copy added `eq` filtering for `accountability_rounds`; without it every round looks cancelled.)

## 6. Concrete risk scenarios

1. **Incident replay, variant A.** 08:10 Sales LINE shows ราชพฤกษ์ "ยืนยันแล้ว ~13,992" and "ถือว่าขายหมด" for items that were actually returned; the banner says only "มีชุดข้อมูลที่ยังไม่ปิด 1 ชุด".
2. **Morning Brief PDF/LINE** (variant A, and variant B headline): ราชพฤกษ์ sales = full withdrawal, no caveat, then purchase planning uses the same day.
3. **White Sheet / ใบขาว close**: expected cash = full withdrawal minus transfers/expenses, so a large false "shortage" for น้อย's actual cash, replied as trusted.
4. **Legacy settlement push**: "ขาด X บาท" / "เงินสดที่ควรเหลือส่งเจ๊" printed numerically from a full-withdrawal ยอดส่ง (footer warns generically).
5. **AI analyst**: asked "ยอดขายราชพฤกษ์เมื่อวาน", may quote `calculatedSalesBaht` (includes pending) or a `TRUSTED` row; sold-out state is not an explicit field.
6. **Date drift**: unbound, undated return sent after 04:00 next day: yesterday clean/sold-out, today falsely blocked.
7. **Direction reversal on correction**: operator later fixes item 22 and the return lands -> `hasPersistedReturn` clears everything, as designed; no stale blocker. Risk exists only while uncorrected.

## 7. Recommended follow-ups (NOT implemented; sales rules unchanged here)

- **F1 (highest).** Bind or attribute the failed plain-text return to its round at refusal time: call `bindPlainTextRound` (or a read-only resolver) before staging `partial_capture`, or record the resolved round on `mark_plain_text_close_refused`. Alternatively make `loadRoundReturnStatuses` also match unbound failed return rows by (source, seller, normalized market, business date) and mark the round `blocked` (fail closed; never `none`).
- **F2.** In `calculate.ts`, when `scopeBlockers` contains `unresolved_pending_session`, do not label identities "ถือว่าขายหมด" and do not render market "ยืนยันแล้ว" figures; at minimum suppress `isSoldOutByAbsentReturn` messaging.
- **F3.** Gate the Digital White Sheet (`requireTrustedWhiteSheetSummary`) on `loadRoundReturnStatuses` / failure scan for the round (new hard-stop warning "มีชั่งคืนที่บันทึกไม่สำเร็จ").
- **F4.** Morning Brief: render `valueAuthoritative=false` and `incompleteReturnIssueCount` (already computed in `morning-brief.ts:165,172`), and caveat `produceFinancial.salesValueSatang`.
- **F5.** Legacy settlement message: suppress "ผลตรวจ/เงินสดส่งเจ๊" numbers for any non-`complete` produce status, not only `invalid`.
- **F6.** One exported `RESOLVED_PENDING_STATUSES` + parity test; derive the SQL list or add a comment-linked test.
- **F7.** Let `reconcile()` consider `close_refused_unresolved` rows (use `finalized_at`/event time, not `close_event_timestamp_ms`) and unbound rows by source.
- **F8.** AI tools: expose `soldOutByAbsentReturn`, `returnEvidenceIncomplete`, and replace `calculatedSalesBaht` with explicit `confirmed` / `pending` plus a `safeToQuote` boolean tied to `scopeBlockers.length===0 && authoritative`.
- **F9.** Populate `produceCrossCheck` in settlement only with a "produce incomplete" note; keep white-sheet sales authoritative.
- **F10.** Decide the fate of the legacy `daily-summary` / `daily_summaries.net_sales` / financial-summary pages (guard or retire).

## 8. Open questions needing production **read-only** data

Q1. For the incident generation (`pending_sessions`, business date 2026-10-07, staff น้อย, ราชพฤกษ์): is `accountability_round_id` NULL or equal to the withdrawal round's id? Also `source_id`, `session_key`, `session_generation`, `close_event_timestamp_ms` (expected NULL), `close_refused_at`, `partial_capture->'issues'` (parser-level vs P4A-level), `runtime_environment`, `created_at` vs first `pending_session_ingest.line_timestamp_ms`.
Q2. Did the 2026-10-08 08:10 Sales / Morning Brief / 08:00 stock messages for ราชพฤกษ์ actually go out, and what did they say (see `cron/daily-sales-summary` logs: `blocked_rounds`, `active_failed_sessions`, `scopeBlockerCount`)? Was `report_status` `blocked`?
Q3. Is the withdrawal round for น้อย/ราชพฤกษ์ still `open` or `closed`, and does `digital_white_sheet_cash_entries` exist/finalized for it (determines white sheet and P3 exposure)?
Q4. Are there other `failed_closed`/`close_refused_unresolved` return rows in the last 30 days with `accountability_round_id IS NULL` (frequency of variant A)? Do any have header dates differing from the first ingest day?
Q5. Which of the legacy reports are still scheduled (Supabase Cron lives outside the repo): `daily-summary`, white sheet LINE close, `/api/settlement`, financial-summary PDF?
Q6. Does `bind_plain_text_accountability_round` get called for plain-text returns anywhere earlier in production's deployed build than in this worktree (deployed SHA unverified)?
Q7. Does any production consumer read `partial_capture`? (Code says reports ignore it until the generation finalizes.)
