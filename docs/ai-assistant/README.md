# @Botsummary AI Assistant (MVP)

Thai Q&A over Bot-summary's authoritative read-only data, answered
asynchronously so it can never delay Produce / Slip / White Sheet events.
Stacked on PR #189 (analyst history, deadline, usage log). **Disabled by
default; not approved for Production.**

## Flow

```
LINE ──signed webhook──► /api/webhook/line ──► WebhookService.processOne
                                                 │  @Botsummary <question>
                                                 ▼
                            enqueue_ai_assistant_job  (one INSERT, idempotent by webhookEventId)
                                                 │
            ┌──── post-response kick (after()) ──┴── /api/cron/ai-assistant-jobs (every 5 min) ────┐
            │                                         1. recovery sweep: unprocessed questions ──► enqueue
            ▼                                         2. worker                                    ▼
   runAssistantWorker: claim_ai_assistant_jobs (lease, live-lease cap, per-conversation order)
            │
            ├─ access: chat on source allowlist (re-checked) ─► approved group policy │ 1:1 grant
            ├─ memory: load_ai_assistant_turns(destination, chat, LINE user) — bounded, expiring
            ├─ business date: fixed at enqueue from the LINE event (Bangkok, 04:00 cutoff)
            ├─ tool loop (GPT-6 Luna via provider seam) ─► scoped executor ─► read-only tools
            ├─ grounding: money-like figures must appear in this answer's tool outputs
            ├─ record_ai_assistant_answer (answer + conversation turn, before delivery)
            └─ delivery: reply (fresh token) │ 400 ► push (opt-in, stable retry key) │ ambiguous ► uncertain
```

The webhook and the ordered per-chat queue do one INSERT per question; the
model, tools and LINE reply run in the worker. Correctness never depends on a
request living after its response: the kick is a latency optimisation, and a
killed kick leaves a leased job that the cron worker reclaims.

## Guarantees and where they are enforced

