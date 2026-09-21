import { describe, expect, test } from "bun:test";
import { centralPriceMapKey } from "@/lib/white-sheet/pricing";
import {
  calculateSalesReport,
  isSoldOutByAbsentReturn,
  salesMarketKey,
  satangToBahtText,
  type SalesIdentityRow,
  type SalesReport,
  type SalesSourceRow,
} from "./calculate";

const DATE = "2026-07-25";
const SOURCE_A = "Csource000000aaaaaa";
const SOURCE_B = "Csource000000bbbbbb";
const MARKET_A = "ตลาดกี้";
const MARKET_B = "ตลาดน้อย";

const TX_WITHDRAW = "เบิก";
const TX_WITHDRAW_MORE = "เบิกเพิ่ม";
const TX_RETURN = "คืน";
const TX_RETURN_MORE = "ชั่งคืนเพิ่ม";
const TX_DAMAGED = "คืนเสีย";
const TX_DAMAGED_LEGACY = "เสีย";

function row(overrides: Partial<SalesSourceRow> = {}): SalesSourceRow {
  return {
    sourceId: SOURCE_A,
    marketName: MARKET_A,
    sessionId: "session-main",
    sessionKind: "main",
    productName: "หมอนทอง",
    unit: "โล",
    quantity: 0,
    transactionType: TX_WITHDRAW,
    ...overrides,
  };
}

function prices(entries: Array<[string, string, number]>): Map<string, number> {
  return new Map(entries.map(([product, unit, satang]) => [centralPriceMapKey(product, unit), satang]));
}

function build(
  rows: readonly SalesSourceRow[],
  options: Partial<Parameters<typeof calculateSalesReport>[0]> = {},
): SalesReport {
  return calculateSalesReport({ businessDate: DATE, rows, ...options });
}

function onlyRow(report: SalesReport): SalesIdentityRow {
  const rows = report.markets.flatMap((market) => market.rows);
  expect(rows).toHaveLength(1);
  return rows[0];
}

const DURIAN_PRICE = prices([["หมอนทอง", "โล", 12_000]]);

// ── Core formula ────────────────────────────────────────────────────────────

describe("P1 sold quantity — W − R − D", () => {
  test("sold quantity is withdrawal minus good return minus damage", () => {
    const report = build(
      [
        row({ quantity: 100, transactionType: TX_WITHDRAW }),
        row({ quantity: 20, transactionType: TX_RETURN }),
        row({ quantity: 5, transactionType: TX_DAMAGED }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.withdrawnQuantity).toBe(100);
    expect(result.goodReturnQuantity).toBe(20);
    expect(result.damagedReturnQuantity).toBe(5);
    expect(result.soldQuantity).toBe(75);
    expect(result.status).toBe("TRUSTED");
  });

  test("a good return alone reduces sold quantity", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(onlyRow(report).soldQuantity).toBe(6);
  });

  test("a damaged return reduces sold quantity and never counts as sellable", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
        row({ quantity: 3, transactionType: TX_DAMAGED }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(onlyRow(report).soldQuantity).toBe(3);
  });

  test("the legacy เสีย spelling is damage, not an unknown type", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
        row({ quantity: 1, transactionType: TX_DAMAGED_LEGACY }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.damagedReturnQuantity).toBe(1);
    expect(result.soldQuantity).toBe(5);
    expect(result.status).toBe("TRUSTED");
  });

  test("everything returned is a trusted zero, not a missing result", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 10, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.soldQuantity).toBe(0);
    expect(result.expectedSalesSatang).toBe(0);
    expect(result.status).toBe("TRUSTED");
    expect(report.allMarkets.valueAuthoritative).toBe(true);
  });

  test("a recorded zero good return is evidence, not missing evidence", () => {
    // "We weighed the return and nothing came back" is a closed day. It is the
    // ABSENCE of any ชั่งคืน row that blocks, never a ชั่งคืน row of zero.
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 0, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("TRUSTED");
    expect(result.soldQuantity).toBe(10);
  });

  test("a VALUE_BLOCKED quantity still counts — only its value is withheld", () => {
    const report = build([
      row({ quantity: 10, transactionType: TX_WITHDRAW }),
      row({ quantity: 4, transactionType: TX_RETURN }),
    ]);

    // No central price blocks the money, never the proven quantity.
    expect(report.products[0].soldQuantity).toBe(6);
    expect(report.products[0].total.quantityAuthoritative).toBe(true);
    expect(report.products[0].total.valueAuthoritative).toBe(false);
    expect(report.blocked[0].soldQuantity).toBe(6);
  });

  test("fractional quantities keep 3-decimal precision without float drift", () => {
    const report = build(
      [
        row({ quantity: 0.1, transactionType: TX_WITHDRAW }),
        row({ quantity: 0.2, transactionType: TX_WITHDRAW }),
        row({ quantity: 0.123, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.withdrawnQuantity).toBe(0.3);
    expect(result.soldQuantity).toBe(0.177);
  });
});

// ── No return rows means sold out ───────────────────────────────────────────

describe("P1 absence of return rows means sold out", () => {
  test("A: withdrawal only is TRUSTED with sold = withdrawal, no missing_return_evidence", () => {
    const report = build([row({ quantity: 10, transactionType: TX_WITHDRAW })], {
      centralPrices: DURIAN_PRICE,
    });

    const result = onlyRow(report);
    expect(result.status).toBe("TRUSTED");
    expect(result.soldQuantity).toBe(10);
    expect(result.reasons).not.toContain("missing_return_evidence");
    expect(result.expectedSalesSatang).toBe(120_000);
  });

  test("B: withdrawal + damaged only, sold = W - D, not blocked for missing return evidence", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 2, transactionType: TX_DAMAGED }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("TRUSTED");
    expect(result.soldQuantity).toBe(8);
    expect(result.reasons).not.toContain("missing_return_evidence");
  });

  test("C: withdrawal + good return only, sold = W - R", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 3, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(onlyRow(report).soldQuantity).toBe(7);
  });

  test("D: withdrawal + both return types, sold = W - R - D", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 3, transactionType: TX_RETURN }),
        row({ quantity: 2, transactionType: TX_DAMAGED }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(onlyRow(report).soldQuantity).toBe(5);
  });

  test("E: returns exceeding the withdrawal still quantity-block", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 6, transactionType: TX_RETURN }),
        row({ quantity: 5, transactionType: TX_DAMAGED }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.reasons).toContain("returns_exceed_withdrawal");
    expect(result.soldQuantity).toBeNull();
  });

  test("F: a return with no withdrawal still quantity-blocks", () => {
    const report = build([row({ quantity: 4, transactionType: TX_RETURN })], {
      centralPrices: DURIAN_PRICE,
    });

    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.reasons).toContain("return_without_withdrawal");
  });

  test("G: withdrawal-only row with a missing central price stays quantity-trusted", () => {
    const report = build([row({ quantity: 10, transactionType: TX_WITHDRAW })]);

    const result = onlyRow(report);
    expect(result.status).toBe("VALUE_BLOCKED");
    expect(result.reasons).toContain("missing_central_price");
    expect(result.soldQuantity).toBe(10);
    expect(result.expectedSalesSatang).toBeNull();
  });

  test("G: withdrawal-only row with a central-price conflict stays quantity-trusted", () => {
    const report = build(
      [row({ quantity: 10, transactionType: TX_WITHDRAW })],
      {
        centralPrices: DURIAN_PRICE,
        priceConflicts: new Set([centralPriceMapKey("หมอนทอง", "โล")]),
      },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("VALUE_BLOCKED");
    expect(result.reasons).toContain("central_price_conflict");
    expect(result.soldQuantity).toBe(10);
    expect(result.expectedSalesSatang).toBeNull();
  });
});

