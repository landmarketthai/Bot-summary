import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { LineMessageEvent } from "@/lib/line/types";
import { FakeDatabase } from "@/lib/summary/test-fake-supabase";
import {
  ASSISTANT_BUSY_REPLY,
  createAssistantDispatcher,
  type AssistantDispatchInput,
} from "@/lib/ai/assistant/dispatch";
import { MemoryAssistantJobStore } from "@/lib/ai/assistant/testing/memory-job-store";
import { WebhookService } from "./webhook-service";

function client(db: FakeDatabase): SupabaseClient<Database> {
  return db as unknown as SupabaseClient<Database>;
}

function textEvent(text: string, id = "evt-bot-summary-1", userId = "Uasker"): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: id,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.now(),
    source: {
      type: "group",
      groupId: "Cgroup",
      userId,
    },
    mode: "active",
    replyToken: `reply-${id}`,
    message: {
      id: `msg-${id}`,
      type: "text",
      quoteToken: "quote-1",
      text,
    },
  };
}

function setup(overrides: Partial<ConstructorParameters<typeof WebhookService>[1]> = {}) {
  const db = new FakeDatabase();
  const dispatched: AssistantDispatchInput[] = [];
  const replies: Array<{ token: string; text: string }> = [];
  const background: Array<() => Promise<void>> = [];
  const kicks: number[] = [];
  const service = new WebhookService(client(db), {
    botSummaryAnalystEnabled: true,
    botSummaryAnalystSourceAllowed: () => true,
    botSummaryAssistantDispatcher: async (input) => {
      dispatched.push(input);
      return { outcome: "queued", jobId: `job-${dispatched.length}` };
    },
    botSummaryAssistantKick: async (budgetMs) => { kicks.push(budgetMs); },
    scheduleBackgroundTask: (task) => { background.push(task); },
    replyMessage: async (token, text) => {
      replies.push({ token, text });
    },
    ...overrides,
  });
  return { db, service, dispatched, replies, background, kicks };
}

describe("@Botsummary webhook routing", () => {
  test("enqueues the question before legacy parsers; the webhook itself does not answer", async () => {
    const s = setup();

    const result = await s.service.processEvents(
      [textEvent("@Botsummary สรุปยอดขายวันนี้")],
      "Ubot",
    );

    expect(result[0]?.status).toBe("saved");
    expect(result[0]?.parsed).toBe(true);
    expect(s.dispatched.map((input) => input.question)).toEqual(["สรุปยอดขายวันนี้"]);
    expect(s.dispatched[0]?.destination).toBe("Ubot");
    expect(s.dispatched[0]?.rawMessageId).toBe("raw-1");
    // The worker replies with the reply token; nothing is sent from here.
    expect(s.replies).toEqual([]);
    expect(s.db.appendCalls).toBe(0);
    expect(s.db.rows("raw_messages")).toHaveLength(1);
    expect(s.db.rows("raw_messages")[0]?.is_processed).toBe(true);
    // One post-response worker kick, inside the route budget.
    expect(s.background).toHaveLength(1);
    await s.background[0]!();
    expect(s.kicks).toHaveLength(1);
    expect(s.kicks[0]!).toBeGreaterThanOrEqual(15_000);
    expect(s.kicks[0]!).toBeLessThanOrEqual(52_000);
  });

  test("returns usage help without enqueueing when only @Botsummary is sent", async () => {
    const s = setup();
    await s.service.processEvents([textEvent("@Botsummary")], "Ubot");
    expect(s.dispatched).toHaveLength(0);
    expect(s.replies[0]?.text).toContain("ถาม @Botsummary ได้");
    expect(s.background).toHaveLength(0);
  });

  test("an enqueue failure is contained in analyst mode and answered with a retry hint", async () => {
    const s = setup({
      botSummaryAssistantDispatcher: async () => { throw Object.assign(new Error("db down: ดำ 500"), { code: "PGRST000" }); },
    });

    const result = await s.service.processEvents(
      [textEvent("@Botsummary วันนี้มีอะไรยังไม่จบ")],
      "Ubot",
    );

    expect(result[0]?.status).toBe("saved");
    expect(result[0]?.parsed).toBe(true);
    expect(s.replies[0]?.text).toContain("อ่านข้อมูลให้ไม่สำเร็จ");
    expect(s.db.appendCalls).toBe(0);
    expect(s.background).toHaveLength(0);
  });

  test("fails closed for a source that is not on the analyst allowlist", async () => {
    const s = setup({ botSummaryAnalystSourceAllowed: () => false });

    const result = await s.service.processEvents(
      [textEvent("@Botsummary ดำวันนี้เงินขาดหรือเกิน")],
      "Ubot",
    );

    expect(result[0]?.status).toBe("saved");
    expect(result[0]?.parsed).toBe(true);
    expect(s.dispatched).toHaveLength(0);
    expect(s.replies[0]?.text).toContain("ยังไม่เปิดใช้งานในแชทนี้");
    expect(s.db.appendCalls).toBe(0);
  });

  test("swallows explicit @Botsummary safely while the feature flag is disabled", async () => {
    const s = setup({ botSummaryAnalystEnabled: false });

    const result = await s.service.processEvents(
      [textEvent("@Botsummary คืนวันนี้มีอะไรค้าง")],
      "Ubot",
    );

    expect(result[0]?.status).toBe("saved");
    expect(result[0]?.parsed).toBe(true);
    expect(s.dispatched).toHaveLength(0);
    expect(s.replies[0]?.text).toContain("ยังไม่เปิดใช้งานในแชทนี้");
    expect(s.db.appendCalls).toBe(0);
  });

  test("a user over the outstanding-question bound is told to wait instead of queueing more", async () => {
    const store = new MemoryAssistantJobStore();
    const s = setup({ botSummaryAssistantDispatcher: createAssistantDispatcher(store) });
    const events = [1, 2, 3, 4].map((n) => textEvent(`@Botsummary คำถามที่ ${n}`, `evt-${n}`));
    for (const event of events) await s.service.processEvents([event], "Ubot");

    expect(store.jobs.size).toBe(3);
    expect(s.replies).toEqual([{ token: "reply-evt-4", text: ASSISTANT_BUSY_REPLY }]);
  });

  test("without a kick (recovery crons) a question is only queued: no assistant work in their background phase", async () => {
    const s = setup({ botSummaryAssistantKick: undefined });
    await s.service.processEvents([textEvent("@Botsummary วันนี้ทุกตลาดขายได้เท่าไหร่?")], "Ubot");
    expect(s.dispatched).toHaveLength(1);
    expect(s.background).toHaveLength(0);
    expect(s.kicks).toHaveLength(0);
  });

  test("several questions in one webhook request share one worker kick", async () => {
    const s = setup();
    await s.service.processEvents([
      textEvent("@Botsummary วันนี้ทุกตลาดขายได้เท่าไหร่?", "evt-a", "Ua"),
      textEvent("@Botsummary เมื่อวานตลาดไหนขายดีกว่าวันนี้?", "evt-b", "Ub"),
    ], "Ubot");
    expect(s.dispatched).toHaveLength(2);
    expect(s.background).toHaveLength(1);
  });
});

