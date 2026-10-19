/**
 * PR #10 review finding #3, at the webhook boundary.
 *
 * The guard has to run BEFORE SlipSessionService.openSession, so a copied or
 * edited guided header never reaches the legacy open and no slip_batches row is
 * created. These tests assert on `openSession` never being called — the only
 * thing that proves zero rows.
 */

import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WebhookService } from "./webhook-service";
import {
  buildSlipHeaderTemplate,
  GuidedJourneyService,
} from "@/lib/line/guided-menu";
import type { GuidedJourneyContext, GuidedJourneyState } from "@/lib/line/guided-menu";
import type { LineMessageEvent } from "./types";
import type { SlipSessionIngestor } from "@/lib/slips/slip-session-service";
import type { Database } from "@/types/database";
import type { WhiteSheetCashEntryState } from "@/lib/white-sheet/persist";

const SOURCE = "G-1";
const DATE = "2026-07-29";
const MARKET = "วัดทุ่งลานนา";
const SELLER = "กี้";
const OWNER_USER = "U-owner";

const CONTEXT: GuidedJourneyContext = {
  sessionKey: `group:${SOURCE}:user:${OWNER_USER}`,
  sourceId: SOURCE,
  lineUserId: OWNER_USER,
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

function supabaseStub(rawId = "raw-txt") {
  return {
    // Slip open is an ordered event: the receive RPC is tried first and must
    // report missing ordering infrastructure (pre-queue double).
    async rpc(name: string) { throw new Error(`unexpected rpc: ${name}`); },
    from(table: string) {
      if (table === "raw_messages") {
        return {
          insert: () => ({
            select: () => ({
              async single() { return { data: { id: rawId }, error: null }; },
            }),
          }),
        };
      }
      if (table === "pending_sessions") {
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

function textEvent(text: string, userId = OWNER_USER): LineMessageEvent {
  return {
    type: "message",
    replyToken: "reply-token",
    source: { type: "group", groupId: SOURCE, userId },
    timestamp: Date.parse(`${DATE}T03:00:00Z`),
    message: { id: `msg-${text.length}-${userId}`, type: "text", text },
  } as unknown as LineMessageEvent;
}

function stageState(
  stage: Exclude<GuidedJourneyState["stage"], "idle">,
): GuidedJourneyState {
  return {
    stage,
    context: CONTEXT,
    session: { session_key: CONTEXT.sessionKey } as never,
    whiteSheet: SUBMITTED,
  };
}

type FakeOwner =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "owned"; lineUserId: string; sessionKey: string };

function journeyStub(
  state: GuidedJourneyState,
  owner: FakeOwner = {
    kind: "owned",
    lineUserId: OWNER_USER,
    sessionKey: CONTEXT.sessionKey,
  },
) {
  return {
    resolve: async () => state,
    findRoundOwner: async () => owner,
  } as unknown as GuidedJourneyService;
}

/** Runs one slip-open header and reports whether the legacy open was reached. */
async function openWith(input: {
  text: string;
  userId?: string;
  journey: GuidedJourneyService;
  assigned?: boolean;
}): Promise<{ opened: boolean; replies: string[] }> {
  const replies: string[] = [];
  let opened = false;
  const slipSessionService: SlipSessionIngestor = {
    async findActiveSession() { return null; },
    async openSession() {
      opened = true;
      return { opened: true, batchId: "batch-1" };
    },
  };

  const service = new WebhookService(supabaseStub(), {
    slipSessionService,
    guidedJourneyService: input.journey,
    guidedMenuStateService: {
      isActiveSellerMarket: async () => input.assigned ?? true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    async replyMessage(_token: string, text: string) { replies.push(text); },
  });

  await service.processEvents([textEvent(input.text, input.userId)], "dest");
  return { opened, replies };
}

const GUIDED_HEADER = buildSlipHeaderTemplate(CONTEXT)!;

describe("guided slip open at the webhook boundary", () => {
  it("opens the batch for the round's own operator", async () => {
    const result = await openWith({
      text: GUIDED_HEADER,
      journey: journeyStub(stageState("slips")),
    });
    expect(result.opened).toBe(true);
    expect(result.replies[0]).toContain("เปิดชุดสลิปเงินโอนแล้ว");
  });

  it("creates no batch when another operator copies the header", async () => {
    const result = await openWith({
      text: GUIDED_HEADER,
      userId: "U-other",
      journey: journeyStub(
        { stage: "idle", reason: "no_session" },
        { kind: "owned", lineUserId: OWNER_USER, sessionKey: CONTEXT.sessionKey },
      ),
    });
    expect(result.opened).toBe(false);
    expect(result.replies[0]).toContain("เป็นของผู้ใช้อีกคน");
    expect(result.replies[0]).toContain("ระบบยังไม่ได้บันทึกอะไร");
  });

  it("creates no batch for an edited market", async () => {
    const result = await openWith({
      text: GUIDED_HEADER.replace(MARKET, "หน้าเซเวน"),
      journey: journeyStub(stageState("slips")),
    });
    expect(result.opened).toBe(false);
    expect(result.replies[0]).toContain("ไม่ตรงกับรอบที่เปิดอยู่");
  });

  it("creates no batch for an edited seller", async () => {
    const result = await openWith({
      text: GUIDED_HEADER.replace(SELLER, "คนอื่น"),
      journey: journeyStub(stageState("slips")),
    });
    expect(result.opened).toBe(false);
  });

  it("creates no batch for an edited date", async () => {
    const result = await openWith({
      text: GUIDED_HEADER.replace("29/07/2569", "28/07/2569"),
      journey: journeyStub(stageState("slips")),
    });
    expect(result.opened).toBe(false);
  });

  it("creates no batch for a malformed, missing or impossible recognized date", async () => {
    for (const badDate of ["29-07-2569", "ไม่ระบุ", "32/13/2569"]) {
      const result = await openWith({
        text: GUIDED_HEADER.replace("29/07/2569", badDate),
        journey: journeyStub(stageState("slips")),
      });
      expect(result.opened).toBe(false);
      expect(result.replies[0]).toContain("วันที่");
    }
  });

  it("creates no batch when the seller-market assignment was revoked", async () => {
    const result = await openWith({
      text: GUIDED_HEADER,
      journey: journeyStub(stageState("slips")),
      assigned: false,
    });
    expect(result.opened).toBe(false);
    expect(result.replies[0]).toContain("ไม่ได้ผูกกันในระบบแล้ว");
  });

  it("creates no batch before the white sheet is submitted", async () => {
    const result = await openWith({
      text: GUIDED_HEADER,
      journey: journeyStub({
        stage: "white_sheet",
        context: CONTEXT,
        session: { session_key: CONTEXT.sessionKey } as never,
        whiteSheet: { status: "not_submitted" },
      }),
    });
    expect(result.opened).toBe(false);
    expect(result.replies[0]).toContain("ยังไม่ได้บันทึกใบขาว");
  });

  it("creates no batch while produce finalization is unproven", async () => {
    for (const stage of ["finalizing", "finalize_failed"] as const) {
      const result = await openWith({
        text: GUIDED_HEADER,
        journey: journeyStub({
          stage,
          context: CONTEXT,
          session: { session_key: CONTEXT.sessionKey } as never,
          whiteSheet: { status: "not_submitted" },
        }),
      });
      expect(result.opened).toBe(false);
    }
  });

  it("still opens a legacy batch that no guided round owns", async () => {
    const result = await openWith({
      text: "ใครก็ได้ ตลาดอื่น สลิปเงินโอน 29/07/2569",
      userId: "U-legacy",
      journey: journeyStub({ stage: "idle", reason: "no_session" }, { kind: "none" }),
    });
    expect(result.opened).toBe(true);
    expect(result.replies[0]).toContain("เปิดชุดสลิปเงินโอนแล้ว");
  });

  it("is idempotent across a duplicate delivery of the same refusal", async () => {
    const journey = journeyStub(stageState("slips"));
    const first = await openWith({
      text: GUIDED_HEADER.replace(MARKET, "หน้าเซเวน"),
      journey,
    });
    const second = await openWith({
      text: GUIDED_HEADER.replace(MARKET, "หน้าเซเวน"),
      journey,
    });
    expect(first.opened).toBe(false);
    expect(second.opened).toBe(false);
    expect(second.replies[0]).toBe(first.replies[0]);
  });
});