describe("isSoldOutByAbsentReturn", () => {
  test("true for a TRUSTED withdrawal-only identity", () => {
    const result = onlyRow(build([row({ quantity: 10, transactionType: TX_WITHDRAW })], {
      centralPrices: DURIAN_PRICE,
    }));
    expect(isSoldOutByAbsentReturn(result)).toBe(true);
  });

  test("true for a VALUE_BLOCKED withdrawal-only identity — quantity trust is independent of price", () => {
    const result = onlyRow(build([row({ quantity: 10, transactionType: TX_WITHDRAW })]));
    expect(result.status).toBe("VALUE_BLOCKED");
    expect(isSoldOutByAbsentReturn(result)).toBe(true);
  });

  test("false when a nonzero good return row exists", () => {
    const result = onlyRow(
      build(
        [
          row({ quantity: 10, transactionType: TX_WITHDRAW }),
          row({ quantity: 3, transactionType: TX_RETURN }),
        ],
        { centralPrices: DURIAN_PRICE },
      ),
    );
    expect(isSoldOutByAbsentReturn(result)).toBe(false);
  });

  test("false when a damaged return row exists", () => {
    const result = onlyRow(
      build(
        [
          row({ quantity: 10, transactionType: TX_WITHDRAW }),
          row({ quantity: 2, transactionType: TX_DAMAGED }),
        ],
        { centralPrices: DURIAN_PRICE },
      ),
    );
    expect(isSoldOutByAbsentReturn(result)).toBe(false);
  });

  test("false for a QUANTITY_BLOCKED identity — soldQuantity is null", () => {
    const result = onlyRow(build([row({ quantity: 4, transactionType: TX_RETURN })], {
      centralPrices: DURIAN_PRICE,
    }));
    expect(result.soldQuantity).toBeNull();
    expect(isSoldOutByAbsentReturn(result)).toBe(false);
  });
});

const COVERED_ROUND = "round-with-persisted-return";
const MANGO_AND_DURIAN = prices([
  ["หมอนทอง", "โล", 12_000],
  ["มะม่วง", "โล", 8_000],
]);

describe("product-level return coverage", () => {
  test("a whole round with no persisted return stays sold-out", () => {
    const result = onlyRow(
      build(
        [row({ accountabilityRoundId: COVERED_ROUND, quantity: 10, transactionType: TX_WITHDRAW })],
        { centralPrices: DURIAN_PRICE },
      ),
    );
    expect(result.status).toBe("TRUSTED");
    expect(result.soldQuantity).toBe(10);
    expect(result.reasons).not.toContain("product_return_absent");
    expect(isSoldOutByAbsentReturn(result)).toBe(true);
  });

  test("P1: an omitted withdrawn product keeps provisional money but no final sold quantity", () => {
    const report = build(
      [
        row({
          accountabilityRoundId: COVERED_ROUND,
          productName: "หมอนทอง",
          quantity: 10,
          transactionType: TX_WITHDRAW,
        }),
        row({
          accountabilityRoundId: COVERED_ROUND,
          productName: "มะม่วง",
          quantity: 5,
          transactionType: TX_WITHDRAW,
          enteredPriceSatang: 7_000,
        }),
        row({
          accountabilityRoundId: COVERED_ROUND,
          productName: "หมอนทอง",
          quantity: 2,
          transactionType: TX_RETURN,
          sessionId: "session-return",
        }),
      ],
      {
        centralPrices: MANGO_AND_DURIAN,
        persistedReturnRounds: new Set([COVERED_ROUND]),
      },
    );

    const rows = report.markets.flatMap((market) => market.rows);
    const covered = rows.find((item) => item.productName === "หมอนทอง")!;
    const omitted = rows.find((item) => item.productName === "มะม่วง")!;

    expect(covered.status).toBe("TRUSTED");
    expect(covered.soldQuantity).toBe(8);
    expect(covered.expectedSalesSatang).toBe(96_000);
    expect(isSoldOutByAbsentReturn(covered)).toBe(false);

    expect(omitted.status).toBe("QUANTITY_BLOCKED");
    expect(omitted.reasons).toContain("product_return_absent");
    expect(omitted.soldQuantity).toBeNull();
    expect(omitted.expectedSalesSatang).toBeNull();
    expect(omitted.valueStatus).toBe("PENDING_REVIEW");
    expect(omitted.pendingReviewSalesSatang).toBe(40_000);
    expect(omitted.adjustmentSatang).toBe(5_000);
    expect(isSoldOutByAbsentReturn(omitted)).toBe(false);

    expect(report.allMarkets.expectedSalesSatang).toBe(96_000);
    expect(report.allMarkets.pendingReviewSalesSatang).toBe(40_000);
    expect(report.allMarkets.totalSalesSatang).toBe(136_000);
    expect(report.allMarkets.adjustmentSatang).toBe(5_000);
    expect(report.allMarkets.trustedRowCount).toBe(1);
    expect(report.allMarkets.quantityBlockedRowCount).toBe(1);
    expect(report.blocked.map((item) => item.productName)).toEqual(["มะม่วง"]);
  });

  test("good return only still calculates when the product is present", () => {
    const result = onlyRow(
      build(
        [
          row({ accountabilityRoundId: COVERED_ROUND, quantity: 10, transactionType: TX_WITHDRAW }),
          row({
            accountabilityRoundId: COVERED_ROUND,
            quantity: 4,
            transactionType: TX_RETURN,
            sessionId: "session-return",
          }),
        ],
        {
          centralPrices: DURIAN_PRICE,
          persistedReturnRounds: new Set([COVERED_ROUND]),
        },
      ),
    );
    expect(result.status).toBe("TRUSTED");
    expect(result.soldQuantity).toBe(6);
  });

  test("damaged return only still calculates when the product is present", () => {
    const result = onlyRow(
      build(
        [
          row({ accountabilityRoundId: COVERED_ROUND, quantity: 10, transactionType: TX_WITHDRAW }),
          row({
            accountabilityRoundId: COVERED_ROUND,
            quantity: 3,
            transactionType: TX_DAMAGED,
            sessionId: "session-damaged",
          }),
        ],
        {
          centralPrices: DURIAN_PRICE,
          persistedReturnRounds: new Set([COVERED_ROUND]),
        },
      ),
    );
    expect(result.status).toBe("TRUSTED");
    expect(result.soldQuantity).toBe(7);
    expect(isSoldOutByAbsentReturn(result)).toBe(false);
  });

  test("good and damaged returns together still calculate", () => {
    const result = onlyRow(
      build(
        [
          row({ accountabilityRoundId: COVERED_ROUND, quantity: 10, transactionType: TX_WITHDRAW }),
          row({
            accountabilityRoundId: COVERED_ROUND,
            quantity: 2,
            transactionType: TX_RETURN,
            sessionId: "session-return",
          }),
          row({
            accountabilityRoundId: COVERED_ROUND,
            quantity: 1,
            transactionType: TX_DAMAGED,
            sessionId: "session-damaged",
          }),
        ],
        {
          centralPrices: DURIAN_PRICE,
          persistedReturnRounds: new Set([COVERED_ROUND]),
        },
      ),
    );
    expect(result.status).toBe("TRUSTED");
    expect(result.soldQuantity).toBe(7);
  });

  test("an explicit recorded zero return stays evidence, not omission", () => {
    const result = onlyRow(
      build(
        [
          row({ accountabilityRoundId: COVERED_ROUND, quantity: 10, transactionType: TX_WITHDRAW }),
          row({
            accountabilityRoundId: COVERED_ROUND,
            quantity: 0,
            transactionType: TX_RETURN,
            sessionId: "session-return",
          }),
        ],
        {
          centralPrices: DURIAN_PRICE,
          persistedReturnRounds: new Set([COVERED_ROUND]),
        },
      ),
    );
    expect(result.status).toBe("TRUSTED");
    expect(result.soldQuantity).toBe(10);
    expect(result.reasons).not.toContain("product_return_absent");
    expect(result.expectedSalesSatang).toBe(120_000);
  });

  test("an incomplete return is provisional, not confirmed or sold-out", () => {
    const report = build(
      [row({ accountabilityRoundId: COVERED_ROUND, quantity: 10, transactionType: TX_WITHDRAW })],
      {
        centralPrices: DURIAN_PRICE,
        incompleteReturnRounds: new Set([COVERED_ROUND]),
      },
    );
    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.soldQuantity).toBeNull();
    expect(result.returnEvidenceIncomplete).toBe(true);
    expect(result.valueStatus).toBe("PENDING_REVIEW");
    expect(result.expectedSalesSatang).toBeNull();
    expect(result.pendingReviewSalesSatang).toBe(120_000);
    expect(report.allMarkets.expectedSalesSatang).toBe(0);
    expect(report.allMarkets.pendingReviewSalesSatang).toBe(120_000);
    expect(isSoldOutByAbsentReturn(result)).toBe(false);
  });

  test("price conflict plus omission stays quantity-blocked and value-blocked", () => {
    const omitted = onlyRow(
      build(
        [row({ accountabilityRoundId: COVERED_ROUND, quantity: 10, transactionType: TX_WITHDRAW })],
        {
          centralPrices: DURIAN_PRICE,
          persistedReturnRounds: new Set([COVERED_ROUND]),
          priceConflicts: new Set([centralPriceMapKey("หมอนทอง", "โล")]),
        },
      ),
    );
    expect(omitted.status).toBe("QUANTITY_BLOCKED");
    expect(omitted.reasons).toContain("product_return_absent");
    expect(omitted.reasons).toContain("central_price_conflict");
    expect(omitted.soldQuantity).toBeNull();
    expect(omitted.expectedSalesSatang).toBeNull();
    expect(isSoldOutByAbsentReturn(omitted)).toBe(false);
  });

  test("a persisted return on another round does not poison this round's sold-out", () => {
    const result = onlyRow(
      build(
        [row({ accountabilityRoundId: "this-round", quantity: 10, transactionType: TX_WITHDRAW })],
        {
          centralPrices: DURIAN_PRICE,
          persistedReturnRounds: new Set(["other-round"]),
        },
      ),
    );
    expect(result.status).toBe("TRUSTED");
    expect(isSoldOutByAbsentReturn(result)).toBe(true);
    expect(result.reasons).not.toContain("product_return_absent");
  });

  test("a legacy row with no round cannot be scoped by another round's return", () => {
    const result = onlyRow(
      build(
        [row({ accountabilityRoundId: null, quantity: 10, transactionType: TX_WITHDRAW })],
        {
          centralPrices: DURIAN_PRICE,
          persistedReturnRounds: new Set([COVERED_ROUND]),
        },
      ),
    );
    expect(result.reasons).not.toContain("product_return_absent");
    expect(isSoldOutByAbsentReturn(result)).toBe(true);
  });

  test("an omitted unit of the same product is unsafe, not sold-out", () => {
    const report = build(
      [
        row({
          accountabilityRoundId: COVERED_ROUND,
          quantity: 10,
          unit: "โล",
          transactionType: TX_WITHDRAW,
        }),
        row({
          accountabilityRoundId: COVERED_ROUND,
          quantity: 8,
          unit: "ลูก",
          transactionType: TX_WITHDRAW,
        }),
        row({
          accountabilityRoundId: COVERED_ROUND,
          quantity: 2,
          unit: "โล",
          transactionType: TX_RETURN,
          sessionId: "session-return",
        }),
      ],
      {
        centralPrices: DURIAN_PRICE,
        persistedReturnRounds: new Set([COVERED_ROUND]),
      },
    );
    const rows = report.markets.flatMap((market) => market.rows);
    const kilo = rows.find((item) => item.unit === "โล")!;
    const piece = rows.find((item) => item.unit === "ลูก")!;
    expect(kilo.status).toBe("TRUSTED");
    expect(kilo.soldQuantity).toBe(8);
    expect(piece.status).toBe("QUANTITY_BLOCKED");
    expect(piece.reasons).toContain("product_return_absent");
    expect(isSoldOutByAbsentReturn(piece)).toBe(false);
  });
});

