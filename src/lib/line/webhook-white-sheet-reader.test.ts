import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { LineMessageEvent } from "./types";
import { FakeDatabase, type Row } from "@/lib/summary/test-fake-supabase";
import { resolveWhiteSheetReadMode, PREVIEW_TTL_MS } from "@/lib/white-sheet-reader/mode";
import { PREVIEW_START_REPLY, PREVIEW_CONSUMED_REPLY, PREVIEW_RETRY_REPLY, readWhiteSheetImage } from "@/lib/white-sheet-reader/reader";
import { WebhookService } from "./webhook-service";

function event(id: string, text?: string, userId = "U1", timestamp = Date.now() - 1000): LineMessageEvent {
  return { type: "message", webhookEventId: `event-${id}`, timestamp,
    deliveryContext: { isRedelivery: false }, source: { type: "group", groupId: "G1", userId },
    mode: "active", replyToken: `reply-${id}`, message: text === undefined
      ? { id, type: "image", quoteToken: id, contentProvider: { type: "line" } }
      : { id, type: "text", quoteToken: id, text } };
}

class PreviewDatabase extends FakeDatabase {
  readonly writes: string[] = [];
  override noteWrite(table: string) { this.writes.push(table); super.noteWrite(table); }
  override insert(table: string, payload: Row, mode: "select" | "insert" | "update" | "upsert" | "delete") {
    this.writes.push(table);
    return super.insert(table, payload, mode);
  }
  private queueRpc(name: string, args?: Row) {
    this.rpcCalls.push(name);
    if (name === "receive_line_webhook_event") {
      const existing = this.rows("raw_messages").find((row) => row.line_event_id === args?.p_line_event_id);
      if (existing) return Promise.resolve({ data: { raw_message_id: existing.id, duplicate: true }, error: null });
      const row = this.insert("raw_messages", {
        line_event_id: args?.p_line_event_id, destination: args?.p_destination,
        source_type: args?.p_source_type, source_id: args?.p_source_id, user_id: args?.p_user_id,
        message_id: args?.p_message_id, message_type: args?.p_message_type,
        raw_text: args?.p_raw_text, payload: args?.p_payload,
      }, "insert");
      this.rows("line_webhook_event_queue").push({ raw_message_id: row.id, line_event_id: row.line_event_id,
        source_id: row.source_id, receive_order: this.rows("line_webhook_event_queue").length + 1,
        received_at: new Date().toISOString(), status: "pending", claim_token: "claim", queue_id: row.id });
      return Promise.resolve({ data: { raw_message_id: row.id, duplicate: false }, error: null });
    }
    if (name === "claim_line_webhook_event") {
      const row = this.rows("line_webhook_event_queue").find((row) => row.source_id === args?.p_source_id && row.status === "pending");
      if (row) row.status = "processing";
      return Promise.resolve({ data: row ?? null, error: null });
    }
    if (name === "complete_line_webhook_event") {
      const row = this.rows("line_webhook_event_queue").find((row) => row.raw_message_id === args?.p_raw_message_id);
      if (row) row.status = args?.p_status;
      return Promise.resolve({ data: true, error: null });
    }
    throw new Error(`Unexpected business RPC: ${name}`);
  }
  client() { return { from: this.from.bind(this), rpc: this.queueRpc.bind(this) } as unknown as SupabaseClient<Database>; }
}

function setup(db = new PreviewDatabase(), allowed = true, enabled = true, readerEnabled = true) {
  const replies: string[] = [], images: string[] = [], asked: string[] = [];
  let slipLookups = 0;
  const dependencies = {
    botSummaryAnalystEnabled: enabled, botSummaryAnalystSourceAllowed: () => allowed,
    whiteSheetReaderEnabled: readerEnabled,
    botSummaryAnalystAnswerer: async (question: string) => { asked.push(question); return "ยอดขายวันนี้"; },
    whiteSheetImageReader: async (id: string) => { images.push(id); return ["preview"] ; },
    replyMessage: async (_token: string, text: string) => { replies.push(text); },
    slipSessionService: {
      findActiveSession: async () => { slipLookups++; return null; },
      openSession: async () => { throw new Error("must not open"); },
    },
    guidedJourneyService: { resolve: async () => ({ stage: "idle", reason: "no_session" }) } as never,
    settlementSheetImageHandler: { handleImage: async () => { throw new Error("must not save settlement draft"); } } as never,
    evidenceIngestor: { ingest: async () => { throw new Error("must not save slip evidence"); } },
  };
  return { db, dependencies, service: new WebhookService(db.client(), dependencies), replies, images, asked,
    slipLookups: () => slipLookups };
}

