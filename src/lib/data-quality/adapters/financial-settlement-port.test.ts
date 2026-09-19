import { describe, expect, it } from "bun:test";
import type { DailyFinancialSettlementResult } from "@/lib/settlement/daily-financial-settlement";
import {
  createFinancialSettlementPort,
  dailyFinancialSettlementToSignal,
} from "./financial-settlement-port";

function settlement(
  overrides: Partial<DailyFinancialSettlementResult> = {},
): DailyFinancialSettlementResult {
  return {
    status: "CLOSED_MATCHED",
    businessDate: "2026-09-07",
    marketLabelNormalized: "ตลาด72",
    whiteSheetSales: 1000,
    transferTotal: 400,
    ownerCash: 100,
    expensesTotal: 50,
    wagesTotal: 50,
    actualCash: 400,
    expectedCash: 400,
    difference: 0,
    missingInputs: [],
    uncertainty: [],
    ...overrides,
  };
}

describe("dailyFinancialSettlementToSignal", () => {  it("does not create an issue for a matched close", () => {
    expect(dailyFinancialSettlementToSignal("C-source", settlement())).toBeNull();
  });

  it("turns a close difference into a settlement mismatch", () => {
    const signal = dailyFinancialSettlementToSignal(
      "C-source",
      settlement({
        status: "CLOSED_DIFFERENCE",
        actualCash: 350,
        expectedCash: 400,
        difference: -50,
      }),
    );

    expect(signal?.kind).toBe("mismatch");
    expect(signal?.businessDate).toBe("2026-09-07");
    expect(signal?.entityRefs).toEqual(["C-source", "market:ตลาด72"]);
    expect(signal?.summaryTh).toContain("50.00");
    expect(signal?.technicalContext).toMatchObject({
      difference: -50,
      actualCash: 350,
      expectedCash: 400,
    });
  });

  it("turns missing close inputs into incomplete evidence", () => {
    const signal = dailyFinancialSettlementToSignal(
      "C-source",
      settlement({
        status: "INCOMPLETE",
        ownerCash: null,
        actualCash: null,
        expectedCash: null,
        difference: null,
        missingInputs: ["owner_cash", "actual_cash"],
      }),
    );

    expect(signal?.kind).toBe("incomplete_evidence");
    expect(signal?.summaryTh).toContain("เงินให้เจ้า");
    expect(signal?.summaryTh).toContain("เงินสดจริง");
    expect(signal?.technicalContext).toMatchObject({
      settlementStatus: "INCOMPLETE",
      missingInputs: ["owner_cash", "actual_cash"],
    });
  });
});

describe("createFinancialSettlementPort", () => {  it("scans every discovered source/market with source-local known markets", async () => {
    const calls: Array<{ market: string; knownMarkets: string[] }> = [];
    const fakeSupabase = {} as never;
    const port = createFinancialSettlementPort(fakeSupabase, {
      async listScopes() {
        return [
          { sourceId: "C-a", marketLabel: "ตลาดA", displayLabel: "ตลาดA" },
          { sourceId: "C-a", marketLabel: "ตลาดB", displayLabel: "ตลาดB" },
          { sourceId: "C-b", marketLabel: "ตลาดC", displayLabel: "ตลาดC" },
        ];
      },
      async getSettlement(_supabase, identity, options) {
        calls.push({
          market: identity.marketLabelNormalized,
          knownMarkets: [...(options?.knownMarkets ?? [])].sort(),
        });
        if (identity.marketLabelNormalized === "ตลาดB") {
          return settlement({
            marketLabelNormalized: "ตลาดB",
            status: "CLOSED_DIFFERENCE",
            difference: 25,
            actualCash: 425,
            expectedCash: 400,
          });
        }
        if (identity.marketLabelNormalized === "ตลาดC") {          return settlement({
            marketLabelNormalized: "ตลาดC",
            status: "INCOMPLETE",
            actualCash: null,
            expectedCash: null,
            difference: null,
            missingInputs: ["actual_cash"],
          });
        }
        return settlement({ marketLabelNormalized: identity.marketLabelNormalized });
      },
    });

    const signals = await port.getSignals("2026-09-07");

    expect(signals.map((signal) => signal.kind).sort()).toEqual([
      "incomplete_evidence",
      "mismatch",
    ]);
    expect(calls).toEqual([
      { market: "ตลาดA", knownMarkets: ["ตลาดA", "ตลาดB"] },
      { market: "ตลาดB", knownMarkets: ["ตลาดA", "ตลาดB"] },
      { market: "ตลาดC", knownMarkets: ["ตลาดC"] },
    ]);
  });
});
