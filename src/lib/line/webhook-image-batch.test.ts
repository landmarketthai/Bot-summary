import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WebhookService } from "./webhook-service";
import type { LineMessageEvent } from "./types";
import type { SlipSessionIngestor, ActiveSlipSession } from "@/lib/slips/slip-session-service";
import type { Database } from "@/types/database";

function createRawMessageSupabase(rawId = "raw-img") {
  const client = {
    async rpc(name: string) { throw new Error(`unexpected rpc: ${name}`); },
    from(table: string) {
      if (table === "raw_messages") {
        return {
          insert() {
            return {
              select() {
                return {
                  async single() {
                    return { data: { id: rawId }, error: null };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
  return client;
}

function imageEvent(id: string, timestamp = Date.UTC(2026, 5, 1, 5, 0, 0)): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: `event-${id}`,
    deliveryContext: { isRedelivery: false },
    timestamp,
    source: { type: "group", groupId: "group-1", userId: "user-1" },
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

function stubIngestor(
  status: "RECEIVED" | "STORAGE_FAILED" = "RECEIVED",
  evidenceId = "ev-1",
  calls?: { count: number },
) {
  return {
    async ingest() {
      if (calls) calls.count += 1;
      return {
        evidenceId: status === "RECEIVED" ? evidenceId : null,
        status,
        storagePath: "slips/path.jpg",
        sha256: "a".repeat(64),
      };
    },
  };
}

const stubCheckProcessor = { async processEvidence() {} };

function activeSession(imageCount: number): ActiveSlipSession {
  return {
    batchId:    "batch-1",
    imageCount,
    headerText: null,
    sellerName: null,
    marketName: null,
    slipDate:   null,
  };
}

// ── Batch behavior ─────────────────────────────────────────────────────────────

describe("WebhookService batch slip flow", () => {
  it("first image in open session (imageCount=0) triggers a reply and schedules OCR", async () => {
    const replies: string[] = [];
    const ingestCalls = { count: 0 };
    const attachCalls: Array<{ batchId: string; evidenceId: string }> = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return activeSession(0); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const bgTasks: Array<() => Promise<void>> = [];
    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor("RECEIVED", "ev-1", ingestCalls),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: {
        async attachEvidence(batchId, evidenceId) { attachCalls.push({ batchId, evidenceId }); },
      },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([imageEvent("msg-1")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe(
      `รับรูปหลักฐานแล้วครับ\nถ้ามีหลายใบ ส่งต่อได้เลย\nพิมพ์ "จบสลิป" เมื่อส่งครบ`,
    );
    expect(ingestCalls.count).toBe(1);
    expect(attachCalls).toEqual([{ batchId: "batch-1", evidenceId: "ev-1" }]);
    expect(bgTasks).toHaveLength(1);
  });

  it("subsequent image (imageCount>0) does not reply but still schedules OCR", async () => {
    const replies: string[] = [];
    const ingestCalls = { count: 0 };
    const attachCalls: Array<{ batchId: string; evidenceId: string }> = [];
    const bgTasks: Array<() => Promise<void>> = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return activeSession(3); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor("RECEIVED", "ev-2", ingestCalls),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: {
        async attachEvidence(batchId, evidenceId) { attachCalls.push({ batchId, evidenceId }); },
      },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([imageEvent("msg-2")], "dest");

    expect(replies).toHaveLength(0);
    expect(ingestCalls.count).toBe(1);
    expect(attachCalls).toEqual([{ batchId: "batch-1", evidenceId: "ev-2" }]);
    expect(bgTasks).toHaveLength(1);
  });

  it("two images in sequence: first replies, second is silent", async () => {
    const replies: string[] = [];
    let callCount = 0;

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() {
        callCount += 1;
        return activeSession(callCount === 1 ? 0 : 1);
      },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor(),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: { async attachEvidence() {} },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask() {},
    });

    await service.processEvents([imageEvent("msg-a"), imageEvent("msg-b")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("รับรูปหลักฐานแล้วครับ");
  });

  it("image with no active session is silently ignored before evidence ingestion", async () => {
    const replies: string[] = [];
    const ingestCalls = { count: 0 };
    const attachCalls: Array<{ batchId: string; evidenceId: string }> = [];
    const bgTasks: Array<() => Promise<void>> = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return null; },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor("RECEIVED", "ev-nosession", ingestCalls),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: {
        async attachEvidence(batchId, evidenceId) { attachCalls.push({ batchId, evidenceId }); },
      },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([imageEvent("msg-nosession")], "dest");

    expect(replies).toHaveLength(0);
    expect(ingestCalls.count).toBe(0);
    expect(attachCalls).toHaveLength(0);
    expect(bgTasks).toHaveLength(0);
  });

  it("session lookup failure ignores the image without evidence ingestion or a reply", async () => {
    const replies: string[] = [];
    const ingestCalls = { count: 0 };
    const attachCalls: Array<{ batchId: string; evidenceId: string }> = [];
    const bgTasks: Array<() => Promise<void>> = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { throw new Error("db unavailable"); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor("RECEIVED", "ev-lookup-fail", ingestCalls),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: {
        async attachEvidence(batchId, evidenceId) { attachCalls.push({ batchId, evidenceId }); },
      },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([imageEvent("msg-fallback")], "dest");

    expect(replies).toHaveLength(0);
    expect(ingestCalls.count).toBe(0);
    expect(attachCalls).toHaveLength(0);
    expect(bgTasks).toHaveLength(0);
  });

  it("attach failure does NOT schedule OCR (evidence would be orphaned with no batch_id)", async () => {
    const bgTasks: Array<() => Promise<void>> = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return activeSession(0); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor("RECEIVED", "ev-attach-fail"),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: {
        async attachEvidence() { throw new Error("attach to batch failed"); },
      },
      async replyMessage() {},
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([imageEvent("msg-attach-fail")], "dest");

    // OCR must not be scheduled — evidence is not attached to any batch
    expect(bgTasks).toHaveLength(0);
  });

  it("storage failure still replies with retry message regardless of session", async () => {
    const replies: string[] = [];
    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return activeSession(0); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase(), {
      evidenceIngestor: stubIngestor("STORAGE_FAILED"),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask() {},
    });

    await service.processEvents([imageEvent("msg-fail")], "dest");

    expect(replies).toEqual(["รับรูปไม่สำเร็จ กรุณาส่งใหม่อีกครั้ง"]);
  });

  // ── Fix 2: Late-image rejection when finalizer has already claimed the batch ──

  it("attachment loses to finalizer: replies with rejection message, no OCR scheduled", async () => {
    const replies: string[] = [];
    const bgTasks: Array<() => Promise<void>> = [];

    const slipSessionService: SlipSessionIngestor = {
      // findActiveSession returns the batch (it's closing or processing from finder's perspective)
      async findActiveSession() { return activeSession(2); },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase("raw-late"), {
      evidenceIngestor: stubIngestor("RECEIVED", "ev-late"),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: {
        async attachEvidence() {
          // Simulates the RPC exception from migration 0024 when batch is processing
          throw new Error(
            "Failed to attach evidence to batch: slip_batch batch-1 not found or not in collecting/closing status",
          );
        },
      },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([imageEvent("msg-late")], "dest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe(
      "รูปนี้ไม่ถูกรวมในชุดสลิป เนื่องจากระบบเริ่มสรุปแล้ว กรุณาเปิดชุดใหม่ก่อนส่งรูป",
    );
    // No OCR — evidence is not part of the finalized batch
    expect(bgTasks).toHaveLength(0);
  });

  it("multiple images with no active session are all silently ignored", async () => {
    const replies: string[] = [];
    const ingestCalls = { count: 0 };
    const attachCalls: Array<{ batchId: string; evidenceId: string }> = [];
    const bgTasks: Array<() => Promise<void>> = [];

    const slipSessionService: SlipSessionIngestor = {
      async findActiveSession() { return null; },
      async openSession() { return { opened: true, batchId: "batch-1" }; },
    };

    const service = new WebhookService(createRawMessageSupabase("raw-nosession"), {
      evidenceIngestor: stubIngestor("RECEIVED", "ev-nosession", ingestCalls),
      checkProcessor: stubCheckProcessor,
      slipSessionService,
      batchService: {
        async attachEvidence(batchId, evidenceId) { attachCalls.push({ batchId, evidenceId }); },
      },
      async replyMessage(_, text) { replies.push(text); },
      scheduleBackgroundTask(task) { bgTasks.push(task); },
    });

    await service.processEvents([
      imageEvent("msg-nosession2"),
      imageEvent("msg-nosession3"),
      imageEvent("msg-nosession4"),
    ], "dest");

    expect(replies).toHaveLength(0);
    expect(ingestCalls.count).toBe(0);
    expect(attachCalls).toHaveLength(0);
    expect(bgTasks).toHaveLength(0);
  });
});
