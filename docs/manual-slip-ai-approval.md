# Manual slip ↔ AI slip: one transfer, one money row

Status: local branch `feat/manual-slip-ai-approval-20261102`, stacked on #193.
- **No PR. Not part of the #193 release.**
- Migrations `20261102120000_slip_check_approval_link.sql`, `20261102130000_manual_slip_entry_review.sql` and `20261102140000_slip_review_hardening.sql` have been applied only to local PG. **A Production apply needs an approved deploy plan** (`docs/release/slip-money-release-runbook.md`).

## Problem (pre-existing)
`manual_slip_entries` stored only an amount, with no reference and no link to `slip_checks`. `checked_slip_total = ai_verified_total + manual_slip_total`, so a slip keyed manually after the AI counted it was counted twice: on the #193 code, the same 70-baht slip came to **140**.

## Model
| Object | Purpose |
|---|---|
| `slip_check_approvals` | Audited decision (`approved` + amount, or `rejected`; reason; reviewer; `active`/`revoked`). Targets **exactly one** AI check (`slip_check_id`) or **one** manual entry (`manual_entry_id`). One active decision per target (partial unique indexes plus row locks). Append-only: a trigger forbids DELETE and every UPDATE except active → revoked. |
| `manual_slip_entries.reference_id` | Optional printed reference on a manual entry. |
| `manual_slip_entries.requires_review` | Set by the **new** LINE flow for an entry without a reference. Default `false`: legacy rows and today's app code are unchanged. |
| `review_slip_check`, `review_manual_slip_entry`, `revoke_slip_check_review` | Service-role only (`SECURITY DEFINER`, `search_path` pinned, revoked from `anon`/`authenticated`). |
| money-close lock | `settlement_finalizations` INSERT and every review/revoke take the same `pg_advisory_xact_lock` per round (or source+day), so a review either commits before the finalization or sees it and refuses. |
| `append_manual_slip_entries_atomic` | Same signature. It also stores optional `reference_id`/`requires_review`; old callers get the old behaviour. |

**Refusals:**
- **AI check:** not verified or no transfer amount; **no reference** (BR-02 first); **not the global winner** (duplicate); **round finalized**; another live decision.
- **Manual entry:** session not closed; reference belongs to a live (not rejected) AI check (approve the AI check instead); round finalized; another live decision.
- An identical retry returns the existing decision.

## Money rule: one row per full reference (`src/lib/slips/reference-ownership.ts`, enforced again by the M3 RPCs)
1. **Candidates:**
   - The AI global winner, only if it has a `transfer_amount` (wallet reads are never bank money) and is not rejected.
   - Manual entries in a closed session that are not rejected and are approved, or that need no review while the AI read is not rejected.
2. **The earliest candidate owns the money** (AI wins a tie). A later arrival never takes money from an earlier owner, so a finalized round's total cannot be changed by an image or entry that comes afterwards. The AI read is then reported as `supersededByManual`, and approving it is refused.
3. **Every other claim:**
   - same amount as the owner → superseded (not counted);
   - different amount → **pending** (never silently reconciled);
   - no owner (needs review, or its AI read was rejected) → pending.
4. **Unreferenced entries:**
   - rejected → 0;
   - `requires_review` → pending until an override (this also applies to a referenced entry);
   - otherwise counted: legacy rows and today's grammar, unchanged.
5. **AI owner:** approved → `approved_amount` once; rejected → 0; otherwise the #193 automatic rules (date, outlier, duplicate).
6. **Visibility:** a pending entry is never silently dropped. It appears in settlement (uncertainty line) and the White Sheet (advisory warning). Round-close rows use the same rule: `excluded` covers wallet, outlier, missing date and rejected reads; it doesn't block the close, and the money difference stays visible.
7. **BR-02:** reference resolution refuses to give a reference to a check while another slip of that reference has a decision.

**M3 hardening** (`20261102140000_slip_review_hardening.sql`):
- **Finalized** means `sending`/`sent`/`ambiguous`. A `failed` or unclaimed row doesn't block reviews; its retry re-reconciles.
- The lock is also taken on the `failed → sending` re-claim.
- Round-bound reviews take the round **and** day locks and also honour legacy day-level (NULL-round) finalizations.
- A revoke is refused when it could move the money to a row of another round.
- An identical retry is idempotent even after finalization.
- `service_role` cannot write decisions directly.

## Server-side authorization
`POST /api/admin/slip-reviews` (`handler.ts`):
- The route is gated by `proxy.ts` and `requireAdminActor` (401 without a session, 403 for a non-admin).
- The **reviewer recorded is the verified admin** (email or id). A `reviewer` field in the request body is ignored.
- Writes go only through the service-role client.
- Refusal codes map to 409 (conflict/finalized/duplicate) or 422 (validation).

