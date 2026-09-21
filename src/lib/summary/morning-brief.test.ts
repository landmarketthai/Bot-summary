import { describe, expect, test } from "bun:test";
import { centralPriceMapKey } from "@/lib/white-sheet/pricing";
import {
  calculateSalesReport,
  type SalesSourceRow,
  type SalesIdentityRow,
  type SalesMarketSummary,
  type SalesReport,
  type SalesTotal,
} from "@/lib/sales/calculate";
import type { PurchasePlanningItem } from "@/lib/summary/purchase-planning";
import { summarizePurchasePlanning, summarizeSales } from "./morning-brief";

function purchaseItem(status: PurchasePlanningItem["status"], productName: string): PurchasePlanningItem {
  return {
    productName,
    unit: "กก.",
    withdrawnQuantity: 1,
    goodReturnQuantity: 0,
    damagedQuantity: 0,
    estimatedSoldQuantity: status === "unknown" ? null : 1,
    sellThroughRate: status === "unknown" ? null : 100,
    band: status === "unknown" ? null : "high",
    status,
    uncertaintyReasons: [],
    houseStockQuantity: null,
    stockAbsence: null,
    nextDayGoodStockQuantity: null,
    nextStockToSoldRatio: null,
    priceConflict: false,
  };
}

function total(overrides: Partial<SalesTotal> = {}): SalesTotal {
  return {
    expectedSalesSatang: 2_174_074,
    pendingReviewSalesSatang: 72_000,
    totalSalesSatang: 2_246_074,
    adjustmentSatang: -1_000,
    quantityAuthoritative: false,
    valueAuthoritative: false,
    trustedRowCount: 77,
    valueBlockedRowCount: 7,
    quantityBlockedRowCount: 100,
    ...overrides,
  };
}

function salesRow(overrides: Partial<SalesIdentityRow> = {}): SalesIdentityRow {
  return {
    marketKey: "market-a",
    marketLabel: "ตลาดเอ",
    sourceId: "source-a",
    businessDate: "2026-08-27",
    productName: "สินค้า",
    unit: "กก.",
    withdrawnQuantity: 10,
    goodReturnQuantity: 0,
    damagedReturnQuantity: 0,
    soldQuantity: 10,
    enteredPriceSatang: 1000,
    centralPriceSatang: 1000,
    expectedSalesSatang: 10_000,
    pendingReviewSalesSatang: null,
    adjustmentSatang: 0,
    valueStatus: "CONFIRMED",
    status: "TRUSTED",
    reasons: [],
    ...overrides,
  };
}

function market(marketKey: string, rows: SalesIdentityRow[]): SalesMarketSummary {
  return { marketKey, marketLabel: rows[0]?.marketLabel ?? marketKey, rows, total: total() };
}

function salesReport(markets: SalesMarketSummary[]): SalesReport {
  const rows = markets.flatMap((entry) => entry.rows);
  return {
    businessDate: "2026-08-27",
    markets,
    products: [],
    allMarkets: total(),
    blocked: rows.filter((row) => row.status !== "TRUSTED"),
    scopeBlockers: [],
  };
}

describe("summarizePurchasePlanning", () => {
  test("keeps every classified item, including unknown details", () => {
    const strong = Array.from({ length: 14 }, (_, index) => purchaseItem("strong", `ซื้อ-${index + 1}`));
    const unknown = Array.from({ length: 88 }, (_, index) => purchaseItem("unknown", `ไม่รู้-${index + 1}`));
    unknown[0]!.uncertaintyReasons = ["return_incomplete"];
    const summary = summarizePurchasePlanning({ items: [...strong, ...unknown] });
    expect(summary.strong.count).toBe(14);
    expect(summary.strong.productNames).toEqual(strong.map((item) => item.productName));
    expect(summary.strong.items).toHaveLength(14);
    expect(summary.unknown.count).toBe(88);
    expect(summary.unknown.productNames).toEqual(unknown.map((item) => item.productName));
    expect(summary.unknown.items?.[0]?.uncertaintyReasons).toEqual(["return_incomplete"]);
  });
});

