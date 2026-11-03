# Slip reference claims: design contract

Problem: four review rounds showed that ownership derived from the *current* state of AI reads and manual entries cannot prove one credit per transfer. Claims change validity after a scope has finalized (reviews, late images, late sessions, push failures). Reproduced with the real finalizer on PostgreSQL in `src/lib/slips/reference-claims.pg.test.ts` (`CLAIMS_BASELINE=1`): P1-1, P1-2 and P1-3 each hand out ฿140 for one ฿70 transfer.

1. **Source of truth.** `slip_reference_claims` is the ledger of credited references. Each row is one canonical reference, credited by one settlement finalization, to one AI check or one manual entry, at one frozen amount.
   - A reference with a claim row counts **only** for that target, in that finalization's scope, at that amount, everywhere: settlement reconcile, White Sheet, daily settlement, round close.
   - A reference without a claim follows the preview rule (earliest valid claim). Previews are not credits.

2. **Unique constraint and transaction boundary.**
   - `PRIMARY KEY (reference_id)`, with the canonical form enforced by `CHECK (reference_id = normalize_slip_reference(reference_id))`.
   - The `claim_slip_references(finalization_id, claims)` RPC runs `INSERT … ON CONFLICT (reference_id) DO NOTHING` in one transaction and returns the claim that now exists for each requested reference.
   - Two finalizations claiming the same reference at once: the primary key lets exactly one insert; the other waits for its commit and then gets nothing.

3. **Lock ordering.**
   - The claim RPC takes no advisory lock. It relies only on the primary key and checks that its finalization row is `sending`.
   - Reviews (approve, reject, revoke) keep the existing order: round key, then day keys. Inside those locks they now also refuse any target whose reference has a claim (`slip_reference_credited`).
   - No path takes a claim and then an advisory key, so no new lock cycle exists.

4. **Lifecycle.** `tryFinalizeSettlement` runs these steps in order:
   1. Claims its `settlement_finalizations` row (`sending`).
   2. Computes the scope's preview credits with the same loaders as reconcile, for referenced rows only.
   3. Calls `claim_slip_references`, which also stamps `claims_recorded_at` on the finalization.
   4. Runs reconcile, which now counts claims.
   5. Pushes LINE.
   6. Marks the row `sent`.

   Claims are append-only: no UPDATE or DELETE, enforced by a trigger, and there are no direct table grants.

5. **Retries and late claims.**
   - **Retry:** a retry (failed → sending, or a stale re-claim) reuses the same finalization id. Its claims are still there, so it re-credits exactly the same references. A LINE timeout, or a `failed` status after a delivered push, never erases a credit.
   - **Late claim:** another AI read or manual entry of a credited reference, in any scope, is superseded (same amount) or pending (different amount). It never counts.
   - **Frozen scope:** once a finalization has recorded claims, a referenced row in that scope without a claim is "late after settlement". It is pending and does not count, so the finalized total does not move.
   - **Reviews:** approving, rejecting or revoking a target whose reference is credited is refused.

6. **Historical behaviour.** No backfill and no recalculation.
   - Finalizations from before the migration have `claims_recorded_at IS NULL`. Their scopes are not frozen and their references are unclaimed, so they behave exactly as today.
   - Production has no manual references, so every historical reference is AI-only and keeps the AI global-winner rule.

7. **Rollback and version skew.**
   - **Down file:** restores the assert functions, drops the RPC, and keeps the table and every claim row.
   - **New code on the old schema:** the RPC is missing (42883), so no claims are made; the claims table is missing, so the loaders see no claims. This is today's behaviour.
   - **Old code on the new schema:** claims are ignored, which is the pre-change behaviour. Reviews of credited targets are still refused while the asserts exist.
   - **Order:** schema first, then code.

## Round-5 review corrections (both P1s fixed before commit)
- **A credit counts only in the scope of the finalization that wrote it.** The unscoped legacy-day view and a round view can load the same evidence. A round-bound slip received after 04:00 also falls in the next day's window. Every other view sees the row as *elsewhere* (superseded). Tested by `round 5 (A)`: ฿70 handed out once; the day view shows 70 and the round view 0.
- **Frozen in every status.** Once a finalization has recorded credits, its scope stays frozen even after a `failed` that followed a delivered push. Its retry adds no credit: the RPC locks the row and inserts nothing when `claims_recorded_at` is set. A row that arrives in the meantime stays late. Tested by `round 5 (B)`: ฿70 delivered, the snapshot stays ฿70, and the new reference is not credited.
- **Round 6 (P1, finalizer bug that predates this change):** a no-round call re-claimed another round's `failed` row, because stages 2 and 3 and the re-fetch had no round filter. It then sent that row with the day view's money, which already held the day's credits. These queries now use the row key `(source, date, round ?? null)`, the same key as the insert. Tested by `round 6`: the test fails before the fix and passes after; ฿70 is handed out once and R's row stays `failed`.
- **Residual P2 limits (documented):**
  - A scope freezes as soon as it credits, so a failure before any push freezes it too (reconcile blocked, produce failure, returns exceeding withdrawal). A referenced slip of that scope that arrives later stays late, and the eventual message under-counts. Nothing is doubled; an operator corrects it outside the scope.
  - Round-bound rows credited by the legacy-day finalization appear in no round White Sheet. They show as elsewhere, while the day message counted them.
  - Unreferenced manual entries in a session closed after settlement still count, so they can move the scope's live total. This is the known no-identity limit.
  - The Stage-2 re-claim without a round can pick another round's `failed` row. This is a finalizer issue that predates this change.
  - A malformed claim element aborts the call, so the settlement fails closed.