describe("@Botsummary read-white-sheet routing", () => {
  it("enters preview before analyst Q&A and business parsing", async () => {
    const s = setup();
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว")], "Ubot");
    expect(s.replies).toEqual([PREVIEW_START_REPLY]); expect(s.asked).toEqual([]);
    expect(s.db.writes.every((table) => table === "raw_messages")).toBe(true);
  });
  it("reads one image across separate Vercel instances and persists no extracted data", async () => {
    const s = setup();
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว")], "Ubot");
    const instance = new WebhookService(s.db.client(), s.dependencies);
    await instance.processEvents([event("img")], "Ubot");
    expect(s.images).toEqual(["img"]); expect(s.replies.at(-1)).toBe("preview");
    expect(s.slipLookups()).toBe(0); expect(s.asked).toEqual([]);
    expect(s.db.writes.every((table) => table === "raw_messages")).toBe(true);
    expect(s.db.rpcCalls.every((name) => /^(receive|claim|complete)_line_webhook_event$/u.test(name))).toBe(true);
    expect(s.db.rows("raw_messages").every((row) => !JSON.stringify(row).includes("preview"))).toBe(true);
  });
  it("handles command plus images in one payload in durable order, then blocks extra images", async () => {
    const s = setup();
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว"), event("img1"), event("img2")], "Ubot");
    expect(s.images).toEqual(["img1"]); expect(s.replies.at(-1)).toBe(PREVIEW_CONSUMED_REPLY);
    expect(s.slipLookups()).toBe(0);
  });
  it("does not repeat extraction on LINE redelivery", async () => {
    const s = setup(), image = event("img");
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว"), image], "Ubot");
    const result = await s.service.processEvents([{ ...image, deliveryContext: { isRedelivery: true } }], "Ubot");
    expect(result[0].status).toBe("duplicate"); expect(s.images).toEqual(["img"]);
  });
  it("keeps normal images and Q&A on their previous routes", async () => {
    const s = setup();
    await s.service.processEvents([event("img"), event("qa", "@Botsummary ยอดขายวันนี้")], "Ubot");
    expect(s.images).toEqual([]); expect(s.slipLookups()).toBe(1);
    expect(s.asked).toEqual(["ยอดขายวันนี้"]);
  });
  it("an active slip batch receives a normal image in an analyst-enabled group", async () => {
    const s = setup(); const evidence: string[] = [], batches: string[] = [];
    const service = new WebhookService(s.db.client(), { ...s.dependencies,
      slipSessionService: {
        findActiveSession: async () => ({ batchId: "slips", imageCount: 0, headerText: null, sellerName: null, marketName: null, slipDate: null }),
        openSession: async () => { throw new Error("must not open"); },
      },
      evidenceIngestor: { ingest: async (input) => { evidence.push(input.lineMessageId); return {
        evidenceId: "evidence", status: "RECEIVED", storagePath: "existing.jpg", sha256: "a".repeat(64),
      }; } },
      batchService: { attachEvidence: async (id) => { batches.push(id); } },
      scheduleBackgroundTask: () => {},
    });
    await service.processEvents([event("slip")], "Ubot");
    expect(s.images).toEqual([]); expect(evidence).toEqual(["slip"]); expect(batches).toEqual(["slips"]);
    expect(s.replies[0]).toContain("รับรูปหลักฐานแล้ว");
  });
  it("explicit preview takes priority over an existing slip batch", async () => {
    const s = setup();
    const service = new WebhookService(s.db.client(), { ...s.dependencies,
      slipSessionService: { findActiveSession: async () => { throw new Error("must not even look up slips"); },
        openSession: async () => { throw new Error("must not open"); } },
    });
    await service.processEvents([event("cmd", "@Botsummary อ่านใบขาว"), event("img")], "Ubot");
    expect(s.images).toEqual(["img"]);
    expect(s.db.writes.every((table) => table === "raw_messages")).toBe(true);
  });
  it("does not consume another user's image", async () => {
    const s = setup();
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว"), event("other", undefined, "U2"), event("mine")], "Ubot");
    expect(s.images).toEqual(["mine"]); expect(s.slipLookups()).toBe(1);
  });
  it.each(["source", "disabled", "user-source", "missing-user"])("fails closed for %s commands", async (kind) => {
    const s = setup(undefined, kind !== "source", kind !== "disabled");
    const command = event("cmd", "@Botsummary อ่านใบขาว");
    if (kind === "user-source") command.source = { type: "user", userId: "U1" };
    if (kind === "missing-user") command.source = { type: "group", groupId: "G1" };
    await s.service.processEvents([command], "Ubot");
    expect(s.asked).toEqual([]); expect(s.images).toEqual([]);
    expect(s.replies[0]).toContain("ยังไม่เปิดใช้งาน");
  });
  it("can disable only the white-sheet reader while keeping normal analyst Q&A and image routing", async () => {
    const s = setup(undefined, true, true, false);
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว"), event("img"),
      event("qa", "@Botsummary ยอดขายวันนี้")], "Ubot");
    expect(s.replies[0]).toContain("ยังไม่เปิดใช้งาน");
    expect(s.images).toEqual([]); expect(s.slipLookups()).toBe(1);
    expect(s.asked).toEqual(["ยอดขายวันนี้"]);
  });
  it("supports actual bot mention metadata", async () => {
    const s = setup(); const command = event("cmd", "@OtherDisplay อ่านใบขาว");
    if (command.message.type === "text") command.message.mention = { mentionees: [{ index: 0, length: 13, type: "user", userId: "Ubot" }] };
    await s.service.processEvents([command, event("img")], "Ubot");
    expect(s.images).toEqual(["img"]); expect(s.asked).toEqual([]);
  });
  it("cancel returns images to normal handling, and a new command rearms one image", async () => {
    const s = setup();
    await s.service.processEvents([event("start", "@Botsummary อ่านใบขาว"),
      event("cancel", "@Botsummary ยกเลิกอ่านใบขาว"), event("normal"),
      event("restart", "@Botsummary อ่านใบขาว"), event("read")], "Ubot");
    expect(s.images).toEqual(["read"]); expect(s.slipLookups()).toBe(1); expect(s.asked).toEqual([]);
  });
  it("expired commands cannot arm the reader", async () => {
    const s = setup();
    await s.service.processEvents([event("old", "@Botsummary อ่านใบขาว", "U1", Date.now() - PREVIEW_TTL_MS - 1), event("img")], "Ubot");
    expect(s.images).toEqual([]); expect(s.slipLookups()).toBe(1);
  });
  it("a delayed older image fails closed instead of becoming slip/settlement input", async () => {
    const s = setup(); const now = Date.now();
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว", "U1", now - 100),
      event("old-image", undefined, "U1", now - 200)], "Ubot");
    expect(s.images).toEqual([]); expect(s.slipLookups()).toBe(0);
    expect(s.replies.at(-1)).toBe(PREVIEW_RETRY_REPLY);
  });
  it.each(["multi-image", "external"])("refuses %s without invoking extraction or any writing flow", async (kind) => {
    const s = setup(); const image = event("img");
    if (image.message.type === "image") {
      if (kind === "multi-image") image.message.imageSet = { id: "set", index: 1, total: 2 };
      else image.message.contentProvider = { type: "external", originalContentUrl: "https://example.com/private" };
    }
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว"), image], "Ubot");
    expect(s.images).toEqual([]); expect(s.replies.at(-1)).toBe(PREVIEW_RETRY_REPLY); expect(s.slipLookups()).toBe(0);
  });
  it("contains reader failure without falling into slip/settlement writes", async () => {
    const s = setup(); s.dependencies.whiteSheetImageReader = async () => { throw new Error("timeout"); };
    const service = new WebhookService(s.db.client(), s.dependencies);
    await service.processEvents([event("cmd", "@Botsummary อ่านใบขาว"), event("img")], "Ubot");
    expect(s.replies.at(-1)).toBe(PREVIEW_RETRY_REPLY); expect(s.slipLookups()).toBe(0);
  });
  it("invalid model output returns retry through the real reader", async () => {
    const s = setup();
    s.dependencies.whiteSheetImageReader = async (id) => readWhiteSheetImage(id,
      async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg" }), async () => ({ invalid: true }));
    await new WebhookService(s.db.client(), s.dependencies).processEvents([event("cmd", "@Botsummary อ่านใบขาว"), event("img")], "Ubot");
    expect(s.replies.at(-1)).toBe(PREVIEW_RETRY_REPLY); expect(s.slipLookups()).toBe(0);
    expect(s.db.writes.every((table) => table === "raw_messages")).toBe(true);
  });
  it("fails closed on unavailable session context instead of invoking writing image handlers", async () => {
    const s = setup();
    const service = new WebhookService(s.db.client(), { ...s.dependencies,
      whiteSheetReadModeResolver: async () => { throw new Error("DB unavailable"); } });
    await service.processEvents([event("img")], "Ubot");
    expect(s.replies).toEqual([PREVIEW_RETRY_REPLY]); expect(s.slipLookups()).toBe(0);
  });
  it("a failed command processing stamp cannot leak the image into settlement/slip writes", async () => {
    const s = setup();
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว")], "Ubot");
    s.db.rows("raw_messages")[0].is_processed = false;
    await s.service.processEvents([event("img")], "Ubot");
    expect(s.replies.at(-1)).toBe(PREVIEW_RETRY_REPLY);
    expect(s.images).toEqual([]); expect(s.slipLookups()).toBe(0);
  });
  it("fails closed on bounded history overflow", async () => {
    const s = setup();
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว")], "Ubot");
    for (let i = 0; i < 200; i++) s.db.rows("line_webhook_event_queue").push({
      raw_message_id: `other-${i}`, source_id: "G1", receive_order: 1,
      received_at: new Date().toISOString(), status: "processed",
    });
    await s.service.processEvents([event("img")], "Ubot");
    expect(s.replies.at(-1)).toBe(PREVIEW_RETRY_REPLY); expect(s.slipLookups()).toBe(0);
  });
  it("binds context to destination and group and rejects absent queue context", async () => {
    const s = setup();
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว"), event("img")], "Ubot");
    const image = event("img");
    await expect(resolveWhiteSheetReadMode(s.db.client(), image, "raw-2", "otherBot")).rejects.toThrow();
    await expect(resolveWhiteSheetReadMode(s.db.client(), image, "absent", "Ubot")).rejects.toThrow();
    image.source = { type: "group", groupId: "otherGroup", userId: "U1" };
    await expect(resolveWhiteSheetReadMode(s.db.client(), image, "raw-2", "Ubot")).rejects.toThrow();
  });
});