// ── Fail-closed quantity rules ──────────────────────────────────────────────

describe("P1 quantity blocking — never assume", () => {
  test("a good return with no withdrawal is QUANTITY_BLOCKED", () => {
    const report = build([row({ quantity: 4, transactionType: TX_RETURN })], {
      centralPrices: DURIAN_PRICE,
    });

    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.reasons).toContain("return_without_withdrawal");
  });

  test("damage with no withdrawal is QUANTITY_BLOCKED", () => {
    const report = build([row({ quantity: 2, transactionType: TX_DAMAGED })], {
      centralPrices: DURIAN_PRICE,
    });
    expect(onlyRow(report).reasons).toContain("return_without_withdrawal");
  });

  test("returns exceeding the withdrawal never produce a negative sold quantity", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 8, transactionType: TX_RETURN }),
        row({ quantity: 5, transactionType: TX_DAMAGED }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.reasons).toContain("returns_exceed_withdrawal");
    expect(result.soldQuantity).toBeNull();
  });

  test("a missing quantity blocks the identity instead of counting as zero", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: null, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(onlyRow(report).reasons).toContain("invalid_quantity");
  });

  test("a missing unit blocks the identity", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, unit: null }),
        row({ quantity: 2, transactionType: TX_RETURN, unit: null }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(onlyRow(report).reasons).toContain("invalid_identity");
  });

  test("an unknown transaction type blocks its identity rather than disappearing", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 2, transactionType: TX_RETURN }),
        row({ quantity: 3, transactionType: "โยนทิ้ง" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.reasons).toContain("unknown_transaction_type");
  });
});

// ── Session integrity ───────────────────────────────────────────────────────

