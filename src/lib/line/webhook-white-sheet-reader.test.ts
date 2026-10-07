import { describe, expect, it } from "bun:test";
import type { LineMessageEvent } from "./types";
import { ReviewDatabase as PreviewDatabase } from "@/lib/white-sheet-reader/test-review-database";
import type { WhiteSheetPreview } from "@/lib/white-sheet-reader/schema";
import { resolveWhiteSheetSession, PREVIEW_TTL_MS } from "@/lib/white-sheet-reader/mode";
import { PREVIEW_START_REPLY, PREVIEW_PENDING_REVIEW_REPLY, PREVIEW_RETRY_REPLY, readWhiteSheetBase, type WhiteSheetBaseRead } from "@/lib/white-sheet-reader/reader";
import { WebhookService } from "./webhook-service";

function event(id: string, text?: string, userId = "U1", timestamp = Date.now() - 1000): LineMessageEvent {
  return { type: "message", webhookEventId: `event-${id}`, timestamp,
    deliveryContext: { isRedelivery: false }, source: { type: "group", groupId: "G1", userId },
    mode: "active", replyToken: `reply-${id}`, message: text === undefined
      ? { id, type: "image", quoteToken: id, contentProvider: { type: "line" } }
      : { id, type: "text", quoteToken: id, text } };
}

const SHEET: WhiteSheetPreview = {
  documentType: "white_sheet", market: "พาซิโอ้ผัก", dateRaw: null, dateIso: null, sellerNames: [], salesAmountBaht: 7170,
  transferAmountBaht: 865, cashSentAmountBaht: 1640, laborAmountBaht: null, remainingCashAmountBaht: null,
  expenses: [], lowConfidenceFields: [], overallConfidence: 0.95, notes: [],
};

function setup(db = new PreviewDatabase(), allowed = true, enabled = true, readerEnabled = true) {
  const replies: string[] = [], images: string[] = [], asked: string[] = [];
  let slipLookups = 0;
  const dependencies = {
    botSummaryAnalystEnabled: enabled, botSummaryAnalystSourceAllowed: () => allowed,
    whiteSheetReaderEnabled: readerEnabled,
    botSummaryAnalystAnswerer: async (question: string) => { asked.push(question); return "ยอดขายวันนี้"; },
    whiteSheetBaseReader: async (id: string): Promise<WhiteSheetBaseRead> => { images.push(id); return { outcome: "applied", snapshot: SHEET, replies: ["preview"] }; },
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
    expect(s.db.writes.every((table) => table === "raw_messages" || table === "white_sheet_review_turns")).toBe(true);
  });
  it("reads one image across separate Vercel instances and persists no extracted data", async () => {
    const s = setup();
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว")], "Ubot");
    const instance = new WebhookService(s.db.client(), s.dependencies);
    await instance.processEvents([event("img")], "Ubot");
    expect(s.images).toEqual(["img"]); expect(s.replies.at(-1)).toBe("preview");
    expect(s.slipLookups()).toBe(0); expect(s.asked).toEqual([]);
    expect(s.db.writes.every((table) => table === "raw_messages" || table === "white_sheet_review_turns")).toBe(true);
    expect(s.db.rpcCalls.every((name) => /^(receive|claim|complete)_line_webhook_event$/u.test(name))).toBe(true);
    expect(s.db.rows("raw_messages").every((row) => !JSON.stringify(row).includes("preview"))).toBe(true);
  });
  it("handles command plus images in one payload in durable order, then blocks extra images", async () => {
    const s = setup();
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว"), event("img1"), event("img2")], "Ubot");
    expect(s.images).toEqual(["img1"]); expect(s.replies.at(-1)).toBe(PREVIEW_PENDING_REVIEW_REPLY);
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
    expect(s.db.writes.every((table) => table === "raw_messages" || table === "white_sheet_review_turns")).toBe(true);
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
  it("an image LINE-stamped before the start command is not the sheet, in claim order, even if received after it", async () => {
    const s = setup(); const now = Date.now();
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว", "U1", now - 100),
      event("old-image", undefined, "U1", now - 200)], "Ubot");
    // The worker claims by (LINE timestamp, receive_order): the image precedes the command, so it is an ordinary image.
    expect(s.images).toEqual([]); expect(s.slipLookups()).toBe(1);
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
    const s = setup(); s.dependencies.whiteSheetBaseReader = async () => { throw new Error("timeout"); };
    const service = new WebhookService(s.db.client(), s.dependencies);
    await service.processEvents([event("cmd", "@Botsummary อ่านใบขาว"), event("img")], "Ubot");
    expect(s.replies.at(-1)).toBe(PREVIEW_RETRY_REPLY); expect(s.slipLookups()).toBe(0);
  });
  it("invalid model output returns retry through the real reader", async () => {
    const s = setup();
    s.dependencies.whiteSheetBaseReader = async (id) => readWhiteSheetBase(id,
      async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg" }), async () => ({ invalid: true }));
    await new WebhookService(s.db.client(), s.dependencies).processEvents([event("cmd", "@Botsummary อ่านใบขาว"), event("img")], "Ubot");
    expect(s.replies.at(-1)).toBe(PREVIEW_RETRY_REPLY); expect(s.slipLookups()).toBe(0);
    expect(s.db.writes.every((table) => table === "raw_messages" || table === "white_sheet_review_turns")).toBe(true);
  });
  it("fails closed on unavailable session context instead of invoking writing image handlers", async () => {
    const s = setup();
    const service = new WebhookService(s.db.client(), { ...s.dependencies,
      whiteSheetSessionResolver: async () => { throw new Error("DB unavailable"); } });
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
    for (let i = 0; i < 300; i++) {
      s.db.rows("raw_messages").push({ id: `other-${i}`, destination: "Ubot", source_type: "group", source_id: "G1",
        user_id: "U1", message_type: "text", raw_text: `chat ${i}`, is_processed: true,
        payload: event(`other-${i}`, `chat ${i}`) });
      s.db.rows("line_webhook_event_queue").push({ raw_message_id: `other-${i}`, source_id: "G1", receive_order: 1.5,
        received_at: new Date().toISOString(), status: "processed" });
    }
    await s.service.processEvents([event("img")], "Ubot");
    expect(s.replies.at(-1)).toBe(PREVIEW_RETRY_REPLY); expect(s.slipLookups()).toBe(0);
  });
  it("binds context to destination and group and rejects absent queue context", async () => {
    const s = setup();
    await s.service.processEvents([event("cmd", "@Botsummary อ่านใบขาว"), event("img")], "Ubot");
    const image = event("img");
    await expect(resolveWhiteSheetSession(s.db.client(), image, "raw-2", "otherBot")).rejects.toThrow();
    await expect(resolveWhiteSheetSession(s.db.client(), image, "absent", "Ubot")).rejects.toThrow();
    image.source = { type: "group", groupId: "otherGroup", userId: "U1" };
    await expect(resolveWhiteSheetSession(s.db.client(), image, "raw-2", "Ubot")).rejects.toThrow();
  });
});
