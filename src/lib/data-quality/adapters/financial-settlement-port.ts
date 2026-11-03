/**
 * Bridges the existing Daily Financial Settlement service into Data Quality.
 * This adapter never re-derives financial formulas; it only discovers the
 * source/market scopes for a date, calls getDailyFinancialSettlement(), and
 * turns non-healthy settlement states into scanner signals.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  getDailyFinancialSettlement,
  type DailyFinancialSettlementResult,
} from "@/lib/settlement/daily-financial-settlement";
import {
  listWhiteSheetMarketScopesForDate,
  type WhiteSheetMarketScopeOption,
} from "@/lib/white-sheet/market-scopes";

type Supabase = SupabaseClient<Database>;

export type FinancialSettlementSignalKind = "mismatch" | "incomplete_evidence";

export interface FinancialSettlementSignal {
  kind: FinancialSettlementSignalKind;
  businessDate: string;
  entityRefs: string[];
  summaryTh: string;
  technicalContext?: Record<string, unknown>;
}

export interface FinancialSettlementPort {
  getSignals(businessDate: string): Promise<FinancialSettlementSignal[]>;
}

export interface FinancialSettlementPortDependencies {
  listScopes?: (
    supabase: Supabase,
    businessDate: string,
  ) => Promise<WhiteSheetMarketScopeOption[]>;
  getSettlement?: typeof getDailyFinancialSettlement;
}

const MISSING_LABEL_TH: Record<string, string> = {
  white_sheet_sales: "ยอดขายใบขาว",
  owner_cash: "เงินให้เจ้า",
  expenses: "ค่าใช้จ่าย",
  wages: "ค่าแรง",
  actual_cash: "เงินสดจริง",
};

function fmtBaht(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function dailyFinancialSettlementToSignal(
  sourceId: string,
  result: DailyFinancialSettlementResult,
): FinancialSettlementSignal | null {
  const entityRefs = [sourceId, `market:${result.marketLabelNormalized}`];

  if (result.status === "CLOSED_DIFFERENCE") {
    return {
      kind: "mismatch",
      businessDate: result.businessDate,
      entityRefs,
      summaryTh:
        `${result.marketLabelNormalized} — เงินปิดไม่ตรง ${fmtBaht(Math.abs(result.difference ?? 0))} บาท `
        + `(เงินสดจริง ${fmtBaht(result.actualCash)} / ควรเหลือ ${fmtBaht(result.expectedCash)})`,
      technicalContext: {
        settlementStatus: result.status,
        difference: result.difference,
        actualCash: result.actualCash,
        expectedCash: result.expectedCash,
        transferTotal: result.transferTotal,
      },
    };
  }

  if (result.status !== "INCOMPLETE") return null;

  const missingLabels = result.missingInputs.map((key) => MISSING_LABEL_TH[key] ?? key);
  return {
    kind: "incomplete_evidence",
    businessDate: result.businessDate,
    entityRefs,
    summaryTh:
      `${result.marketLabelNormalized} — ข้อมูลปิดยอดไม่ครบ: ${missingLabels.join(", ")}`,
    technicalContext: {
      settlementStatus: result.status,
      missingInputs: result.missingInputs,
      uncertainty: result.uncertainty,
    },
  };
}

export function createFinancialSettlementPort(
  supabase: Supabase,
  dependencies: FinancialSettlementPortDependencies = {},
): FinancialSettlementPort {
  const listScopes = dependencies.listScopes ?? listWhiteSheetMarketScopesForDate;
  const getSettlement = dependencies.getSettlement ?? getDailyFinancialSettlement;

  return {
    async getSignals(businessDate: string): Promise<FinancialSettlementSignal[]> {
      const scopes = await listScopes(supabase, businessDate);
      const knownMarketsBySource = new Map<string, Set<string>>();

      for (const scope of scopes) {
        const set = knownMarketsBySource.get(scope.sourceId) ?? new Set<string>();
        set.add(scope.marketLabel);
        knownMarketsBySource.set(scope.sourceId, set);
      }

      const results = await Promise.all(
        scopes.map(async (scope) => {
          const settlement = await getSettlement(
            supabase,
            {
              sourceId: scope.sourceId,
              marketLabelNormalized: scope.marketLabel,
              businessDate,
            },
            { knownMarkets: knownMarketsBySource.get(scope.sourceId) ?? new Set([scope.marketLabel]) },
          );
          return dailyFinancialSettlementToSignal(scope.sourceId, settlement);
        }),
      );

      return results.filter((signal): signal is FinancialSettlementSignal => signal !== null);
    },
  };
}
