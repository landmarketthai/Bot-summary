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
            ▼                                                                                       ▼
   runAssistantWorker: claim_ai_assistant_jobs (lease, live-lease cap, per-conversation order)
            │
            ├─ authorization: LINE user ─► supervisor env list | ai_assistant_user_grants
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
| ≤ 3 outstanding questions per user/chat, ≤ 500 backlog | `enqueue_ai_assistant_job` under a per-conversation advisory lock |
| ≤ `MAX_RUNNING` answers in flight across all invocations | `claim_ai_assistant_jobs` (serialized claim, live-lease count) |
| Follow-up waits for the previous question | claim skips a job with an earlier open job in the same conversation |
| Crashed worker's job is recovered | lease expiry → reclaim (attempts +1); retired after `max_attempts + 2` |
| A taken-over worker cannot write | every RPC after claim is fenced by `lease_token` |
| Model is not paid twice after a crash | answer persisted before delivery; reclaim skips the model |
| A reply is never sent twice | `reply_started` recorded before the call; unknown outcome → `uncertain` |
| A push is never shown twice | stable `delivery_retry_key` → LINE `X-Line-Retry-Key` (409 = already sent) |
| No provider text stored | `last_error_code` CHECK `^[a-z0-9_.:-]{1,80}$` |
| Tables unreachable except via RPC; RPCs service_role only | REVOKE ALL + grants (asserted in the PG suite) |
| Per-user / per-market data scope | `authorization.ts` before any read + market filter at the data source |
| Settlement only for supervisors (Decision 1) | tool not offered to staff and refused if called |
| Memory isolation | turns keyed by destination + chat + LINE user, TTL 30 min, newest 6 kept |
| Answers state only tool figures | `ungroundedNumbers` → answer withheld |
| DB I/O bounded per answer | `boundedJobFetch`: job deadline, per-call cap, ≤ 4 requests in flight |

## Authorization model

Identity is the LINE user id from the signed webhook — never the question
text or the model's tool arguments.

- **supervisor**: `BOT_SUMMARY_ASSISTANT_SUPERVISOR_LINE_USER_IDS` (all
  markets) or a grant with `role = 'supervisor'` (its markets). Any staff
  member inside those markets, settlement included.
- **staff**: grant with `role = 'staff'` and `staff_label`. Own documents only
  (a staff argument naming someone else is refused; "ของผม/หนู" maps to the
  label), own markets only, no settlement tools.
- **no grant**: a fixed Thai notice; the model is not called.

The chat must still be on `BOT_SUMMARY_ANALYST_LINE_SOURCE_IDS`. Answers are
posted to the chat where the question was asked — in a group, everyone in it
sees the asker's answer.

Managing grants (service role / SQL editor):

```sql
-- staff member ดำ, market ราชพฤกษ์ only
INSERT INTO public.ai_assistant_user_grants (line_user_id, role, staff_label, market_labels)
VALUES ('U…', 'staff', 'ดำ', ARRAY['ราชพฤกษ์']);
-- market supervisor
INSERT INTO public.ai_assistant_user_grants (line_user_id, role, market_labels)
VALUES ('U…', 'supervisor', ARRAY['พาซิโอ้ผัก', 'วัดตะกล่ำ']);
-- revoke
UPDATE public.ai_assistant_user_grants SET active = false, updated_at = now() WHERE line_user_id = 'U…';
```

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
2. Apply `supabase/migrations/20261031090000_ai_assistant_jobs.sql`
   (rollback: `supabase/rollback/20261031090000_ai_assistant_jobs.down.sql`).
3. Preview with an isolated Supabase branch and a test LINE channel: set
   `BOT_SUMMARY_ANALYST_ENABLED=true`, a test group in
   `BOT_SUMMARY_ANALYST_LINE_SOURCE_IDS`, supervisors/grants, `OPENAI_API_KEY`.
4. Run the live eval on fixture data:
   `bun scripts/ai-assistant-thai-eval.ts --live --out docs/ai-assistant/thai-eval-results.md`.
5. Decide `BOT_SUMMARY_ASSISTANT_PUSH_FALLBACK_ENABLED` (LINE quota).
6. Set the GitHub variable `AI_ASSISTANT_CRON_ENABLED=true` (worker sweep).
7. UAT in a management chat, then Production flags.

## Verification in this PR

- `bun test src/lib/ai/assistant` (+ PostgreSQL: `ALLOW_DISPOSABLE_POSTGRES_TESTS=1`)
- [`preview-demo-transcript.md`](preview-demo-transcript.md): `scripts/ai-assistant-preview-demo.ts`
  — real webhook, real SQL queue, worker, authorization, memory and delivery;
  simulated LINE, scripted model, fixture data.
- [`thai-eval-results.md`](thai-eval-results.md): `scripts/ai-assistant-thai-eval.ts`.

## Known limits and risks

- **Not measured against the real GPT-6 Luna.** No API key in the build
  environment; tool selection by the real model is unmeasured. The scripted
  stand-in only proves the pipeline.
- **No Vercel Preview UAT yet**: needs an isolated Supabase branch and a test LINE channel.
- Crash recovery latency: lease (120 s) + cron interval (5 min, GitHub
  Actions schedules can be late). Expired reply tokens then need push.
- Aborting a PostgREST request does not cancel the PostgreSQL statement; that
  is bounded by the role's `statement_timeout`.
- `uncertain` deliveries (ambiguous reply) are not resent by design; they are
  counted in `ai_assistant_queue_health().undelivered_24h`.
- Grounding checks figures ≥ 100 or with decimals; small counts are trusted
  to the tool-only instructions.
- The 13 pre-existing non-PG test failures on `main` are unrelated (see PR).
