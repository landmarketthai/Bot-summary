/**
 * End to end, with only the outside world simulated:
 *   simulated LINE user -> real WebhookService -> durable job (in-memory
 *   store, and the real SQL store on PostgreSQL when enabled) -> independent
 *   worker -> real authorization + memory + grounding -> test-safe LINE adapter.
 * The model is the scripted stand-in and business data is fixtures; nothing
 * here can reach LINE, OpenAI or Production data.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/ai/assistant/e2e.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { BOT_SUMMARY_TEMPORARY_ERROR_REPLY } from "@/lib/ai/line-command";
import { OpenAIAnalystError } from "@/lib/ai/openai-analyst";
import type { LineMessageEvent } from "@/lib/line/types";
import { WebhookService } from "@/lib/line/webhook-service";
import { FakeDatabase } from "@/lib/summary/test-fake-supabase";
import type { SlipTestDb } from "@/lib/slips/testing/pg-slip-harness";
import type { AssistantScope, ScopeResolution } from "./authorization";
import { answerAssistantJob, ASSISTANT_NO_PERMISSION_REPLY, revalidateAssistantJob, type AssistantCoreDeps } from "./core";
import { createAssistantDispatcher } from "./dispatch";
import { SupabaseAssistantJobStore, type AssistantJobStore } from "./job-store";
import { createFixtureDataReader, FIXTURE_MARKETS } from "./testing/fixture-data";
import { MemoryAssistantJobStore } from "./testing/memory-job-store";
import { assistantRpcClient, createAssistantTestDb } from "./testing/pg-assistant-db";
import { RecordingLineDelivery } from "./testing/recording-line";
import { ScriptedThaiModel } from "./testing/scripted-provider";
import { runAssistantWorker } from "./worker";

const SCOPES: Record<string, AssistantScope> = {
  Uboss: { lineUserId: "Uboss", role: "supervisor", staffLabel: null, markets: null, grantSource: "env_supervisor" },
  Udam: { lineUserId: "Udam", role: "staff", staffLabel: "ดำ", markets: new Set([FIXTURE_MARKETS.RATCHAPHRUEK]), grantSource: "grant" },
};
const resolveScope = async (id: string): Promise<ScopeResolution> =>
  SCOPES[id] ? { ok: true, scope: SCOPES[id] } : { ok: false, reason: "no_grant" };

function pipeline(store: AssistantJobStore) {
  const line = new RecordingLineDelivery();
  const model = new ScriptedThaiModel();
  const webhookReplies: string[] = [];
  const kicks: Array<() => Promise<void>> = [];
  const today = bangkokBusinessDateFromTimestamp(Date.now())!;
  const service = new WebhookService(new FakeDatabase() as unknown as SupabaseClient<Database>, {
    botSummaryAnalystEnabled: true,
    // Cmanagement and the 1:1 chats used below are allowlisted; Cexternal is not.
    botSummaryAnalystSourceAllowed: (sourceId) => ["Cmanagement", "Cworkers", "Udam", "Ustranger"].includes(sourceId),
    botSummaryAssistantDispatcher: createAssistantDispatcher(store),
    botSummaryAssistantKick: async () => {},
    scheduleBackgroundTask: (task) => { kicks.push(task); },
    replyMessage: async (_token, text) => { webhookReplies.push(text); },
  });
  let seq = 0;
  const say = async (userId: string, text: string, options: { eventId?: string; chat?: "Cmanagement" | "Cworkers" | "Cexternal" | "dm" } = {}) => {
    seq += 1;
    const id = options.eventId ?? `evt-${userId}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
    const event: LineMessageEvent = {
      type: "message",
      webhookEventId: id,
      deliveryContext: { isRedelivery: Boolean(options.eventId) },
      timestamp: Date.now(),
      source: options.chat === "dm" ? { type: "user", userId } : { type: "group", groupId: options.chat ?? "Cmanagement", userId },
      mode: "active",
      replyToken: `reply-${id}`,
      message: { id: `m-${id}`, type: "text", quoteToken: "q", text: `@Botsummary ${text}` },
    };
    const started = Date.now();
    const [result] = await service.processEvents([event], "Ubot");
    return { result, event, webhookMs: Date.now() - started };
  };
  const deps: AssistantCoreDeps = {
    supabase: {} as SupabaseClient<Database>,
    store,
    provider: model,
    resolveScope,
    sourceAllowed: (sourceId) => ["Cmanagement", "Cworkers", "Udam", "Ustranger"].includes(sourceId),
    // Cmanagement is a supervisors' group with an explicit full group policy.
    resolveGroupPolicy: async (sourceId) => ({
      ok: true,
      policy: sourceId === "Cmanagement"
        ? { sourceId, allowFinancial: true, allowPersonSpecific: true, markets: null }
        : null,
    }),
    readData: createFixtureDataReader([], { today }),
  };
  const work = () => runAssistantWorker({
    store,
    answer: (job, context) => answerAssistantJob(job, context, deps),
    revalidate: (job, scopeKey, deliverTo) => revalidateAssistantJob(job, deps, scopeKey, deliverTo),
    delivery: line,
    pushFallbackEnabled: true,
    workerId: "e2e-worker",
    budgetMs: 20_000,
    deliveryReserveMs: 2_000,
    temporaryErrorText: BOT_SUMMARY_TEMPORARY_ERROR_REPLY,
  });
  return { line, model, say, work, webhookReplies, kicks, today };
}

const db: SlipTestDb | null = await createAssistantTestDb();
afterAll(async () => { await db?.drop(); });

interface StoreUnderTest {
  store: AssistantJobStore;
  /** Let queued retries run now (skip the backoff). */
  makeAvailable(): Promise<void>;
  jobCount(): Promise<number>;
}

