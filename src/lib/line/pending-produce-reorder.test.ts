import { describe, expect, it } from "bun:test";
import { processExpiredPendingProduceEvents } from "./pending-produce-reorder";

function event(overrides: Record<string, unknown> = {}) {
  return {
    line_event_id: "evt-1",
    raw_message_id: "raw-1",
    session_key: "group:g:user:u",
    source_id: "group-source",
    line_user_id: "user-1",
    line_timestamp_ms: 1_000,
    raw_text: "1.ทุเรียน100บาท\n2โล",
    reply_token: "expired-reply-token",
    status: "rejected_orphan",
    defer_reason: "orphan",
    session_generation: null,
    opener_line_event_id: null,
    opener_line_timestamp_ms: null,
    close_line_event_id: null,
    close_line_timestamp_ms: null,
    received_at: "2026-09-29T00:00:00.000Z",
    resolved_at: "2026-09-29T00:01:00.000Z",
    ...overrides,
  };
}

describe("processExpiredPendingProduceEvents", () => {
  it("pushes deferred rejection to durable source_id instead of reusing reply_token", async () => {
    const supabase = { rpc: async () => ({ data: [event()], error: null }) };
    const calls: Array<{ to: string; text: string }> = [];

    const result = await processExpiredPendingProduceEvents(
      supabase as never,
      async (to, text) => { calls.push({ to, text }); },
    );

    expect(result).toEqual({ claimed: 1, replied: 1, replyErrors: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe("group-source");
    expect(calls[0].to).not.toBe("expired-reply-token");
  });

  it("still notifies when the deferred row has no reply token", async () => {
    const supabase = { rpc: async () => ({ data: [event({ reply_token: null })], error: null }) };
    const destinations: string[] = [];

    await processExpiredPendingProduceEvents(
      supabase as never,
      async (to) => { destinations.push(to); },
    );

    expect(destinations).toEqual(["group-source"]);
  });
});
