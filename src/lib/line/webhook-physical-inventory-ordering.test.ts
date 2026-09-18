import { describe, expect, test } from "bun:test";
import {
  WebhookService,
  isPhysicalInventoryOrderingEvent,
} from "./webhook-service";
import type { LineEvent, LineMessageEvent } from "./types";

const GROUP_ID = "C1d96954d298d99f65912a5f1e96edffc";
const USER_ID = "U-house-order";

function textEvent(id: string, text: string, timestamp: number): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: id,
    deliveryContext: { isRedelivery: false },
    timestamp,
    source: { type: "group", groupId: GROUP_ID, userId: USER_ID },
    mode: "active",
    replyToken: `reply-${id}`,
    message: {
      id: `message-${id}`,
      type: "text",
      text,
      quoteToken: `quote-${id}`,
    },
  };
}

function unsendEvent(id: string, messageId: string, timestamp: number): LineEvent {
  return {
    type: "unsend",
    webhookEventId: id,
    deliveryContext: { isRedelivery: false },
    timestamp,    source: { type: "group", groupId: GROUP_ID, userId: USER_ID },
    mode: "active",
    unsend: { messageId },
  };
}

type QueueRow = {
  rawId: string;
  eventId: string;
  sourceId: string;
  payload: LineEvent;
  receiveOrder: number;
  status: "pending" | "processing" | "processed";
  claimToken: string | null;
};

function makeQueueDb() {
  const queue: QueueRow[] = [];
  let seq = 0;

  return {
    queue,
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "receive_line_webhook_event") {
        const eventId = String(args.p_line_event_id);
        const existing = queue.find((row) => row.eventId === eventId);
        if (existing) {
          return { data: { raw_message_id: existing.rawId, duplicate: true }, error: null };
        }
        const row: QueueRow = {          rawId: `raw-${++seq}`,
          eventId,
          sourceId: String(args.p_source_id),
          payload: args.p_payload as LineEvent,
          receiveOrder: seq,
          status: "pending",
          claimToken: null,
        };
        queue.push(row);
        return { data: { raw_message_id: row.rawId, duplicate: false }, error: null };
      }

      if (name === "claim_line_webhook_event") {
        const row = queue
          .filter((item) =>
            item.sourceId === String(args.p_source_id) && item.status === "pending"
          )
          .sort((a, b) => a.receiveOrder - b.receiveOrder)[0];
        if (!row) return { data: null, error: null };
        row.status = "processing";
        row.claimToken = `claim-${++seq}`;
        return {
          data: {
            queue_id: `queue-${row.receiveOrder}`,
            line_event_id: row.eventId,
            source_id: row.sourceId,
            raw_message_id: row.rawId,
            receive_order: row.receiveOrder,
            claim_token: row.claimToken,
          },
          error: null,        };
      }

      if (name === "complete_line_webhook_event") {
        const row = queue.find((item) => item.rawId === String(args.p_raw_message_id));
        if (!row || row.claimToken !== String(args.p_claim_token)) {
          return { data: false, error: null };
        }
        row.status = String(args.p_status) as QueueRow["status"];
        row.claimToken = null;
        return { data: true, error: null };
      }

      throw new Error(`unexpected rpc: ${name}`);
    },
    from(table: string) {
      if (table !== "raw_messages") throw new Error(`unexpected table: ${table}`);
      return {
        select() {
          return {
            eq(_column: string, rawId: unknown) {
              return {
                async maybeSingle() {
                  const row = queue.find((item) => item.rawId === rawId);
                  return { data: row ? { payload: row.payload } : null, error: null };
                },
              };
            },
          };
        },
      };
    },  };
}

describe("House Stock durable ordering", () => {
  test("classifies header, item, close, and unsend on the same ordered path", () => {
    expect(isPhysicalInventoryOrderingEvent(
      textEvent("header", "ผลไม้คงเหลือในบ้าน\n18/9/69", 1_000),
    )).toBe(true);
    expect(isPhysicalInventoryOrderingEvent(
      textEvent("item", "5ไซมัส33บาท\n15โล", 1_100),
    )).toBe(true);
    expect(isPhysicalInventoryOrderingEvent(
      textEvent("close", "จบ", 1_200),
    )).toBe(true);
    expect(isPhysicalInventoryOrderingEvent(
      unsendEvent("unsend", "message-old-close", 1_300),
    )).toBe(true);

    const outside = {
      ...unsendEvent("outside", "message-old-close", 1_400),
      source: { type: "group", groupId: "C-other", userId: USER_ID },
    } as LineEvent;
    expect(isPhysicalInventoryOrderingEvent(outside)).toBe(false);
  });

  test("drains unsend then item 5 then replacement close in receive order", async () => {
    const db = makeQueueDb();
    const service = new WebhookService(db as never, {
      replyMessage: async () => {},
      scheduleBackgroundTask: () => {},
    });
    const processed: string[] = [];    const mutable = service as unknown as {
      processOne: (event: LineEvent) => Promise<{
        eventId: string;
        eventType: string;
        status: "saved";
      }>;
    };
    mutable.processOne = async (event) => {
      processed.push(event.webhookEventId);
      return {
        eventId: event.webhookEventId,
        eventType: event.type,
        status: "saved",
      };
    };

    const events = [
      unsendEvent("unsend-old-close", "message-old-close", 2_000),
      textEvent("item-5", "5ไซมัส33บาท\n15โล", 2_050),
      textEvent("replacement-close", "จบ", 2_100),
    ];

    await service.processEvents(events, "destination");

    expect(db.queue).toHaveLength(3);
    expect(db.queue.every((row) => row.status === "processed")).toBe(true);
    expect(processed).toEqual([
      "unsend-old-close",
      "item-5",
      "replacement-close",
    ]);
  });
});
