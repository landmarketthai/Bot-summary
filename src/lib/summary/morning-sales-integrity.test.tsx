import React from "react";
import { describe, expect, test } from "bun:test";
import { renderToBuffer } from "@react-pdf/renderer";
import { calculateSalesReport, type SalesSourceRow } from "@/lib/sales/calculate";
import { summarizeProduceFinancial } from "./morning-brief-service";
import { summarizeSales, type MorningBriefReport } from "./morning-brief";
import { MorningBriefA4Doc } from "@/lib/pdf/MorningBriefA4Doc";
import { registerFonts } from "@/lib/pdf/fonts";
import { buildMorningBriefMessage } from "./morning-brief-message";

// Representative quantities reproduce the supplied totals; the original 26 lines were not supplied.
const withdrawal: SalesSourceRow = {
  sourceId: "C-pasio", accountabilityRoundId: "round-pasio-20261019",
  marketName: "พาซิโอ้ผลไม้", sessionId: "withdrawal", sessionKind: "main",
  productName: "มังคุด", unit: "โล", quantity: 968.775,
  transactionType: "เบิก", enteredPriceSatang: 2000,
};
const returned: SalesSourceRow = { ...withdrawal, sessionId: "return", quantity: 686.25, transactionType: "คืน" };
function build(rows: SalesSourceRow[], incomplete = false): MorningBriefReport {
  const sales = calculateSalesReport({ businessDate: "2026-10-19", rows,
    requireReturnEvidence: true,
    incompleteReturnRounds: incomplete ? new Set([withdrawal.accountabilityRoundId!]) : undefined });
  const houseStock = { status: "missing" } as const;
  const fruit = summarizeProduceFinancial(sales, houseStock, "fruit");
  return { businessDate: "2026-10-19", sales: summarizeSales(sales), houseStock,
    produceFinancial: { fruit }, fruitFinancial: fruit,
    purchasePlanning: { strong: { count: 0, productNames: [] }, surplus: { count: 0, productNames: [] },
      reduce: { count: 0, productNames: [] }, unknown: { count: 0, productNames: [] } } };
}
function text(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    if (typeof node.type === "function") return text((node.type as (props: unknown) => React.ReactNode)(node.props));
    return text(node.props.children);
  }
  return "";
}
const generatedAt = new Date("2026-10-20T08:05:00+07:00");

describe("19 October Morning Brief integrity", () => {
  test("withdrawal without return is unavailable on cover, details and LINE", () => {
    const report = build([withdrawal]);
    expect(report.sales.confirmedSalesSatang).toBe(0);
    expect(report.sales.totalSalesSatang).toBe(0);
    expect(report.sales.awaitingReturnCount).toBe(1);
    expect(report.sales.excludedFromSalesCount).toBe(1);
    expect(report.fruitFinancial!.withdrawalValueSatang).toBe(1_937_550);
    expect(report.fruitFinancial!.salesValueSatang).toBe(0);
    const contents = text(MorningBriefA4Doc({ report, generatedAt })).replace(/\s+/g, " ");
    expect(contents).toContain("ยอดขายยืนยันแล้ว");
    expect(contents).toContain("รอชั่งคืน");
    expect(contents).toContain("ยังไม่คำนวณ 1 รายการ");
    expect(contents).not.toContain("ยอดขายยืนยันแล้ว 19,375.50");
    const line = buildMorningBriefMessage(report);
    expect(line).toContain("ยอดขายยืนยันแล้ว 0.00 บาท");
    expect(line).toContain("รอชั่งคืน 1 รายการ");
  });

  test("late complete return recalculates 5,650.50 without reusing the 08:05 total", async () => {
    const morning = build([withdrawal]);
    const after = build([withdrawal, returned]);
    expect(morning.sales.confirmedSalesSatang).toBe(0);
    expect(after.sales.confirmedSalesSatang).toBe(565_050);
    expect(after.sales.pendingReviewSalesSatang).toBe(0);
    expect(after.sales.totalSalesSatang).toBe(565_050);
    expect(after.fruitFinancial!.goodReturnValueSatang).toBe(1_372_500);
    expect(after.fruitFinancial!.salesValueSatang).toBe(565_050);
    expect(after.sales.markets![0].confirmedSalesSatang).toBe(565_050);
    expect(after.sales.awaitingReturnCount).toBe(0);
    const doc = MorningBriefA4Doc({ report: after, generatedAt });
    expect(text(doc)).toContain("5,650.50");
    registerFonts();
    const bytes = await renderToBuffer(doc);
    expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
  });

  test("confirmed, pending review and unavailable markets never enter each other's totals", () => {
    const other = (sourceId: string, transactionType: string, quantity: number): SalesSourceRow => ({
      ...withdrawal, sourceId, accountabilityRoundId: sourceId, marketName: sourceId,
      sessionId: `${sourceId}-${transactionType}`, quantity, transactionType,
    });
    const report = build([withdrawal, returned, other("ตลาดครบ", "เบิก", 10),
      other("ตลาดครบ", "คืน", 4), other("ตลาดรอ", "เบิก", 30)], true);
    expect(report.sales.confirmedSalesSatang).toBe(12_000);
    expect(report.sales.pendingReviewSalesSatang).toBe(565_050);
    expect(report.sales.excludedFromSalesCount).toBe(1);
    expect(report.sales.totalSalesSatang).toBe(577_050);
    expect(report.fruitFinancial!.salesValueSatang).toBe(12_000);
    expect(report.fruitFinancial!.pendingReviewSalesSatang).toBe(565_050);
  });

  test("an explicit zero return confirms sold-out; missing legacy return remains unavailable", () => {
    expect(build([withdrawal, { ...returned, quantity: 0 }]).sales.confirmedSalesSatang).toBe(1_937_550);
    expect(build([{ ...withdrawal, accountabilityRoundId: null }]).sales.confirmedSalesSatang).toBe(0);
  });
});
