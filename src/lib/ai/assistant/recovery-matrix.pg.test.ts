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
    resolveGroupPolicy: async (sourceId) => ({ ok: true, policy: { sourceId, allowFinancial: true, allowPersonSpecific: true, markets: null } }),
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
    revalidate: (job, scopeKey, deliverTo) => revalidateAssistantJob(job, deps, scopeKey, deliverTo),
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
    await db!.query("TRUNCATE public.ai_assistant_conversation_turns, public.ai_assistant_jobs");
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