## Legacy manual entries (no reference)
- Untouched: `reference_id` stays NULL and `requires_review` stays false, so they keep counting exactly as today.
- Nothing is linked to an AI check by guessing (no amount/date matching).
- **Remaining limit:** a legacy or today's-grammar entry that re-keys a slip the AI already counted is still counted twice (`reconciliation.test.ts` `it.failing` "LIMIT"). It closes only for new entries, once the LINE grammar below is enabled.
- The historical audit (`docs/sql/slip-eligibility-historical-audit.sql`) can size the exposure read-only; it has not been run.

## LINE UX proposal (not enabled)
- **AI slip pending:** the operator does not key a manual slip. An admin approves or rejects it from a dashboard pending list (each row: #N in LINE order, amount, read date, reason). A later LINE admin command could be `อนุมัติ #4 50 ภาพเป็น 29 ต.ค.`, using the #N from the batch summary and refusing `#N?`. No long ids to remember.
- **Slip without an image:** `ยอด 50 อ้างอิง 0123` (the reference printed on the slip; last 4+ digits are matched in full against the AI reference).
  - Phase 1: optional.
  - Phase 2: missing reference → saved with `requires_review` and shown as `รออนุมัติ`.
  - The bot replies with the pending count, never a confirmed total for those.
- **Business rule to confirm before Phase 2:** matching on a partial reference (last N digits) is not implemented. The loader matches the full reference only.

## Isolated UAT (local, nothing external)
Same method as PR #182: local `next start` + local PostgreSQL/PostgREST, all migrations including both new ones, LINE/OCR mocked, external calls = 0. Synthetic slips (`.../scratchpad/uat/images`). Scenarios:
1. AI misdated → admin approves via `/api/admin/slip-reviews` → White Sheet, settlement and round close show it once.
2. AI counted + manual `ยอด 70 อ้างอิง X` → manual superseded, checked total unchanged.
3. AI rejected + manual with the same reference → pending → override → counted once.
4. Manual first, then an AI image with the same reference → still once.
5. New flow without a reference → pending in settlement → override approve / reject.
6. Revoke an approval → back to the automatic rule.
7. Finalize the round, then try review / revoke / manual entry → all refused.
8. Non-admin session → 403; the audit row shows the admin, not the body.
9. Roll back M2 then M1 → rows kept, old app code runs.

## Tests
- `src/lib/slips/slip-check-approval.pg.test.ts` (30 cases, PG 17): the full B1 matrix, concurrency and close races (in-flight INSERT and `failed → sending` re-claim), finalized-status scope, legacy NULL-round finalization, cross-round freeze, BR-02, privileges, idempotent re-apply, rollback M3 → M2 → M1, and version skew.
- `src/lib/slips/reference-ownership.test.ts` (10 cases): the pure ownership rule.
- `src/lib/slips/uat-manual-approval.pg.test.ts` (12 scenarios, E2E through webhook → ledger → LINE summary → loaders → round close → admin route); artifact `docs/uat/slip-money-uat.md`.
- `src/app/api/admin/slip-reviews/handler.test.ts`: 4 cases (401/403, reviewer = verified admin, routing, 400/422/409).

## Deploy order (for approval; nothing applied)
1. #192 → #194 → #193 (no migration).
2. Apply M1, then M2 (additive).
3. Deploy this branch.
4. Enable the admin pending list.
5. Enable the LINE grammar phases.

## Rollback
Full procedure, limits and triggers: `docs/release/slip-money-release-runbook.md` §9. Order: M3 down → M2 down → M1 down. M1 cannot be re-applied after its down file. A code revert makes old code ignore decisions (a rejected AI slip counts again, and `requires_review` entries count as ordinary money), so turn the LINE grammar phase 2 off first.
- **Code:** revert. With the code reverted nothing reads the new objects; money returns to the #193 rules.
- **Database:** `supabase/rollback/20261102130000_manual_slip_entry_review.down.sql`, then `20261102120000_slip_check_approval_link.down.sql`. They drop the RPCs and lock trigger and restore the previous append RPC. **Every decision row, `reference_id` and `requires_review` is kept.**

## Second adversarial review: fixes and residual limits (`20261102150000_slip_reference_scope.sql` + containment)
- **Containment of finalized money:** once any valid claim on a reference sits in a finalized round/day (`sending`/`sent`/`ambiguous`), only finalized claims can own it. Claims in open rounds become superseded (same amount) or pending. This holds no matter how they became valid later: session close, approval of an older pending entry, rejection of the owner, or a late OCR completion. **Corrected by the third review (below):** ranking finalized claims by `created_at` still paid a transfer twice when the scope holding the later-created claim finalized first.
- **One reference normalizer:** every whitespace kind, including no-break and zero-width spaces, is removed in TypeScript (`normalizeSlipReference`) and in SQL (`normalize_slip_reference`, applied when manual references are written).
- **Receipt day:** a round-bound slip's review also locks and checks the legacy NULL-round settlement of its receipt day.
- **BR-02 behaviour change (needs sign-off):** reference resolution now refuses a reference that already exists on another slip, reviewed or not, because that check is its duplicate. Before, it was allowed and could make the older check the new owner.

**Residual limits (documented, not fixed):**
1. **Live recomputation of a finalized day can differ from its sent message.** Example: rejecting an open-round owner can let an already-finalized claim become owner in that day's live view. The sent message is the authority. (The double payment across two sent settlements is fixed by M5; see below.)
2. **AI-vs-AI duplicate winner** (pre-existing since main): a check whose OCR completes late keeps its original `created_at` and can become the global winner over a newer check. Containment does not cover AI-vs-AI.
3. **Push timeout that LINE actually delivered:** the row is marked `failed`, so reviews reopen; the retry recomputes. The group may have seen the earlier totals.
4. **Unreferenced manual entries:** legacy entries and today's grammar cannot be matched to an AI read (no identity).

## Third adversarial review: claim order (`20261102160000_finalization_claim_order.sql`, M5)
- **P1 found and fixed.** The finalizer reconciles under its own `sending` row, so its claim always counted as "finalized". When both scopes of a reference were finalized, the earlier-created claim won, so the scope that finalized second counted the transfer again. Example: CB is sent with AI ฿70; CA (manual ฿70, keyed earlier) then finalizes and also counts ฿70.
- **Rule now:** among finalized claims, the scope that finalized **first** owns the reference. When it finalized, its own claim was the only finalized one, so it is the scope that counted the transfer. Open claims, and scopes that finalize later, are superseded (same amount) or pending.
- **Exact claim order:** `settlement_finalizations.money_claimed_at` is stamped by the database when a row enters `sending`/`sent`/`ambiguous`. It is kept on `sent` and on the stale re-claim, cleared on `failed`, and stamped again when a failed row is re-claimed. One global advisory key, taken before the scope key, serializes claims, so a later claimant always sees the earlier claim. Reviews never take that key, so no deadlock.
- **Also fixed:**
  - The finalization lookup is limited to the claims' own rounds and (source, day) pairs. An unbounded lookup could be truncated by PostgREST `max_rows`.
  - AI reads use the same normalizer, so a zero-width space no longer hides a duplicate.
  - The SQL normalizer uses an explicit character list identical to the TypeScript one (no ctype dependence).
- **Tests:** both finalization orders, a failed claim that retries after another scope finalized, the stamp lifecycle, claim serialization against an uncommitted claim, normalizer parity per code point, and rollback M5 → M1. Proof: the two money scenarios fail on the previous rule (฿70 counted twice).
- **Business rule to sign off:** a cross-scope duplicate (an AI read and a manual entry with the same full reference) goes to the scope that finalizes first, not to the earliest-created claim. Before either scope finalizes, previews still show the earliest-created claim as owner, so the first finalizer's sent total can differ from its own preview.

**Residual limits (third review, documented, not fixed):**
5. **Review RPCs (M3) still use the earliest-created rule.** An approval can be accepted that the loader then shows as superseded or pending, because another scope finalized first. This never causes double money; the reviewer sees the entry still pending.
6. **A claim that becomes valid after its own scope finalized** (late OCR, late session close) can leave the transfer counted nowhere. It is under-counted and visible, never doubled.
7. **`ambiguous` counts as finalized** (as for reviews). An ambiguous scope can hold a reference it never paid out; the transfer is then counted nowhere until the scope is resolved.
8. **Rollback with new code:** revert the app code before running the M5/M4 down files. Without a code revert the down files still work, but the exact claim order (M5) and the normalization of new manual references (M4) are lost.

## Round-4 review: OPEN BLOCKER (gates LINE grammar phase 1)
Deriving ownership from the current state of claims cannot prove that one transfer is counted once across scopes. Each review round found a new path, so a targeted patch is not enough.
- **P1-3, confirmed on PostgreSQL 17:** pinned as `test.failing` "OPEN BLOCKER P1-3" in `slip-check-approval.pg.test.ts`.
  - M1 (CA) is counted and sent.
  - An admin rejects the AI read of the same reference in open scope Z.
  - M2 (CC) is approved and finalized, and ฿70 is counted again.
- **P1-1, from the review, not reproduced:** a claim that appears after its scope's legacy day-level finalization inherits that early stamp. It can take a reference that another scope already counted.
- **P1-2, from the review, not reproduced:** a push timeout that LINE actually delivered marks the row `failed` and clears its stamp. A second scope can then count the same transfer. This is limit 3, now known to cause a double count.
- Limit 6 above ("never doubled") is wrong because of P1-1.
- **Containment:** every path needs `manual_slip_entries.reference_id`, and no Production code writes it (`appendEntries` sends only raw_line/amount). AI-only references are unaffected. **Do not enable LINE grammar phase 1 (manual references)** until claims are persisted per finalization: the references each sent settlement counted, unique per reference, written under the claim lock. That is a new design and needs approval.
