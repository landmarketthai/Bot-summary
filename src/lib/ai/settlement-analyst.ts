import type { DailyFinancialSettlementResult } from "@/lib/settlement/daily-financial-settlement";
import {
  answerBotSummaryQuestion,
  type AnalystSnapshot,
  type OpenAIAnalystOptions,
} from "./openai-analyst";

export function settlementToAnalystSnapshot(
  result: DailyFinancialSettlementResult,
): AnalystSnapshot {
  return {
    asOf: result.businessDate,
    scope: result.marketLabelNormalized,
    facts: {
      status: result.status,
      whiteSheetSalesBaht: result.whiteSheetSales,
      transferTotalBaht: result.transferTotal,
      ownerCashBaht: result.ownerCash,
      expensesTotalBaht: result.expensesTotal,
      wagesTotalBaht: result.wagesTotal,
      expectedCashBaht: result.expectedCash,
      actualCashBaht: result.actualCash,
      differenceBaht: result.difference,
      missingInputs: result.missingInputs,
      uncertainty: result.uncertainty,
      produceCrossCheck: result.produceCrossCheck ?? null,
    },
    notes: [
      "ตัวเลขทั้งหมดมาจาก Calculation Engine ของ Bot Summary แล้ว LLM มีหน้าที่อธิบายเท่านั้น",
      "status=INCOMPLETE หมายถึงข้อมูลยังไม่ครบ ห้ามสรุปว่าเงินขาด/เกิน",
    ],
  };
}

export async function answerSettlementQuestion(
  question: string,
  result: DailyFinancialSettlementResult,
  options: OpenAIAnalystOptions = {},
): Promise<string> {
  return answerBotSummaryQuestion(
    question,
    settlementToAnalystSnapshot(result),
    options,
  );
}
