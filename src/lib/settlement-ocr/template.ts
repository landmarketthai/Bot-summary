/**
 * Builds the SAME guided "ส่งยอด" template parseGuidedSettlementCommand
 * already accepts (src/lib/line/guided-menu/settlement-command.ts), pre-
 * filled with the OCR-read amounts instead of zero.
 *
 * This is the entire "confirm/correct" mechanism for OCR drafts: the reply
 * asks the operator to review the numbers and send this exact text back
 * (editing any wrong figure first). Sending it re-enters the EXISTING
 * isGuidedSettlementCommandText / processGuidedSettlementSubmission /
 * submitSettlementEntryForSource pipeline unchanged — no new write path,
 * no new arithmetic, no new ownership logic.
 *
 * The guided marker (withGuidedMarker) is signed for the round owner's own
 * lineUserId (context.lineUserId, which resolve() in journey.ts guarantees
 * equals the photo sender — see gate.ts). A different LINE user sending or
 * editing this exact text fails verifyGuidedMarker on the receiving end
 * (ownership-guard.ts) and is refused — this is what makes "only the
 * submitting user may confirm" hold without any new authorization code.
 */

import { thaiDateFromIso, type GuidedJourneyContext } from "@/lib/line/guided-menu/journey";
import { withGuidedMarker } from "@/lib/line/guided-menu/provenance";

function fmtAmount(value: number): string {
  // Plain, parser-compatible formatting (parseCloseMoneyAmount accepts a
  // bare decimal) — never locale-grouped, so the template round-trips.
  return (Math.round(value * 100) / 100).toString();
}

export function buildSettlementOcrTemplate(
  context: GuidedJourneyContext,
  amounts: {
    moneyTransfer: number;
    moneyCash: number;
    expenses: number;
    labor: number;
  },
): string | null {
  const thaiDate = thaiDateFromIso(context.businessDate);
  if (!thaiDate) return null;

  const template = [
    `${context.sellerLabel} ${context.marketLabel} ส่งยอด ${thaiDate}`,
    `ยอดโอน ${fmtAmount(amounts.moneyTransfer)}`,
    `เงินสด ${fmtAmount(amounts.moneyCash)}`,
    `ค่าใช้จ่าย ${fmtAmount(amounts.expenses)}`,
    `ค่าแรง ${fmtAmount(amounts.labor)}`,
    "จบส่งยอด",
  ].join("\n");

  return withGuidedMarker(template, {
    purpose: "settlement",
    sourceId: context.sourceId,
    lineUserId: context.lineUserId,
    marketLabelNormalized: context.marketLabelNormalized,
    businessDate: context.businessDate,
    sessionGeneration: context.sessionGeneration,
  });
}