describe("P1 session integrity", () => {
  test("an additional session is additive, not a duplicate", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({
          quantity: 5,
          transactionType: TX_WITHDRAW_MORE,
          sessionId: "session-additional",
          sessionKind: "additional",
        }),
        row({ quantity: 3, transactionType: TX_RETURN }),
        row({
          quantity: 2,
          transactionType: TX_RETURN_MORE,
          sessionId: "session-additional-return",
          sessionKind: "additional",
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.withdrawnQuantity).toBe(15);
    expect(result.goodReturnQuantity).toBe(5);
    expect(result.soldQuantity).toBe(10);
    expect(result.status).toBe("TRUSTED");
  });

  test("two active main sessions of the same type block the whole market", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionId: "session-1" }),
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionId: "session-2" }),
        row({ quantity: 3, transactionType: TX_RETURN, sessionId: "session-3" }),
        row({
          quantity: 1,
          transactionType: TX_RETURN,
          sessionId: "session-3",
          productName: "ชะอม",
          unit: "กำ",
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    expect(report.blocked).toHaveLength(2);
    for (const blocked of report.blocked) {
      expect(blocked.status).toBe("QUANTITY_BLOCKED");
      expect(blocked.reasons).toContain("duplicate_main_session");
    }
    expect(report.allMarkets.valueAuthoritative).toBe(false);
  });

  test("a duplicate main session in one market does not block another market", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionId: "dup-1" }),
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionId: "dup-2" }),
        row({ quantity: 2, transactionType: TX_RETURN, sessionId: "dup-1" }),
        row({
          marketName: MARKET_B,
          sessionId: "clean-1",
          quantity: 8,
          transactionType: TX_WITHDRAW,
        }),
        row({
          marketName: MARKET_B,
          sessionId: "clean-1",
          quantity: 3,
          transactionType: TX_RETURN,
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const clean = report.markets.find((market) => market.marketLabel === MARKET_B);
    expect(clean?.rows[0].status).toBe("TRUSTED");
    expect(clean?.total.valueAuthoritative).toBe(true);

    const dirty = report.markets.find((market) => market.marketLabel === MARKET_A);
    expect(dirty?.total.valueAuthoritative).toBe(false);
  });

  test("a session with parser errors blocks every identity in its market", () => {
    // The failure mode is a line that never landed at all, so a sibling product
    // can look complete while its real return was larger. The market is the
    // smallest scope that provably contains the damage.
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionIssues: ["session_parser_errors"] }),
        row({ quantity: 2, transactionType: TX_RETURN, sessionId: "session-clean" }),
        row({
          quantity: 5,
          transactionType: TX_WITHDRAW,
          sessionId: "session-clean",
          productName: "ชะอม",
          unit: "กำ",
        }),
        row({
          quantity: 1,
          transactionType: TX_RETURN,
          sessionId: "session-clean",
          productName: "ชะอม",
          unit: "กำ",
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    expect(report.blocked).toHaveLength(2);
    for (const blocked of report.blocked) {
      expect(blocked.reasons).toContain("session_parser_errors");
    }
  });

  test("a broken session in one market does not block another market", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionIssues: ["session_parser_errors"] }),
        row({ quantity: 2, transactionType: TX_RETURN, sessionIssues: ["session_parser_errors"] }),
        row({
          marketName: MARKET_B,
          sessionId: "clean-1",
          quantity: 8,
          transactionType: TX_WITHDRAW,
        }),
        row({
          marketName: MARKET_B,
          sessionId: "clean-1",
          quantity: 3,
          transactionType: TX_RETURN,
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const clean = report.markets.find((market) => market.marketLabel === MARKET_B);
    expect(clean?.total.valueAuthoritative).toBe(true);
    expect(report.blocked).toHaveLength(1);
  });

  test("a session with parser errors blocks its identities", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionIssues: ["session_parser_errors"] }),
        row({ quantity: 2, transactionType: TX_RETURN, sessionIssues: ["session_parser_errors"] }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.reasons).toContain("session_parser_errors");
  });

  test("a persisted item-count mismatch blocks its identities", () => {
    const report = build(
      [
        row({
          quantity: 10,
          transactionType: TX_WITHDRAW,
          sessionIssues: ["session_item_count_mismatch"],
        }),
        row({
          quantity: 2,
          transactionType: TX_RETURN,
          sessionIssues: ["session_item_count_mismatch"],
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(onlyRow(report).reasons).toContain("session_item_count_mismatch");
  });

  test("an unresolved pending session demotes every total in the scope", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 2, transactionType: TX_RETURN }),
      ],
      {
        centralPrices: DURIAN_PRICE,
        scopeBlockers: [{ kind: "unresolved_pending_session", count: 1 }],
      },
    );

    // The row itself is still individually trusted …
    expect(onlyRow(report).status).toBe("TRUSTED");
    // … but nothing derived from an incomplete day may be called a total.
    expect(report.allMarkets.valueAuthoritative).toBe(false);
    expect(report.markets[0].total.valueAuthoritative).toBe(false);
    expect(report.products[0].total.valueAuthoritative).toBe(false);
    expect(report.scopeBlockers).toEqual([{ kind: "unresolved_pending_session", count: 1 }]);
  });

  test("a crashed message parse demotes every total in the scope", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 2, transactionType: TX_RETURN }),
      ],
      {
        centralPrices: DURIAN_PRICE,
        scopeBlockers: [{ kind: "message_parser_error", count: 3 }],
      },
    );
    expect(report.allMarkets.valueAuthoritative).toBe(false);
  });
});