| Property | Enforced by |
|---|---|
| One job per LINE event (redelivery-safe) | `UNIQUE (line_event_id)` + `enqueue_ai_assistant_job` |
| ≤ 3 outstanding questions per user/chat, ≤ 500 backlog | `enqueue_ai_assistant_job` under one global advisory lock (exact under concurrency) |
| A question is acknowledged only once its job exists | webhook marks the raw message processed after enqueue; an enqueue error is a retryable 503 |
| A failed enqueue is recovered without LINE redelivery | the cron's recovery sweep enqueues unprocessed `@Botsummary` raw messages of the last 30 min (older than 30 s); duplicates are absorbed by `line_event_id` |
| The sweep cannot skip, repeat or starve a question | `list_ai_assistant_recovery_candidates`: only rows containing `@` or mentioning the bot are read (other workflows' rows never are); composite keyset `(created_at, id)`; ≤ 250 rows per run; a persisted cursor resumes where the last run stopped and is cleared at the window end, so every candidate is visited within ⌈candidates / 250⌉ runs |
| ≤ `MAX_RUNNING` answers in flight across all invocations | `claim_ai_assistant_jobs` (serialized claim, live-lease count) |
| One active job per conversation, even for late older events | claim skips a job while another job of its conversation is running; partial unique index on running jobs |
| Follow-up waits for the previous question | queued jobs of a conversation are claimed in LINE order |
| Crashed worker's job is recovered | lease expiry → reclaim (attempts +1); retired after `max_attempts + 2` |
| A taken-over worker cannot write | every RPC after claim is fenced by `lease_token` |
| Model is not paid twice after a crash | answer persisted before delivery; reclaim skips the model |
| A reply is never sent twice | `reply_started` recorded before the call; unknown outcome → `uncertain` |
| A push is never shown twice | stable `delivery_retry_key` → LINE `X-Line-Retry-Key` (409 = already sent); an ambiguous push older than 23 h is `uncertain`, never retried |
| No provider text stored | `last_error_code` CHECK `^[a-z0-9_.:-]{1,80}$` |
| Tables unreachable except via RPC; RPCs service_role only | REVOKE ALL + grants (asserted in the PG suite) |
| Only approved chats get data | chat on `BOT_SUMMARY_ANALYST_LINE_SOURCE_IDS` (checked in the webhook **and** again in the worker) |
| Every member of an approved group shares one scope | active `ai_assistant_group_policies` row → role `group_member` with the policy's categories and markets; no per-user grant is read, and one member's grant never authorizes a group |
| Unapproved groups get nothing | no policy → fixed refusal (or opt-in 1:1 push to an asker who has their own grant) |
| 1:1 chats keep per-user scope | supervisor env list / `ai_assistant_user_grants`; staff see only their own rows |
| Memory isolation and stale scope | turns keyed by destination + chat + LINE user and the SHA-256 access-scope key; TTL 30 min, newest 6 kept |
| A revoked policy/grant never delivers an old answer | every data answer is revalidated against the current scope right before delivery, also after a crash; else withheld |
| Money and cash statuses are exact | `financial-render.ts` renders them from backend fields (satang, sign, null, confirmed vs pending); model text about money is discarded |
| DB I/O bounded per answer | `boundedJobFetch`: job deadline, per-call cap, ≤ 4 requests in flight, response bodies read inside the bound |
| Status tools never miss the asked rows | slip / white-sheet rows scanned in pages and filtered before the output limit; `partial` when the scan cap is hit |

## Authorization model (owner decision, 2026-10-31)

Identity is the LINE user id and chat id from the signed webhook — never the
question text or the model's tool arguments. Signature verification, the
source allowlist and read-only tools are unchanged.

- **Approved group** = on `BOT_SUMMARY_ANALYST_LINE_SOURCE_IDS` **and** an
  active `ai_assistant_group_policies` row. Every member, with or without a
  grant, asks any supported question and sees the answer in the group. The
  scope is the group's: all markets (`all_markets`) or `market_labels`, and the
  categories `allow_financial` (sales, settlement) and `allow_person_specific`
  (per-employee produce, slips, settlement, pending). Staff are not limited to
  their own rows there. No member's grant is consulted.
- **Unapproved group** (allowlisted, no policy): refusal
  "…ตอบในกลุ่มนี้ไม่ได้…"; with `BOT_SUMMARY_ASSISTANT_PRIVATE_DELIVERY_ENABLED=true`
  an asker who has their own grant gets the answer by 1:1 push instead.
- **Not allowlisted** (any chat): not enqueued; the webhook answers
  "ยังไม่เปิดใช้งานในแชทนี้", and the worker refuses again if the allowlist changed.
- **1:1 chat**: the asker's own scope — supervisor (env list or grant) or
  staff (own เบิก/คืน, pending items, slips only); no grant → notice, no model call.

Memory stays per member: turns are keyed by destination + chat + LINE user +
access-scope key, so two members of the same group never share follow-ups. A
policy change (revoked, narrowed markets/categories) starts memory afresh,
and a recorded answer is re-checked right before delivery and withheld.

Managing access (service role / SQL editor, on the target environment only):

```sql
-- approved group: every member may ask everything, all markets
INSERT INTO public.ai_assistant_group_policies (source_id, allow_financial, allow_person_specific, all_markets)
VALUES ('C…', true, true, true);
-- approved group limited to one market
INSERT INTO public.ai_assistant_group_policies (source_id, allow_financial, allow_person_specific, market_labels)
VALUES ('C…', true, true, ARRAY['พาซิโอ้ผัก']);
-- revoke a group
UPDATE public.ai_assistant_group_policies SET active = false, updated_at = now() WHERE source_id = 'C…';
-- 1:1 only: staff member ดำ, market ราชพฤกษ์ / market supervisor
INSERT INTO public.ai_assistant_user_grants (line_user_id, role, staff_label, market_labels)
VALUES ('U…', 'staff', 'ดำ', ARRAY['ราชพฤกษ์']);
INSERT INTO public.ai_assistant_user_grants (line_user_id, role, market_labels)
VALUES ('U…', 'supervisor', ARRAY['พาซิโอ้ผัก', 'วัดตะกล่ำ']);
```

The group id must also be in `BOT_SUMMARY_ANALYST_LINE_SOURCE_IDS`; a policy
alone does not open a chat.

## LINE webhook redelivery and recovery

Verified against the LINE Messaging API documentation (not against the actual
channel, whose setting is unknown):

- Redelivery is **off by default**. Turn it on in LINE Developers Console →
  the Messaging API channel → *Messaging API* tab → *Webhook settings* →
  *Use webhook* on → *Webhook redelivery* on.
- LINE redelivers only after a non-2xx or no response; count and interval are
  not published and may change; redelivery is not guaranteed and LINE may
  disable it for a channel that fails too often.
- A redelivered event has the same `webhookEventId` (deduplicated by the job
  table) and `deliveryContext.isRedelivery = true`; its reply token may already
  be expired. Events may arrive out of order.

The code does **not** depend on redelivery for an enqueue failure: the raw
message is stored first, and the recovery sweep enqueues it on the next cron
run. What still depends on it or remains open:

| Failure | Outcome |
|---|---|
| Raw message INSERT fails (DB down at webhook time) | 503; only LINE redelivery recovers it — lost if redelivery is off |
| Enqueue fails, redelivery off | recovered by the next sweep; with more than 250 unprocessed `@` candidates ahead, by a later sweep (cursor), as long as fewer than ~6 × 250 are ahead within its 30 min window |
| Sweep or worker not running (`AI_ASSISTANT_CRON_ENABLED` unset) | nothing recovers until it runs; questions older than 30 min are not swept |
| Reply token expired by the time the answer is ready | push with `X-Line-Retry-Key` if `BOT_SUMMARY_ASSISTANT_PUSH_FALLBACK_ENABLED=true`, else `undeliverable` |
| Reply request sent, response lost | `uncertain`; not resent (could duplicate) |
| Push response lost | retried with the same retry key (LINE answers 409 if already sent) for 23 h, then `uncertain` |

## Tools

Existing: `get_daily_summary`, `get_market_summary`, `get_stock_summary`,
`get_market_stock`, `get_staff_settlement`, `get_market_settlement`,
`get_settlement_overview`, `compare_daily_sales` (now with per-market totals),
`get_pending_items` (now filterable by staff/market).

New, all read-only and grounded in stored data:

- `get_staff_produce` — เบิก / ชั่งคืน / คืนเสีย lines per document for one staff
  member, quantities as recorded, never summed.
- `get_slip_status` — slip batches of the day with stored counters and the OCR
  check status of each image (NEED_REVIEW/FAILED = admin must check by hand).
- `get_white_sheet_status` — per market: exists, finalized, which inputs were
  entered. No amounts.

With a market scope, sales totals come from the existing calculator run with
`marketFilter` (never re-derived from filtered rows); cross-market stock
category totals are withheld.

## Activation runbook (owner approval required at each step)

1. Review and merge PR #189, then this PR.
2. Apply, in order, `supabase/migrations/20261031090000_ai_assistant_jobs.sql`,
   `20261031150000_ai_assistant_access_scope.sql`,
   `20261031160000_ai_assistant_queue_hardening.sql` and
   `20261031170000_ai_assistant_recovery_scan.sql` (rollbacks in
   `supabase/rollback/`, applied in reverse order).
   Turn on webhook redelivery in the test channel (see above) — recommended,
   not required.
3. Preview with an isolated Supabase branch and a test LINE channel: set
   `BOT_SUMMARY_ANALYST_ENABLED=true`, the test group in
   `BOT_SUMMARY_ANALYST_LINE_SOURCE_IDS`, its `ai_assistant_group_policies`
   row, `OPENAI_API_KEY`.
4. Run the live eval on fixture data with an explicit test key and budget:
   `BOT_SUMMARY_EVAL_OPENAI_API_KEY=… BOT_SUMMARY_ANALYST_INPUT_USD_PER_MTOK=… BOT_SUMMARY_ANALYST_OUTPUT_USD_PER_MTOK=… bun scripts/ai-assistant-eval.ts --model live --max-usd 2 --out-md docs/ai-assistant/eval-results.md`.
5. Decide `BOT_SUMMARY_ASSISTANT_PUSH_FALLBACK_ENABLED` (strongly recommended:
   swept and slow answers need push) and
   `BOT_SUMMARY_ASSISTANT_PRIVATE_DELIVERY_ENABLED` (LINE push quota). Create a
   group policy only for groups whose members may all see the data.
6. Set the GitHub variable `AI_ASSISTANT_CRON_ENABLED=true` (worker sweep).
7. UAT in a management chat, then Production flags.

## Verification in this PR

- `bun test src/lib/ai/assistant` (+ PostgreSQL: `ALLOW_DISPOSABLE_POSTGRES_TESTS=1`)
- [`preview-demo-transcript.md`](preview-demo-transcript.md): `scripts/ai-assistant-preview-demo.ts`
  — real webhook, real SQL queue, worker, authorization, memory and delivery;
  simulated LINE, scripted model, fixture data.
- [`eval-results.md`](eval-results.md): `scripts/ai-assistant-eval.ts` — 74 Thai questions
  (financial, produce, stock, slips, white sheet, pending, business date, memory, ambiguous,
  hallucination, access) graded on the final answer against fixture values; error categories,
  latency, tokens, cost. The committed run uses the scripted stand-in: a **harness check, not
  a GPT-6 Luna score**. Live run: NOT RUN (no test key in this environment).
- `recovery-matrix.pg.test.ts` (PostgreSQL): failed enqueue without redelivery, duplicate
  webhook, worker timeout, crashes, lost reply/push responses, expired token, push retry,
  uncertain delivery.

## Known limits and risks

- **Not measured against the real GPT-6 Luna.** No test key in the build
  environment; answer accuracy of the real model is unmeasured. The scripted
  stand-in only proves the pipeline and the grader.
- **No Vercel Preview UAT yet**: needs an isolated Supabase branch and a test LINE channel.
- Crash recovery latency: lease (120 s) + cron interval (5 min, GitHub
  Actions schedules can be late). Expired reply tokens then need push.
- Aborting a PostgREST request does not cancel the PostgreSQL statement; that
  is bounded by the role's `statement_timeout`.
- `uncertain` deliveries (ambiguous reply) are not resent by design; they are
  counted in `ai_assistant_queue_health().undelivered_24h`.
- Non-financial answers (quantities, slip counts) are still model-worded;
  their figures ≥ 100 or with decimals must appear in that answer's tool
  outputs, and they may not state money. Small counts are trusted to the
  tool-only instructions.
- Approved groups disclose every member's sales, settlement and slip data to
  everyone in the group (owner decision): approve only groups whose members
  may all see it.
- A late, older event waits for the conversation's running job and is then
  answered without that newer turn as context.
- Full non-PG `bun test ./src` has 16 failures that fail identically on the PR #189 head
  (manifest/migration-history, purchase-capture e2e, slip cron deadline, preflight
  message, white_sheet_review_turns); none touch this change.
