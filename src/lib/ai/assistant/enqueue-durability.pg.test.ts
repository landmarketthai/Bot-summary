/**
 * P1-E on real PostgreSQL: a transient AI enqueue failure must not
 * permanently acknowledge the LINE event. The production WebhookService and
 * its default dispatcher run against the real raw_messages table and the real
 * ai_assistant_jobs RPCs; the failure is a genuinely unavailable RPC.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/ai/assistant/enqueue-durability.pg.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { LineMessageEvent } from "@/lib/line/types";
import { WebhookService } from "@/lib/line/webhook-service";
import { webhookResponseStatus } from "@/lib/line/webhook-response";
import { createPgSupabase, createSlipTestDb, SLIP_PIPELINE_MIGRATIONS, type SlipTestDb } from "@/lib/slips/testing/pg-slip-harness";
import { ASSISTANT_MIGRATIONS, assistantRpcClient } from "./testing/pg-assistant-db";

let db: SlipTestDb | null = null;
if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS === "1") {
  try {
    db = await createSlipTestDb("ai_enqueue", [...SLIP_PIPELINE_MIGRATIONS, ...ASSISTANT_MIGRATIONS]);
  } catch (error) {
    if (process.env.AI_ASSISTANT_PG_REQUIRE === "1") throw error;
  }
} else if (process.env.AI_ASSISTANT_PG_REQUIRE === "1") {
  throw new Error("AI_ASSISTANT_PG_REQUIRE=1 needs ALLOW_DISPOSABLE_POSTGRES_TESTS=1");
}
afterAll(async () => { await db?.drop(); });

/** Real SQL: tables through the PostgREST-style harness, AI RPCs through the text[]-aware client. */
function client(database: SlipTestDb): SupabaseClient<Database> {
  const base = createPgSupabase(database, { failUpload: new Set(), uploaded: new Map() });
  const ai = assistantRpcClient(database);
  return {
    ...base,
    rpc: (name: string, args?: Record<string, unknown>) =>
      name.includes("ai_assistant") ? ai.rpc(name as never, args as never) : base.rpc(name, args),
  } as unknown as SupabaseClient<Database>;
}

function question(id: string, redelivery = false): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: id,
    deliveryContext: { isRedelivery: redelivery },
    timestamp: Date.now(),
    source: { type: "group", groupId: "Cmanagement", userId: "Uboss" },
    mode: "active",
    replyToken: `reply-${id}-${redelivery ? "2" : "1"}`,
    message: { id: `m-${id}`, type: "text", quoteToken: "q", text: "@Botsummary วันนี้ทุกตลาดขายได้เท่าไหร่?" },
  };
}

const describePg = db ? describe : describe.skip;

describePg("P1-E: AI enqueue failure is never permanently acknowledged (real PostgreSQL)", () => {
  test("enqueue failure -> retryable webhook response -> LINE redelivery -> job enqueued once", async () => {
    const database = db!;
    const replies: string[] = [];
    const service = () => new WebhookService(client(database), {
      botSummaryAnalystEnabled: true,
      botSummaryAnalystSourceAllowed: () => true,
      scheduleBackgroundTask: () => {},
      replyMessage: async (_token, text) => { replies.push(text); },
    });

    // 1. The enqueue RPC is unavailable (deploy gap / outage).
    await database.query("ALTER FUNCTION public.enqueue_ai_assistant_job(jsonb, integer, integer) RENAME TO enqueue_ai_assistant_job_offline");
    const first = await service().processEvents([question("evt-p1e")], "Ubot");
    expect(first[0]).toMatchObject({ status: "error", retryable: true });
    expect(webhookResponseStatus(first)).toBe(503);
    const raw = await database.query<{ is_processed: boolean }>("SELECT is_processed FROM public.raw_messages WHERE line_event_id = 'evt-p1e'");
    expect(raw).toEqual([{ is_processed: false }]);
    expect(await database.scalar("SELECT count(*) FROM public.ai_assistant_jobs")).toBe("0");
    // No "try again" reply: the redelivery is expected to answer.
    expect(replies).toEqual([]);

    // 2. The RPC is back; LINE redelivers the same webhookEventId.
    await database.query("ALTER FUNCTION public.enqueue_ai_assistant_job_offline(jsonb, integer, integer) RENAME TO enqueue_ai_assistant_job");
    const second = await service().processEvents([question("evt-p1e", true)], "Ubot");
    expect(second[0]).toMatchObject({ status: "saved" });
    expect(webhookResponseStatus(second)).toBe(200);
    expect(await database.scalar("SELECT count(*) FROM public.ai_assistant_jobs WHERE line_event_id = 'evt-p1e'")).toBe("1");
    expect(await database.scalar("SELECT is_processed::text FROM public.raw_messages WHERE line_event_id = 'evt-p1e'")).toBe("true");
    expect(await database.scalar("SELECT count(*) FROM public.raw_messages WHERE line_event_id = 'evt-p1e'")).toBe("1");

    // 3. A further redelivery of an already-enqueued event changes nothing.
    const third = await service().processEvents([question("evt-p1e", true)], "Ubot");
    expect(third[0]).toMatchObject({ status: "duplicate" });
    expect(await database.scalar("SELECT count(*) FROM public.ai_assistant_jobs WHERE line_event_id = 'evt-p1e'")).toBe("1");
  });

  test("a processed non-assistant duplicate keeps the existing duplicate behaviour", async () => {
    const database = db!;
    const service = new WebhookService(client(database), {
      botSummaryAnalystEnabled: true,
      botSummaryAnalystSourceAllowed: () => true,
      scheduleBackgroundTask: () => {},
      replyMessage: async () => {},
    });
    const plain: LineMessageEvent = { ...question("evt-plain"), message: { id: "m-plain", type: "text", quoteToken: "q", text: "สวัสดีครับ" } };
    await service.processEvents([plain], "Ubot");
    const again = await service.processEvents([{ ...plain, deliveryContext: { isRedelivery: true } }], "Ubot");
    expect(again[0]?.status).toBe("duplicate");
  });
});