// Production 2026-08-19 shapes (SELECT-verified, none voided, no declared
// transaction type): a P2E round legitimately spans several persisted main
// documents of the same effective type. Round ids and seller/market labels
// below are the real production identities from the addendum; product counts
// are scaled down from the originals (e.g. 40/34, 22/19, 12/12, 8/8 for
// ตลาด72) to a handful of representative products while preserving the exact
// invariants that were verified in production — a zero-intersection product
// set between two main คืน documents, and a second main คืน document holding
// a single item.
describe("P1 duplicate main session — round scoping (2026-08-19 regression)", () => {
  const ROUND_KWAN = "f17c54cc-09c7-4091-bf8e-4dcdf8bdb6c0"; // ขวัญ, ตลาด72
  const ROUND_JA = "ff236c81-13e3-4149-939b-a8d298c037e5"; // จ้า, ทรัพย์พัน
  const ROUND_DAM = "2b611dac-75c6-4a35-9960-dc527308a315"; // ดำ, วัดตะกล่ำ

  const PRICES = prices([
    ["ทุเรียน", "โล", 10_000],
    ["มะม่วง", "โล", 5_000],
    ["ชมพู่", "โล", 3_000],
  ]);

  test("1: same round + same return type + DISJOINT products aggregates, no duplicate_main_session", () => {
    const report = build(
      [
        row({ accountabilityRoundId: ROUND_KWAN, sessionId: "f23ae1e9", productName: "ทุเรียน", quantity: 10, transactionType: TX_WITHDRAW }),
        row({ accountabilityRoundId: ROUND_KWAN, sessionId: "f23ae1e9", productName: "มะม่วง", quantity: 10, transactionType: TX_WITHDRAW }),
        row({ accountabilityRoundId: ROUND_KWAN, sessionId: "ddf0ebda", productName: "ทุเรียน", quantity: 3, transactionType: TX_RETURN }),
        row({ accountabilityRoundId: ROUND_KWAN, sessionId: "69bb468f", productName: "มะม่วง", quantity: 4, transactionType: TX_RETURN }),
      ],
      { centralPrices: PRICES },
    );

    expect(report.blocked).toHaveLength(0);
    const durian = report.markets[0].rows.find((r) => r.productName === "ทุเรียน");
    const mango = report.markets[0].rows.find((r) => r.productName === "มะม่วง");
    expect(durian?.status).toBe("TRUSTED");
    expect(durian?.soldQuantity).toBe(7);
    expect(mango?.status).toBe("TRUSTED");
    expect(mango?.soldQuantity).toBe(6);
    for (const r of report.markets[0].rows) expect(r.reasons).not.toContain("duplicate_main_session");
  });

  test("2: same round + same return type + OVERLAPPING products aggregates per normal semantics — document count alone is not duplicate evidence", () => {
    const report = build(
      [
        row({ accountabilityRoundId: ROUND_KWAN, sessionId: "f23ae1e9", productName: "ทุเรียน", quantity: 10, transactionType: TX_WITHDRAW }),
        row({ accountabilityRoundId: ROUND_KWAN, sessionId: "ddf0ebda", productName: "ทุเรียน", quantity: 3, transactionType: TX_RETURN }),
        row({ accountabilityRoundId: ROUND_KWAN, sessionId: "69bb468f", productName: "ทุเรียน", quantity: 2, transactionType: TX_RETURN }),
      ],
      { centralPrices: PRICES },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("TRUSTED");
    expect(result.goodReturnQuantity).toBe(5);
    expect(result.soldQuantity).toBe(5);
    expect(result.reasons).not.toContain("duplicate_main_session");
  });

  test("3: withdrawal + multiple good-return documents (+ damaged, + additional) in one round is trusted when arithmetic is valid", () => {
    const report = build(
      [
        row({ accountabilityRoundId: ROUND_KWAN, sessionId: "f23ae1e9", productName: "ทุเรียน", quantity: 10, transactionType: TX_WITHDRAW }),
        row({ accountabilityRoundId: ROUND_KWAN, sessionId: "ddf0ebda", productName: "ทุเรียน", quantity: 3, transactionType: TX_RETURN }),
        row({ accountabilityRoundId: ROUND_KWAN, sessionId: "69bb468f", productName: "ทุเรียน", quantity: 2, transactionType: TX_RETURN }),
        row({ accountabilityRoundId: ROUND_KWAN, sessionId: "790e1f87", productName: "ทุเรียน", quantity: 1, transactionType: TX_DAMAGED }),
        row({
          accountabilityRoundId: ROUND_KWAN,
          sessionId: "9dea923f",
          sessionKind: "additional",
          productName: "ทุเรียน",
          quantity: 1,
          transactionType: TX_RETURN_MORE,
        }),
      ],
      { centralPrices: PRICES },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("TRUSTED");
    expect(result.withdrawnQuantity).toBe(10);
    expect(result.goodReturnQuantity).toBe(6); // 3 + 2 + 1 additional
    expect(result.damagedReturnQuantity).toBe(1);
    expect(result.soldQuantity).toBe(3);
    expect(report.blocked).toHaveLength(0);
  });

  test("3b: a second main document holding a SINGLE item is the same shape, not a duplicate (round ff236c81)", () => {
    const report = build(
      [
        row({ accountabilityRoundId: ROUND_JA, marketName: "ทรัพย์พัน", sessionId: "06e68e3c", productName: "ชมพู่", quantity: 5, transactionType: TX_WITHDRAW }),
        row({ accountabilityRoundId: ROUND_JA, marketName: "ทรัพย์พัน", sessionId: "fdcbd52f", productName: "ชมพู่", quantity: 3, transactionType: TX_RETURN }),
        // 75302548: the second main คืน document, holding a single item.
        row({ accountabilityRoundId: ROUND_JA, marketName: "ทรัพย์พัน", sessionId: "75302548", productName: "ชมพู่", quantity: 1, transactionType: TX_RETURN }),
      ],
      { centralPrices: PRICES },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("TRUSTED");
    expect(result.goodReturnQuantity).toBe(4);
    expect(result.soldQuantity).toBe(1);
    expect(result.reasons).not.toContain("duplicate_main_session");
  });

  test("3c: same shape for round 2b611dac (a second main document holding a single item)", () => {
    const report = build(
      [
        row({ accountabilityRoundId: ROUND_DAM, marketName: "วัดตะกล่ำ", sessionId: "aadf35c2", productName: "ชมพู่", quantity: 6, transactionType: TX_WITHDRAW }),
        row({ accountabilityRoundId: ROUND_DAM, marketName: "วัดตะกล่ำ", sessionId: "85025fe8", productName: "ชมพู่", quantity: 4, transactionType: TX_RETURN }),
        // 73cc3660: the second main คืน document, holding a single item.
        row({ accountabilityRoundId: ROUND_DAM, marketName: "วัดตะกล่ำ", sessionId: "73cc3660", productName: "ชมพู่", quantity: 1, transactionType: TX_RETURN }),
      ],
      { centralPrices: PRICES },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("TRUSTED");
    expect(result.goodReturnQuantity).toBe(5);
    expect(result.soldQuantity).toBe(1);
    expect(result.reasons).not.toContain("duplicate_main_session");
  });

  test("4: multiple DISTINCT populated rounds for the same business identity stay separate — never silently aggregated (protection ii, unweakened)", () => {
    const OTHER_ROUND = "11111111-2222-4333-8444-555555555555";
    const report = build(
      [
        row({ accountabilityRoundId: ROUND_KWAN, sessionId: "round-a-main", productName: "ทุเรียน", quantity: 10, transactionType: TX_WITHDRAW }),
        row({ accountabilityRoundId: OTHER_ROUND, sessionId: "round-b-main", productName: "ทุเรียน", quantity: 8, transactionType: TX_WITHDRAW }),
      ],
      { centralPrices: PRICES },
    );

    // Two distinct round ids for the same source + label never collapse into
    // one identity: each keeps its own marketKey and its own row, so a real
    // second round is always visible in the report rather than netted away.
    expect(report.markets).toHaveLength(2);
    const quantities = report.markets
      .flatMap((m) => m.rows.map((r) => r.withdrawnQuantity))
      .sort((a, b) => a - b);
    expect(quantities).toEqual([8, 10]);
    for (const market of report.markets) {
      for (const r of market.rows) expect(r.reasons).not.toContain("duplicate_main_session");
    }
  });

  test("5: an additional session inside a round stays additive, not a duplicate (unchanged)", () => {
    const report = build(
      [
        row({ accountabilityRoundId: ROUND_KWAN, sessionId: "main-1", quantity: 10, transactionType: TX_WITHDRAW }),
        row({
          accountabilityRoundId: ROUND_KWAN,
          sessionId: "additional-1",
          sessionKind: "additional",
          quantity: 5,
          transactionType: TX_WITHDRAW_MORE,
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.withdrawnQuantity).toBe(15);
    expect(result.status).toBe("TRUSTED");
    expect(result.reasons).not.toContain("duplicate_main_session");
  });

  test("6: legacy rows with NO round still fail closed on two main sessions of the same type (unchanged)", () => {
    // No accountabilityRoundId here is deliberate: without a round, there is no
    // proof that two main sessions of the same type share one accountability
    // lifecycle, so P1 keeps blocking exactly as it did before this fix. Voided
    // sessions are excluded upstream in load.ts (produce_transactions is
    // already void-filtered) and never reach this calculator either way.
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionId: "legacy-1" }),
        row({ quantity: 10, transactionType: TX_WITHDRAW, sessionId: "legacy-2" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    expect(report.blocked).toHaveLength(1);
    for (const blocked of report.blocked) {
      expect(blocked.reasons).toContain("duplicate_main_session");
    }
  });
});

// ── Product and unit identity ───────────────────────────────────────────────

describe("P1 product and unit identity", () => {
  test("an explicit product alias merges into one identity", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, productName: "หมอนทอง" }),
        row({ quantity: 4, transactionType: TX_RETURN, productName: "หมอน" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.productName).toBe("หมอนทอง");
    expect(result.soldQuantity).toBe(6);
  });

  test("an unrelated product is never fuzzy-merged", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, productName: "หมอนทอง" }),
        row({ quantity: 4, transactionType: TX_RETURN, productName: "ชะนี" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    // หมอนทอง is withdrawal-only and priced, so it is TRUSTED and sold out —
    // only ชะนี (a return with no withdrawal of its own) stays blocked.
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].productName).toBe("ชะนี");
    expect(report.blocked[0].reasons).toContain("return_without_withdrawal");
  });

  test("a verified unit conversion lands both sides in one identity", () => {
    // ขีด → โล ×0.1 is an explicit, shop-verified conversion.
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, unit: "โล" }),
        row({ quantity: 25, transactionType: TX_RETURN, unit: "ขีด" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.unit).toBe("โล");
    expect(result.goodReturnQuantity).toBe(2.5);
    expect(result.soldQuantity).toBe(7.5);
  });

  test("a unit with no known conversion is never merged with another unit", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, unit: "โล" }),
        row({ quantity: 3, transactionType: TX_RETURN, unit: "ลูก" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    // Two separate identities — never merged — but only the return-without-
    // withdrawal one (ลูก) stays blocked; the withdrawal-only โล identity is
    // TRUSTED and sold out.
    const rows = report.markets.flatMap((market) => market.rows);
    expect(rows).toHaveLength(2);
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].unit).toBe("ลูก");
    expect(report.blocked[0].reasons).toContain("return_without_withdrawal");
  });

  test("a spelling alias for a unit normalizes without rescaling", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, unit: "กก." }),
        row({ quantity: 4, transactionType: TX_RETURN, unit: "โล" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(onlyRow(report).soldQuantity).toBe(6);
  });
});

// ── Market identity ─────────────────────────────────────────────────────────

