# HANDOFF — Bot Summary AI Consultant Phase 1–3

Self-contained engineering handoff for the next session (Sol 6.1).

**P2 follow-up completed (2026-10-08):** all four findings below are fixed. See
[review-fixes.md](review-fixes.md) for the current implementation and validation
evidence. The original analysis below is preserved as historical context.

| | |
|---|---|
| Repository | `landmarketthai/Bot-summary` |
| Branch | `feat/ai-consultant-phase1-3` (tracks `origin/feat/ai-consultant-phase1-3`) |
| Base | `origin/main` @ `9f08879` |
| Last reviewed code commit | `ca31c8f` (this handoff is a docs-only commit on top) |
| Draft PR | https://github.com/landmarketthai/Bot-summary/pull/174 |
| Review | https://github.com/landmarketthai/Bot-summary/pull/174#issuecomment-6053603073 (4 × P2, below) |
| Authorization | Implement + test only. **No merge, no deploy, no Production DB/env changes, no financial-calculation changes.** |

Local worktree used so far: `C:\GitHub\_worktrees\bot-summary-ai-consultant` (its `node_modules` is a
Windows junction to `C:\GitHub\Bot-summary\node_modules` — never `rm -rf` through it; `cmd //c rmdir <junction>` first).
The primary checkout `C:\GitHub\Bot-summary` has unrelated uncommitted work on another branch — do not touch it.

Companion docs in this folder: `README.md` (feature overview, env, rollout), `sold-out-risk.md`
(P0 business risk, out of PR scope), `uat-transcript.md` (simulated LINE UAT), `phase4-reconciliation-proposal.md`.

---

## 1. What the feature does

`@Botsummary <question>` in LINE. Extends the existing read-only GPT-6 Luna analyst with:

- **Phase 1 – usage guide**: verified how-to answers (เบิก/ชั่งคืน/คืนเสีย, แก้ข้อ/ลบข้อ, จบรายการ, slips, white sheet, escalation).
- **Phase 2 – workflow status**: real state of the asker's latest Produce document from `pending_sessions` + persistence proof in `produce_sessions`.
- **Phase 3 – diagnosis**: which item blocks, why, and only the next steps the current state really supports.

The consultant never writes business data. Facts are computed deterministically; the LLM only phrases them.

## 2. Architecture and execution flow

```
LINE webhook (signature verified)            src/app/api/webhook/line/route.ts
 └ WebhookService.processEvents              src/lib/line/webhook-service.ts
    raw event persisted + deduped (redelivery → "duplicate", no second reply)
    production: ordered per-chat queue drained inside after() with a 45s deadline
 └ processOne → extractBotSummaryQuestion (mention or "@Botsummary" prefix)   ~line 1084
    analystAllowed  = BOT_SUMMARY_ANALYST_ENABLED && chat ∈ BOT_SUMMARY_ANALYST_LINE_SOURCE_IDS
    consultantOnly  = !analystAllowed && BOT_SUMMARY_CONSULTANT_ENABLED && chat ∈ BOT_SUMMARY_CONSULTANT_LINE_SOURCE_IDS
    neither → "ยังไม่เปิดใช้งานในแชทนี้"; White Sheet read commands only when analystAllowed
    empty question → botSummaryUsageReply(consultantEnabled, consultantOnly)
    else → botSummaryAnalystAnswerer(question, {sourceId, sourceType, lineUserId, destination, rawMessageId, analystToolsAllowed})
 └ answerBotSummaryForLine                   src/lib/ai/consultant/answer.ts:515
    consultant flag off → legacy answerWithReadonlyTools (unchanged behavior)
    1. resolveConsultantScope                authorization.ts   (BEFORE any business read)
    2. loadRecentBotSummaryQuestions         conversation.ts    (same user+chat, ≤2 questions, ≤10 min; questions only)
    3. buildExtension                        answer.ts:344      (tools bound to scope; model args only narrow)
    4. answerWithReadonlyTools(..., extension)  src/lib/ai/readonly-analyst.ts
         tools = analyst tools + consultant tools, or ONLY consultant tools when exclusive (worker chat)
         exclusive mode refuses any non-extension tool name the model emits
         full history resent every round (store:false), ≤3 rounds, ≤6 tool calls, deadlineAt budget
    5. post-processing                       answer.ts:568-581
         workflow tool ran → guardConsultantAnswer (internal terms / unproven saved claim / unsupported action → deterministic reply)
         status question, no workflow tool → deterministicConsultantAnswer          ← review issue 1
         otherwise → claimsSaved(answer, allowQuoted) → REPLY_CANNOT_CONFIRM         ← review issue 3
    6. model error/timeout → deterministicConsultantAnswer (no model)               ← review issue 2
       null → error propagates → webhook replies BOT_SUMMARY_TEMPORARY_ERROR_REPLY
```

