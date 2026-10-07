import { describe, expect, test } from "bun:test";
import { computeDailyFinancialSettlement } from "@/lib/settlement/daily-financial-settlement";
import { settlementToAnalystSnapshot } from "./settlement-analyst";

describe("settlementToAnalystSnapshot", () => {
  test("adapts the existing calculation-engine result without re-deriving money", () => {
    const result = computeDailyFinancialSettlement(
      {
        businessDate: "2026-09-29",
        marketLabelNormalized: "พาซิโอ้ผัก",
      },
      {
        whiteSheetSales: 22527,
        transferTotal: 0,
        ownerCash: 0,
        expensesTotal: 0,
        wagesTotal: 0,
        actualCash: 22665,
      },
    );

    const snapshot = settlementToAnalystSnapshot(result);

    expect(snapshot.asOf).toBe("2026-09-29");
    expect(snapshot.scope).toBe("พาซิโอ้ผัก");
    expect(snapshot.facts.expectedCashBaht).toBe(22527);
    expect(snapshot.facts.actualCashBaht).toBe(22665);
    expect(snapshot.facts.differenceBaht).toBe(138);
    expect(snapshot.notes?.join(" ")).toContain("Calculation Engine");
  });

  test("preserves INCOMPLETE status and null difference", () => {
    const result = computeDailyFinancialSettlement(
      {
        businessDate: "2026-10-06",
        marketLabelNormalized: "พาซิโอ้ผัก",
      },
      {
        whiteSheetSales: null,
        transferTotal: 0,
        ownerCash: 0,
        expensesTotal: 0,
        wagesTotal: 0,
        actualCash: null,
      },
    );

    const snapshot = settlementToAnalystSnapshot(result);

    expect(snapshot.facts.status).toBe("INCOMPLETE");
    expect(snapshot.facts.differenceBaht).toBeNull();
    expect(snapshot.facts.missingInputs).toEqual([
      "white_sheet_sales",
      "actual_cash",
    ]);
  });
});
