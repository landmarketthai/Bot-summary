process.env.LINE_CHANNEL_SECRET ??= "test-channel-secret";

import { describe, expect, it } from "bun:test";
import { buildSettlementOcrTemplate } from "./template";
import { verifyGuidedMarker } from "@/lib/line/guided-menu/provenance";
import { parseGuidedSettlementCommand } from "@/lib/line/guided-menu/settlement-command";
import type { GuidedJourneyContext } from "@/lib/line/guided-menu/journey";

const context: GuidedJourneyContext = {
  accountabilityRoundId: "round-1",
  sessionKey: "group:g1:user:submitter",
  sourceId: "g1",
  lineUserId: "submitter",
  sellerLabel: "กี้",
  marketLabel: "วัดทุ่งลานนา",
  marketLabelNormalized: "วัดทุ่งลานนา",
  businessDate: "2026-09-21",
  transactionType: "เบิก",
  sessionGeneration: "gen-1",
};

const amounts = { moneyTransfer: 2123, moneyCash: 2250, expenses: 200, labor: 550 };

describe("buildSettlementOcrTemplate", () => {
  it("produces a template the existing guided-settlement parser accepts, with the OCR amounts", () => {
    const template = buildSettlementOcrTemplate(context, amounts)!;
    const strippedOfMarker = template.split("\n").filter((l) => !l.startsWith("#gp1.")).join("\n");
    const parsed = parseGuidedSettlementCommand(strippedOfMarker);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.command).toMatchObject({
        subject: "กี้ วัดทุ่งลานนา",
        businessDate: "2026-09-21",
        moneyTransfer: 2123,
        moneyCash: 2250,
        expenses: 200,
        labor: 550,
      });
    }
  });

  it("returns null when the round's business date cannot be rendered", () => {
    const badContext = { ...context, businessDate: "not-a-date" };
    expect(buildSettlementOcrTemplate(badContext, amounts)).toBeNull();
  });

  it("signs a marker that verifies for the photo submitter", () => {
    const template = buildSettlementOcrTemplate(context, amounts)!;
    const markerLine = template.split("\n").find((l) => l.startsWith("#gp1."))!;
    expect(markerLine).toBeTruthy();

    expect(
      verifyGuidedMarker(markerLine, {
        purpose: "settlement",
        sourceId: context.sourceId,
        lineUserId: context.lineUserId,
        marketLabelNormalized: context.marketLabelNormalized,
        businessDate: context.businessDate,
        sessionGeneration: context.sessionGeneration,
      }),
    ).toBe(true);
  });

  it("does NOT verify for a different LINE user — a non-submitter cannot confirm this draft", () => {
    const template = buildSettlementOcrTemplate(context, amounts)!;
    const markerLine = template.split("\n").find((l) => l.startsWith("#gp1."))!;

    expect(
      verifyGuidedMarker(markerLine, {
        purpose: "settlement",
        sourceId: context.sourceId,
        lineUserId: "someone-else",
        marketLabelNormalized: context.marketLabelNormalized,
        businessDate: context.businessDate,
        sessionGeneration: context.sessionGeneration,
      }),
    ).toBe(false);
  });
});