Budget: `DEFAULT_BUDGET_MS = 15_000` total, `PER_CALL_TIMEOUT_MS = 8_000` (answer.ts:74-75), deadline measured on the real clock.

### Modules

| File | Role |
|---|---|
| `src/lib/ai/consultant/types.ts` | `ConsultantRequester`, `ConsultantScope` (own / supervisor), `SubmissionLifecycleState` (11 states), `ConsultantActionId` (8 actions) |
| `src/lib/ai/consultant/authorization.ts` | flags + allowlists, `resolveConsultantScope`, `lookupStaffLabel` (`line_operator_identities`), `normalizeStaffName`, `authorizeStaffQuery` |
| `src/lib/ai/consultant/knowledge.ts` | `CONSULTANT_KNOWLEDGE` (21 topics, `KnowledgeEntry`), `CONSULTANT_ACTION_GUIDES`, `findKnowledge`, `getKnowledge`, `CONSULTANT_KNOWLEDGE_VERSION` |
| `src/lib/ai/consultant/workflow-status.ts` | `loadSubmissions` (the single authorized read, :486), `proveProduceSessions`, `pickLatest` (:653), `getLatestSubmissionStatus` (:671), `getPendingSubmissions` (:693), `getSubmissionDiagnosis` (:711), `submissionReference` |
| `src/lib/ai/consultant/diagnostics.ts` | pure `diagnoseSubmission(facts, now)` → state, allowed actions, Thai `workerMessage` |
| `src/lib/ai/consultant/conversation.ts` | follow-up context from `raw_messages` |
| `src/lib/ai/consultant/answer.ts` | tool schemas, `buildExtension`, guard, routing regexes, deterministic fallback, entry point |
| `src/lib/ai/readonly-analyst.ts` | `AnalystToolExtension` (`exclusive`, `deadlineAt`, `context`), `ReadonlyAnalystResult.toolExecutions/extensionOutputs` |
| `src/lib/line/webhook-service.ts` | routing + consultant-only chats (small diff vs main) |

Consultant tools exposed to the model (answer.ts:219-281, all `strict: true`, no identity/scope fields):
`get_usage_guide{topic}`, `get_submission_status{staff, transaction_kind}`, `get_unfinished_submissions{staff}`,
`get_submission_problem{staff, item_number}`.

## 3. Actual implementation state (at `ca31c8f`)

Done and tested: Phase 1–3 as above; authorization; consultant-only chats; guard; deterministic fallback;
security-review fixes (supervisor chat scoping, broader saved-claim detection, budget, name normalization);
18 required scenarios; simulated UAT transcript (`uat-transcript.md`, scripted model — not live GPT-6 Luna).

Validation evidence at `ca31c8f` (Windows, Bun 1.3.14):

| Check | Result |
|---|---|
| AI + webhook suites (14 files) | 432 pass / 0 fail |
| Full non-PG suite | 5409 pass / 25 fail — failure set **identical** to `origin/main 9f08879` (5085 / 25) |
| `npx tsc --noEmit` | clean |
| `npx eslint src/lib/ai src/lib/line/webhook-service.ts src/lib/line/webhook-ai-consultant.test.ts` | 0 errors, 1 pre-existing warning (`webhook-service.ts` unused `replyMessage`, also on main) |
| `next build --webpack` (placeholder env) | compiled successfully |
| PG suites (`*.pg.test.ts`) | not run — no SQL/migration in this PR |
| Live GPT-6 Luna | not run |

Sol 6.1 targeted re-run: 331 tests passed.

## 4. Review findings — root causes and fixes

### Issue 1 [P2] Existing analyst answers overridden by consultant fallback (answer.ts:576–578)

**Symptom.** In an analyst (management) chat, `@Botsummary วันนี้มีอะไรยังไม่จบ` → model correctly calls the analyst
tool `get_pending_items` (all workers) → the valid answer is discarded and replaced with the asker's own produce status.
Broad `ตอนนี้` (e.g. "ตอนนี้ของเหลือเท่าไหร่", a stock question) has the same effect.

