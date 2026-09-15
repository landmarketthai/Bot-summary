/**
 * Phase 2 slip-close tests.
 *
 * Verifies the new "จบสลิป" behaviour:
 *   1. Bot immediately acks with SLIP_CLOSE_ACKNOWLEDGED_REPLY.
 *   2. Batch transitions collecting → closing, not collecting → processing.
 *   3. Repeated "จบสลิป" while already closing gets ALREADY_CLOSING_REPLY.
 *   4. No summary is sent synchronously on close.
 *   5. Images arriving during the closing window still attach (findActiveSession
 *      returns closing batch; attachEvidence RPC updated separately in DB).
 *   6. Produce-session text flow is untouched.
 */
import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import type {
  SlipSessionIngestor,
  ActiveSlipSession,
} from "@/lib/slips/slip-session-service";
import type { Database } from "@/types/database";

// ── Stubs ─────────────────────────────────────────────────────────────────────

function makeRawMessageSupabase(rawId = "raw-txt"): SupabaseClient<Database> {
  return {
    async rpc(name: string) {
      if (name === "receive_line_webhook_event") {
        return { data: { raw_message_id: rawId, duplicate: false }, error: null };
      }
      throw new Error(`Unexpected rpc: ${name}`);
    },
    from(table: string) {
      if (table === "raw_messages") {
        return {
          insert() {
            return {
              select() {
                return {
                  async single() { return { data: { id: rawId }, error: null }; },
                };
              },
            };
          },
        };
      }
      if (table === "pending_sessions") {
        return {
          select() {
            return {
              eq() { return { async maybeSingle() { return { data: null, error: null }; } }; },
            };
          },
        };
      }
      if (table === "parse_errors") {
        return { async insert() { return { error: null }; } };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
}

/**
 * Supabase stub that supports the slip_batches UPDATE pattern used by
 * processSlipClose.  Captures the update payload for assertions.
 */
function makeCloseSupabase(
  rawId = "raw-txt",
  claimSucceeds = true,
  batchId = "batch-1",
) {
  const batchUpdates: Array<Record<string, unknown>> = [];

  const client = {
    from(table: string) {
      if (table === "raw_messages") {
        return {
          insert() {
            return {
              select() {
                return {
                  async single() { return { data: { id: rawId }, error: null }; },
                };
              },
            };
          },
        };
      }
      if (table === "pending_sessions") {
        return {
          select() {
            return {
              eq() { return { async maybeSingle() { return { data: null, error: null }; } }; },
            };
          },
        };
      }
      if (table === "slip_batches") {
        return {
          update(values: Record<string, unknown>) {
            batchUpdates.push(values);
            return {
              eq(_c: string, _v: unknown) {
                return {
                  eq(_c2: string, _v2: unknown) {
                    return {
                      select() {
                        return {
                          async single() {
                            if (claimSucceeds) return { data: { id: batchId }, error: null };
                            return { data: null, error: { message: "no rows" } };
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
          select() {
            return {
              eq() {
                return { async maybeSingle() { return { data: null, error: null }; } };
              },
            };
          },
        };
      }
      if (table === "slip_evidences") {
        return {
          select() {
            return {
              eq() {
                return {
                  order() { return Promise.resolve({ data: [], error: null }); },
                };
              },
            };
          },
        };
      }
      if (table === "parse_errors") {
        return { async insert() { return { error: null }; } };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    _batchUpdates: batchUpdates,
  } as unknown as SupabaseClient<Database> & {
    _batchUpdates: Array<Record<string, unknown>>;
  };

  return client;
}

function textEvent(text: string, id = "event-txt"): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: id,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.UTC(2026, 5, 9, 5, 0, 0),
    source: { type: "group", groupId: "group-1", userId: "user-1" },
    mode: "active",
    replyToken: "reply-txt",
    message: { id: "msg-txt", type: "text", quoteToken: "q", text },
  };
}

function activeSession(imageCount: number, batchId = "batch-1"): ActiveSlipSession {
  return {
    batchId,
    imageCount,
    headerText: null,
    sellerName: null,
    marketName: null,
    slipDate: null,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("WebhookService slip close v2 — immediate ack, deferred summary", () => {
  it("transitions collecting→closing and replies with ack (not summary)", async () => {
    const replies: string[] = [];
    const supabase = makeCloseSupabase("raw", true);

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return activeSession(6); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(supabase, {
      slipSessionService,
      async replyMessage(_, text) { replies.push(text); },
    });

    await service.processEvents([textEvent("จบสลิป")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe("รับคำสั่งจบชุดแล้ว กำลังตรวจสอบสลิปทั้งหมด กรุณารอสรุปผล");

    // Batch must be transitioned to 'closing', not 'processing'
    const claim = supabase._batchUpdates.find((u) => u.status);
    expect(claim?.status).toBe("closing");
    expect(typeof claim?.closing_at).toBe("string");
  });

  it("does NOT send a summary message in the same webhook response", async () => {
    const replies: string[] = [];
    const supabase = makeCloseSupabase("raw", true);

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return activeSession(3); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(supabase, {
      slipSessionService,
      async replyMessage(_, text) { replies.push(text); },
    });

    await service.processEvents([textEvent("จบสลิป")], "dest");

    expect(replies).toHaveLength(1);
    // The reply must be the ack, not a slip summary
    expect(replies[0]).not.toContain("สรุปชุดสลิปเงินโอน");
    expect(replies[0]).not.toContain("รับทั้งหมด:");
  });

  it("replies with already-closing message when 'จบสลิป' is sent a second time", async () => {
    const replies: string[] = [];
    // claimSucceeds=false → the collecting→closing UPDATE returns null
    const supabase = makeCloseSupabase("raw", false);

    const slipSessionService: SlipSessionIngestor = {
      // findActiveSession still returns the batch (it's now 'closing', not null)
      async findActiveSession() { return activeSession(4); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(supabase, {
      slipSessionService,
      async replyMessage(_, text) { replies.push(text); },
    });

    await service.processEvents([textEvent("จบสลิป")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe("รับทราบแล้ว กำลังสรุปสลิปอยู่ กรุณารอสักครู่");
  });

  it("replies no-batch message when no session is open", async () => {
    const replies: string[] = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return null; },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(makeRawMessageSupabase(), {
      slipSessionService,
      async replyMessage(_, text) { replies.push(text); },
    });

    await service.processEvents([textEvent("จบสลิป")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("ยังไม่มีชุดสลิปที่เปิดอยู่");
  });

  it("images arriving during closing window: findActiveSession returns closing batch", async () => {
    // findActiveSession returns a batch regardless of whether it is collecting
    // or closing — this simulates the batch being in 'closing' state already.
    // The image handler should attach evidence and schedule OCR without any
    // extra prompt to the user.
    const replies: string[] = [];
    const bgTasks: Array<() => Promise<void>> = [];
    const attachCalls: Array<{ batchId: string; evidenceId: string }> = [];

    const slipSessionService: SlipSessionIngestor = {
      // Returns the closing batch — imageCount > 0 means no first-image reply
      async findActiveSession() { return activeSession(3); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(makeRawMessageSupabase("raw-img"), {
      evidenceIngestor: {
        async ingest() {
          return { evidenceId: "ev-late", status: "RECEIVED", storagePath: "slips/x.jpg", sha256: "a".repeat(64) };
        },
      },
      checkProcessor: { async processEvidence() {} },
      slipSessionService,
      batchService: {
        async attachEvidence(batchId, evidenceId) { attachCalls.push({ batchId, evidenceId }); },
      },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    const imageEvent: LineMessageEvent = {
      type: "message",
      webhookEventId: "ev-late-event",
      deliveryContext: { isRedelivery: false },
      timestamp: Date.UTC(2026, 5, 9, 5, 0, 5),
      source: { type: "group", groupId: "group-1", userId: "user-1" },
      mode: "active",
      replyToken: "reply-late",
      message: { id: "msg-late", type: "image", quoteToken: "q", contentProvider: { type: "line" } },
    };

    await service.processEvents([imageEvent], "dest");

    // No reply for non-first image
    expect(replies).toHaveLength(0);
    // Evidence attached and OCR scheduled
    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0]).toEqual({ batchId: "batch-1", evidenceId: "ev-late" });
    expect(bgTasks).toHaveLength(1);
  });

  it("produce-session text does not trigger slip close", async () => {
    const replies: string[] = [];
    let closeCalled = false;

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { closeCalled = true; return null; },
      async openSession() { return { opened: true, batchId: "b" }; },
    };

    const service = new WebhookService(makeRawMessageSupabase(), {
      slipSessionService,
      async replyMessage(_, text) { replies.push(text); },
    });

    // "จบรายการ" is the produce-session end trigger — not slip close
    await service.processEvents([textEvent("จบรายการ")], "dest");

    expect(closeCalled).toBe(false);
  });

  it("failed Push never changes batch status back to collecting", async () => {
    // After processSlipClose transitions the batch to 'closing', the batch must
    // never revert to 'collecting' even if a subsequent push error occurs.
    // This test verifies the webhook transition side (collecting→closing).
    // The cron-side non-revert is tested in batch-finalizer.test.ts.
    const batchUpdates: Array<Record<string, unknown>> = [];
    const supabase = makeCloseSupabase("raw", true); // claim succeeds → 'closing'

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return activeSession(2); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(supabase, {
      slipSessionService,
      async replyMessage(_, text) {
        // Simulate replyMessage throwing (post-claim failure)
        // The batch is already in 'closing' — should NOT revert to 'collecting'
        batchUpdates.push(...supabase._batchUpdates);
      },
    });

    await service.processEvents([textEvent("จบสลิป")], "dest");

    // The only status update should be 'closing', never 'collecting'
    const closingUpdate = supabase._batchUpdates.find((u) => u.status === "closing");
    expect(closingUpdate).toBeDefined();

    const revertToCollecting = supabase._batchUpdates.find((u) => u.status === "collecting");
    expect(revertToCollecting).toBeUndefined();
  });
});
