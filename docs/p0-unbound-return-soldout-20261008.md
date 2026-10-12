# P0 — Unbound failed return can be reported as sold out

**Date:** 2026-10-08 (Asia/Bangkok)
**Branch:** `fix/failed-return-sales-integrity-20261008`, forked from `origin/main` at `9f08879`
**Status:** RED regression reproduced. No Production changes. Not ready to merge or deploy.

## Verified Production shape (read-only queries)

Over the last 30 days, two Production `pending_sessions` rows were
`finalization_status='failed_closed'`, `terminalized=true`, and had
`accountability_round_id IS NULL`. Both raw documents mention a return.
These two rows **must not be assumed to represent the same failure mechanism**.

- **2026-10-07 case (น้อย / ราชพฤกษ์):** `partial_capture` exists and
  `finalization_error` mentions close refusal. All four direct identity fields
  `business_date`, `staff_label`, `market_label`, and
  `declared_transaction_type` are NULL. The failed session has a source ID.
  There is exactly **one** accountability round with that source ID and business
  date 2026-10-07, matching the reported market and seller.
- **2026-09-22 case:** the pending row is also failed, terminalized, and
  unbound, but lacks `partial_capture`. It must be investigated separately
  before assuming identical recovery.

No row was modified or backfilled. These facts alone do **not** confirm
whether an inaccurate sales, White Sheet, or Morning Brief message was
actually delivered.

## Exact reproducer

`src/lib/produce/round-return-status.unbound-p0.test.ts` uses a
filter-respecting fake PostgREST database:

1. Withdrawal with no attempted return: returns `none` (correct; control
   test passes).
2. Same withdrawal with a `failed_closed` return that has no
   `accountability_round_id`: **expected `blocked`, actual `none`**
   (test fails, proving the silent evidence gap).

Command: `bun test src/lib/produce/round-return-status.unbound-p0.test.ts`.

The current loader in `src/lib/produce/round-return-status.ts` selects
pending rows only where `accountability_round_id IN (withdrawal round IDs)`,
so a NULL-round failed return is never seen. The plain-text close code in
`src/lib/line/webhook-service.ts` stages a partial capture and returns
**before** calling `bindPlainTextRound` when the parser reports errors.
This is a **root-cause hypothesis supported by code**; an independent
end-to-end test and deployment-parity check are still needed.

## Repair requirements / security invariants

1. **Prospective binding:** For a plainly identified return document, bind
   its accountability round before declining a malformed close, without
   making any partial item an official `produce_item`. Never create a new
   withdrawal round from a refused or ambiguous document. Preserve
   concurrency, idempotency, source, seller, market, and date checks.
2. **Historical read-only fail-closed path:** Existing unbound failed returns
   must not be ignored. Resolve by verified source + seller + canonical
   market + business date when uniquely attributable. If ambiguous, show
   explicit pending/unverified status, **not sold out or confirmed cash**.
   Do not automatically backfill a historical round ID on Production.
3. **Consumer parity:** P1 Sales rows and messages, Morning Brief, Digital
   White Sheet, legacy settlement/net, and read-only AI reporting must not
   imply verified sold quantities/cash while return evidence is incomplete.
   Calculated provisional amounts may remain visible if prominently labelled.
4. **Strict isolation:** Ignore unrelated source, seller, market, date,
   preview/development records and resolved/superseded failures; never
   attribute one worker's incomplete return to another's round.
5. **Date boundary:** Consider Bangkok 04:00 cutoff and messages arriving
   after the cutoff with no explicit header date; avoid silent assignment
   to the wrong business day.

## Tests before any release

- RED reproducer above turns GREEN with a realistic, filter-aware fake.
- A healthy no-return round is still allowed to be sold out.
- Different market/source/day failures do not poison another round.
- Duplicate/ambiguous candidate rounds fail closed without guessing.
- Later genuine persisted return clears the provisional failure.
- Return partial capture never enters official inventory/settlement writes.
- Morning Brief and White Sheet never report confirmed amounts for the
  unresolved case; stable API and LINE messages include a clear warning.
- PostgreSQL integration and real LINE Preview UAT on test-only records,
  including at/before/after 04:00.
- Full regression compared by **test identity**, not failure count alone.

**Release boundary:** This work is separate from AI Consultant Draft PR #174.
No migration, Production mutation, deploy, merge, or historical reconciliation
is authorized by this audit.
