import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import type { Database } from "@/types/database";

function supabaseStub() {
  const rawUpdates: unknown[] = [];
  return {
    rawUpdates,
    client: {
      from(table: string) {
        if (table !== "raw_messages") throw new Error(`unexpected table: ${table}`);
        return {
          insert: () => ({
            select: () => ({
              async single() {
                return { data: { id: "raw-correction" }, error: null };
              },
            }),
          }),
          update: (values: unknown) => {
            rawUpdates.push(values);
            return { async eq() { return { error: null }; } };
          },
        };
      },
    } as unknown as SupabaseClient<Database>,
  };
}

function textEvent(
  text: string,
  quotedMessageId = "line-slip",
  sender = "user-1",
): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: `event-${text}-${quotedMessageId}-${sender}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.parse("2026-09-21T05:00:00Z"),
    source: { type: "group", groupId: "group-1", userId: sender },
    mode: "active",
    replyToken: "reply-1",
    message: {
      id: "line-correction",
      type: "text",
      text,
      quoteToken: "quote-1",
      quotedMessageId,
    },
  };
}

describe("quoted slip text webhook routing", () => {
  it("routesยอด text with the exact LINE quote and sender context", async () => {
    const { client, rawUpdates } = supabaseStub();
    const calls: unknown[] = [];
    const service = new WebhookService(client, {
      quotedSlipAmountCorrectionService: {
        async handle(input) {
          calls.push(input);
          return { handled: true, kind: "applied", amount: 268 };
        },
      },
    });

    const [result] = await service.processEvents([
      textEvent("\u0e22\u0e2d\u0e14 268"),
    ], "dest");

    expect(result).toMatchObject({ status: "saved", parsed: true });
    expect(calls[0]).toMatchObject({
      rawMessageId: "raw-correction",
      lineMessageId: "line-correction",
      quotedMessageId: "line-slip",
      sourceId: "group-1",
      sourceType: "group",
      lineUserId: "user-1",
      text: "\u0e22\u0e2d\u0e14 268",
    });
    expect(rawUpdates).toEqual([{ is_processed: true }]);
  });

  it("claims a quoted amount even when the exact target fails closed", async () => {
    const { client, rawUpdates } = supabaseStub();
    const service = new WebhookService(client, {
      quotedSlipAmountCorrectionService: {
        async handle() {
          return { handled: true, kind: "ignored", reason: "quoted_target_not_exact" };
        },
      },
    });

    const [wrongSource] = await service.processEvents([
      textEvent("\u0e22\u0e2d\u0e14 268", "image-from-another-source"),
    ], "dest");
    const [wrongSender] = await service.processEvents([
      textEvent("\u0e22\u0e2d\u0e14 268", "image-from-another-sender", "user-2"),
    ], "dest");
    const [nonImage] = await service.processEvents([
      textEvent("\u0e22\u0e2d\u0e14 268", "quoted-text-message"),
    ], "dest");

    expect(wrongSource).toMatchObject({ status: "saved", parsed: false });
    expect(wrongSender).toMatchObject({ status: "saved", parsed: false });
    expect(nonImage).toMatchObject({ status: "saved", parsed: false });
    expect(rawUpdates).toEqual([
      { is_processed: true },
      { is_processed: true },
      { is_processed: true },
    ]);
  });

  it("leaves a transient correction failure retryable and unprocessed", async () => {
    const { client, rawUpdates } = supabaseStub();
    const service = new WebhookService(client, {
      quotedSlipAmountCorrectionService: {
        async handle() {
          return { handled: true, kind: "failed", reason: "correction_rpc_failed" };
        },
      },
    });

    const [result] = await service.processEvents([
      textEvent("\u0e22\u0e2d\u0e14 268"),
    ], "dest");

    expect(result).toMatchObject({
      status: "error",
      retryable: true,
      error: "correction_rpc_failed",
    });
    expect(rawUpdates).toHaveLength(0);
  });

  it("leaves a thrown correction service failure retryable and unprocessed", async () => {
    const { client, rawUpdates } = supabaseStub();
    const service = new WebhookService(client, {
      quotedSlipAmountCorrectionService: {
        async handle() {
          throw new Error("database unavailable");
        },
      },
    });

    const [result] = await service.processEvents([
      textEvent("\u0e22\u0e2d\u0e14 268"),
    ], "dest");

    expect(result).toMatchObject({
      status: "error",
      retryable: true,
      error: "quoted slip amount correction failed",
    });
    expect(rawUpdates).toHaveLength(0);
  });
});
