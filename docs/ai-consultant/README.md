# @Botsummary AI Consultant (Phase 1–3)

Extends the existing read-only GPT-6 Luna analyst so frontline workers can ask,
in Thai, how to use Bot Summary, what happened to their own latest Produce
document (เบิก / ชั่งคืน / คืนเสีย), why it is blocked, and what to do next.
Nothing in the consultant writes business data.

## Flow

```
LINE text addressed to @Botsummary (mention or literal prefix)
  └─ webhook-service.ts: raw event persisted + deduplicated (redelivery = no-op)
     ├─ chat in BOT_SUMMARY_ANALYST_LINE_SOURCE_IDS   → analyst tools + consultant tools
     ├─ chat in BOT_SUMMARY_CONSULTANT_LINE_SOURCE_IDS → consultant tools ONLY
     └─ otherwise                                     → "ยังไม่เปิดใช้งานในแชทนี้"
  └─ consultant/answer.ts
     1. authorization.ts   scope from the signed event (before any read)
     2. conversation.ts    same user's last ≤2 questions, same chat, ≤10 min (questions only)
     3. readonly-analyst   GPT picks tools; extension tools run with the scope bound
        ├─ get_usage_guide            → knowledge.ts (versioned, test-verified)
        ├─ get_submission_status      → workflow-status.ts → diagnostics.ts
        ├─ get_unfinished_submissions → workflow-status.ts → diagnostics.ts
        └─ get_submission_problem     → workflow-status.ts → diagnostics.ts
     4. guardConsultantAnswer: model reply rejected (deterministic reply used)
        if it uses internal terms or claims "บันทึกแล้ว" without persisted=true
     5. model error / timeout → deterministicConsultantAnswer (same tools, no model)
```

The model chooses tools and phrases the reply. Facts, lifecycle state,
saved-vs-unsaved counts, blockers and the allowed next actions are computed by
backend code and passed to the model as `suggestedReply` plus structured
evidence.

## Modules

| File | Role |
|---|---|
| `src/lib/ai/consultant/types.ts` | Scope, lifecycle states, action ids |
| `src/lib/ai/consultant/authorization.ts` | Flags, chat allowlists, supervisor list, scope resolution, staff-name authorization |
| `src/lib/ai/consultant/knowledge.ts` | 21 verified how-to topics + guides for every action id |
| `src/lib/ai/consultant/workflow-status.ts` | Authorized, bounded reads of `pending_sessions` + persistence proof in `produce_sessions` |
| `src/lib/ai/consultant/diagnostics.ts` | Deterministic state → actions → Thai worker message |
| `src/lib/ai/consultant/conversation.ts` | Follow-up context from `raw_messages` |
| `src/lib/ai/consultant/answer.ts` | Tool definitions, orchestration, guard, fallback |
| `src/lib/ai/readonly-analyst.ts` | `AnalystToolExtension` (+ `exclusive` for worker chats), full-history fix |
| `src/lib/line/webhook-service.ts` | Routing + consultant-only chats |

## Authorization (initial, deliberately narrow)

- Identity = LINE `source` id + `userId` from the signature-verified webhook.
  Question text ("ของผม", "ของน้อย") and tool arguments never prove identity.
- Worker: only `pending_sessions` rows with `line_user_id = asker` AND
  `source_id = this chat` (filter in the query, re-checked in memory).
- A name in the question equal to the asker's trusted `line_operator_identities.staff_label`
  is treated as "self" (still filtered by `line_user_id`). Any other name from a
  non-supervisor → refused without querying.
- Supervisor (`BOT_SUMMARY_CONSULTANT_SUPERVISOR_LINE_USER_IDS`): documents in
  all consultant-allowlisted chats, optionally filtered by staff name.
- Worker chats (`BOT_SUMMARY_CONSULTANT_LINE_SOURCE_IDS`) never receive sales /
  settlement tools; a hallucinated analyst tool call is refused by the backend.
- Runtime environment: Production reads `production` + legacy NULL rows; Preview /
  development read only their own rows.

There is no general staff ↔ LINE-user mapping beyond `line_operator_identities`
(Guided Menu operators). Workers not in it can still ask about their own
documents (by `line_user_id`) but cannot use their name as a shortcut.

## Lifecycle the consultant distinguishes

`capturing`, `needs_correction`, `close_refused_correctable`,
`awaiting_confirmation`, `finalization_pending`, `finalized` (only with a
proven `produce_sessions` row whose ingest key matches the generation),
`duplicate_already_saved`, `failed_terminal`, `expired_empty`,
`cancelled_or_superseded`, `unknown`. Workers never see these names.
A LINE message being received, or lines being parsed into `partial_capture`,
is never reported as saved.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `BOT_SUMMARY_CONSULTANT_ENABLED` | off | Master switch; off = previous behavior exactly |
| `BOT_SUMMARY_CONSULTANT_LINE_SOURCE_IDS` | empty | Worker chats: consultant only |
| `BOT_SUMMARY_CONSULTANT_SUPERVISOR_LINE_USER_IDS` | empty | LINE users who may ask about others |
| existing `BOT_SUMMARY_ANALYST_*` | unchanged | Analyst chats also get the consultant when enabled |

No database migration is required.

## Known limitations

- `pending_sessions` keeps ONE row per sender per chat; a new document by the
  same sender replaces the previous one, so the consultant only sees each
  sender's latest document (lookback 3 business days).
- Slips, White Sheet and settlement status are not inspected (how-to only).
- Entry-gate validation issues are known only when a partial-capture snapshot
  exists for the current revision; otherwise only parse failures are reported.
- Recovery of a closed-without-saving round is admin-only and has no automated
  apply step (see `phase4-reconciliation-proposal.md`).
- Sold-out reporting risk for unbound failed returns: see `sold-out-risk.md`
  (documented, not changed here).

## Staged rollout

1. Merge with all flags off (no behavior change; verified by tests).
2. Preview: `BOT_SUMMARY_CONSULTANT_ENABLED=true`, one test worker chat in
   `BOT_SUMMARY_CONSULTANT_LINE_SOURCE_IDS`, one supervisor id. Run the UAT
   script in `uat-transcript.md` against live GPT-6 Luna.
3. Production pilot: one worker group + supervisors; monitor
   `Bot Summary analyst failed` logs and answer quality for a week.
4. Widen to remaining worker groups.

Rollback: unset `BOT_SUMMARY_CONSULTANT_ENABLED`.
