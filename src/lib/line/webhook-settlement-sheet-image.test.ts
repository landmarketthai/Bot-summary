/**
 * The settlement-sheet OCR gate lives inside processImageMessage's existing
 * "no active slip session" branch (webhook-service.ts). These tests prove
 * the three safety requirements directly:
 *   1. An ordinary photo with no guided round is ignored exactly as before
 *      this feature existed — the new handler is never invoked.
 *   2. The new handler IS invoked, with the resolved round context, only
 *      inside the narrow window a typed "ส่งยอด" command would already work.
 *   3. An active bank-slip batch session takes priority unconditionally —
 *      the settlement-sheet handler is never invoked even if a guided round
 *      is simultaneously in the right stage.
 */

import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WebhookService } from "./webhook-service";
import { GuidedJourneyService } from "@/lib/line/guided-menu";
import type { GuidedJourneyContext, GuidedJourneyState } from "@/lib/line/guided-menu";
import type { LineMessageEvent } from "./types";
import type { SlipSessionIngestor } from "@/lib/slips/slip-session-service";
import type { SettlementSheetImageHandler } from "@/lib/settlement-ocr/draft-service";
import type { SettlementSheetIngestInput } from "@/lib/settlement-ocr/evidence-service";
import type { Database } from "@/types/database";
import type { WhiteSheetCashEntryState } from "@/lib/white-sheet/persist";

const SOURCE = "G-1";
const DATE = "2026-09-21";
const MARKET = "วัดทุ่งลานนา";
const SELLER = "กี้";
const USER = "U-owner";

const CONTEXT: GuidedJourneyContext = {
  sessionKey: `group:${SOURCE}:user:${USER}`,
  sourceId: SOURCE,
  lineUserId: USER,
  sellerLabel: SELLER,
  marketLabel: MARKET,
  marketLabelNormalized: MARKET,
  businessDate: DATE,
  transactionType: "เบิก",
  sessionGeneration: "gen-1",
};

const SUBMITTED: WhiteSheetCashEntryState = {
  status: "submitted",
  expenses: { labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0 },
  actualCashSubmitted: 0,
  updatedAt: `${DATE}T05:00:00Z`,
};

function stageState(stage: Exclude<GuidedJourneyState["stage"], "idle">): GuidedJourneyState {
  return { stage, context: CONTEXT, session: { session_key: CONTEXT.sessionKey } as never, whiteSheet: SUBMITTED };
}

function journeyStub(state: GuidedJourneyState) {
  return { resolve: async () => state, findRoundOwner: async () => ({ kind: "none" }) } as unknown as GuidedJourneyService;
}

function supabaseStub() {
  return {
    from(table: string) {
      if (table === "raw_messages") {
        return {
          insert: () => ({ select: () => ({ async single() { return { data: { id: "raw-1" }, error: null }; } }) }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
}

function imageEvent(id: string, userId = USER): LineMessageEvent {
  return {
    type: "message",
    webhookEventId: `event-${id}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.parse(`${DATE}T05:00:00Z`),
    source: { type: "group", groupId: SOURCE, userId },
    mode: "active",
    replyToken: `reply-${id}`,
    message: { id, type: "image", quoteToken: `quote-${id}`, contentProvider: { type: "line" } },
  } as unknown as LineMessageEvent;
}

function noActiveSlipSession(): SlipSessionIngestor {
  return { async findActiveSession() { return null; }, async openSession() { throw new Error("not used"); } };
}

function activeSlipSession(): SlipSessionIngestor {
  return {
    async findActiveSession() {
      return { batchId: "batch-1", imageCount: 0, headerText: null, sellerName: null, marketName: null, slipDate: null };
    },
    async openSession() { throw new Error("not used"); },
  };
}

function handlerStub() {
  const calls: SettlementSheetIngestInput[] = [];
  const handler = { async handleImage(input: SettlementSheetIngestInput) { calls.push(input); } } as unknown as SettlementSheetImageHandler;
  return { handler, calls };
}

describe("settlement-sheet OCR gate in processImageMessage", () => {
  it("does not hijack an ordinary photo when no guided round exists", async () => {
    const { handler, calls } = handlerStub();
    const service = new WebhookService(supabaseStub(), {
      slipSessionService: noActiveSlipSession(),
      guidedJourneyService: journeyStub({ stage: "idle", reason: "no_session" }),
      settlementSheetImageHandler: handler,
      async replyMessage() {},
      evidenceIngestor: { async ingest() { throw new Error("must not be called"); } },
      checkProcessor: { async processEvidence() { throw new Error("must not be called"); } },
      batchService: { async attachEvidence() { throw new Error("must not be called"); } },
    });

    const [result] = await service.processEvents([imageEvent("img-1")], "dest");

    expect(result).toMatchObject({ status: "saved", parsed: false });
    expect(calls).toHaveLength(0);
  });

  it("does not trigger before the white sheet step (guided round exists but too early)", async () => {
    const { handler, calls } = handlerStub();
    const service = new WebhookService(supabaseStub(), {
      slipSessionService: noActiveSlipSession(),
      guidedJourneyService: journeyStub(stageState("white_sheet")),
      settlementSheetImageHandler: handler,
      async replyMessage() {},
    });

    await service.processEvents([imageEvent("img-2")], "dest");

    expect(calls).toHaveLength(0);
  });

  it("triggers the settlement-sheet handler once the round is past the white sheet step", async () => {
    const { handler, calls } = handlerStub();
    const service = new WebhookService(supabaseStub(), {
      slipSessionService: noActiveSlipSession(),
      guidedJourneyService: journeyStub(stageState("slips")),
      settlementSheetImageHandler: handler,
      async replyMessage() {},
    });

    const [result] = await service.processEvents([imageEvent("img-3")], "dest");

    expect(result).toMatchObject({ status: "saved", parsed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      rawMessageId: "raw-1",
      lineMessageId: "img-3",
      sourceId: SOURCE,
      sourceType: "group",
      lineUserId: USER,
      context: CONTEXT,
    });
  });

  it("also triggers in the reconcile stage", async () => {
    const { handler, calls } = handlerStub();
    const service = new WebhookService(supabaseStub(), {
      slipSessionService: noActiveSlipSession(),
      guidedJourneyService: journeyStub(stageState("reconcile")),
      settlementSheetImageHandler: handler,
      async replyMessage() {},
    });

    await service.processEvents([imageEvent("img-4")], "dest");
    expect(calls).toHaveLength(1);
  });

  it("bank slip path is unaffected: an active slip-batch session takes priority and the new handler is never called", async () => {
    const { handler, calls } = handlerStub();
    const replies: string[] = [];
    const service = new WebhookService(supabaseStub(), {
      slipSessionService: activeSlipSession(),
      // Guided round IS in the settlement window — priority must still go to
      // the pre-existing bank-slip flow.
      guidedJourneyService: journeyStub(stageState("slips")),
      settlementSheetImageHandler: handler,
      evidenceIngestor: {
        async ingest() {
          return { evidenceId: "evidence-1", status: "RECEIVED", storagePath: "p", sha256: "a".repeat(64) };
        },
      },
      checkProcessor: { async processEvidence() {} },
      batchService: { async attachEvidence() {} },
      async replyMessage(_token, text) { replies.push(text); },
    });

    await service.processEvents([imageEvent("img-5")], "dest");

    expect(calls).toHaveLength(0);
    expect(replies).toEqual([
      "รับรูปหลักฐานแล้วครับ\nถ้ามีหลายใบ ส่งต่อได้เลย\nพิมพ์ \"จบสลิป\" เมื่อส่งครบ",
    ]);
  });
});
