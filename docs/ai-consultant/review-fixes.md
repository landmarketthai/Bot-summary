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
