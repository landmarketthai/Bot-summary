# P0 failed-return sales integrity — 2026-10-08/09 (local-only)

## Scope and safety
Branch `fix/failed-return-sales-integrity-20261008`, base `9f0887936b76025cbf33e2aca446703808e9856b`.
Commits: `8a4f227` (red reproducer), `280186c` (first mitigation), then the audit/completion
commit described below. No production write, migration application, record repair, LINE
push, remote push, PR, merge or deploy was performed. Incident context (not re-verified —
no read-only production access in this session): 2026-10-07 pending session
`4e0d5ed6-a3f3-4ee4-acd2-7faff90fa57b` (failed_closed, null round, partial capture); the
2026-09-22 case `81f1db96-8780-492f-9cda-2c61d5a92cd0` has no partial capture and is unverified.

## Core invariant
An unprocessed, unbound, refused or erased ชั่งคืน is never proof that the withdrawal sold
out. While return evidence is unresolved, quantities and every money conclusion derived
from them (sales, ยอดส่ง, expected cash, ขาด/เกิน) are provisional (รอตรวจสอบ).

## One integrity policy, two layers
1. **Evidence → round** (`src/lib/produce/round-return-status.ts`):
   `activeUnboundReturnIdentities` (lifecycle-active, non-withdrawal, unbound attempts) +
   `protectiveUnboundReturnRounds` (narrowing attribution, never a binding). Used by the
   Sales loader AND `runDailyClosePreflight` (they previously disagreed).
2. **Round → money verdict** (`src/lib/settlement/produce-value-status.ts`):
   `settlementProduceValueStatus` (existing settlement rule, now alias-aware),
   `marketProduceValueStatus` (White Sheet scope, no seller),
   `loadProduceValueStatusResolver` / `markUncertifiedProduceNets` /
   `uncertifiedReportGroupKeys` (legacy seller/market screens). Anything but `complete`
   is not money.

## Defects found in 280186c and fixed
| # | Sev | Defect | Fix |
|---|-----|--------|-----|
| A1 | P0 | Exact 4-field match: a typo/unreviewed-alias/wrong-group refused return matched no round and the round stayed `none` (silent sold-out). `normalizedMarketLabel` ignored reviewed aliases. | Narrowing attribution: start from all rounds of the date, narrow by source → seller → canonical market only where some round shares the value; protect every survivor. Exact evidence still protects only its own round. |
| A2 | P0 | Rotation erasure: `open_pending_plain_text_generation` rewrites the single `pending_sessions` row, wiping a failed_closed return (status, text, round) when the same LINE user sends the next header — before the 08:00 reports. | Migration `20261008150000_pending_session_retired_generations.sql` (append-only table + AFTER UPDATE trigger, evidence only). Sales scan reads retired `failed_closed` non-withdrawal generations (not `user_cancelled`/`superseded`); a database without the table reads as empty, any other read error fails closed. |
| A3 | P1 | Mixed document (เบิก + คืน section) with errors bound with `p_is_new_round=true` → could mint/reuse a round from a refused document. | `refusedReturnMayBindRound`: never a new-round document; return kind from header or items. |
| A4 | P1 | Refused return bound with the fallback date = processing clock (`bangkokBusinessDateNow`), not the event; across 04:00 → wrong round (D+1 blocked, D sold-out). | `undatedBusinessDateAmbiguous` (±30 min of 04:00 or clocks disagree): refused documents are not bound; valid undated continuations are refused at close gate and finalizer with `UNDATED_CUTOFF_REPLY`. |
| A5 | P1 | Finalizer replaced the parse-error reply with the bind refusal text. | Attribution-only bind refusal is logged, never shown. |
| A6 | P2 | A return whose every item line failed had kind `null` (could not bind; lifecycle could never supersede it). | Parser exposes `header_transaction_type` (explicit only); used by binding and `transactionKindFromText`. |
| A7 | P2 | `unattributableReturnRisk` demoted every seller for any missing field. | Now only when an attempt cannot be placed on any round of its day. |
| A8 | P2 | Two `RESOLVED_PENDING_STATUSES` copies. | Sales imports the exported one. |
| D1 | P0-D | Undated return sent just after 04:00 (late return for yesterday) attributed only to today. | Undated **return** attempts within ±30 min of 04:00 are reported on both days; only a resend on the EARLIER day may supersede across the cutoff (`classifyProduceFailuresAcrossCutoff`, used by Sales scan and preflight) — the later day's ordinary return never clears yesterday's failure. Withdrawals keep the event-time rule. |

