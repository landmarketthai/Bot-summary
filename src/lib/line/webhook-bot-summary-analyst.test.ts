import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { LineMessageEvent } from "@/lib/line/types";
import { FakeDatabase } from "@/lib/summary/test-fake-supabase";
import { WebhookService } from "./webhook-service";

function client(db: FakeDatabase): SupabaseClient<Database> {
  return db as unknown as SupabaseClient<Database>;
}

function textEvent(text: string): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: "evt-bot-summary-1",
    deliveryContext: { isRedelivery: false },
    timestamp: Date.parse("2026-10-07T03:00:00Z"),
    source: {
      type: "group",
      groupId: "Cgroup",
      userId: "Uasker",
    },
    mode: "active",
    replyToken: "reply-1",
    message: {
      id: "msg-1",
      type: "text",
      quoteToken: "quote-1",
      text,
    },
  };
}

describe("@Botsummary webhook routing", () => {
  test("intercepts the analyst command before legacy parsers and replies once", async () => {
    const db = new FakeDatabase();
    const asked: string[] = [];
    const replies: Array<{ token: string; text: string }> = [];

    const service = new WebhookService(client(db), {
      botSummaryAnalystEnabled: true,
      botSummaryAnalystSourceAllowed: () => true,
      botSummaryAnalystAnswerer: async (question) => {
        asked.push(question);
        return "ยอดขายวันนี้ 12,345 บาท";
      },
      replyMessage: async (token, text) => {
        replies.push({ token, text });
      },
    });

    const result = await service.processEvents(
      [textEvent("@Botsummary สรุปยอดขายวันนี้")],
      "Ubot",
    );

    expect(result[0]?.status).toBe("saved");
    expect(result[0]?.parsed).toBe(true);
    expect(asked).toEqual(["สรุปยอดขายวันนี้"]);
    expect(replies).toEqual([
      { token: "reply-1", text: "ยอดขายวันนี้ 12,345 บาท" },
    ]);
    expect(db.appendCalls).toBe(0);
    expect(db.rows("raw_messages")).toHaveLength(1);
    expect(db.rows("raw_messages")[0]?.is_processed).toBe(true);
  });

  test("returns usage help without calling GPT when only @Botsummary is sent", async () => {
    const db = new FakeDatabase();
    let analystCalls = 0;
    const replies: string[] = [];

    const service = new WebhookService(client(db), {
      botSummaryAnalystEnabled: true,
      botSummaryAnalystSourceAllowed: () => true,
      botSummaryAnalystAnswerer: async () => {
        analystCalls += 1;
        return "should not happen";
      },
      replyMessage: async (_token, text) => {
        replies.push(text);
      },
    });

    await service.processEvents([textEvent("@Botsummary")], "Ubot");

    expect(analystCalls).toBe(0);
    expect(replies[0]).toContain("ถาม @Botsummary ได้");
  });

  test("contains failures inside analyst mode instead of falling through into data-entry flows", async () => {
    const db = new FakeDatabase();
    const replies: string[] = [];

    const service = new WebhookService(client(db), {
      botSummaryAnalystEnabled: true,
      botSummaryAnalystSourceAllowed: () => true,
      botSummaryAnalystAnswerer: async () => {
        throw new Error("provider unavailable");
      },
      replyMessage: async (_token, text) => {
        replies.push(text);
      },
    });

    const result = await service.processEvents(
      [textEvent("@Botsummary วันนี้มีอะไรยังไม่จบ")],
      "Ubot",
    );

    expect(result[0]?.status).toBe("saved");
    expect(result[0]?.parsed).toBe(true);
    expect(replies[0]).toContain("อ่านข้อมูลให้ไม่สำเร็จ");
    expect(db.appendCalls).toBe(0);
  });

  test("fails closed for a source that is not on the analyst allowlist", async () => {
    const db = new FakeDatabase();
    const replies: string[] = [];
    let analystCalls = 0;

    const service = new WebhookService(client(db), {
      botSummaryAnalystEnabled: true,
      botSummaryAnalystSourceAllowed: () => false,
      botSummaryAnalystAnswerer: async () => {
        analystCalls += 1;
        return "must not be returned";
      },
      replyMessage: async (_token, text) => {
        replies.push(text);
      },
    });

    const result = await service.processEvents(
      [textEvent("@Botsummary ดำวันนี้เงินขาดหรือเกิน")],
      "Ubot",
    );

    expect(result[0]?.status).toBe("saved");
    expect(result[0]?.parsed).toBe(true);
    expect(analystCalls).toBe(0);
    expect(replies[0]).toContain("ยังไม่เปิดใช้งานในแชทนี้");
    expect(db.appendCalls).toBe(0);
  });

  test("swallows explicit @Botsummary safely while the feature flag is disabled", async () => {
    const db = new FakeDatabase();
    const replies: string[] = [];

    const service = new WebhookService(client(db), {
      botSummaryAnalystEnabled: false,
      botSummaryAnalystSourceAllowed: () => true,
      replyMessage: async (_token, text) => {
        replies.push(text);
      },
    });

    const result = await service.processEvents(
      [textEvent("@Botsummary คืนวันนี้มีอะไรค้าง")],
      "Ubot",
    );

    expect(result[0]?.status).toBe("saved");
    expect(result[0]?.parsed).toBe(true);
    expect(replies[0]).toContain("ยังไม่เปิดใช้งานในแชทนี้");
    expect(db.appendCalls).toBe(0);
  });
});
