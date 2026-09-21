/**
 * Sold-out safety: "no return row means sold out" is only true when nothing is
 * known to be missing.
 *
 * Production 2026-08-10 held all four states at once and Daily Sales called
 * three of them sold out. The withdrawal arithmetic is untouched — only the
 * confident sold-out reading is withdrawn, and only for a round whose return
 * evidence is provably unfinished.
 */
import { describe, expect, test } from "bun:test";
import {
  calculateSalesReport,
  isSoldOutByAbsentReturn,
  salesRoundMarketKey,
  type SalesSourceRow,
} from "./calculate";
import { centralPriceMapKey } from "@/lib/white-sheet/pricing";

const LANNA = "d96d2898-43f7-4eeb-9477-5e8b942da477";
const SAP_PHUN = "b0e8b69f-69b0-4af4-98ea-522bcd051d38";

const row = (overrides: Partial<SalesSourceRow>): SalesSourceRow => ({
  sourceId: "G-1",
  accountabilityRoundId: LANNA,
  marketName: "ทุ่งลานนา",
  sessionId: "session-1",
  sessionKind: "main",
  productName: "หมอนทอง",
  unit: "โล",
  quantity: 10,
  transactionType: "เบิก",
  ...overrides,
});

const prices = new Map([[centralPriceMapKey("หมอนทอง", "โล"), 10_000]]);

describe("round identity in Daily Sales", () => {
  test("Test 7 — a return filed under the alias label matches its withdrawal", () => {
    const report = calculateSalesReport({
      businessDate: "2026-08-10",
      centralPrices: prices,
      roundMarketLabels: new Map([[LANNA, "ทุ่งลานนา"]]),
      rows: [
        row({ transactionType: "เบิก", quantity: 20 }),
        row({ marketName: "วัดทุ่งลานนา", transactionType: "คืน", quantity: 7, sessionId: "session-2" }),
        row({ marketName: "วัดทุ่งลานนา", transactionType: "คืนเสีย", quantity: 3, sessionId: "session-3" }),
      ],
    });

    expect(report.markets).toHaveLength(1);
    expect(report.markets[0]!.marketKey).toBe(salesRoundMarketKey(LANNA));
    expect(report.markets[0]!.marketLabel).toBe("ทุ่งลานนา");
    expect(report.blocked).toEqual([]);
    expect(report.markets[0]!.rows[0]).toMatchObject({
      withdrawnQuantity: 20,
      goodReturnQuantity: 7,
      damagedReturnQuantity: 3,
      soldQuantity: 10,
      status: "TRUSTED",
    });
  });

  test("without the round the same rows split into two markets and block", () => {
    const report = calculateSalesReport({
      businessDate: "2026-08-10",
      centralPrices: prices,
      rows: [
        row({ accountabilityRoundId: null, transactionType: "เบิก", quantity: 20 }),
        row({ accountabilityRoundId: null, marketName: "วัดทุ่งลานนา", transactionType: "คืน", quantity: 7 }),
      ],
    });
    expect(report.markets).toHaveLength(2);
    expect(report.blocked.map((item) => item.reasons).flat()).toContain("return_without_withdrawal");
  });

  test("legacy rows with no round keep the (source + label) identity", () => {
    const report = calculateSalesReport({
      businessDate: "2026-08-10",
      centralPrices: prices,
      rows: [
        row({ accountabilityRoundId: null, transactionType: "เบิก", quantity: 20 }),
        row({ accountabilityRoundId: null, transactionType: "คืน", quantity: 5 }),
      ],
    });
    expect(report.markets).toHaveLength(1);
    expect(report.markets[0]!.marketKey).toContain("G-1");
    expect(report.markets[0]!.rows[0]!.soldQuantity).toBe(15);
  });
});

describe("sold-out inference", () => {
  const soldOutRows = [row({ transactionType: "เบิก", quantity: 20 })];

  test("Test 3 — a withdrawal with no return evidence is still sold out", () => {
    const report = calculateSalesReport({
      businessDate: "2026-08-10",
      centralPrices: prices,
      rows: soldOutRows,
    });
    expect(report.markets[0]!.rows[0]!.status).toBe("TRUSTED");
    expect(isSoldOutByAbsentReturn(report.markets[0]!.rows[0]!)).toBe(true);
  });

  test("Test 4 — a blocked return is NOT sold out and keeps provisional money", () => {
    const report = calculateSalesReport({
      businessDate: "2026-08-10",
      centralPrices: prices,
      rows: [row({ accountabilityRoundId: SAP_PHUN, marketName: "ทรัพย์พัน2", transactionType: "เบิก", quantity: 33 })],
      incompleteReturnRounds: new Set([SAP_PHUN]),
    });
    const identity = report.markets[0]!.rows[0]!;

    expect(isSoldOutByAbsentReturn(identity)).toBe(false);
    // The withdrawal value stays visible, but return uncertainty means neither
    // sold quantity nor money is confirmed yet.
    expect(identity).toMatchObject({
      withdrawnQuantity: 33,
      soldQuantity: null,
      status: "QUANTITY_BLOCKED",
      valueStatus: "PENDING_REVIEW",
      expectedSalesSatang: null,
      pendingReviewSalesSatang: 330_000,
    });
  });

  test("Test 5 — a pending return is NOT sold out either", () => {
    const report = calculateSalesReport({
      businessDate: "2026-08-10",
      centralPrices: prices,
      rows: soldOutRows,
      incompleteReturnRounds: new Set([LANNA]),
    });
    expect(isSoldOutByAbsentReturn(report.markets[0]!.rows[0]!)).toBe(false);
  });

  test("an unrelated round's incomplete return never demotes this one", () => {
    const report = calculateSalesReport({
      businessDate: "2026-08-10",
      centralPrices: prices,
      rows: soldOutRows,
      incompleteReturnRounds: new Set([SAP_PHUN]),
    });
    expect(isSoldOutByAbsentReturn(report.markets[0]!.rows[0]!)).toBe(true);
  });

  test("a legacy row carries no round, so the guard cannot reach it", () => {
    const report = calculateSalesReport({
      businessDate: "2026-08-10",
      centralPrices: prices,
      rows: [row({ accountabilityRoundId: null, transactionType: "เบิก", quantity: 20 })],
      incompleteReturnRounds: new Set([LANNA]),
    });
    expect(isSoldOutByAbsentReturn(report.markets[0]!.rows[0]!)).toBe(true);
  });

  test("a persisted return that omitted this product is not sold out", () => {
    const report = calculateSalesReport({
      businessDate: "2026-08-10",
      centralPrices: prices,
      rows: soldOutRows,
      persistedReturnRounds: new Set([LANNA]),
    });
    const identity = report.markets[0]!.rows[0]!;
    expect(identity.status).toBe("QUANTITY_BLOCKED");
    expect(identity.reasons).toContain("product_return_absent");
    expect(isSoldOutByAbsentReturn(identity)).toBe(false);
  });
});
