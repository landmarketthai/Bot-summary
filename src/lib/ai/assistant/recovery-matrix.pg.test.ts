/**
 * Recovery matrix on REAL PostgreSQL: production WebhookService, dispatcher,
 * SupabaseAssistantJobStore, worker and delivery state machine; LINE is the
 * recording adapter, the model the scripted stand-in, data fixtures. Final
 * state is asserted in SQL.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/ai/assistant/recovery-matrix.pg.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { BOT_SUMMARY_TEMPORARY_ERROR_REPLY } from "@/lib/ai/line-command";
import type { AssistantModelProvider } from "@/lib/ai/model-provider";
import type { LineMessageEvent } from "@/lib/line/types";
import { WebhookService } from "@/lib/line/webhook-service";
import { webhookResponseStatus } from "@/lib/line/webhook-response";
import { createPgSupabase, createSlipTestDb, SLIP_PIPELINE_MIGRATIONS, type SlipTestDb } from "@/lib/slips/testing/pg-slip-harness";
import { answerAssistantJob, revalidateAssistantJob, type AssistantCoreDeps } from "./core";
import { LineDeliveryError } from "./delivery";
import { createAssistantDispatcher } from "./dispatch";
import { SupabaseAssistantJobStore, type AssistantJobStore } from "./job-store";
import { recoverUnenqueuedQuestions } from "./recovery";
import { createFixtureDataReader } from "./testing/fixture-data";
import { ASSISTANT_MIGRATIONS, assistantRpcClient } from "./testing/pg-assistant-db";
import { RecordingLineDelivery } from "./testing/recording-line";
import { ScriptedThaiModel } from "./testing/scripted-provider";
import { runAssistantWorker, type AssistantWorkerOptions } from "./worker";

let db: SlipTestDb | null = null;
if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS === "1") {
  try {
    db = await createSlipTestDb("ai_recovery", [...SLIP_PIPELINE_MIGRATIONS, ...ASSISTANT_MIGRATIONS]);
  } catch (error) {
    if (process.env.AI_ASSISTANT_PG_REQUIRE === "1") throw error;
  }
} else if (process.env.AI_ASSISTANT_PG_REQUIRE === "1") {
  throw new Error("AI_ASSISTANT_PG_REQUIRE=1 needs ALLOW_DISPOSABLE_POSTGRES_TESTS=1");
}
afterAll(async () => { await db?.drop(); });

function client(database: SlipTestDb): SupabaseClient<Database> {
  const base = createPgSupabase(database, { failUpload: new Set(), uploaded: new Map() });
  const ai = assistantRpcClient(database);
  return {
    ...base,
    rpc: (name: string, args?: Record<string, unknown>) =>
      name.includes("ai_assistant") ? ai.rpc(name as never, args as never) : base.rpc(name, args),
  } as unknown as SupabaseClient<Database>;
}

let seq = 0;
function question(text: string, options: { ageMs?: number; id?: string; redelivery?: boolean } = {}): LineMessageEvent {
  seq += 1;
  const id = options.id ?? `rm-${seq}`;
  return {
    type: "message", webhookEventId: id, deliveryContext: { isRedelivery: options.redelivery ?? false },
    timestamp: Date.now() - (options.ageMs ?? 0), source: { type: "group", groupId: "Capproved", userId: `Umember${seq}` },
    mode: "active", replyToken: `reply-${id}`,
    message: { id: `m-${id}`, type: "text", quoteToken: "q", text: `@Botsummary ${text}` },
  };
}

function pipeline(database: SlipTestDb, overrides: { model?: AssistantModelProvider; store?: AssistantJobStore } = {}) {
  const supabase = client(database);
  const store = overrides.store ?? new SupabaseAssistantJobStore(supabase);
  const line = new RecordingLineDelivery();
  const model = overrides.model ?? new ScriptedThaiModel();
  const deps: AssistantCoreDeps = {
    supabase, store, provider: model,
    sourceAllowed: () => true,
    resolveGroupPolicy: async (sourceId) => ({ ok: true, policy: { sourceId, markets: null } }),
    readData: createFixtureDataReader(),
  };
  const service = new WebhookService(supabase, {
    botSummaryAnalystEnabled: true,
    botSummaryAnalystSourceAllowed: () => true,
    scheduleBackgroundTask: () => {},
    replyMessage: async () => {},
  });
  const work = (options: Partial<AssistantWorkerOptions> = {}) => runAssistantWorker({
    store,
    answer: (job, context) => answerAssistantJob(job, context, deps),
    revalidate: (job, scopeKey) => revalidateAssistantJob(job, deps, scopeKey),
    delivery: line, pushFallbackEnabled: true, workerId: "matrix", budgetMs: 15_000, deliveryReserveMs: 2_000,
    temporaryErrorText: BOT_SUMMARY_TEMPORARY_ERROR_REPLY,
    ...options,
  });
  return { supabase, store, line, model, deps, service, work };
}

const job = async (database: SlipTestDb, lineEventId: string) => {
  const rows = await database.query<{ j: Record<string, unknown> }>(
    `SELECT to_jsonb(j) AS j FROM public.ai_assistant_jobs j WHERE line_event_id = '${lineEventId}'`);
  const value = rows[0]?.j;
  return (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown> | undefined;
};
const makeAvailable = (database: SlipTestDb) =>
  database.query("UPDATE public.ai_assistant_jobs SET available_at = now() - interval '1 second' WHERE status = 'queued'");

const describePg = db ? describe : describe.skip;

describePg("recovery matrix (real PostgreSQL)", () => {
  beforeEach(async () => {
    await db!.query("TRUNCATE public.ai_assistant_conversation_turns, public.ai_assistant_jobs, public.ai_assistant_recovery_cursor");
  });

  test("failed enqueue + LINE never redelivers: the worker-cron sweep recovers and answers it", async () => {
    const database = db!;
    const p = pipeline(database);
    const event = question("วันนี้ทุกตลาดขายได้เท่าไหร่?");
    await database.query("ALTER FUNCTION public.enqueue_ai_assistant_job(jsonb, integer, integer) RENAME TO enqueue_ai_assistant_job_offline");
    try {
      const result = await p.service.processEvents([event], "Ubot");
      expect(webhookResponseStatus(result)).toBe(503);
    } finally {
      await database.query("ALTER FUNCTION public.enqueue_ai_assistant_job_offline(jsonb, integer, integer) RENAME TO enqueue_ai_assistant_job");
    }
    // No redelivery arrives. The sweep finds the unprocessed question.
    const recovered = await recoverUnenqueuedQuestions({
      supabase: p.supabase, dispatcher: createAssistantDispatcher(p.store), analystEnabled: true,
      sourceAllowed: () => true, whiteSheetReaderEnabled: false, minAgeMs: 0,
    });
    expect(recovered).toMatchObject({ enqueued: 1, deferred: 0 });
    expect(await database.scalar(`SELECT is_processed::text FROM public.raw_messages WHERE line_event_id = '${event.webhookEventId}'`)).toBe("true");
    await p.work();
    expect(p.line.sent).toHaveLength(1);
    expect(p.line.sent[0]!.text).toContain("40,550.75");
    // A late redelivery or a second sweep changes nothing.
    await recoverUnenqueuedQuestions({
      supabase: p.supabase, dispatcher: createAssistantDispatcher(p.store), analystEnabled: true,
      sourceAllowed: () => true, whiteSheetReaderEnabled: false, minAgeMs: 0,
    });
    await p.service.processEvents([{ ...event, deliveryContext: { isRedelivery: true } }], "Ubot");
    await p.work();
    expect(p.line.sent).toHaveLength(1);
    expect(await database.scalar("SELECT count(*) FROM public.ai_assistant_jobs")).toBe("1");
  });

  test("unprocessed non-question messages are never read by the sweep, so they cannot hide a question", async () => {
    const database = db!;
    const p = pipeline(database);
    await database.query("TRUNCATE public.raw_messages CASCADE");
    // 60 older unprocessed produce texts left by another workflow.
    await database.query(`
      INSERT INTO public.raw_messages (line_event_id, destination, event_type, source_type, source_id, user_id, message_id, message_type, raw_text, payload, is_processed, created_at)
      SELECT 'noise-' || g, 'Ubot', 'message', 'group', 'Capproved', 'Uworker', 'mn-' || g, 'text', 'เบิก มะม่วง ' || g,
             jsonb_build_object('type', 'message', 'webhookEventId', 'noise-' || g, 'timestamp', 0,
               'source', jsonb_build_object('type', 'group', 'groupId', 'Capproved', 'userId', 'Uworker'),
               'message', jsonb_build_object('id', 'mn-' || g, 'type', 'text', 'text', 'เบิก มะม่วง ' || g)),
             false, now() - interval '10 minutes' + (g || ' milliseconds')::interval
      FROM generate_series(1, 60) AS g`);
    const event = question("วันนี้ทุกตลาดขายได้เท่าไหร่?");
    await database.query("ALTER FUNCTION public.enqueue_ai_assistant_job(jsonb, integer, integer) RENAME TO enqueue_ai_assistant_job_offline");
    try {
      expect(webhookResponseStatus(await p.service.processEvents([event], "Ubot"))).toBe(503);
    } finally {
      await database.query("ALTER FUNCTION public.enqueue_ai_assistant_job_offline(jsonb, integer, integer) RENAME TO enqueue_ai_assistant_job");
    }
    const sweep = (maxRows: number) => recoverUnenqueuedQuestions({
      supabase: p.supabase, dispatcher: createAssistantDispatcher(p.store), analystEnabled: true,
      sourceAllowed: () => true, whiteSheetReaderEnabled: false, minAgeMs: 0, limit: 25, maxRows,
    });
    // Only the question is a candidate: even a 1-row budget reaches it.
    expect(await sweep(1)).toMatchObject({ scanned: 1, skipped: 0, enqueued: 1 });
    expect(await database.scalar("SELECT count(*) FROM public.raw_messages WHERE is_processed = false")).toBe("60");
    await p.work();
    expect(p.line.sent).toHaveLength(1);
    expect(p.line.sent[0]!.text).toContain("40,550.75");
  });

  test("duplicate webhook delivery: one job, one message", async () => {
    const database = db!;
    const p = pipeline(database);
    const event = question("วันนี้ทุกตลาดขายได้เท่าไหร่?");
    await p.service.processEvents([event], "Ubot");
    await p.service.processEvents([{ ...event, deliveryContext: { isRedelivery: true } }], "Ubot");
    await p.work();
    await p.work();
    expect(await database.scalar("SELECT count(*) FROM public.ai_assistant_jobs")).toBe("1");
    expect(p.line.sent).toHaveLength(1);
  });

  test("worker timeout: a hung model is cut at the answer budget, retried, and answered once", async () => {
    const database = db!;
    let hang = true;
    const scripted = new ScriptedThaiModel();
    const model: AssistantModelProvider = {
      name: "flaky", model: "flaky",
      respond: (request, options) => (hang ? new Promise(() => {}) : scripted.respond(request, options)),
    };
    const p = pipeline(database, { model });
    const event = question("วันนี้ทุกตลาดขายได้เท่าไหร่?");
    await p.service.processEvents([event], "Ubot");
    expect(await p.work({ answerBudgetMs: 2_500 })).toMatchObject({ retried: 1 });
    expect(await job(database, event.webhookEventId)).toMatchObject({ status: "queued", last_error_code: "answer_timeout", attempts: 1 });
    hang = false;
    await makeAvailable(database);
    await p.work();
    expect(await job(database, event.webhookEventId)).toMatchObject({ status: "completed", delivery_state: "delivered", attempts: 2 });
    expect(p.line.sent).toHaveLength(1);
  });

  test("crash after the answer was recorded: lease expiry, reclaim, delivered once, model paid once", async () => {
    const database = db!;
    const real = new SupabaseAssistantJobStore(client(database));
    let crash = true;
    const crashing: AssistantJobStore = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      setDelivery: async (...args: Parameters<AssistantJobStore["setDelivery"]>) => {
        if (crash) { crash = false; throw new Error("process killed"); }
        return real.setDelivery(...args);
      },
    });
    const model = new ScriptedThaiModel();
    const p = pipeline(database, { store: crashing, model });
    const event = question("วันนี้ทุกตลาดขายได้เท่าไหร่?");
    await p.service.processEvents([event], "Ubot");
    await p.work();
    expect(await job(database, event.webhookEventId)).toMatchObject({ status: "running", delivery_state: "pending" });
    const modelCallsBefore = model.requests.length;
    await database.query("UPDATE public.ai_assistant_jobs SET lease_expires_at = now() - interval '1 second'");
    await p.work();
    expect(model.requests.length).toBe(modelCallsBefore);
    expect(await job(database, event.webhookEventId)).toMatchObject({ status: "completed", delivery_state: "delivered", attempts: 2 });
    expect(p.line.sent).toHaveLength(1);
  });

  test("crash between a sent reply and recording it: never sent twice (uncertain)", async () => {
    const database = db!;
    const real = new SupabaseAssistantJobStore(client(database));
    let calls = 0;
    const crashing: AssistantJobStore = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      setDelivery: async (...args: Parameters<AssistantJobStore["setDelivery"]>) => {
        calls += 1;
        if (calls === 2) throw new Error("process killed after reply");
        return real.setDelivery(...args);
      },
    });
    const p = pipeline(database, { store: crashing });
    const event = question("วันนี้ทุกตลาดขายได้เท่าไหร่?");
    await p.service.processEvents([event], "Ubot");
    await p.work();
    expect(p.line.sent).toHaveLength(1);
    await database.query("UPDATE public.ai_assistant_jobs SET lease_expires_at = now() - interval '1 second'");
    await p.work();
    expect(p.line.sent).toHaveLength(1);
    expect(await job(database, event.webhookEventId)).toMatchObject({ status: "completed", delivery_state: "uncertain" });
  });

  test("lost LINE reply response (5xx / network): uncertain, never resent", async () => {
    const database = db!;
    const p = pipeline(database);
    p.line.replyScript = [new LineDeliveryError("ambiguous", 502, false)];
    const event = question("วันนี้ทุกตลาดขายได้เท่าไหร่?");
    await p.service.processEvents([event], "Ubot");
    await p.work();
    await p.work();
    expect(p.line.attempts.map((attempt) => attempt.channel)).toEqual(["reply"]);
    expect(await job(database, event.webhookEventId)).toMatchObject({ status: "completed", delivery_state: "uncertain", last_error_code: "reply_outcome_unknown" });
  });

  test("expired reply token -> push with the job's stable retry key", async () => {
    const database = db!;
    const p = pipeline(database);
    const event = question("วันนี้ทุกตลาดขายได้เท่าไหร่?", { ageMs: 70_000 });
    await p.service.processEvents([event], "Ubot");
    await p.work();
    const row = await job(database, event.webhookEventId);
    expect(p.line.sent).toEqual([expect.objectContaining({ channel: "push", target: "Capproved", retryKey: row!.delivery_retry_key })]);
    expect(row).toMatchObject({ delivery_state: "delivered", delivery_channel: "push" });
    expect(row!.push_started_at).toBeTruthy();
  });

  test("lost LINE push response: retried with the same key, shown once", async () => {
    const database = db!;
    const p = pipeline(database);
    p.line.pushScript = [{ acceptedThenFail: new LineDeliveryError("ambiguous", null, true) }];
    const event = question("วันนี้ทุกตลาดขายได้เท่าไหร่?", { ageMs: 70_000 });
    await p.service.processEvents([event], "Ubot");
    expect(await p.work()).toMatchObject({ retried: 1 });
    await makeAvailable(database);
    await p.work();
    expect(p.line.sent).toHaveLength(1);
    expect(p.line.attempts).toHaveLength(2);
    expect(new Set(p.line.attempts.map((attempt) => attempt.retryKey)).size).toBe(1);
    expect(await job(database, event.webhookEventId)).toMatchObject({ status: "completed", delivery_state: "delivered" });
  });

  test("push 503/429: retried with backoff and delivered", async () => {
    const database = db!;
    const p = pipeline(database);
    p.line.pushScript = [new LineDeliveryError("ambiguous", 503, true)];
    const event = question("วันนี้ทุกตลาดขายได้เท่าไหร่?", { ageMs: 70_000 });
    await p.service.processEvents([event], "Ubot");
    await p.work();
    expect(await job(database, event.webhookEventId)).toMatchObject({ status: "queued", delivery_state: "push_started", last_error_code: "push_retryable" });
    await makeAvailable(database);
    await p.work();
    expect(await job(database, event.webhookEventId)).toMatchObject({ status: "completed", delivery_state: "delivered" });
    expect(p.line.sent).toHaveLength(1);
  });

  test("ambiguous push older than the 24 h retry-key window: uncertain, no further push", async () => {
    const database = db!;
    const p = pipeline(database);
    p.line.pushScript = [new LineDeliveryError("ambiguous", null, true)];
    const event = question("วันนี้ทุกตลาดขายได้เท่าไหร่?", { ageMs: 70_000 });
    await p.service.processEvents([event], "Ubot");
    await p.work();
    await database.query("UPDATE public.ai_assistant_jobs SET push_started_at = now() - interval '25 hours', available_at = now() - interval '1 second'");
    await p.work();
    expect(p.line.attempts).toHaveLength(1);
    expect(p.line.sent).toHaveLength(0);
    expect(await job(database, event.webhookEventId)).toMatchObject({ status: "completed", delivery_state: "uncertain", last_error_code: "push_retry_window_expired" });
  });
});

/**
 * Sweep pagination on REAL PostgreSQL. Rows are inserted directly so their
 * created_at (and ties) are exact. "Blocked" questions come from a chat that
 * is not on the source allowlist: the sweep must skip them and leave them
 * unprocessed, which is what made pages repeat in the past.
 */
