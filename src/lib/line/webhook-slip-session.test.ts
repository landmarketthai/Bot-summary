import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import type { SlipSessionIngestor, ActiveSlipSession } from "@/lib/slips/slip-session-service";
import type { Database } from "@/types/database";

// ── Minimal supabase stub ──────────────────────────────────────────────────

function makeTextSupabase(rawId = "raw-txt") {
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
        // No guided round exists here: the per-user lookup finds nothing and the
        // source-wide ownership query returns no rows, so the guided slip guard
        // answers not_guided and the legacy open runs exactly as before.
        const empty: Record<string, unknown> = {};
        empty.eq = () => empty;
        empty.not = () => empty;
        empty.order = async () => ({ data: [], error: null });
        empty.maybeSingle = async () => ({ data: null, error: null });
        return { select: () => empty };
      }
      if (table === "parse_errors") {
        return { async insert() { return { error: null }; } };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
}

// Supabase stub that can handle both raw_messages AND slip_batches
// (needed for processSlipClose which updates slip_batches directly).
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
            return { eq() { return { async maybeSingle() { return { data: null, error: null }; } }; } };
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
          // also handle finalizeSlipBatch internals (loadBatchRow, etc.)
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
                  order() {
                    return { async data() { return []; } };
                  },
                  async data() { return []; },
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
  } as unknown as SupabaseClient<Database> & { _batchUpdates: Array<Record<string, unknown>> };

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

const noopSession: SlipSessionIngestor = {
  async findActiveSession() { return null; },
  async openSession() { return { opened: true, batchId: "batch-1" }; },
};

// ── Slip open command ──────────────────────────────────────────────────────

describe("WebhookService slip session open", () => {
  it("replies with session-opened confirmation for valid header", async () => {
    const replies: string[] = [];
    let openCalled = false;

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return null; },
      async openSession() {
        openCalled = true;
        return { opened: true, batchId: "new-batch" };
      },
    };

    const service = new WebhookService(makeTextSupabase(), {
      slipSessionService,
      async replyMessage(_, text) { replies.push(text); },
    });

    await service.processEvents(
      [textEvent("กี้ วัดทุ่งลานนา สลิปเงินโอน 9/6/2569")],
      "dest",
    );

    expect(openCalled).toBe(true);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("เปิดชุดสลิปเงินโอนแล้ว");
    expect(replies[0]).toContain("กี้");
    expect(replies[0]).toContain("วัดทุ่งลานนา");
    expect(replies[0]).toContain("9/6/2569");
    expect(replies[0]).toContain("จบสลิป");
  });

  it("replies with already-open message when session exists", async () => {
    const replies: string[] = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession(): Promise<ActiveSlipSession> {
        return { batchId: "existing", imageCount: 1, headerText: null, sellerName: null, marketName: null, slipDate: null };
      },
      async openSession() { return { opened: false, existingBatchId: "existing" }; },
    };

    const service = new WebhookService(makeTextSupabase(), {
      slipSessionService,
      async replyMessage(_, text) { replies.push(text); },
    });

    await service.processEvents(
      [textEvent("กี้ วัดทุ่งลานนา สลิปเงินโอน 9/6/2569")],
      "dest",
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("จบสลิป");
    expect(replies[0]).toContain("มีชุดสลิปที่เปิดอยู่แล้ว");
  });

  it("dash-separated header also opens a session", async () => {
    const replies: string[] = [];
    let openCalled = false;

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return null; },
      async openSession() { openCalled = true; return { opened: true, batchId: "b2" }; },
    };

    const service = new WebhookService(makeTextSupabase(), {
      slipSessionService,
      async replyMessage(_, text) { replies.push(text); },
    });

    await service.processEvents([textEvent("กี้-วัดทุ่งลานนา สลิปเงินโอน 9/6/2569")], "dest");
    expect(openCalled).toBe(true);
    expect(replies[0]).toContain("เปิดชุดสลิปเงินโอนแล้ว");
  });
});

// ── Slip close command ─────────────────────────────────────────────────────

describe("WebhookService slip session close", () => {
  it("replies with no-batch message when no session is open", async () => {
    const replies: string[] = [];

    const service = new WebhookService(makeTextSupabase(), {
      slipSessionService: noopSession,
      async replyMessage(_, text) { replies.push(text); },
    });

    await service.processEvents([textEvent("จบสลิป")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("ยังไม่มีชุดสลิปที่เปิดอยู่");
  });

  it.each([["จบสลิป"], ["สรุปสลิป"], ["ปิดชุดสลิป"], ["จบชุดสลิป"]])(
    "close command '%s' is recognised",
    async (cmd) => {
      const replies: string[] = [];
      const service = new WebhookService(makeTextSupabase(), {
        slipSessionService: noopSession,
        async replyMessage(_, text) { replies.push(text); },
      });
      await service.processEvents([textEvent(cmd)], "dest");
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("ยังไม่มีชุดสลิปที่เปิดอยู่");
    },
  );

  it("replies already-closing when claim fails (batch is already in closing state)", async () => {
    const replies: string[] = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession(): Promise<ActiveSlipSession> {
        return { batchId: "batch-1", imageCount: 2, headerText: null, sellerName: null, marketName: null, slipDate: null };
      },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(makeCloseSupabase("raw", false), {
      slipSessionService,
      async replyMessage(_, text) { replies.push(text); },
    });

    await service.processEvents([textEvent("จบสลิป")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe("รับทราบแล้ว กำลังสรุปสลิปอยู่ กรุณารอสักครู่");
  });

  it("produce session text does not trigger slip close", async () => {
    const replies: string[] = [];
    let closeCalled = false;

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { closeCalled = true; return null; },
      async openSession() { return { opened: true, batchId: "b" }; },
    };

    const service = new WebhookService(makeTextSupabase(), {
      slipSessionService,
      async replyMessage(_, text) { replies.push(text); },
    });

    // "จบรายการ" is a produce session end — should NOT trigger slip close
    await service.processEvents([textEvent("จบรายการ")], "dest");

    expect(closeCalled).toBe(false);
  });
});