describe("summarizeSales", () => {
  test("copies SalesReport totals and uses isSoldOutByAbsentReturn semantics", () => {
    const soldOut = salesRow();
    const incompleteReturn = salesRow({
      productName: "หลักฐานคืนไม่ครบ",
      returnEvidenceIncomplete: true,
    });
    const conflictA = salesRow({
      productName: "ขัดแย้งเอ",
      status: "VALUE_BLOCKED",
      valueStatus: "PENDING_REVIEW",
      expectedSalesSatang: null,
      pendingReviewSalesSatang: 10_000,
      centralPriceSatang: null,
      reasons: ["central_price_conflict"],
    });
    const conflictB = salesRow({
      marketKey: "market-b",
      marketLabel: "ตลาดบี",
      productName: "ขัดแย้งบี",
      status: "QUANTITY_BLOCKED",
      valueStatus: "UNAVAILABLE",
      soldQuantity: null,
      expectedSalesSatang: null,
      pendingReviewSalesSatang: null,
      centralPriceSatang: null,
      reasons: ["central_price_conflict"],
    });
    const report = salesReport([
      market("market-a", [soldOut, incompleteReturn, conflictA]),
      market("market-b", [conflictB]),
    ]);

    expect(summarizeSales(report)).toEqual({
      totalSalesSatang: 2_246_074,
      confirmedSalesSatang: 2_174_074,
      pendingReviewSalesSatang: 72_000,
      adjustmentSatang: -1_000,
      valueAuthoritative: false,
      trustedCount: 77,
      unresolvedCount: 107,
      soldOutCount: 2,
      markets: [
        { marketLabel: "\u0e15\u0e25\u0e32\u0e14\u0e40\u0e2d", totalSalesSatang: 2_246_074, confirmedSalesSatang: 2_174_074, pendingReviewSalesSatang: 72_000, adjustmentSatang: -1_000, valueAuthoritative: false, trustedCount: 77, unresolvedCount: 107, soldOutCount: 2, priceIssueCount: 1, incompleteReturnIssueCount: 1, excludedFromSalesCount: 0 },
        { marketLabel: "\u0e15\u0e25\u0e32\u0e14\u0e1a\u0e35", totalSalesSatang: 2_246_074, confirmedSalesSatang: 2_174_074, pendingReviewSalesSatang: 72_000, adjustmentSatang: -1_000, valueAuthoritative: false, trustedCount: 77, unresolvedCount: 107, soldOutCount: 0, priceIssueCount: 1, incompleteReturnIssueCount: 0, excludedFromSalesCount: 1 },
      ],
      priceConflictCount: 2,
      priceConflictMarketCount: 2,
      priceIssueCount: 2,
      incompleteReturnIssueCount: 1,
      excludedFromSalesCount: 1,
      reviewItems: [
        { marketLabel: "ตลาดเอ", productName: "หลักฐานคืนไม่ครบ", unit: "กก.", status: "TRUSTED", valueStatus: "CONFIRMED", reasons: [], soldQuantity: 10, enteredPriceSatang: 1000, centralPriceSatang: 1000, confirmedSalesSatang: 10_000, pendingReviewSalesSatang: null, adjustmentSatang: 0, returnEvidenceIncomplete: true },
        { marketLabel: "ตลาดเอ", productName: "ขัดแย้งเอ", unit: "กก.", status: "VALUE_BLOCKED", valueStatus: "PENDING_REVIEW", reasons: ["central_price_conflict"], soldQuantity: 10, enteredPriceSatang: 1000, centralPriceSatang: null, confirmedSalesSatang: null, pendingReviewSalesSatang: 10_000, adjustmentSatang: 0, returnEvidenceIncomplete: false },
        { marketLabel: "ตลาดบี", productName: "ขัดแย้งบี", unit: "กก.", status: "QUANTITY_BLOCKED", valueStatus: "UNAVAILABLE", reasons: ["central_price_conflict"], soldQuantity: null, enteredPriceSatang: 1000, centralPriceSatang: null, confirmedSalesSatang: null, pendingReviewSalesSatang: null, adjustmentSatang: 0, returnEvidenceIncomplete: false },
      ],
    });
  });

  test("P5: product_return_absent is counted as a return issue and its provisional value remains visible", () => {
    const sourceRow = (overrides: Partial<SalesSourceRow> = {}): SalesSourceRow => ({
      sourceId: "Csrc",
      marketName: "ตลาดเอ",
      sessionId: "s-main",
      sessionKind: "main",
      accountabilityRoundId: "round-1",
      productName: "หมอนทอง",
      unit: "โล",
      quantity: 10,
      transactionType: "เบิก",
      enteredPriceSatang: 12_000,
      ...overrides,
    });
    const report = calculateSalesReport({
      businessDate: "2026-09-20",
      rows: [
        sourceRow(),
        sourceRow({ productName: "มังคุด", quantity: 5, enteredPriceSatang: 5_000 }),
        sourceRow({ productName: "มังคุด", quantity: 1, transactionType: "คืน", sessionId: "s-ret", enteredPriceSatang: null }),
      ],
      centralPrices: new Map([
        [centralPriceMapKey("หมอนทอง", "โล"), 12_000],
        [centralPriceMapKey("มังคุด", "โล"), 5_000],
      ]),
      persistedReturnRounds: new Set(["round-1"]),
    });

    const summary = summarizeSales(report);
    expect(summary.incompleteReturnIssueCount).toBe(1);
    expect(summary.pendingReviewSalesSatang).toBe(120_000);
    expect(summary.confirmedSalesSatang).toBe(20_000);
    expect(summary.totalSalesSatang).toBe(140_000);
    expect(summary.excludedFromSalesCount).toBe(0);
  });
});
