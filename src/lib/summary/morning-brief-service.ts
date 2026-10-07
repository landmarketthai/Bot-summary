import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import {
  buildHouseStockReport,
  fetchAuthoritativeHouseStockItems,
} from "@/lib/physical-inventory/house-stock-report";
import { quantityTimesSatang, toMilliQuantity } from "@/lib/sales/calculate";
import { loadSalesReport } from "@/lib/sales/load";
import { fetchReconciliationReport } from "@/lib/reconciliation-report-service";
import { loadPurchasePlanningReport } from "@/lib/summary/purchase-planning-service";
import {
  morningBriefProductIdentity,
  summarizePurchasePlanning,
  summarizeSales,
  type MorningBriefHouseStock,
  type MorningBriefHouseStockItem,
  type MorningBriefReconciliation,
  type MorningBriefReport,
  type MorningBriefWhiteSheetStatus,
} from "@/lib/summary/morning-brief";

import { PRODUCE_SECTIONS, produceSectionOf, type ProduceSection } from "@/lib/summary/produce-section";

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

async function loadWhiteSheetStatus(
  supabase: Supabase,
  businessDate: string,
): Promise<MorningBriefWhiteSheetStatus> {
  try {
    const { data, error } = await supabase
      .from("digital_white_sheet_cash_entries")
      .select("white_sheet_sales")
      .eq("business_date", businessDate);
    if (error) throw error;
    return (data ?? []).some((row) => row.white_sheet_sales !== null)
      ? "entered"
      : "missing";
  } catch (error) {
    logger.warn("morning brief white sheet unavailable", {
      businessDate,
      error: error instanceof Error ? error.message : String(error),
    });
    return "unavailable";
  }
}

export function summarizeProduceFinancial(
  salesReport: Awaited<ReturnType<typeof loadSalesReport>>,
  houseStock: MorningBriefHouseStock,
  section: ProduceSection,
) {
  const markets = salesReport.markets.flatMap((market) => {
    const sectionRows = market.rows.filter(
      (row) => produceSectionOf(morningBriefProductIdentity(row.productName, row.unit).productName) === section,
    );
    if (sectionRows.length === 0) return [];

    let withdrawalValueSatang = 0;
    let salesValueSatang = 0;
    let goodReturnValueSatang = 0;
    for (const row of sectionRows) {
      const priceSatang = row.enteredPriceSatang ?? row.centralPriceSatang;
      if (priceSatang != null) {
        withdrawalValueSatang += quantityTimesSatang(row.withdrawnQuantity, priceSatang) ?? 0;
        goodReturnValueSatang += quantityTimesSatang(row.goodReturnQuantity, priceSatang) ?? 0;
      }
      salesValueSatang += (row.expectedSalesSatang ?? 0) + (row.pendingReviewSalesSatang ?? 0);
    }

    return [{
      marketLabel: market.marketLabel,
      withdrawalValueSatang,
      salesValueSatang,
      goodReturnValueSatang,
    }];
  });

  const withdrawalValueSatang = markets.reduce((sum, market) => sum + market.withdrawalValueSatang, 0);
  const salesValueSatang = markets.reduce((sum, market) => sum + market.salesValueSatang, 0);
  const goodReturnValueSatang = markets.reduce((sum, market) => sum + market.goodReturnValueSatang, 0);
  const houseStockValueSatang = houseStock.status === "available"
    ? (houseStock.items ?? [])
      .filter((item) => produceSectionOf(morningBriefProductIdentity(item.productName, item.unit).productName) === section)
      .reduce((sum, item) => sum + item.valueSatang, 0)
    : null;

  return {
    withdrawalValueSatang,
    salesValueSatang,
    goodReturnValueSatang,
    houseStockValueSatang,
    readyValueSatang: houseStockValueSatang == null ? null : goodReturnValueSatang + houseStockValueSatang,
    markets,
  };
}

export async function loadMorningBriefReport(
  supabase: Supabase,
  businessDate: string,
): Promise<MorningBriefReport> {
  const [purchasePlanning, sales, houseStock, reconciliation, whiteSheetStatus] = await Promise.all([
    loadPurchasePlanningReport(supabase, businessDate),
    loadSalesReport(supabase, businessDate),
    loadHouseStock(supabase, businessDate),
    loadReconciliation(supabase, businessDate),
    loadWhiteSheetStatus(supabase, businessDate),
  ]);

  const produceFinancial: NonNullable<MorningBriefReport["produceFinancial"]> = {};
  for (const section of PRODUCE_SECTIONS) {
    const summary = summarizeProduceFinancial(sales, houseStock, section);
    // A section with neither sales rows nor actual house stock has no page or heading.
    if (summary.markets.length > 0 || (summary.houseStockValueSatang ?? 0) !== 0
      || (houseStock.status === "available" && (houseStock.items ?? []).some((item) =>
        item.quantity > 0 && produceSectionOf(morningBriefProductIdentity(item.productName, item.unit).productName) === section))) {
      produceFinancial[section] = summary;
    }
  }

  return {
    businessDate,
    purchasePlanning: summarizePurchasePlanning(purchasePlanning),
    sales: summarizeSales(sales),
    fruitFinancial: produceFinancial.fruit,
    produceFinancial,
    houseStock,
    whiteSheetStatus,
    reconciliation,
  };
}