describe("@Botsummary async isolation", () => {
  test("a slow model never holds the webhook: processEvents returns while the answer is still pending", async () => {
    const store = new MemoryAssistantJobStore();
    let modelStarted = false;
    let release!: () => void;
    const modelGate = new Promise<void>((resolve) => { release = resolve; });
    const s = setup({
      botSummaryAssistantDispatcher: createAssistantDispatcher(store),
      // The kick represents the worker; here it blocks on a model that hangs.
      botSummaryAssistantKick: async () => { modelStarted = true; await modelGate; },
      scheduleBackgroundTask: (task) => { void task(); },
    });

    const started = Date.now();
    const result = await s.service.processEvents([textEvent("@Botsummary วันนี้ทุกตลาดขายได้เท่าไหร่?")], "Ubot");
    const elapsed = Date.now() - started;

    expect(result[0]?.status).toBe("saved");
    expect(elapsed).toBeLessThan(500);
    expect(modelStarted).toBe(true);
    const [job] = [...store.jobs.values()];
    expect(job?.status).toBe("queued");
    expect(job?.question).toBe("วันนี้ทุกตลาดขายได้เท่าไหร่?");
    release();
  });

  test("a later message in the same payload is handled while the model is still hung", async () => {
    const store = new MemoryAssistantJobStore();
    const s = setup({
      botSummaryAssistantDispatcher: createAssistantDispatcher(store),
      botSummaryAssistantKick: () => new Promise(() => {}),
      scheduleBackgroundTask: (task) => { void task(); },
    });
    const started = Date.now();
    const results = await s.service.processEvents([
      textEvent("@Botsummary ทำไมรายการของพี่ปลายังปิดไม่ได้?", "evt-q"),
      textEvent("สวัสดีครับ", "evt-next"),
    ], "Ubot");
    expect(Date.now() - started).toBeLessThan(500);
    expect(results.map((result) => result.status)).toEqual(["saved", "saved"]);
    expect(s.db.rows("raw_messages")).toHaveLength(2);
    expect(store.jobs.size).toBe(1);
  });

  test("a redelivered LINE event never creates a second job", async () => {
    const store = new MemoryAssistantJobStore();
    const dispatcher = createAssistantDispatcher(store);
    const event = textEvent("@Botsummary พี่ดำเบิกอะไรไป แล้วคืนเท่าไหร่?");
    const first = await dispatcher({ event, question: "พี่ดำเบิกอะไรไป แล้วคืนเท่าไหร่?", destination: "Ubot", rawMessageId: "raw-1" });
    const again = await dispatcher({ event: { ...event, deliveryContext: { isRedelivery: true } }, question: "พี่ดำเบิกอะไรไป แล้วคืนเท่าไหร่?", destination: "Ubot", rawMessageId: "raw-1" });
    expect(first.outcome).toBe("queued");
    expect(again).toEqual({ outcome: "duplicate", jobId: first.jobId });
    expect(store.jobs.size).toBe(1);

    // Through the webhook (this fake has no raw_messages unique key, so the
    // job store's idempotency is what stops it): one job, no reply, no
    // second worker kick.
    const s = setup({ botSummaryAssistantDispatcher: dispatcher });
    await s.service.processEvents([textEvent("@Botsummary ซ้ำ", "evt-dup")], "Ubot");
    await s.service.processEvents([textEvent("@Botsummary ซ้ำ", "evt-dup")], "Ubot");
    expect([...store.jobs.values()].filter((job) => job.line_event_id === "evt-dup")).toHaveLength(1);
    expect(s.background).toHaveLength(1);
    expect(s.replies).toEqual([]);
  });
});
