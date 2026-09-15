import { describe, expect, it } from "bun:test";
import { WebhookService, isProduceOrderingEvent } from "./webhook-service";
import type { LineEvent, LineMessageEvent } from "./types";

function textEvent(text: string): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: `evt-${text}`,
    timestamp: Date.now(),
    replyToken: "reply",
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    message: { type: "text", id: "message-1", text },
  } as unknown as LineMessageEvent;
}

describe("Produce durable ordering classification", () => {
  it.each([
    "ดำ-วัดตะกล่ำ เบิก 14/9/2569",
    "1พุทราจีน100บาท\n1.4.โล",
    "จบรายการเบิก",
    "ยกเลิกรายการ",
    "กู้รายการล่าสุด",
    "แก้ข้อ 3",
    "ลบข้อ 3",
  ])("queues stateful Produce text: %s", (text) => {
    expect(isProduceOrderingEvent(textEvent(text))).toBe(true);
  });

  it("fails closed when the durable receive RPC returns no receipt", async () => {
    const supabase = {
      rpc: async (name: string) => {
        if (name === "receive_line_webhook_event") return { data: null, error: null };
        throw new Error(`unexpected rpc: ${name}`);
      },
    };
    const service = new WebhookService(supabase as never, {
      replyMessage: async () => {},
    });
    const [result] = await service.processEvents(
      [textEvent("1พุทราจีน100บาท\n1.4โล")],
      "destination",
    );
    expect(result.status).toBe("error");
  });
  it("keeps unrelated chatter and non-message events off the Produce ordered path", () => {
    expect(isProduceOrderingEvent(textEvent("สวัสดีครับ"))).toBe(false);
    expect(isProduceOrderingEvent({
      type: "follow",
      webhookEventId: "follow-1",
      timestamp: Date.now(),
      source: { type: "user", userId: "user-1" },
    } as unknown as LineEvent)).toBe(false);
  });
});