describePg("recovery sweep pagination (real PostgreSQL)", () => {
  beforeEach(async () => {
    await db!.query("TRUNCATE public.ai_assistant_conversation_turns, public.ai_assistant_jobs");
    await db!.query("TRUNCATE public.raw_messages CASCADE");
    await db!.query(`DO $$ BEGIN
      IF to_regclass('public.ai_assistant_recovery_cursor') IS NOT NULL THEN DELETE FROM public.ai_assistant_recovery_cursor; END IF;
    END $$`);
  });

  /** Inserts `count` unprocessed text rows; `createdAt` is a SQL expression of g (1..count). */
  async function seed(database: SlipTestDb, options: { prefix: string; count: number; sourceId: string; text: string; createdAt: string }) {
    const { prefix, count, sourceId, text, createdAt } = options;
    await database.query(`
      INSERT INTO public.raw_messages (line_event_id, destination, event_type, source_type, source_id, user_id, message_id, message_type, raw_text, payload, is_processed, created_at)
      SELECT '${prefix}-' || g, 'Ubot', 'message', 'group', '${sourceId}', 'U${prefix}' || g, 'm-${prefix}-' || g, 'text', '${text}',
             jsonb_build_object('type', 'message', 'webhookEventId', '${prefix}-' || g, 'timestamp', (extract(epoch FROM now()) * 1000)::bigint,
               'replyToken', 'reply-${prefix}-' || g,
               'source', jsonb_build_object('type', 'group', 'groupId', '${sourceId}', 'userId', 'U${prefix}' || g),
               'message', jsonb_build_object('id', 'm-${prefix}-' || g, 'type', 'text', 'text', '${text}')),
             false, ${createdAt}
      FROM generate_series(1, ${count}) AS g`);
  }

  const QUESTION = "@Botsummary วันนี้ทุกตลาดขายได้เท่าไหร่?";
  const NOISE = "เบิก มะม่วงน้ำดอกไม้ 30";

  test("more than one page of rows with the SAME created_at: every row visited exactly once, no loop", async () => {
    const database = db!;
    const p = pipeline(database);
    const tie = "timestamptz '2026-10-31 08:00:00+00'";
    // 80 skipped questions (blocked chat) and 30 recoverable ones, all at one instant.
    await seed(database, { prefix: "tb", count: 80, sourceId: "Cblocked", text: QUESTION, createdAt: tie });
    await seed(database, { prefix: "tq", count: 30, sourceId: "Capproved", text: QUESTION, createdAt: tie });
    const visits = new Map<string, number>();
    let allowChecks = 0;
    const dispatcher = createAssistantDispatcher(p.store);
    const summary = await recoverUnenqueuedQuestions({
      supabase: p.supabase,
      dispatcher: async (input) => {
        visits.set(input.event.webhookEventId, (visits.get(input.event.webhookEventId) ?? 0) + 1);
        return dispatcher(input);
      },
      analystEnabled: true,
      sourceAllowed: (sourceId) => { allowChecks += 1; return sourceId === "Capproved"; },
      whiteSheetReaderEnabled: false,
      now: Date.parse("2026-10-31T08:10:00Z"),
      limit: 25,
      maxRows: 500,
    });
    expect(summary).toMatchObject({ scanned: 110, skipped: 80, enqueued: 30, deferred: 0 });
    expect(allowChecks).toBe(110);
    expect(visits.size).toBe(30);
    expect([...visits.values()].every((count) => count === 1)).toBe(true);
    expect(await database.scalar("SELECT count(*) FROM public.ai_assistant_jobs")).toBe("30");
    expect(await database.scalar("SELECT count(*) FROM public.raw_messages WHERE is_processed = false")).toBe("80");
  });

  test("more than 250 older NON-AI rows ahead of a failed-enqueue question: recovered by the cron sweeps inside its window", async () => {
    const database = db!;
    const p = pipeline(database);
    const t0 = Date.parse("2026-10-31T08:00:00Z");
    // 300 produce texts left unprocessed by another workflow, all older than the question.
    await seed(database, { prefix: "np", count: 300, sourceId: "Capproved", text: NOISE, createdAt: "timestamptz '2026-10-31 07:58:00+00' + (g || ' milliseconds')::interval" });
    await seed(database, { prefix: "aq", count: 1, sourceId: "Capproved", text: QUESTION, createdAt: "timestamptz '2026-10-31 08:00:00+00'" });
    // Cron every 5 minutes while the question is eligible (30-minute window).
    let recoveredAt: number | null = null;
    for (let minute = 5; minute <= 25 && recoveredAt === null; minute += 5) {
      const summary = await recoverUnenqueuedQuestions({
        supabase: p.supabase, dispatcher: createAssistantDispatcher(p.store), analystEnabled: true,
        sourceAllowed: () => true, whiteSheetReaderEnabled: false, now: t0 + minute * 60_000,
      });
      if (summary.enqueued > 0) recoveredAt = minute;
    }
    expect(recoveredAt).not.toBeNull();
    expect(await database.scalar("SELECT is_processed::text FROM public.raw_messages WHERE line_event_id = 'aq-1'")).toBe("true");
    // Produce rows are left exactly as they were.
    expect(await database.scalar("SELECT count(*) FROM public.raw_messages WHERE line_event_id LIKE 'np-%' AND is_processed = false")).toBe("300");
  });

  test("more than one sweep's worth of skipped QUESTIONS ahead: progress across sweeps, recovered inside its window", async () => {
    const database = db!;
    const p = pipeline(database);
    const t0 = Date.parse("2026-10-31T08:00:00Z");
    await seed(database, { prefix: "sb", count: 300, sourceId: "Cblocked", text: QUESTION, createdAt: "timestamptz '2026-10-31 07:58:00+00' + (g || ' milliseconds')::interval" });
    await seed(database, { prefix: "sq", count: 1, sourceId: "Capproved", text: QUESTION, createdAt: "timestamptz '2026-10-31 08:00:00+00'" });
    let recoveredAt: number | null = null;
    for (let minute = 5; minute <= 25 && recoveredAt === null; minute += 5) {
      const summary = await recoverUnenqueuedQuestions({
        supabase: p.supabase, dispatcher: createAssistantDispatcher(p.store), analystEnabled: true,
        sourceAllowed: (sourceId) => sourceId === "Capproved", whiteSheetReaderEnabled: false, now: t0 + minute * 60_000,
      });
      expect(summary.scanned).toBeLessThanOrEqual(250);
      if (summary.enqueued > 0) recoveredAt = minute;
    }
    expect(recoveredAt).not.toBeNull();
    expect(await database.scalar("SELECT count(*) FROM public.raw_messages WHERE line_event_id LIKE 'sb-%' AND is_processed = false")).toBe("300");
  });

  test("cursor: a sweep resumes where the last stopped, clears it at the end of the window, and ignores a stale key", async () => {
    const database = db!;
    const p = pipeline(database);
    const t0 = Date.parse("2026-10-31T08:00:00Z");
    await seed(database, { prefix: "cb", count: 30, sourceId: "Cblocked", text: QUESTION, createdAt: "timestamptz '2026-10-31 07:58:00+00' + (g || ' milliseconds')::interval" });
    const sweep = (minute: number) => recoverUnenqueuedQuestions({
      supabase: p.supabase, dispatcher: createAssistantDispatcher(p.store), analystEnabled: true,
      sourceAllowed: (sourceId) => sourceId === "Capproved", whiteSheetReaderEnabled: false,
      now: t0 + minute * 60_000, limit: 7, maxRows: 20,
    });
    const cursor = () => database.scalar("SELECT coalesce(max(after_id::text), 'none') FROM public.ai_assistant_recovery_cursor");
    expect(await sweep(5)).toMatchObject({ scanned: 20 });
    expect(await cursor()).toBe(await database.scalar("SELECT id::text FROM public.raw_messages WHERE line_event_id = 'cb-20'"));
    expect(await sweep(6)).toMatchObject({ scanned: 10 });
    expect(await cursor()).toBe("none");
    // Wrapped: the next sweep starts at the window start again.
    expect(await sweep(7)).toMatchObject({ scanned: 20 });
    // A key older than the window start is ignored (the window is used instead).
    await database.query("UPDATE public.ai_assistant_recovery_cursor SET after_created_at = timestamptz '2026-10-31 06:00:00+00'");
    expect(await sweep(8)).toMatchObject({ scanned: 20 });
  });

  test("keys keep microsecond precision: page size 1 over microsecond-apart rows visits each once", async () => {
    const database = db!;
    const p = pipeline(database);
    await seed(database, { prefix: "us", count: 9, sourceId: "Capproved", text: QUESTION, createdAt: "timestamptz '2026-10-31 08:00:00.000001+00' + (g || ' microseconds')::interval" });
    const visits: string[] = [];
    const dispatcher = createAssistantDispatcher(p.store);
    const summary = await recoverUnenqueuedQuestions({
      supabase: p.supabase,
      dispatcher: async (input) => { visits.push(input.event.webhookEventId); return dispatcher(input); },
      analystEnabled: true, sourceAllowed: () => true, whiteSheetReaderEnabled: false,
      now: Date.parse("2026-10-31T08:10:00Z"), limit: 1, maxRows: 50,
    });
    expect(summary).toMatchObject({ scanned: 9, enqueued: 9 });
    expect(visits).toEqual(Array.from({ length: 9 }, (_, index) => `us-${index + 1}`));
  });

  test("a question that only mentions the bot (no '@' text) is still a candidate", async () => {
    const database = db!;
    const p = pipeline(database);
    await database.query(`
      INSERT INTO public.raw_messages (line_event_id, destination, event_type, source_type, source_id, user_id, message_id, message_type, raw_text, payload, is_processed, created_at)
      VALUES ('mention-1', 'Ubot', 'message', 'group', 'Capproved', 'Umention', 'm-mention-1', 'text', 'บอท วันนี้ขายได้เท่าไหร่',
        jsonb_build_object('type', 'message', 'webhookEventId', 'mention-1', 'timestamp', (extract(epoch FROM now()) * 1000)::bigint,
          'source', jsonb_build_object('type', 'group', 'groupId', 'Capproved', 'userId', 'Umention'),
          'message', jsonb_build_object('id', 'm-mention-1', 'type', 'text', 'text', 'บอท วันนี้ขายได้เท่าไหร่',
            'mention', jsonb_build_object('mentionees', jsonb_build_array(jsonb_build_object('index', 0, 'length', 3, 'type', 'user', 'userId', 'Ubot'))))),
        false, timestamptz '2026-10-31 08:00:00+00')`);
    const summary = await recoverUnenqueuedQuestions({
      supabase: p.supabase, dispatcher: createAssistantDispatcher(p.store), analystEnabled: true,
      sourceAllowed: () => true, whiteSheetReaderEnabled: false, now: Date.parse("2026-10-31T08:10:00Z"),
    });
    expect(summary).toMatchObject({ scanned: 1, enqueued: 1 });
  });
});