describe("P1 market identity", () => {
  test("the same label under two LINE sources stays two markets", () => {
    const report = build(
      [
        row({ sourceId: SOURCE_A, quantity: 10, transactionType: TX_WITHDRAW }),
        row({ sourceId: SOURCE_A, quantity: 4, transactionType: TX_RETURN }),
        row({ sourceId: SOURCE_B, sessionId: "s-b", quantity: 6, transactionType: TX_WITHDRAW }),
        row({ sourceId: SOURCE_B, sessionId: "s-b", quantity: 1, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    expect(report.markets).toHaveLength(2);
    expect(report.markets.map((market) => market.marketKey)).toEqual([
      salesMarketKey(SOURCE_A, MARKET_A),
      salesMarketKey(SOURCE_B, MARKET_A),
    ]);
    // The display label disambiguates so a human can tell them apart.
    for (const market of report.markets) {
      expect(market.marketLabel.startsWith(`${MARKET_A} · …`)).toBe(true);
    }
  });

  test("a row with no resolvable market is blocked, never merged into one", () => {
    const report = build(
      [
        row({ marketName: null, quantity: 10, transactionType: TX_WITHDRAW }),
        row({ marketName: null, quantity: 4, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].reasons).toContain("market_unresolved");
    expect(report.allMarkets.valueAuthoritative).toBe(false);
  });

  test("unresolved-market rows from different sessions never merge with each other", () => {
    const report = build(
      [
        row({ marketName: null, sessionId: "s1", quantity: 10, transactionType: TX_WITHDRAW }),
        row({ marketName: null, sessionId: "s2", quantity: 4, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(report.blocked).toHaveLength(2);
  });

  test("a row with no resolvable LINE source is blocked", () => {
    const report = build(
      [
        row({ sourceId: null, quantity: 10, transactionType: TX_WITHDRAW }),
        row({ sourceId: null, quantity: 4, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(report.blocked[0].reasons).toContain("market_unresolved");
  });
});

// ── Central price ───────────────────────────────────────────────────────────

describe("P1 expected sales value", () => {
  test("expected sales is sold quantity × central price", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, enteredPriceSatang: 12_050 }),
        row({ quantity: 2.5, transactionType: TX_RETURN }),
      ],
      { centralPrices: prices([["หมอนทอง", "โล", 12_050]]) },
    );

    const result = onlyRow(report);
    expect(result.soldQuantity).toBe(7.5);
    expect(result.centralPriceSatang).toBe(12_050);
    expect(result.expectedSalesSatang).toBe(90_375);
    expect(result.pendingReviewSalesSatang).toBeNull();
    expect(result.valueStatus).toBe("CONFIRMED");
    expect(report.allMarkets).toMatchObject({
      expectedSalesSatang: 90_375,
      pendingReviewSalesSatang: 0,
      totalSalesSatang: 90_375,
      adjustmentSatang: 0,
    });
    expect(satangToBahtText(result.expectedSalesSatang as number)).toBe("903.75");
  });

  test("a trusted quantity with no central price is VALUE_BLOCKED", () => {
    const report = build([
      row({ quantity: 10, transactionType: TX_WITHDRAW }),
      row({ quantity: 4, transactionType: TX_RETURN }),
    ]);

    const result = onlyRow(report);
    expect(result.status).toBe("VALUE_BLOCKED");
    expect(result.reasons).toContain("missing_central_price");
    expect(result.soldQuantity).toBe(6);
    expect(result.expectedSalesSatang).toBeNull();
    expect(result.pendingReviewSalesSatang).toBeNull();
    expect(result.valueStatus).toBe("UNAVAILABLE");
    expect(report.allMarkets.totalSalesSatang).toBe(0);
  });

  test("a missing central price uses one usable entered price as pending-review money", () => {
    const report = build([
      row({ quantity: 10, transactionType: TX_WITHDRAW, enteredPriceSatang: 12_000 }),
      row({ quantity: 4, transactionType: TX_RETURN }),
    ]);

    const result = onlyRow(report);
    expect(result).toMatchObject({
      status: "VALUE_BLOCKED",
      valueStatus: "PENDING_REVIEW",
      soldQuantity: 6,
      enteredPriceSatang: 12_000,
      centralPriceSatang: null,
      expectedSalesSatang: null,
      pendingReviewSalesSatang: 72_000,
      adjustmentSatang: 0,
    });
    expect(report.allMarkets).toMatchObject({
      expectedSalesSatang: 0,
      pendingReviewSalesSatang: 72_000,
      totalSalesSatang: 72_000,
      adjustmentSatang: 0,
    });
  });

  test("P2: multiple entered withdrawal prices aggregate into pending money", () => {
    const report = build([
      row({ quantity: 6, transactionType: TX_WITHDRAW, enteredPriceSatang: 12_000 }),
      row({
        quantity: 4,
        transactionType: TX_WITHDRAW_MORE,
        sessionId: "session-additional",
        sessionKind: "additional",
        enteredPriceSatang: 11_000,
      }),
    ]);

    expect(onlyRow(report)).toMatchObject({
      enteredPriceSatang: 11_600,
      valueStatus: "PENDING_REVIEW",
      pendingReviewSalesSatang: 116_000,
    });
    expect(report.allMarkets.totalSalesSatang).toBe(116_000);
  });

  test("multiple entered prices retain an exact approved-price adjustment without double count", () => {
    const report = build(
      [
        row({ quantity: 6, transactionType: TX_WITHDRAW, enteredPriceSatang: 12_000 }),
        row({
          quantity: 4,
          transactionType: TX_WITHDRAW_MORE,
          sessionId: "session-additional",
          sessionKind: "additional",
          enteredPriceSatang: 11_000,
        }),
        row({ quantity: 2, transactionType: TX_RETURN, sessionId: "session-return" }),
      ],
      { centralPrices: prices([["หมอนทอง", "โล", 13_000]]) },
    );

    expect(onlyRow(report)).toMatchObject({
      soldQuantity: 8,
      enteredPriceSatang: 11_600,
      expectedSalesSatang: 104_000,
      pendingReviewSalesSatang: null,
      adjustmentSatang: 11_200,
      valueStatus: "CONFIRMED",
    });
    expect(report.allMarkets).toMatchObject({
      expectedSalesSatang: 104_000,
      pendingReviewSalesSatang: 0,
      totalSalesSatang: 104_000,
      adjustmentSatang: 11_200,
    });
  });

  test("an unresolved central-price conflict blocks value even when a price exists", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
      ],
      {
        centralPrices: DURIAN_PRICE,
        priceConflicts: new Set([centralPriceMapKey("หมอนทอง", "โล")]),
      },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("VALUE_BLOCKED");
    expect(result.reasons).toContain("central_price_conflict");
    expect(result.expectedSalesSatang).toBeNull();
    expect(result.valueStatus).toBe("UNAVAILABLE");
  });

  test("a central-price conflict uses the entered price but keeps the money pending review", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, enteredPriceSatang: 12_000 }),
        row({ quantity: 4, transactionType: TX_RETURN }),
      ],
      {
        centralPrices: prices([["หมอนทอง", "โล", 9_900]]),
        priceConflicts: new Set([centralPriceMapKey("หมอนทอง", "โล")]),
      },
    );

    expect(onlyRow(report)).toMatchObject({
      status: "VALUE_BLOCKED",
      valueStatus: "PENDING_REVIEW",
      centralPriceSatang: null,
      expectedSalesSatang: null,
      pendingReviewSalesSatang: 72_000,
      adjustmentSatang: 0,
    });
    expect(report.allMarkets.totalSalesSatang).toBe(72_000);
  });

  test("an admin-corrected central price is used verbatim", () => {
    // BR-04: once an admin sets the price it is authoritative, and the
    // withdrawal-row price is never substituted for it.
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW, enteredPriceSatang: 12_000 }),
        row({ quantity: 0, transactionType: TX_RETURN }),
      ],
      { centralPrices: prices([["หมอนทอง", "โล", 9_900]]) },
    );

    const result = onlyRow(report);
    expect(result.centralPriceSatang).toBe(9_900);
    expect(result.expectedSalesSatang).toBe(99_000);
    expect(result.valueStatus).toBe("CONFIRMED");
    expect(result.pendingReviewSalesSatang).toBeNull();
    expect(result.adjustmentSatang).toBe(-21_000);
    expect(report.allMarkets.totalSalesSatang).toBe(99_000);
    expect(report.allMarkets.adjustmentSatang).toBe(-21_000);
  });

  test("incomplete return evidence keeps calculable sales in the total", () => {
    const roundId = "round-incomplete-return";
    const report = build(
      [row({
        accountabilityRoundId: roundId,
        quantity: 10,
        transactionType: TX_WITHDRAW,
        enteredPriceSatang: 12_000,
      })],
      { centralPrices: DURIAN_PRICE, incompleteReturnRounds: new Set([roundId]) },
    );

    expect(onlyRow(report)).toMatchObject({
      returnEvidenceIncomplete: true,
      status: "QUANTITY_BLOCKED",
      soldQuantity: null,
      valueStatus: "PENDING_REVIEW",
      expectedSalesSatang: null,
      pendingReviewSalesSatang: 120_000,
    });
    expect(report.allMarkets.expectedSalesSatang).toBe(0);
    expect(report.allMarkets.pendingReviewSalesSatang).toBe(120_000);
    expect(report.allMarkets.totalSalesSatang).toBe(120_000);
  });

  test("incomplete damaged-return evidence subtracts known damage and keeps calculable sales", () => {
    const roundId = "round-incomplete-damaged-return";
    const report = build(
      [
        row({
          accountabilityRoundId: roundId,
          quantity: 10,
          transactionType: TX_WITHDRAW,
          enteredPriceSatang: 12_000,
        }),
        row({
          accountabilityRoundId: roundId,
          sessionId: "session-damaged",
          quantity: 2,
          transactionType: TX_DAMAGED,
        }),
      ],
      {
        centralPrices: DURIAN_PRICE,
        persistedReturnRounds: new Set([roundId]),
        incompleteReturnRounds: new Set([roundId]),
      },
    );

    expect(onlyRow(report)).toMatchObject({
      damagedReturnQuantity: 2,
      soldQuantity: null,
      returnEvidenceIncomplete: true,
      status: "QUANTITY_BLOCKED",
      valueStatus: "PENDING_REVIEW",
      expectedSalesSatang: null,
      pendingReviewSalesSatang: 96_000,
    });
    expect(report.allMarkets.expectedSalesSatang).toBe(0);
    expect(report.allMarkets.pendingReviewSalesSatang).toBe(96_000);
    expect(report.allMarkets.totalSalesSatang).toBe(96_000);
  });

  test("total sales is confirmed plus pending and never adds the adjustment again", () => {
    const report = build(
      [
        row({
          productName: "หมอนทอง",
          quantity: 10,
          transactionType: TX_WITHDRAW,
          enteredPriceSatang: 10_000,
        }),
        row({
          productName: "มังคุด",
          sessionId: "session-mangosteen",
          sessionKind: "additional",
          quantity: 4,
          transactionType: TX_WITHDRAW,
          enteredPriceSatang: 5_000,
        }),
      ],
      {
        centralPrices: prices([
          ["หมอนทอง", "โล", 12_000],
          ["มังคุด", "โล", 6_000],
        ]),
        priceConflicts: new Set([centralPriceMapKey("มังคุด", "โล")]),
      },
    );

    expect(report.allMarkets).toMatchObject({
      expectedSalesSatang: 120_000,
      pendingReviewSalesSatang: 20_000,
      totalSalesSatang: 140_000,
      adjustmentSatang: 20_000,
    });
    expect(report.allMarkets.totalSalesSatang).toBe(
      report.allMarkets.expectedSalesSatang + report.allMarkets.pendingReviewSalesSatang,
    );
  });

  test("a quantity-blocked row never reports a value", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 15, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const result = onlyRow(report);
    expect(result.status).toBe("QUANTITY_BLOCKED");
    expect(result.centralPriceSatang).toBeNull();
    expect(result.expectedSalesSatang).toBeNull();
    expect(result.pendingReviewSalesSatang).toBeNull();
    expect(result.valueStatus).toBe("UNAVAILABLE");
  });
});