const stores: Array<{ name: string; make: () => Promise<StoreUnderTest> }> = [{
  name: "memory",
  make: async () => {
    const store = new MemoryAssistantJobStore();
    return { store, makeAvailable: async () => store.makeAvailable(), jobCount: async () => store.jobs.size };
  },
}];
if (db) {
  stores.push({
    name: "postgresql",
    make: async () => {
      await db.query("TRUNCATE public.ai_assistant_conversation_turns, public.ai_assistant_jobs");
      return {
        store: new SupabaseAssistantJobStore(assistantRpcClient(db)),
        makeAvailable: async () => {
          await db.query("UPDATE public.ai_assistant_jobs SET available_at = now() - interval '1 second' WHERE status = 'queued'");
        },
        jobCount: async () => Number(await db.scalar("SELECT count(*) FROM public.ai_assistant_jobs")),
      };
    },
  });
}

for (const { name, make } of stores) {
  describe(`@Botsummary end to end (${name} queue)`, () => {
    test("a supervisor's six-question Thai conversation, answered by the worker through the reply token", async () => {
      const p = pipeline((await make()).store);
      const conversation: Array<[string, string[]]> = [
        ["วันนี้ทุกตลาดขายได้เท่าไหร่?", ["40,550.75", FIXTURE_MARKETS.PASEO]],
        ["พี่ดำเบิกอะไรไป แล้วคืนเท่าไหร่?", ["เบิก", "ชั่งคืน", "มะม่วงน้ำดอกไม้ 30"]],
        ["หนูเล็กมีสลิปที่ยังรอตรวจกี่รายการ?", ["ตรวจมือ 2 รายการ"]],
        ["เมื่อวานตลาดไหนขายดีกว่าวันนี้?", [FIXTURE_MARKETS.PASEO, "15,210.00"]],
        ["ทำไมรายการของพี่ปลายังปิดไม่ได้?", ["ปลา", FIXTURE_MARKETS.WAT]],
        ["แล้วของพี่ขวัญล่ะ?", ["ขวัญ", FIXTURE_MARKETS.PASEO]],
      ];
      for (const [question, expected] of conversation) {
        const { result, event, webhookMs } = await p.say("Uboss", question);
        expect(result?.status).toBe("saved");
        expect(webhookMs).toBeLessThan(1_000);
        expect(p.webhookReplies).toEqual([]);
        const summary = await p.work();
        expect(summary).toMatchObject({ claimed: 1, completed: 1, delivered: 1 });
        const sent = p.line.sent.at(-1)!;
        expect(sent).toMatchObject({ channel: "reply", target: event.replyToken });
        for (const fragment of expected) expect(sent.text).toContain(fragment);
      }
      expect(p.line.sent).toHaveLength(6);
      // The follow-up answered about ขวัญ, not ปลา.
      expect(p.line.sent.at(-1)!.text).not.toContain("ปลา");
      // One worker kick per webhook request.
      expect(p.kicks).toHaveLength(6);
    });

    test("duplicate delivery makes no second job; an outage is retried and answered once; staff are bounded", async () => {
      const queue = await make();
      const p = pipeline(queue.store);

      const first = await p.say("Uboss", "วันนี้ทุกตลาดขายได้เท่าไหร่?");
      await p.say("Uboss", "วันนี้ทุกตลาดขายได้เท่าไหร่?", { eventId: first.event.webhookEventId });
      expect(await queue.jobCount()).toBe(1);

      p.model.failures = [new OpenAIAnalystError("OpenAI analyst request failed: HTTP 503", "http", 503)];
      expect(await p.work()).toMatchObject({ claimed: 1, retried: 1, delivered: 0 });
      expect((await p.work()).claimed).toBe(0); // still in backoff
      await queue.makeAvailable();
      expect(await p.work()).toMatchObject({ claimed: 1, completed: 1, delivered: 1 });
      expect(p.line.sent).toHaveLength(1);
      expect(p.line.sent[0]).toMatchObject({ channel: "reply", target: first.event.replyToken });
      expect(p.line.sent[0]!.text).toContain("40,550.75");

      // Approved group (owner decision): every member shares the group scope,
      // staff and members without any personal grant included.
      await p.say("Udam", "พี่ขวัญเบิกอะไรไป");
      await p.work();
      expect(p.line.sent.at(-1)!.text).toContain("ผักกาดขาว 15");
      await p.say("Ustranger", "วันนี้ทุกตลาดขายได้เท่าไหร่?");
      await p.work();
      expect(p.line.sent.at(-1)!.text).toContain("40,550.75");
      // The same staff member 1:1 keeps their own-records grant.
      await p.say("Udam", "พี่ขวัญเบิกอะไรไป", { chat: "dm" });
      await p.work();
      expect(p.line.sent.at(-1)!.text).toContain("ไม่มีสิทธิ์");
      // Someone with no grant, 1:1.
      await p.say("Ustranger", "วันนี้ทุกตลาดขายได้เท่าไหร่?", { chat: "dm" });
      await p.work();
      expect(p.line.sent.at(-1)!.text).toBe(ASSISTANT_NO_PERMISSION_REPLY);
      // An allowlisted group without a group policy: refused, nothing disclosed.
      await p.say("Uboss", "วันนี้ทุกตลาดขายได้เท่าไหร่?", { chat: "Cworkers" });
      await p.work();
      expect(p.line.sent.at(-1)!.text).toContain("ตอบในกลุ่มนี้ไม่ได้");
      // A group that is not allowlisted never even reaches the queue.
      const before = p.line.sent.length;
      await p.say("Uboss", "วันนี้ทุกตลาดขายได้เท่าไหร่?", { chat: "Cexternal" });
      expect((await p.work()).claimed).toBe(0);
      expect(p.line.sent).toHaveLength(before);
      expect(p.webhookReplies.at(-1)).toContain("ยังไม่เปิดใช้งานในแชทนี้");
    });
  });
}