### Fixed after the independent review of this patch
| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| R1 | P1 | A return refused at close but not yet terminal (status `pending`, `close_refused_at`) was dropped when the next header rotated it. | Trigger also keeps `close_refused_at` (only for that generation); reader keeps failed_closed OR close requested/refused. Never-closed drafts still discarded. |
| R1b | P1 | Retaining refusals made every typo-corrected return a permanent block (exact-identity supersession only). | Lifecycle release for unbound **return** attempts: released only when EVERY withdrawal round it could belong to (narrowed source → seller → canonical market) got a later main return of the same kind. Another market's return of the same seller (ต้อม) or another seller's return never releases it. |
| R2 | P1 | Cross-cutoff: next day's ordinary return superseded yesterday's failed return. | Earlier-day-only cross-cutoff supersession. |
| R3 | P1 | Legacy screens blocked every pre-round date ("no round" → blocked). | Before `PLAIN_TEXT_ROUND_ENFORCEMENT_FROM` (2026-08-11) a seller/market with no round is judged by day-level blockers; from that date on round-less produce is never certified (also for White Sheet round-less rows). |
| R5 | P2 | Missing-table tolerance matched on message text. | Only PostgREST `PGRST205` / `42P01` on the first page. |
| R6 | P2 | A preflight error returned 500 for the whole White Sheet. | Verdict error → `blocked` (hard stop), page still renders. |
| R7 | P2 | NULL `session_generation` would make the trigger fail the rotation. | `WHEN (OLD.session_generation IS NOT NULL AND …)`. |
| R10 | P2 | Ingest timestamp lookup unpaged (>1000 rows → silent created_at fallback near 04:00). | Paged with stable order. |
| R11 | P2 | Morning Brief PDF per-market sales cell had no marker. | "(รอตรวจ)" on market rows and the total when pending > 0. |

## Consumers protected in this commit
- **Digital White Sheet** (`white-sheet/load.ts`): preflight verdict for every round in
  scope → new hard stop `RETURN_EVIDENCE_INCOMPLETE_WARNING_PREFIX`. Covers `/white-sheet`,
  `GET/POST /api/white-sheet`, LINE ปิดยอด (refuses ตรง/ขาด/เกิน; integrity read failure
  → "saved, summary not loaded"). `finalizeServerWhiteSheetCashEntry` now requires a
  trusted summary (route → 409).
- **Daily summary LINE cron**: per seller/market verdict; uncertified rows show
  `ยอดส่ง: รอตรวจสอบ` and `⚠️ ยอดขายสุทธิ: รอตรวจสอบ` (withdrawal/returns still shown).
- **`/api/settlement/yod-song`** returns `ยอดส่ง: null` + `produceValueStatus` unless
  certified; the settlement form shows รอตรวจสอบ and no ขาด/เกิน.
- **Financial summary page + PDF**: `produceNetStatus: "return_incomplete"` → ยอดส่ง/ขาด/เกิน hidden.
- **Report summary page + PDF**: `provisional` groups render ยอดส่ง / เงินสดต้องส่งเจ๊ / ขาด/เกิน as รอตรวจสอบ.
- **Morning Brief**: per-section `pendingSalesValueSatang`; LINE shows
  `ยอดขาย (รวมยอดรอตรวจ)` + `ยืนยันแล้ว / รอตรวจ`; PDF KPI shows the unconfirmed amount.
