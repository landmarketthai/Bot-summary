import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { LineMessageEvent } from "@/lib/line/types";
import { WebhookService, isSlipSessionOrderingEvent } from "@/lib/line/webhook-service";
import { isSlipCancelCommand, isSlipCloseCommand } from "@/lib/slips/slip-session-service";
import type { SlipSessionIngestor } from "@/lib/slips/slip-session-service";

const timestamp = Date.UTC(2026, 10, 5, 3, 50);
function event(text: string, userId = "owner"): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: "slip-cancel-event",
    deliveryContext: { isRedelivery: false },
    timestamp,
    source: { type: "group", groupId: "test-group", userId },
    mode: "active",
    replyToken: "reply-token",
    message: { id: "msg-cancel", type: "text", quoteToken: "q", text },
  };
}

type Result = "cancelled" | "no_active" | "not_owner" | "already_closing";
function harness(result: Result = "cancelled", fail = false) {
  const replies: string[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return fail
        ? { data: null, error: { message: "db unavailable" } }
        : { data: result, error: null };
    },
    from() { throw new Error("must use the atomic cancellation RPC"); },
  } as unknown as SupabaseClient<Database>;
  const slipSessionService: SlipSessionIngestor = {
    async findActiveSession() { throw new Error("must not read before atomic cancellation"); },
    async openSession() { return { opened: true, batchId: "fresh" }; },
  };
  const service = new WebhookService(supabase, {
    slipSessionService,
    async replyMessage(_token, text) { replies.push(text); },
  });
  async function cancel(userId = "owner") {
    const fn = Reflect.get(service, "processSlipCancel") as (
      ev: LineMessageEvent, id: string, eventType: string,
      log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
    ) => Promise<unknown>;
    await fn.call(service, event("ยกเลิกสลิป", userId), "e1", "message", {
      info() {}, error() {},
    });
  }
  return { cancel, replies, calls };
}

describe("LINE slip cancellation contract", () => {
  it("recognizes only exact command and keeps cancel ordered with images and close", () => {
    expect(isSlipCancelCommand(" ยกเลิกสลิป ")).toBe(true);
    expect(isSlipCancelCommand("ยกเลิกสลิปมือ")).toBe(false);
    expect(isSlipCancelCommand("ยกเลิกรายการ")).toBe(false);
    expect(isSlipCloseCommand("ยกเลิกสลิป")).toBe(false);
    expect(isSlipSessionOrderingEvent(event("ยกเลิกสลิป"))).toBe(true);
    expect(isSlipSessionOrderingEvent(event("จบสลิป"))).toBe(true);
  });

  it("calls one atomic transaction with source, owner and LINE timestamp", async () => {
    const h = harness();
    await h.cancel();
    expect(h.calls).toEqual([{
      name: "cancel_collecting_slip_batch",
      args: { p_source_id: "test-group", p_sender_id: "owner", p_event_ts_ms: timestamp },
    }]);
    expect(h.replies[0]).toContain("ยกเลิกชุดสลิปแล้ว");
    expect(h.replies[0]).toContain("หัวชุด");
  });

  it("does not let a different group sender cancel the opener's batch", async () => {
    const h = harness("not_owner");
    await h.cancel("other-user");
    expect(h.calls[0].args.p_sender_id).toBe("other-user");
    expect(h.replies[0]).toContain("คนที่เปิดชุดสลิป");
  });

  it("rejects cancellation when close has already claimed the batch", async () => {
    const h = harness("already_closing");
    await h.cancel();
    expect(h.replies[0]).toContain("เริ่มสรุปแล้ว");
  });

  it("does not modify any data if no batch is open", async () => {
    const h = harness("no_active");
    await h.cancel();
    expect(h.replies[0]).toContain("ไม่มีชุดสลิป");
  });

  it("fails closed on database errors and never claims success", async () => {
    const h = harness("cancelled", true);
    await h.cancel();
    expect(h.replies[0]).toContain("ยกเลิกสลิปไม่สำเร็จ");
  });
});