// ── Money rounding ──────────────────────────────────────────────────────────

describe("P1 money rounding", () => {
  test("each row rounds half-up to satang exactly once", () => {
    // 0.001 kg × 12.005 baht = 0.012005 baht = 1.2005 satang → 1 satang.
    const report = build(
      [
        row({ quantity: 1.001, transactionType: TX_WITHDRAW }),
        row({ quantity: 1, transactionType: TX_RETURN }),
      ],
      { centralPrices: prices([["หมอนทอง", "โล", 1_200]]) },
    );
    // 0.001 × 1200 satang = 1.2 satang → 1
    expect(onlyRow(report).expectedSalesSatang).toBe(1);
  });

  test("a half satang rounds up, not to even", () => {
    // 0.005 kg × 1.00 baht = 0.5 satang → 1 satang (half-up).
    const report = build(
      [
        row({ quantity: 1.005, transactionType: TX_WITHDRAW }),
        row({ quantity: 1, transactionType: TX_RETURN }),
      ],
      { centralPrices: prices([["หมอนทอง", "โล", 100]]) },
    );
    expect(onlyRow(report).expectedSalesSatang).toBe(1);
  });

  test("every displayed total is the exact integer sum of its rows", () => {
    const report = build(
      [
        row({ quantity: 1.001, transactionType: TX_WITHDRAW }),
        row({ quantity: 1, transactionType: TX_RETURN }),
        row({
          marketName: MARKET_B,
          sessionId: "s-b",
          quantity: 1.001,
          transactionType: TX_WITHDRAW,
        }),
        row({ marketName: MARKET_B, sessionId: "s-b", quantity: 1, transactionType: TX_RETURN }),
      ],
      { centralPrices: prices([["หมอนทอง", "โล", 1_200]]) },
    );

    const rowSum = report.markets
      .flatMap((market) => market.rows)
      .reduce((sum, current) => sum + (current.expectedSalesSatang ?? 0), 0);

    expect(report.allMarkets.expectedSalesSatang).toBe(rowSum);
    expect(report.products[0].total.expectedSalesSatang).toBe(rowSum);
    expect(
      report.markets.reduce((sum, market) => sum + market.total.expectedSalesSatang, 0),
    ).toBe(rowSum);
  });

  test("satang formatting keeps two decimals and thousands separators", () => {
    expect(satangToBahtText(0)).toBe("0.00");
    expect(satangToBahtText(5)).toBe("0.05");
    expect(satangToBahtText(1_234_567)).toBe("12,345.67");
  });
});

// ── Aggregation authority ───────────────────────────────────────────────────

describe("P1 aggregation authority", () => {
  test("a market total is authoritative only when every identity is trusted", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
        row({ quantity: 5, transactionType: TX_WITHDRAW, productName: "ชะอม", unit: "กำ" }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const market = report.markets[0];
    expect(market.total.valueAuthoritative).toBe(false);
    expect(market.total.trustedRowCount).toBe(1);
    // ชะอม is withdrawal-only and unpriced: quantity-trusted, value-blocked.
    expect(market.total.quantityBlockedRowCount).toBe(0);
    expect(market.total.valueBlockedRowCount).toBe(1);
    // The partial figure is still the sum of what IS verified.
    expect(market.total.expectedSalesSatang).toBe(72_000);
  });

  test("a product total across markets is authoritative only when every contributor is", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
        // A return with no withdrawal of its own in MARKET_B: still not sold.
        row({
          marketName: MARKET_B,
          sessionId: "s-b",
          quantity: 5,
          transactionType: TX_RETURN,
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const product = report.products[0];
    expect(product.total.valueAuthoritative).toBe(false);
    expect(product.soldQuantity).toBe(6);
    expect(product.markets).toHaveLength(1);
  });

  test("the all-market total is authoritative only when the whole scope is trusted", () => {
    const trusted = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(trusted.allMarkets.valueAuthoritative).toBe(true);

    const partial = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
        // A return with no withdrawal of its own in MARKET_B: still not sold.
        row({
          marketName: MARKET_B,
          sessionId: "s-b",
          quantity: 5,
          transactionType: TX_RETURN,
        }),
      ],
      { centralPrices: DURIAN_PRICE },
    );
    expect(partial.allMarkets.valueAuthoritative).toBe(false);
  });

  test("a VALUE_BLOCKED row demotes its totals and contributes no value", () => {
    const report = build([
      row({ quantity: 10, transactionType: TX_WITHDRAW }),
      row({ quantity: 4, transactionType: TX_RETURN }),
    ]);

    expect(report.allMarkets.valueAuthoritative).toBe(false);
    expect(report.allMarkets.expectedSalesSatang).toBe(0);
    expect(report.blocked).toHaveLength(1);
  });

  test("every blocked identity is listed, never sampled", () => {
    // All three are withdrawal-only and unpriced: quantity-trusted but
    // VALUE_BLOCKED, which still lists them in full.
    const report = build([
      row({ quantity: 1, transactionType: TX_WITHDRAW, productName: "หมอนทอง" }),
      row({ quantity: 1, transactionType: TX_WITHDRAW, productName: "ชะอม", unit: "กำ" }),
      row({ quantity: 1, transactionType: TX_WITHDRAW, productName: "คะน้า", unit: "กำ" }),
    ]);
    expect(report.blocked).toHaveLength(3);
  });
});


