/**
 * Non-blocking Produce reconciliation → Data Quality Inbox candidates.
 *
 * These issues never stop a session and are never shown to field staff. They
 * are written to public.data_quality_issues (ADVISORY, admin dashboard only)
 * after the session is persisted, through the same idempotent
 * upsert_data_quality_issues RPC every other inbox source uses. The issue key
 * is (category, business date, produce session, item / product+unit), so a
 * retry or a recovery replay of the same session refreshes one row instead of
 * adding another.
 */

import type { DataQualityIssueCandidate } from "@/lib/data-quality/types";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import type { ProduceValidationReconciliation } from "./entry-validation";

export interface ProduceReconciliationContext {
  produceSessionId: string;
  pendingSessionKey: string;
  pendingSessionGeneration: string;
  accountabilityRoundId: string | null;
  /** The persisted (alias-canonical) document. */
  parsed: WeighSession;
  reconciliation: readonly ProduceValidationReconciliation[];
}

export function buildProduceReconciliationIssues(
  context: ProduceReconciliationContext,
): DataQualityIssueCandidate[] {
  const businessDate = context.parsed.date;
  if (!businessDate) return [];
  const base = {
    produce_session_id: context.produceSessionId,
    pending_session_key: context.pendingSessionKey,
    pending_session_generation: context.pendingSessionGeneration,
    accountability_round_id: context.accountabilityRoundId,
    staff_name: context.parsed.staff_name,
    market_name: context.parsed.session_title,
  };
  const sessionRef = `produce_session:${context.produceSessionId}`;
  const itemByNumber = new Map(context.parsed.items.map((item) => [item.item_number, item]));
  const itemFacts = (itemNumber: number) => {
    const item = itemByNumber.get(itemNumber);
    return {
      item_number: itemNumber,
      original_item_number: item?.original_item_number ?? itemNumber,
      transaction_type: item?.transaction_type ?? null,
      quantity: item?.quantity ?? null,
      unit: item?.unit ?? null,
      raw_unit: item?.raw_unit ?? item?.unit ?? null,
      price_per_unit: item?.price_per_unit ?? null,
    };
  };

  const issues: DataQualityIssueCandidate[] = [];
  for (const item of context.parsed.items) {
    if (item.original_item_number === undefined) continue;
    issues.push({
      category: "produce_item_renumbered",
      businessDate,
      entityRefs: [sessionRef, `item:${item.item_number}`],
      summaryTh: `เลขข้อ ${item.original_item_number} ถูกจัดลำดับใหม่เป็นข้อ ${item.item_number} (${item.product_name})`,
      technicalContext: {
        ...base,
        ...itemFacts(item.item_number),
        product_name: item.product_name,
        reason: "duplicate_missing_or_out_of_order_item_number",
      },
    });
  }

  for (const entry of context.reconciliation) {
    switch (entry.kind) {
      case "unknown_product_vocabulary":
      case "product_not_withdrawn":
        issues.push({
          category: "produce_unknown_product",
          businessDate,
          entityRefs: [sessionRef, `item:${entry.itemNumber}`],
          summaryTh: entry.kind === "unknown_product_vocabulary"
            ? `ชื่อสินค้า “${entry.productName}” ไม่อยู่ในรายการมาตรฐาน (บันทึกตามที่กรอก)`
            : `“${entry.productName}” ไม่พบในรายการเบิกของรอบนี้ (บันทึกตามที่กรอก)`,
          technicalContext: {
            ...base,
            ...itemFacts(entry.itemNumber),
            product_name: entry.productName,
            reason: entry.kind === "unknown_product_vocabulary"
              ? "not_in_product_dictionary"
              : "not_withdrawn_in_round",
            suggestions: entry.suggestions,
          },
        });
        break;
      case "unit_not_withdrawn":
        issues.push({
          category: "produce_unit_mismatch",
          businessDate,
          entityRefs: [sessionRef, `item:${entry.itemNumber}`],
          summaryTh: `“${entry.productName}” ชั่งคืนเป็น ${entry.unit} แต่เบิกเป็น ${entry.withdrawnUnits.join(", ")} (ไม่แปลงหน่วย)`,
          technicalContext: {
            ...base,
            ...itemFacts(entry.itemNumber),
            product_name: entry.productName,
            withdrawn_units: entry.withdrawnUnits,
            reason: "unit_not_withdrawn",
          },
        });
        break;
      case "return_exceeds_withdrawal":
        issues.push({
          category: "produce_return_exceeds_withdrawal",
          businessDate,
          entityRefs: [sessionRef, `product:${entry.productName}|${entry.unit}`],
          summaryTh: `“${entry.productName}” คืนเกินยอดเบิก ${entry.excessQuantity} ${entry.unit} (บันทึกตามที่กรอก)`,
          technicalContext: {
            ...base,
            product_name: entry.productName,
            unit: entry.unit,
            withdrawn_quantity: entry.withdrawnQuantity,
            good_return_quantity: entry.goodReturnQuantity,
            damaged_quantity: entry.damagedQuantity,
            excess_quantity: entry.excessQuantity,
            reason: "return_exceeds_recorded_withdrawal",
          },
        });
        break;
    }
  }
  return issues;
}
