import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import { fetchAuthoritativeHouseStockItems } from "@/lib/physical-inventory/house-stock-report";
import { quantityTimesSatang, toMilliQuantity } from "@/lib/sales/calculate";
import { loadSalesReport } from "@/lib/sales/load";
import { fetchReconciliationReport } from "@/lib/reconciliation-report-service";
import { loadPurchasePlanningReport } from "@/lib/summary/purchase-planning-service";
import {
  isMorningBriefFruitCategory,
  morningBriefProductIdentity,
  summarizePurchasePlanning,
  summarizeSales,
  type MorningBriefHouseStock,
  type MorningBriefHouseStockItem,
  type MorningBriefReconciliation,
  type MorningBriefReport,
} from "@/lib/summary/morning-brief";

type Supabase = SupabaseClient<Database>;
type HouseRow = Database["public"]["Tables"]["physical_inventory_items"]["Row"];

function summarizeHouseStockRows(rows: readonly HouseRow[]): MorningBriefHouseStockItem[] {
  const groups = new Map<string, MorningBriefHouseStockItem & { quantityMilli: bigint }>();
  for (const row of rows) {
    const rawProduct = row.normalized_product?.trim() || row.raw_product_description?.trim();
    const unit = row.normalized_unit?.trim() || row.raw_unit?.trim();
    if (!rawProduct || !unit) continue;
    const quantity = Number(row.quantity);
    const unitPriceSatang = Number(row.unit_price_satang);
    const quantityMilli = toMilliQuantity(quantity);
    const valueSatang = quantityTimesSatang(quantity, unitPriceSatang);
    if (quantityMilli === null || valueSatang === null || !Number.isSafeInteger(unitPriceSatang)) continue;

    const identity = morningBriefProductIdentity(rawProduct, unit);
    const key = JSON.stringify([rawProduct, unit, unitPriceSatang]);
    const group = groups.get(key) ?? {
      productName: identity.productName,
      category: identity.category,
      unit,
      quantity: 0,
      quantityMilli: BigInt(0),
      unitPriceSatang,
      valueSatang: 0,
    };
    group.quantityMilli += quantityMilli;
    group.quantity = Number(group.quantityMilli) / 1000;
    group.valueSatang += valueSatang;
    groups.set(key, group);
  }
  return [...groups.values()].map(({ quantityMilli, ...group }) => {
    void quantityMilli;
    return group;
  });
}

async function loadHouseStock(
  supabase: Supabase,
  businessDate: string,
): Promise<MorningBriefHouseStock> {
  try {
    const snapshot = await fetchAuthoritativeHouseStockItems(supabase, businessDate);
    if (!snapshot) return { status: "missing" };
    const items = summarizeHouseStockRows(snapshot.items)
      .filter((item) => isMorningBriefFruitCategory(item.category));
    return {
      status: "available",
      groupCount: items.length,
      totalValueSatang: items.reduce((sum, item) => sum + item.valueSatang, 0),
      items,
    };
  } catch (error) {
    logger.warn("morning brief house stock unavailable", {
      businessDate,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "unavailable" };
  }
}

async function loadReconciliation(
  supabase: Supabase,
  businessDate: string,
): Promise<MorningBriefReconciliation> {
  try {
    const report = await fetchReconciliationReport(supabase, {
      fromDate: businessDate,
      toDate: businessDate,
    });
    if (report.rows.length === 0) return { status: "missing" };
    return {
      status: "available",
      submittedTransferBaht: report.summary.submitted_transfer_total,
      checkedSlipBaht: report.summary.checked_slip_total,
      differenceBaht: report.summary.difference_total,
      needsReviewCount: report.summary.needs_review_count,
      rows: report.rows.map((row) => ({
        market: row.market,
        submittedTransferBaht: row.submitted_transfer_total,
        checkedSlipBaht: row.checked_slip_total,
        differenceBaht: row.difference,
        status: row.status,
      })),
    };
  } catch (error) {
    logger.warn("morning brief reconciliation unavailable", {
      businessDate,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "unavailable" };
  }
}

export async function loadMorningBriefReport(
  supabase: Supabase,
  businessDate: string,
): Promise<MorningBriefReport> {
  const [purchasePlanning, sales, houseStock, reconciliation] = await Promise.all([
    loadPurchasePlanningReport(supabase, businessDate),
    loadSalesReport(supabase, businessDate),
    loadHouseStock(supabase, businessDate),
    loadReconciliation(supabase, businessDate),
  ]);

  const summarizedSales = summarizeSales(sales);
  const returnGapKeys = new Set(
    (summarizedSales.reviewItems ?? [])
      .filter((item) => item.returnEvidenceIncomplete || item.reasons.includes("product_return_absent"))
      .map((item) => JSON.stringify([item.productName, item.unit])),
  );
  const purchasePlanningForBrief = {
    ...purchasePlanning,
    items: purchasePlanning.items.map((item) => {
      const identity = morningBriefProductIdentity(item.productName, item.unit);
      const hasReturnGap = returnGapKeys.has(JSON.stringify([identity.productName, item.unit]));
      if (!hasReturnGap) return item;
      return {
        ...item,
        status: "unknown" as const,
        uncertaintyReasons: item.uncertaintyReasons.includes("product_return_absent")
          ? item.uncertaintyReasons
          : [...item.uncertaintyReasons, "product_return_absent" as const],
      };
    }),
  };

  return {
    businessDate,
    purchasePlanning: summarizePurchasePlanning(purchasePlanningForBrief),
    sales: summarizedSales,
    houseStock,
    reconciliation,
  };
}