**Root cause.**
- answer.ts:568-578 only looks at `result.extensionOutputs`. Analyst tool calls are recorded in
  `result.toolExecutions` but are ignored, so "no workflow tool ran" is true even though the question WAS
  answered from authoritative analyst data.
- `isStatusQuestion` (answer.ts:473) is too broad: `PENDING_QUESTION` (`ค้าง|ยังไม่จบ|ยังไม่เสร็จ`, :462) and
  `PERSONAL_STATUS` (`…|ตอนนี้|…`, :465-466) match management/stock questions.
- The catch-path (answer.ts:582-588) has the same problem when the model fails in an analyst chat: a requester-only
  produce answer is given for a chat-wide question.

**Fix.**
1. After the model returns: `const analystToolRan = result.toolExecutions.some((e) => !WORKFLOW_TOOL_NAMES.has(e.tool) && e.tool !== "get_usage_guide")`.
   If true and no workflow tool ran → return `result.answer` unchanged (legacy analyst behavior; analyst answers
   were never guarded before this PR).
2. Narrow `ตอนนี้` in `PERSONAL_STATUS` to document context, e.g. `ตอนนี้.{0,12}(?:รายการ|ต้องทำ|ติด|เป็นยังไง)`;
   keep `ค้าง` / `ยังไม่จบ` out of `PERSONAL_STATUS` (they stay in `PENDING_QUESTION`).
3. Deterministic override/fallback in analyst chats (`context.analystToolsAllowed !== false`): only when the
   question has a first-person marker (`ผม|ฉัน|หนู|ของผม|รายการผม|เมื่อกี้`). Otherwise rethrow (catch path) /
   keep the model answer (post-processing). Pass `analystToolsAllowed` into `deterministicConsultantAnswer`
   or decide in `answerBotSummaryForLine`.

### Issue 2 [P2] Deterministic fallback ignores requested transaction kind (answer.ts:503–507)

**Symptom.** Model fails; question "ชั่งคืนล่าสุดของผมเข้าหรือยัง"; asker's newest document is a finalized เบิก →
fallback reports "บันทึกเรียบร้อยแล้ว" about the เบิก. The worker believes the return was saved.

**Root cause.** `deterministicConsultantAnswer` (answer.ts:487) calls `getPendingSubmissions` / `getSubmissionDiagnosis`
with only `{ now, businessDate?, itemNumber? }`. It never derives `transactionKind`, although
`SubmissionQueryOptions.transactionKind` exists (workflow-status.ts:202) and is applied in `loadSubmissions`.
(Also: `getSubmissionDiagnosis` accepts `transactionKind` through `SubmissionDiagnosisOptions extends SubmissionQueryOptions`.)

**Fix.** Add a pure helper and use it in the fallback:
```ts
export function kindFromQuestion(q: string): "withdrawal" | "return" | "damaged_return" | undefined {
  if (/คืนเสีย/u.test(q)) return "damaged_return";      // check before ชั่งคืน/คืน
  if (/ชั่งคืน|คืนดี|\bคืน/u.test(q)) return "return";
  if (/เบิก/u.test(q)) return "withdrawal";               // includes เบิกเพิ่ม
  return undefined;
}
```
Pass `transactionKind` to both fallback calls (and to `getPendingSubmissions` only if its options type allows —
it is `Omit<…,"transactionKind">`; either filter its result by `evidence.transactionKind` or widen the type).
If the kind is named and no matching document exists, reply `REPLY_NONE` — never a different kind's status.

### Issue 3 [P2] Saved-claim guard rejects verified usage guides (answer.ts:581)

**Symptom.** "จบรายการแล้วต้องทำอะไรต่อ" → model answers from `get_usage_guide`, e.g. explaining
"เมื่อบอทตอบว่าบันทึกเรียบร้อยแล้ว ก็ไม่ต้องส่งซ้ำ" → replaced by `REPLY_CANNOT_CONFIRM`.

**Root cause.** answer.ts:581 runs `claimsSaved(result.answer, true)` on every non-status answer. `claimsSaved`
(answer.ts:408) is intentionally broad and only exempts phrases immediately preceded by a quote mark, so
instructional text (unquoted, or in conditional form "ถ้า…บันทึกแล้ว", or copied from guide text such as
`CONSULTANT_ACTION_GUIDES.nothing_needed.howToThai` "รายการนี้บันทึกเรียบร้อยแล้ว ไม่ต้องส่งซ้ำ") is treated as a live
persistence claim. The check cannot distinguish "explaining the phrase" from "asserting this document is saved".

