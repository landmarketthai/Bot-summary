import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import {
  buildHouseStockReport,
  fetchAuthoritativeHouseStockItems,
} from "@/lib/physical-inventory/house-stock-report";
import { quantityTimesSatang, toMilliQuantity } from "@/lib/sales/calculate";
import { loadSalesReport } from "@/lib/sales/load";
import { loadPurchasePlanningReport } from "@/lib/summary/purchase-planning-service";
import {
  morningBriefProductIdentity,
  summarizePurchasePlanning,
  summarizeSales,
  type MorningBriefHouseStock,
  type MorningBriefHouseStockItem,
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
    const report = buildHouseStockReport(snapshot.businessDate, snapshot.items);
    return {
      status: "available",
      groupCount: report.groupCount,
      totalValueSatang: report.totalValueSatang,
      items: summarizeHouseStockRows(snapshot.items),
    };
  } catch (error) {
    logger.warn("morning brief house stock unavailable", {
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
  const [purchasePlanning, sales, houseStock] = await Promise.all([
    loadPurchasePlanningReport(supabase, businessDate),
    loadSalesReport(supabase, businessDate),
    loadHouseStock(supabase, businessDate),
  ]);

  return {
    businessDate,
    purchasePlanning: summarizePurchasePlanning(purchasePlanning),
    sales: summarizeSales(sales),
    houseStock,
  };
}
