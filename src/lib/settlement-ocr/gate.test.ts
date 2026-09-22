import { describe, expect, it } from "bun:test";
import { isAwaitingSettlementSubmission } from "./gate";
import type { GuidedJourneyContext, GuidedJourneyState } from "@/lib/line/guided-menu/journey";

const context: GuidedJourneyContext = {
  accountabilityRoundId: "round-1",
  sessionKey: "group:g1:user:u1",
  sourceId: "g1",
  lineUserId: "u1",
  sellerLabel: "กี้",
  marketLabel: "วัดทุ่งลานนา",
  marketLabelNormalized: "วัดทุ่งลานนา",
  businessDate: "2026-09-21",
  transactionType: "เบิก",
  sessionGeneration: "gen-1",
};

function stateWithStage(stage: GuidedJourneyState["stage"]): GuidedJourneyState {
  if (stage === "idle") return { stage: "idle", reason: "no_session" };
  return {
    stage,
    context,
    // Only .stage is read by the gate; the rest are unused fixtures.
    session: {} as never,
    whiteSheet: { status: "submitted", expenses: {
      labor: 0, locationFee: 0, bag: 0, snack: 0, other: 0,
    }, actualCashSubmitted: 0, updatedAt: "2026-09-21T00:00:00Z" },
  };
}

describe("isAwaitingSettlementSubmission", () => {
  it("is true once the white sheet is submitted and slips are being collected", () => {
    expect(isAwaitingSettlementSubmission(stateWithStage("slips"))).toBe(true);
  });

  it("is true once slips are collected and the round is ready to reconcile", () => {
    expect(isAwaitingSettlementSubmission(stateWithStage("reconcile"))).toBe(true);
  });

  it("is false with no guided round at all — an ordinary photo is never hijacked", () => {
    expect(isAwaitingSettlementSubmission(stateWithStage("idle"))).toBe(false);
  });

  it("is false before the white sheet has been submitted", () => {
    expect(isAwaitingSettlementSubmission(stateWithStage("white_sheet"))).toBe(false);
  });

  it("is false while still capturing produce or awaiting its own confirmation", () => {
    expect(isAwaitingSettlementSubmission(stateWithStage("capture"))).toBe(false);
    expect(isAwaitingSettlementSubmission(stateWithStage("awaiting_confirm"))).toBe(false);
  });

  it("is false while produce finalization is in flight or has failed", () => {
    expect(isAwaitingSettlementSubmission(stateWithStage("finalizing"))).toBe(false);
    expect(isAwaitingSettlementSubmission(stateWithStage("finalize_failed"))).toBe(false);
  });
});
