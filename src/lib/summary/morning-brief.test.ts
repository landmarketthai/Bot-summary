import { describe, expect, test } from "bun:test";
import type {
  SalesIdentityRow,
  SalesMarketSummary,
  SalesReport,
  SalesTotal,
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
    centralPriceSatang: 1000,
    expectedSalesSatang: 10_000,
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
      expectedSalesSatang: null,
      centralPriceSatang: null,
      reasons: ["central_price_conflict"],
    });
    const conflictB = salesRow({
      marketKey: "market-b",
      marketLabel: "ตลาดบี",
      productName: "ขัดแย้งบี",
      status: "QUANTITY_BLOCKED",
      soldQuantity: null,
      expectedSalesSatang: null,
      centralPriceSatang: null,
      reasons: ["central_price_conflict"],
    });
    const report = salesReport([
      market("market-a", [soldOut, incompleteReturn, conflictA]),
      market("market-b", [conflictB]),
    ]);

    expect(summarizeSales(report)).toEqual({
      confirmedSalesSatang: 2_174_074,
      valueAuthoritative: false,
      trustedCount: 77,
      unresolvedCount: 107,
      soldOutCount: 2,
      priceConflictCount: 2,
      priceConflictMarketCount: 2,
      reviewItems: [
        { marketLabel: "ตลาดเอ", productName: "ขัดแย้งเอ", unit: "กก.", status: "VALUE_BLOCKED", reasons: ["central_price_conflict"] },
        { marketLabel: "ตลาดบี", productName: "ขัดแย้งบี", unit: "กก.", status: "QUANTITY_BLOCKED", reasons: ["central_price_conflict"] },
      ],
    });
  });
});