- Already protected (verified): Settlement LINE messages (280186c), Sales LINE/cron, AI
  read-only tools (SalesReport flags).

## Verification (2026-10-09, local)
Method: identical suite groups run on HEAD `280186c` (via stash) and on the working tree,
compared by **test identity** (not counts).
- produce/sales/settlement/summary/cron/data-quality/ai: 2026 pass, 17 fail — the 17 are
  exactly the baseline set (baseline 1983 pass / 17 fail).
- parsers + line: 1680 pass, 2 fail — identical to baseline's 2.
- white-sheet, pdf, reconciliation, settlement-finalizer, app, components and remaining
  lib dirs: 1704 pass, 12 fail — all 12 in baseline (8 central-price White Sheet, 3
  daily-stock cron, 1 review-turns migration-set).
- New P0 tests (all pass): round attribution 22, Sales loader P0 14, lifecycle release 5,
  cross-cutoff 2, binding/cutoff 26, webhook close gate 3, verdict/legacy (incl.
  pre-round dates), White Sheet LINE close 2, Morning Brief 2, daily summary 2, report
  groups 2; PostgreSQL 17 trigger test 5/5 (`ALLOW_DISPOSABLE_POSTGRES_TESTS=1`).
- `inventory-cost` and `purchase-capture` PostgreSQL integration suites time out locally
  on both baseline and this branch (fixed migration lists, unrelated) — environment.
- Typecheck pass. ESLint on changed files: 0 errors, 5 pre-existing warnings.
  `git diff --check` clean.
- `next build --webpack`: compiled + TypeScript OK; **prerender `/overview` fails —
  `supabaseUrl is required`** (no env in this worktree). Build is NOT verified as passing.
  (An earlier attempt caught a real regression — preflight pulled `node:crypto` into a
  client bundle via `white-sheet/load` — fixed by `white-sheet/return-integrity.ts`.)

## Remaining risks / NOT PRODUCTION READY
1. **Migration not applied anywhere but a local PostgreSQL 17.** Production needs
   `20261008150000` before code relying on it gives the erasure protection (code tolerates
   its absence = today's behaviour). Retained evidence starts only from application; past
   erased generations are not recoverable by this change.
2. **Legacy screens run one preflight per date** (financial summary month view ≈ 31
   sequential preflights). Correct but possibly slow; not measured.
3. **Settlement finalization is one-shot**: `settlement_finalizations` stores only
   `sent`; a provisional message is final and no confirmed message follows once the
   return is fixed (no wrong number is sent).
4. **Identity drift**: a mistyped refused return is released once every round it could
   belong to has a later main return. A seller-name typo across several sellers, or a
   multi-market seller who never returns one market, stays provisional; there is no admin
   "resolve failed attempt" workflow yet. Never-closed abandoned drafts are not retained.
   Sales still trusts round-less withdrawal rows on dates that also have rounds (the
   preflight blocks them via `unbound_produce_transaction`).
9. Finalizer refuses an undated continuation if it runs late past 04:00 (conservative:
   its fallback date is the finalizer's clock). `daily-stock-summary` and purchase
   planning still use the non-lifecycle return scan (quantities, not money).
5. **Cutoff residual**: undated returns sent more than 30 minutes after 04:00 follow the
   event-time rule. Undated returns near 04:00 are now refused at close (operators must
   add the date).
6. `daily_summaries.net_sales` is still written on ingest (no reader found); P3
   `recordSnapshot` has no caller (latent).
7. **Build** not verified end-to-end in this worktree (no runtime env); production
   evidence (7 Oct / 22 Sep, whether wrong LINE/Morning Brief messages were sent) not
   verified — no read-only production access in this session.
8. Pre-existing baseline failures (White Sheet central-price, migration manifest,
   Morning Brief PDF/service, preflight message, purchase planning, daily stock) are
   unchanged and unrelated.

Any unresolved/ambiguous financial evidence must remain **รอตรวจสอบ** and must never be
inferred as a confirmed sale.
