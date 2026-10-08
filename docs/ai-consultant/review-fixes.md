# PR #174 — P2 implementation and validation

Validated on 2026-10-08 (Asia/Bangkok), continuing the existing
`feat/ai-consultant-phase1-3` branch from `9128426`. Main baseline was freshly
fetched and tested at `9f0887936b76025cbf33e2aca446703808e9856b` in an isolated
detached worktree. No existing feature implementation or tests were removed.

## Fixes

- **P2-1 — Analyst preservation:** successful Analyst tool executions keep their
  answer when no workflow tool ran. Chat-wide questions never fall back to the
  asker's own document in an Analyst chat. Personal document questions still
  read deterministic evidence. The broad `ตอนนี้` marker now requires document
  context.
- **P2-2 — Transaction kind:** deterministic fallback carries the explicit
  เบิก/เบิกเพิ่ม, ชั่งคืน/คืนดี, or คืนเสีย kind into diagnosis and unfinished
  queries. A missing requested kind cannot be replaced by a different kind's
  saved document.
- **P2-3 — Verified guides:** usage-only answers may explain saved-message wording
  grounded in the successful guide output. Exact verified guide sentences are
  accepted; paraphrases require instructional context for each saved phrase.
  An earlier instructional clause cannot authorize a later live saved claim.
  Personal-status and workflow-evidence guards remain strict. All 21 operational
  guides and their caveats are covered, including `common_replies`.
- **P2-4 — Market clarification:** all three strict workflow schemas accept a
  required `market` string (empty means unspecified). Follow-up context lets a
  supervisor supply the market after ambiguity. The backend canonicalizes and
  filters market **after** scoped queries and source/user checks; it never
  interpolates market into PostgREST filters. Status, diagnosis, and unfinished
  selectors can only narrow the requester's existing permissions.

The new regression cases also verify successful legacy tool outputs, provider
outages, unsupported live saved claims, same-sentence mixed guide/live claims,
canonical markets, hostile selectors, and scope enforcement even when a fake
database ignores query filters. Existing test expectations were preserved.

## Validation evidence

| Check | Result |
|---|---|
| AI + four LINE webhook suites (14 files) | **518 pass / 0 fail**, previously 432 pass |
| Full non-PG branch regression | **5495 pass / 25 fail**, 5520 tests / 291 files |
| Fresh main non-PG baseline | **5085 pass / 25 fail**, 5110 tests / 284 files |
| Exact failing-testcase comparison | **0 differences**; all 25 failures predate this PR |
| `npx tsc --noEmit` | Passed |
| Scoped ESLint (AI + webhook integration) | **0 errors / 1 existing warning** |
| Full `npx eslint`, branch and main | Both passed: **0 errors / 69 warnings** |
| `npx next build --webpack` | Passed with process-local placeholder credentials |
| Simulated LINE transcript regeneration | **20 replies** match `uat-transcript.md` exactly |
| Independent implementation review | Four reproduction scenarios verified; no remaining actionable finding in the fix diff |
| Final diff / `git diff --check` | Passed; changes limited to consultant code, tests, and these handoff documents |

Raw logs and JUnit reports are kept locally in
`C:\GitHub\Bot-summary\tmp\pr174-evidence-20261008` (`focused.log`, `branch.xml`,
`branch.log`, `main.xml`, `main.log`, `*-failures.txt`, `typecheck.log`, `lint.log`,
`full-lint.log`, `main-lint.log`, `build.log`, and `uat-transcript.json`).

## Boundaries and remaining UAT

Consultant business tools remain read-only. No webhook implementation,
idempotency path, finance calculation, migration, Production data, or environment
file was changed. No Auto Reconciliation, merge, or Production deployment.

Ready for independent PR re-review and **Preview UAT**. Live GPT-6 Luna and real
LINE interactions still need Preview verification, particularly the market
follow-up and Thai guide paraphrases. PG integration suites were not run because
this fix changes no SQL/schema and requires no database writes. Existing bounded
lookback/search limits and the conservative Thai phrasing guard remain.

Production rollout remains blocked by the separate P0 sold-out reporting issue
documented in `sold-out-risk.md`, independent security/owner approval, and live UAT.

## 2026-10-08 — Independent re-review round 2 and local validation

The next independent review of commit `0444299` identified four additional P2 edge cases
(see [PR #174 review comment](https://github.com/landmarketthai/Bot-summary/pull/174#issuecomment-6054807984)).
The current **uncommitted** implementation in `answer.ts` and its two regression-test files
addresses those cases; this section documents evidence before the next commit:

1. **Personal status despite an unrelated Analyst tool:** select the intent from the
   original user question. A stock/sales tool response is not persistence evidence
   for a specific person's produce document.
2. **Guide-based false saving claims:** full verified guide text may be returned,
   but an invented claim about a specific already-saved document may not borrow
   keywords, quotation marks, or conditional phrasing from a guide. An unsafe
   model paraphrase is replaced by the verified guide itself.
3. **Produce pending-status routing:** questions such as `ชั่งคืนมีอะไรค้าง`
   and `รายการเบิกค้างอะไร` inspect the actual scoped workflow even on provider
   outage; how-to questions still use knowledge.
4. **No-tool Analyst status answers:** the model cannot claim a document was
   saved without authoritative workflow status, including in management chats.

The same patch also preserves an explicit requested transaction kind when the
model selects a mismatching tool, and preserves aggregate market-wide Analyst
answers rather than substituting a personal status.

### Round 2 evidence

- Independent QA: **84 passed / 0 failed / 218 assertions**; simulated LINE
  transcript: **41 cases, no failures** (local `qa-final.log` and
  `qa-final-transcript.json`).
- Focused Consultant/LINE tests reported by the implementing agent:
  **596 passed / 0 failed**. A separate maintainer rerun of a bounded
  10-file AI/LINE selection passed **516 / 516**.
- Final non-PostgreSQL regression on the branch: **5,583 passed / 25 failed**.
  Main baseline: **5,085 passed / 25 failed**. The failure-name sets were
  identical. Earlier branch run had **27 failures**; the two additional cases
  (multi-image White Sheet routing and a pathological LINE reply hitting a
  five-second timeout) passed on rerun. Treat them as potentially flaky and
  monitor rather than claiming their root cause is proven.
- `npx tsc --noEmit`: passed in the maintainer rerun.
- `npx eslint .`: **0 errors / 69 warnings** in the maintainer rerun
  (same count as main baseline).
- Local `next build --webpack` with process-local placeholder credentials:
  succeeded in the implementing agent's final build log.
- `git diff --check`: passed. No accounting code, migrations, LINE webhook
  implementation, database rows, or Production environment variables were changed.

Original evidence is on the developer workstation in
`C:\GitHub\Bot-summary\tmp\pr174-round2-evidence-20261008`,
including `branch-final.log`, `main-full-tests.log`,
`qa-final.log`, and `build.log`.

**Release gate remains closed:** independent review of the *new commit*,
Live GPT-6 Luna + real LINE Preview UAT, PostgreSQL integration checks,
and the separate P0 failed-return/sold-out fix are still outstanding.
Keep PR #174 Draft; do not merge or deploy to Production.