// ── Quantity trust vs value trust ───────────────────────────────────────────

describe("P1 quantity trust is independent of value trust", () => {
  test("a missing central price never erases a proven sold quantity", () => {
    const report = build([
      row({ quantity: 12, transactionType: TX_WITHDRAW }),
      row({ quantity: 2, transactionType: TX_RETURN }),
    ]);

    const identity = onlyRow(report);
    expect(identity.status).toBe("VALUE_BLOCKED");
    expect(identity.soldQuantity).toBe(10);
    expect(identity.expectedSalesSatang).toBeNull();
    expect(report.products[0].soldQuantity).toBe(10);
  });

  test("a priced and an unpriced product coexist without either losing its truth", () => {
    // Central prices are keyed by (product, unit), so value trust is decided per
    // product — quantity trust is decided per identity, and they do not interact.
    const report = build(
      [
        row({ quantity: 12, transactionType: TX_WITHDRAW }),
        row({ quantity: 2, transactionType: TX_RETURN }),
        row({ productName: "ชะอม", unit: "กำ", quantity: 8, transactionType: TX_WITHDRAW }),
        row({ productName: "ชะอม", unit: "กำ", quantity: 3, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const durian = report.products.find((product) => product.productName === "หมอนทอง");
    const chaOm = report.products.find((product) => product.productName === "ชะอม");

    expect(durian?.soldQuantity).toBe(10);
    expect(durian?.total.valueAuthoritative).toBe(true);
    expect(durian?.total.expectedSalesSatang).toBe(120_000);

    expect(chaOm?.soldQuantity).toBe(5);
    expect(chaOm?.total.quantityAuthoritative).toBe(true);
    expect(chaOm?.total.valueAuthoritative).toBe(false);
    expect(chaOm?.total.expectedSalesSatang).toBe(0);
  });

  test("an unpriced product sums its quantity across markets and reports no value", () => {
    const report = build([
      row({ quantity: 12, transactionType: TX_WITHDRAW }),
      row({ quantity: 2, transactionType: TX_RETURN }),
      row({ sourceId: SOURCE_B, marketName: MARKET_B, sessionId: "s-b", quantity: 8, transactionType: TX_WITHDRAW }),
      row({ sourceId: SOURCE_B, marketName: MARKET_B, sessionId: "s-b", quantity: 3, transactionType: TX_RETURN }),
    ]);

    const product = report.products[0];
    expect(product.soldQuantity).toBe(15); // 10 + 5, both proven
    expect(product.markets).toHaveLength(2);
    for (const entry of product.markets) expect(entry.expectedSalesSatang).toBeNull();
    expect(product.total.quantityAuthoritative).toBe(true);
    expect(product.total.valueAuthoritative).toBe(false);
    expect(product.total.valueBlockedRowCount).toBe(2);
    expect(product.total.quantityBlockedRowCount).toBe(0);
  });

  test("a quantity-blocked row contributes neither quantity nor value", () => {
    const report = build(
      [
        row({ quantity: 12, transactionType: TX_WITHDRAW }),
        row({ quantity: 2, transactionType: TX_RETURN }),
        // A return with no withdrawal of its own in the other market: not sold.
        row({ sourceId: SOURCE_B, marketName: MARKET_B, sessionId: "s-b", quantity: 8, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    const product = report.products[0];
    expect(product.soldQuantity).toBe(10);
    expect(product.markets).toHaveLength(1);
    expect(product.total.quantityAuthoritative).toBe(false);
    expect(product.total.valueAuthoritative).toBe(false);
    expect(product.total.quantityBlockedRowCount).toBe(1);
  });

  test("a price conflict blocks value only, never the quantity", () => {
    const report = build(
      [
        row({ quantity: 12, transactionType: TX_WITHDRAW }),
        row({ quantity: 2, transactionType: TX_RETURN }),
      ],
      {
        centralPrices: DURIAN_PRICE,
        priceConflicts: new Set([centralPriceMapKey("หมอนทอง", "โล")]),
      },
    );

    expect(onlyRow(report).soldQuantity).toBe(10);
    expect(report.products[0].soldQuantity).toBe(10);
    expect(report.allMarkets.quantityAuthoritative).toBe(true);
    expect(report.allMarkets.valueAuthoritative).toBe(false);
    expect(report.allMarkets.expectedSalesSatang).toBe(0);
  });

  test("market and all-market totals state the two kinds of trust separately", () => {
    const report = build(
      [
        row({ quantity: 12, transactionType: TX_WITHDRAW }),
        row({ quantity: 2, transactionType: TX_RETURN }),
        row({ productName: "ชะอม", unit: "กำ", quantity: 8, transactionType: TX_WITHDRAW }),
        row({ productName: "ชะอม", unit: "กำ", quantity: 3, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE },
    );

    for (const total of [report.markets[0].total, report.allMarkets]) {
      expect(total.quantityAuthoritative).toBe(true);
      expect(total.valueAuthoritative).toBe(false);
      expect(total.trustedRowCount).toBe(1);
      expect(total.valueBlockedRowCount).toBe(1);
      expect(total.expectedSalesSatang).toBe(120_000); // TRUSTED rows only
    }
  });

  test("a scope blocker demotes quantity authority as well as value", () => {
    const report = build(
      [
        row({ quantity: 12, transactionType: TX_WITHDRAW }),
        row({ quantity: 2, transactionType: TX_RETURN }),
      ],
      {
        centralPrices: DURIAN_PRICE,
        scopeBlockers: [{ kind: "unresolved_pending_session", count: 1 }],
      },
    );

    expect(report.allMarkets.quantityAuthoritative).toBe(false);
    expect(report.allMarkets.valueAuthoritative).toBe(false);
    expect(report.markets[0].total.quantityAuthoritative).toBe(false);
    expect(report.products[0].total.quantityAuthoritative).toBe(false);
  });
});

// ── Sessions that persisted nothing ─────────────────────────────────────────

describe("P1 session audits — a session that persisted no rows", () => {
  const audit = {
    sessionId: "session-broken",
    sourceId: SOURCE_A,
    marketName: MARKET_A,
    reasons: ["session_rows_missing"] as const,
  };

  test("blocks the market it can be attributed to", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE, sessionAudits: [audit] },
    );

    expect(report.markets[0].total.quantityAuthoritative).toBe(false);
    expect(report.markets[0].rows[0].reasons).toContain("session_rows_missing");
    // Attributable, so it is a market block — not a whole-scope one.
    expect(report.scopeBlockers).toEqual([]);
  });

  test("appears as its own blocked entry when the market has nothing else", () => {
    const report = build([], { sessionAudits: [audit] });

    expect(report.markets).toHaveLength(1);
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].isSessionPlaceholder).toBe(true);
    expect(report.blocked[0].soldQuantity).toBeNull();
    expect(report.blocked[0].reasons).toContain("session_rows_missing");
    // A placeholder reports a session, so it never becomes a product line.
    expect(report.products).toHaveLength(0);
  });

  test("becomes a scope blocker when the market cannot be proven", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
      ],
      {
        centralPrices: DURIAN_PRICE,
        sessionAudits: [{ ...audit, sourceId: null, marketName: null }],
      },
    );

    expect(report.scopeBlockers).toEqual([{ kind: "unattributable_session", count: 1 }]);
    expect(report.allMarkets.quantityAuthoritative).toBe(false);
    expect(report.allMarkets.valueAuthoritative).toBe(false);
  });

  test("no audits leaves a clean day clean", () => {
    const report = build(
      [
        row({ quantity: 10, transactionType: TX_WITHDRAW }),
        row({ quantity: 4, transactionType: TX_RETURN }),
      ],
      { centralPrices: DURIAN_PRICE, sessionAudits: [] },
    );

    expect(report.scopeBlockers).toEqual([]);
    expect(report.allMarkets.valueAuthoritative).toBe(true);
  });
});
