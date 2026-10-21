import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import {
  buildHouseStockReport,
  fetchAuthoritativeHouseStockItems,
} from "@/lib/physical-inventory/house-stock-report";
import { quantityTimesSatang, toMilliQuantity } from "@/lib/sales/calculate";
import { fetchSalesProduceRows, loadSalesReport, loadProduceFailureScan, type SalesMarketFilter } from "@/lib/sales/load";
import { canonicalMarketLabel } from "@/lib/market";
import { isQaMarketLabel } from "@/lib/sales/qa-scopes";
import { fetchReconciliationReport } from "@/lib/reconciliation-report-service";
import { summarizeReconciliationReport } from "@/lib/reconciliation-report";
import { baseTransactionType } from "@/lib/summary/transactions";
import { loadPurchasePlanningReport } from "@/lib/summary/purchase-planning-service";
import {
  morningBriefProductIdentity,
  summarizePurchasePlanning,
  summarizeSales,
  type MorningBriefHouseStock,
  type MorningBriefHouseStockItem,
  type MorningBriefReconciliation,
  type MorningBriefReport,
  type MorningBriefProduceReadiness,
  type MorningBriefWhiteSheetStatus,
  type MorningBriefScope,
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
  reportScope?: MorningBriefScope,
): Promise<MorningBriefHouseStock> {
  // The warehouse snapshot has no allocation to the vegetable market.
  if (reportScope === "vegetable") return { status: "missing" };
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
  marketFilter?: SalesMarketFilter,
): Promise<MorningBriefReconciliation> {
  try {
    const report = await fetchReconciliationReport(supabase, {
      fromDate: businessDate,
      toDate: businessDate,
    });
    const rows = report.rows.filter((row) => !marketFilter || marketFilter(row.market, row.accountability_round_id));
    if (rows.length === 0) return { status: "missing" };
    const summary = summarizeReconciliationReport(rows);
    return {
      status: "available",
      submittedTransferBaht: summary.submitted_transfer_total,
      checkedSlipBaht: summary.checked_slip_total,
      differenceBaht: summary.difference_total,
      needsReviewCount: summary.needs_review_count,
      rows: rows.map((row) => ({
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
  marketFilter?: SalesMarketFilter,
): Promise<MorningBriefWhiteSheetStatus> {
  try {
    const { data, error } = await supabase
      .from("digital_white_sheet_cash_entries")
      .select("white_sheet_sales, market_label_normalized, accountability_round_id")
      .eq("business_date", businessDate);
    if (error) throw error;
    return (data ?? []).some((row) => row.white_sheet_sales !== null
      && (!marketFilter || marketFilter(row.market_label_normalized, row.accountability_round_id)))
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
    let pendingReviewSalesSatang = 0;
    let unavailableCount = 0;
    let awaitingReturnCount = 0;
    let goodReturnValueSatang = 0;
    for (const row of sectionRows) {
      const priceSatang = row.enteredPriceSatang ?? row.centralPriceSatang;
      withdrawalValueSatang += row.recordedWithdrawalSatang !== undefined
        ? row.recordedWithdrawalSatang ?? 0
        : priceSatang == null ? 0 : quantityTimesSatang(row.withdrawnQuantity, priceSatang) ?? 0;
      goodReturnValueSatang += row.recordedGoodReturnSatang !== undefined
        ? row.recordedGoodReturnSatang ?? 0
        : priceSatang == null ? 0 : quantityTimesSatang(row.goodReturnQuantity, priceSatang) ?? 0;
      salesValueSatang += row.expectedSalesSatang ?? 0;
      pendingReviewSalesSatang += row.pendingReviewSalesSatang ?? 0;
      if (row.valueStatus === "UNAVAILABLE") unavailableCount += 1;
      if (row.reasons.includes("missing_return_evidence")) awaitingReturnCount += 1;
    }

    return [{
      marketLabel: market.marketLabel,
      withdrawalValueSatang,
      salesValueSatang,
      pendingReviewSalesSatang,
      unavailableCount,
      awaitingReturnCount,
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
    pendingReviewSalesSatang: markets.reduce((sum, market) => sum + market.pendingReviewSalesSatang, 0),
    unavailableCount: markets.reduce((sum, market) => sum + market.unavailableCount, 0),
    awaitingReturnCount: markets.reduce((sum, market) => sum + market.awaitingReturnCount, 0),
    goodReturnValueSatang,
    houseStockValueSatang,
    readyValueSatang: houseStockValueSatang == null ? null : goodReturnValueSatang + houseStockValueSatang,
    markets,
  };
}

/** Recorded documents are evidence, not confirmation of completeness. */
export function summarizeReadiness(rows: readonly Pick<Awaited<ReturnType<typeof fetchSalesProduceRows>>[number], "market_name" | "base_transaction_type">[]): MorningBriefProduceReadiness {
  const markets = new Map<string, MorningBriefProduceReadiness["markets"][number]>();
  let transactionCount = 0;
  for (const row of rows) {
    const label = canonicalMarketLabel(row.market_name) || "ตลาดไม่ชัด";
    if (isQaMarketLabel(label)) continue;
    transactionCount += 1;
    const entry = markets.get(label) ?? { marketLabel: label, hasWithdrawal: false, hasReturn: false };
    if (row.base_transaction_type === "เบิก") entry.hasWithdrawal = true;
    // Damaged returns ("เสีย") are not evidence of a good-return weighing sheet.
    if (row.base_transaction_type === "คืน") entry.hasReturn = true;
    markets.set(label, entry);
  }
  return { transactionCount, markets: [...markets.values()].sort((a,b) => a.marketLabel.localeCompare(b.marketLabel, "th")) };
}

export async function loadMorningBriefReport(
  supabase: Supabase,
  businessDate: string,
  reportScope?: MorningBriefScope,
): Promise<MorningBriefReport> {
  const allRows = await fetchSalesProduceRows(supabase, businessDate);
  const roundMarkets = new Map<string, string>();
  if (reportScope) {
    const ids = [...new Set(allRows.flatMap((row) => row.accountability_round_id ? [row.accountability_round_id] : []))];
    for (let offset = 0; offset < ids.length; offset += 500) {
      // Round tables use the same ungenerated schema boundary as round-return-status.
      const { data, error } = await (supabase as SupabaseClient).from("accountability_rounds")
        .select("id, market_label").in("id", ids.slice(offset, offset + 500));
      if (error) throw new Error(`morning brief market scope lookup failed: ${error.message}`);
      for (const round of (data ?? []) as { id: string; market_label: string | null }[]) roundMarkets.set(round.id, canonicalMarketLabel(round.market_label));
    }
  }
  const marketFilter: SalesMarketFilter | undefined = reportScope ? (market, roundId) => {
    const label = (roundId && roundMarkets.get(roundId)) || canonicalMarketLabel(market);
    if (isQaMarketLabel(label)) return false;
    const vegetable = label === "พาซิโอ้ผัก";
    return reportScope === "vegetable" ? vegetable : !vegetable;
  } : undefined;
  const produceRows = allRows.filter((row) => !marketFilter || marketFilter(row.market_name, row.accountability_round_id));
  const [houseStock, failures] = await Promise.all([
    loadHouseStock(supabase, businessDate, reportScope),
    loadProduceFailureScan(supabase, businessDate, marketFilter),
  ]);
  const [purchasePlanning, sales, reconciliation, whiteSheetStatus] = await Promise.all([
    loadPurchasePlanningReport(supabase, businessDate, { rows: produceRows, marketFilter, failures,
      houseStock: reportScope === "vegetable" ? { status: "none" } : undefined }),
    loadSalesReport(supabase, businessDate, { requireReturnEvidence: true, rows: produceRows, marketFilter, failures, roundMarketLabels: roundMarkets }),
    loadReconciliation(supabase, businessDate, marketFilter),
    loadWhiteSheetStatus(supabase, businessDate, marketFilter),
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
    ...(reportScope ? {
      reportScope,
      readiness: morningBriefReadiness(produceRows, reportScope),
      salesDetails: sales.markets.flatMap((market) => market.rows),
      sourceTransactions: produceRows.map((row) => ({ id: row.id, sessionId: row.session_id, accountabilityRoundId: row.accountability_round_id })),
    } : {}),
    businessDate,
    purchasePlanning: summarizePurchasePlanning(purchasePlanning),
    sales: summarizeSales(sales),
    fruitFinancial: produceFinancial.fruit,
    produceFinancial,
    houseStock,
    whiteSheetStatus,
    produceReadiness: summarizeReadiness(produceRows.map((row) => ({ ...row,
      market_name: (row.accountability_round_id && roundMarkets.get(row.accountability_round_id)) || row.market_name }))),
    reconciliation,
  };
}

/** Both document kinds must share a non-legacy round; never join by market alone. */
export function morningBriefReadiness(
  rows: readonly Pick<Awaited<ReturnType<typeof fetchSalesProduceRows>>[number], "accountability_round_id" | "transaction_type">[],
  reportScope: MorningBriefScope,
): NonNullable<MorningBriefReport["readiness"]> {
  if (reportScope === "fruit") return { status: "ready", reasons: [] };
  const withdrawals = new Set<string>();
  const returns = new Set<string>();
  let unboundRound = false;
  for (const row of rows) {
    if (!row.accountability_round_id) {
      unboundRound = true;
      continue;
    }
    const kind = baseTransactionType(row.transaction_type);
    if (kind === "เบิก") withdrawals.add(row.accountability_round_id);
    if (kind === "คืน") returns.add(row.accountability_round_id);
  }
  const reasons: string[] = [];
  if (unboundRound) reasons.push("unbound_accountability_round");
  if (withdrawals.size === 0) reasons.push("missing_withdrawal");
  if (returns.size === 0) reasons.push("missing_good_return");
  if (withdrawals.size && returns.size && ![...withdrawals].some((id) => returns.has(id))) reasons.push("no_matching_accountability_round");
  return { status: reasons.length ? "not_ready" : "ready", reasons };
}