**Fix (ground claims in the guide, keep live claims strict).**
1. If a `get_usage_guide` output with `status: "ok"` exists, no workflow tool ran, and the question is not a
   personal status question → accept saved-phrases that are **grounded**: every `claimsSaved` match in the answer
   must also occur (after `compactThai`) in the concatenated guide text the model received
   (`suggestedReply` + `caveats` + `examples` + the action guides). Ungrounded saved claims still → `REPLY_CANNOT_CONFIRM`.
   Implement as `claimsUngroundedSaved(answer, groundingTexts)` reusing the same regex.
2. Do NOT relax the strict path (workflow tool ran, or personal status question) — that is the safety property.

### Issue 4 [P2] Supervisors cannot disambiguate by market (answer.ts:245–250)

**Symptom.** Supervisor (management chat) asks about น้อย; น้อย has two documents of the same date/kind in two markets
→ `ambiguous` with candidates → the bot asks "หมายถึงรายการไหน" → the follow-up ("ราชพฤกษ์") cannot be honored
because no tool accepts a market or document selector, so the same ambiguity repeats.

**Root cause.** `get_submission_status` / `get_submission_problem` / `get_unfinished_submissions` schemas
(answer.ts:238-281) have only `staff`, `transaction_kind`, `item_number`. `SubmissionQueryOptions`
(workflow-status.ts:202) has no market/reference field; `pickLatest` (workflow-status.ts:653) cannot narrow.
Candidates carry an opaque `reference` (sha256 prefix of session_key:generation) but it is not shown to the
model nor accepted back.

**Fix.**
1. Add optional `market?: string` to `SubmissionQueryOptions`; in `loadSubmissions` filter **in memory after the
   scope filter** with `canonicalMarketLabel` from `@/lib/market` (same helper the analyst uses) on
   `facts.header.market`. Never place it in a PostgREST filter string.
2. Add `market` to the three tool schemas (`type: "string"`, description "ชื่อตลาดถ้าผู้ใช้ระบุ ไม่ระบุให้ส่งค่าว่าง";
   strict mode ⇒ add to `required`, empty string = none). `stringArg(args,"market")` (40-char cap) → option.
3. Include `market` in ambiguity candidates shown to the model (already in `candidateLine`) and instruct:
   "ถ้าผู้ใช้ตอบชื่อตลาดหลังถูกถามกลับ ให้เรียก tool เดิมพร้อม market". Follow-up context already carries the
   previous question, so "ราชพฤกษ์" + previous "ของน้อย" is resolvable by the model.
4. Optional, if market is still not unique: accept `reference` (10 hex) and match it only against rows already
   returned by the scoped query (never a lookup key on its own).

## 5. Security and authorization invariants (must still hold after the fixes)

1. Identity = LINE `sourceId` + `userId` from the signed event only. Question text and tool args never prove identity.
2. Scope is resolved before any business read; tool executors close over the scope. No tool schema has a
   scope/identity/source field.
3. Own scope: `pending_sessions` filtered **in the query** by `line_user_id` AND `source_id`, re-checked in memory.
4. Non-supervisor naming another worker → `forbidden` with **zero** queries. A name equals "self" only when it matches
   the trusted `line_operator_identities.staff_label` (`authorizeStaffQuery`).
5. Supervisor (`BOT_SUMMARY_CONSULTANT_SUPERVISOR_LINE_USER_IDS`): asking chat only, unless asking from a management
   (analyst-allowlisted) chat or DM → all allowlisted chats. No staff name ⇒ own documents only.
6. New selectors (market, reference) may only **narrow** rows already returned by the scoped query.
7. Worker chats (`exclusive`) never get analyst tools; a hallucinated analyst tool name is refused.
8. Read-only: no insert/update/upsert/delete/rpc in consultant paths.
9. Never sent to the model or logged: `accumulated_text`, raw source lines, `session_key`, generation, LINE ids,
   DB error text (mapped to `unavailable`). Worker-typed labels pass through `safeLabel`.
10. "บันทึกแล้ว" only when the **last** evidence has `persisted: true` (proven `produce_sessions` row with matching
    ingest key). Received/parsed ≠ saved.
