import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import type { SlipEvidenceInput } from "@/lib/slips/types";
import type { SlipSessionIngestor } from "@/lib/slips/slip-session-service";
import type { Database } from "@/types/database";

function createWebhookSupabase() {
  const rawRows: Array<Record<string, unknown>> = [];
  let parseErrorInserts = 0;

  const client = {
    async rpc(name: string) { throw new Error(`unexpected rpc: ${name}`); },
    from(table: string) {
      if (table === "raw_messages") {
        return {
          insert(row: Record<string, unknown>) {
            rawRows.push(row);
            return {
              select() {
                return {
                  async single() {
                    return { data: { id: "raw-image-1" }, error: null };
                  },
                };
              },
            };
          },
        };
      }

      if (table === "parse_errors") {
        return {
          async insert() {
            parseErrorInserts += 1;
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;

  return {
    client,
    rawRows,
    getParseErrorInserts: () => parseErrorInserts,
  };
}

function imageEvent(id: string): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: `event-${id}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.UTC(2026, 5, 1, 5, 0, 0),
    source: {
      type: "group",
      groupId: "group-1",
      userId: "user-1",
    },
    mode: "active",
    replyToken: `reply-${id}`,
    message: {
      id,
      type: "image",
      quoteToken: `quote-${id}`,
      contentProvider: { type: "line" },
    },
  };
}

function newSessionService(): SlipSessionIngestor {
  return {
    async findActiveSession() {
      return { batchId: "batch-1", imageCount: 0, headerText: null, sellerName: null, marketName: null, slipDate: null };
    },
    async openSession() {
      return { opened: true, batchId: "batch-1" };
    },
  };
}

describe("WebhookService image messages", () => {
  it("persists raw event, ingests evidence, acknowledges, and skips unsupported error", async () => {
    const fake = createWebhookSupabase();
    const evidenceInputs: SlipEvidenceInput[] = [];
    const replies: Array<{ token: string; text: string }> = [];
    const processedEvidenceIds: string[] = [];
    const backgroundTasks: Array<() => Promise<void>> = [];
    const service = new WebhookService(fake.client, {
      evidenceIngestor: {
        async ingest(input) {
          evidenceInputs.push(input);
          return {
            evidenceId: "evidence-1",
            status: "RECEIVED",
            storagePath: "private/path.jpg",
            sha256: "a".repeat(64),
          };
        },
      },
      checkProcessor: {
        async processEvidence(evidenceId) {
          processedEvidenceIds.push(evidenceId);
        },
      },
      slipSessionService: newSessionService(),
      batchService: { async attachEvidence() {} },
      async replyMessage(token, text) {
        replies.push({ token, text });
      },
      scheduleBackgroundTask(task) {
        backgroundTasks.push(task);
      },
    });

    const result = await service.processEvents(
      [imageEvent("line-message-1")],
      "line-destination",
    );

    expect(result[0]).toMatchObject({
      eventId: "event-line-message-1",
      eventType: "message",
      status: "saved",
      parsed: false,
    });
    expect(result[0].error).toBeUndefined();
    expect(fake.rawRows[0]).toMatchObject({
      line_event_id: "event-line-message-1",
      destination: "line-destination",
      source_type: "group",
      source_id: "group-1",
      user_id: "user-1",
      message_id: "line-message-1",
      message_type: "image",
      raw_text: null,
    });
    expect(evidenceInputs).toEqual([{
      rawMessageId: "raw-image-1",
      lineMessageId: "line-message-1",
      sourceId: "group-1",
      sourceType: "group",
      lineUserId: "user-1",
      eventTimestamp: Date.UTC(2026, 5, 1, 5, 0, 0),
    }]);
    expect(fake.getParseErrorInserts()).toBe(0);
    expect(replies).toEqual([{
      token: "reply-line-message-1",
      text: "รับรูปหลักฐานแล้วครับ\nถ้ามีหลายใบ ส่งต่อได้เลย\nพิมพ์ \"จบสลิป\" เมื่อส่งครบ",
    }]);
    expect(backgroundTasks).toHaveLength(1);
    expect(processedEvidenceIds).toEqual([]);
    await backgroundTasks[0]();
    expect(processedEvidenceIds).toEqual(["evidence-1"]);
  });

  it("replies with retry text when evidence storage fails", async () => {
    const fake = createWebhookSupabase();
    const replies: string[] = [];
    const service = new WebhookService(fake.client, {
      evidenceIngestor: {
        async ingest() {
          return {
            evidenceId: "evidence-2",
            status: "STORAGE_FAILED",
            storagePath: "private/path.jpg",
            sha256: "b".repeat(64),
          };
        },
      },
      slipSessionService: newSessionService(),
      async replyMessage(_token, text) {
        replies.push(text);
      },
    });

    const result = await service.processEvents(
      [imageEvent("line-message-2")],
      "line-destination",
    );

    expect(result[0].error).toBe("STORAGE_FAILED");
    expect(replies).toEqual(["รับรูปไม่สำเร็จ กรุณาส่งใหม่อีกครั้ง"]);
    expect(fake.getParseErrorInserts()).toBe(0);
  });
});