11. Model suggestions outside `allowedNextActions` are replaced (`suggestsUnsupportedAction`).
12. Consultant flag off ⇒ legacy analyst behavior (except the intentional full-history fix in `readonly-analyst.ts`).

## 6. Tests that must be added (one per issue minimum)

Put them in `src/lib/ai/consultant/answer.test.ts` (has `ScriptedModel`, `toolCall`, `modelText`, filter-accurate
fake DB, `context(...)`, `deps(...)`) and `answer-guard.test.ts` for pure helpers. Never use `mock.module`
(Bun's registry is process-wide and other files mock `@/lib/supabase/server` incompatibly).

| # | Test |
|---|---|
| 1a | Analyst chat, "วันนี้มีอะไรยังไม่จบ", model calls `get_pending_items` then answers → reply equals model answer; no consultant read of `pending_sessions` for the asker. |
| 1b | Analyst chat, "ตอนนี้ของเหลือเท่าไหร่" with `get_stock_summary` → model answer kept. |
| 1c | Analyst chat, model fails on "วันนี้มีอะไรยังไม่จบ" → error propagates (temporary-error reply), not a requester-only produce answer. |
| 1d | Regression: worker chat "ตอนนี้รายการผมเป็นยังไง" with no tool call → still deterministic status. |
| 2a | Asker has finalized เบิก (newest) + failed ชั่งคืน; model fails; "ชั่งคืนล่าสุดของผมเข้าหรือยัง" → reply is about ชั่งคืน, not saved. |
| 2b | Only a finalized เบิก exists; "ชั่งคืนผมเข้าหรือยัง" + model failure → `REPLY_NONE`-style reply, never "บันทึกเรียบร้อยแล้ว". |
| 2c | Unit: `kindFromQuestion` — คืนเสีย→damaged_return, ชั่งคืน→return, เบิกเพิ่ม→withdrawal, none→undefined. |
| 3a | "จบรายการแล้วต้องทำอะไรต่อ" answered via `get_usage_guide` with grounded "บันทึกเรียบร้อยแล้ว" text → kept. |
| 3b | Same question, model adds ungrounded "รายการของคุณบันทึกแล้ว" → `REPLY_CANNOT_CONFIRM`. |
| 3c | Regression: status question + workflow tool + unproven saved claim → still replaced (strict path unchanged). |
| 4a | Management-chat supervisor; น้อย has two same-day ชั่งคืน in two markets → ambiguous; second call with `market:"ราชพฤกษ์"` → that document only. |
| 4b | Own scope with `market` of a document belonging to another user/chat → still none/forbidden (selector only narrows). |
| 4c | Request body: all three workflow tool schemas contain `market`, `strict: true`, no scope fields. |

Remove nothing from the existing 432 tests; adjust only tests whose expectations encode the buggy behavior, and say so in the commit.

## 7. Commands and known baselines

From the worktree root (Windows Git Bash; Bun 1.3.14):

```bash
bun test src/lib/ai src/lib/line/webhook-ai-consultant.test.ts src/lib/line/webhook-bot-summary-analyst.test.ts src/lib/line/webhook-white-sheet-reader.test.ts src/lib/line/webhook-white-sheet-review.test.ts
```
Expected now: 432 pass / 0 fail (plus new tests).

```bash
npx tsc --noEmit
npx eslint src/lib/ai src/lib/line/webhook-service.ts src/lib/line/webhook-ai-consultant.test.ts
```

Full non-PG regression (writes JUnit; compare failing testcase names, not counts):
```bash
bun test ./src --path-ignore-patterns='**/*.pg.test.ts' --reporter=junit --reporter-outfile=branch.xml
```
Known baseline on `origin/main 9f08879`: **25 failures**, all unrelated and identical on this branch:
BR-01 central price seed rule (C/D, H) · central price seeds on withdrawal write (B/C, E, I) · Phase 12/13/14 central price ·
Morning Brief LINE layout / section financial purity / loadMorningBriefReport (2) · P1 executive summary P4 ·
Pending forward migrations (3) · Production ledger version drift (2) · Production migration-history baseline (2) ·
buildWeighSessionSummary category grouping · loadPurchasePlanningReport unattributable withdrawal ·
preflight price conflicts · webhook wiring review_presented · white_sheet_review_turns migration.
Any failure outside this set is a regression.

Build (a worktree has no `.env.local`; a junctioned `node_modules` breaks Turbopack):
```bash
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=x SUPABASE_SERVICE_ROLE_KEY=x npx next build --webpack
```

Regenerate the simulated transcript data: `UAT_TRANSCRIPT_OUT=<abs path>.json bun test src/lib/ai/consultant/answer.test.ts`
(then update `uat-transcript.md` only by copying real outputs).

Environment pitfalls: Git Bash `sed -i` converts CRLF files (e.g. `webhook-service.ts`) to LF — restore with a Bun
script; Git Bash heredocs mangle Thai text — write patch scripts with an editor/Write tool, not heredocs.

## 8. Recommended order of implementation

1. **Issue 2** (smallest, highest worker-facing risk: false "saved"): `kindFromQuestion` + fallback wiring + tests 2a–2c.
2. **Issue 1**: analyst-tool detection, narrowed `ตอนนี้`, analyst-chat fallback rule + tests 1a–1d.
3. **Issue 3**: grounded saved-claim check for guide answers + tests 3a–3c.
4. **Issue 4**: `market` option in workflow-status, schemas, instruction + tests 4a–4c (touches the authorized
   read — re-verify invariants 3–6).
5. Re-run §7 suite, tsc, eslint, full non-PG diff vs baseline, webpack build. Re-check `uat-transcript.md`
   replies still match (regenerate JSON). Push branch; request re-review on PR #174.

## 9. Known limitations

- `pending_sessions` keeps one row per sender per chat; a newer document by the same sender hides the older one;
  lookback 3 business days.
- Slip / White Sheet / settlement status not inspected (how-to only).
- Without a current-revision partial-capture snapshot, only parser failures are reported as blockers.
- Pure under-claiming ("ยังไม่ได้บันทึก" about a saved document, with no instruction) is not caught (pinned test).
- No automated admin recovery for closed-without-saving rounds (`phase4-reconciliation-proposal.md`).
- Workers not in `line_operator_identities` can still query own documents (by LINE id) but cannot name themselves.
- Pre-existing (M2): any member of an analyst-allowlisted chat can read all workers' pending items and settlement
  through the legacy analyst tools.

## 10. Production blockers (independent of the four P2s)

1. **P0 sold-out risk** (`sold-out-risk.md`, out of this PR's scope): a plain-text ชั่งคืน refused for parse errors is
   never bound to its accountability round (`runPlainTextCloseGate` returns before `bindPlainTextRound`), so Sales
   treats the round as sold out (full withdrawal value), and Digital White Sheet / legacy ยอดส่ง / Morning Brief show no
   caveat. Must be resolved (separate PR) before Production rollout.
2. Read-only Production check whether the 2026-10-07 น้อย/ราชพฤกษ์ failed return row has `accountability_round_id IS NULL`.
   Do **not** recover or modify that record.
3. Live GPT-6 Luna UAT on Preview (the transcript used a scripted model).
4. Rollout rule: worker groups only in `BOT_SUMMARY_CONSULTANT_LINE_SOURCE_IDS`, never in
   `BOT_SUMMARY_ANALYST_LINE_SOURCE_IDS` (M2).
5. Explicit owner approval for merge and for each env change. No migration is needed.

## 11. Acceptance criteria for Sol 6.1

- [ ] Issue 1: analyst-tool-backed answers are never replaced by consultant status/fallback; `ตอนนี้`/`ยังไม่จบ`
      management questions keep analyst answers; worker-chat personal status questions still use deterministic status. Tests 1a–1d pass.
- [ ] Issue 2: the deterministic fallback honors the transaction kind named in the question and never reports a
      different kind's state; tests 2a–2c pass.
- [ ] Issue 3: guide answers containing grounded saved-phrases are kept; ungrounded saved claims are still replaced;
      strict path unchanged; tests 3a–3c pass.
- [ ] Issue 4: a supervisor can resolve an ambiguity by market; selectors only narrow scoped rows; schemas strict;
      tests 4a–4c pass.
- [ ] All invariants in §5 still hold (existing authorization/answer/workflow tests green, no edits that weaken them).
- [ ] `bun test` targeted suites 0 fail; `tsc` clean; eslint 0 errors (1 known warning allowed);
      full non-PG failure set identical to the 25-test baseline; `next build --webpack` succeeds.
- [ ] No changes to sales/settlement calculations, migrations, Production data or env; no merge/deploy.
- [ ] `uat-transcript.md` replies re-verified against regenerated output (or updated from it).
- [ ] PR #174 updated with a summary of fixes + test evidence; re-review requested.
