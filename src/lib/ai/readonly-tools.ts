import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { canonicalMarketLabel } from "@/lib/market";
import {
  fetchSalesProduceRows,
  loadSalesReport,
  loadProduceFailureScan,
} from "@/lib/sales/load";
import {
  getDailyFinancialSettlement,
  type DailyFinancialSettlementResult,
} from "@/lib/settlement/daily-financial-settlement";
import { loadStockSummary } from "@/lib/summary/stock-summary-service";

type Supabase = SupabaseClient<Database>;
type ProduceTransactionRow = Database["public"]["Views"]["produce_transactions"]["Row"];

export type ReadonlyAnalystToolName =
  | "get_daily_summary"
  | "get_market_summary"
  | "get_stock_summary"
  | "get_market_stock"
  | "get_pending_items"
  | "get_staff_settlement"
  | "get_market_settlement"
  | "get_settlement_overview"
  | "compare_daily_sales";

export type ReadonlyAnalystToolRequest =
  | { tool: "get_daily_summary"; businessDate: string }
  | { tool: "get_market_summary"; businessDate: string; market: string }
  | { tool: "get_stock_summary"; businessDate: string }
  | { tool: "get_market_stock"; businessDate: string; market: string }
  | { tool: "get_pending_items"; businessDate: string }
  | { tool: "get_staff_settlement"; businessDate: string; staff: string }
  | { tool: "get_market_settlement"; businessDate: string; market: string }
  | { tool: "get_settlement_overview"; businessDate: string }
  | { tool: "compare_daily_sales"; businessDate: string; days: number };

function satangToBaht(satang: number): number {
  return satang / 100;
}

function compactTotal(total: {
  expectedSalesSatang: number;
  pendingReviewSalesSatang: number;
  totalSalesSatang: number;
  adjustmentSatang: number;
  quantityAuthoritative: boolean;
  valueAuthoritative: boolean;
  trustedRowCount: number;
  valueBlockedRowCount: number;
  quantityBlockedRowCount: number;
}) {
  return {
    confirmedSalesBaht: satangToBaht(total.expectedSalesSatang),
    pendingReviewSalesBaht: satangToBaht(total.pendingReviewSalesSatang),
    calculatedSalesBaht: satangToBaht(total.totalSalesSatang),
    priceAdjustmentBaht: satangToBaht(total.adjustmentSatang),
    quantityAuthoritative: total.quantityAuthoritative,
    valueAuthoritative: total.valueAuthoritative,
    trustedRowCount: total.trustedRowCount,
    valueBlockedRowCount: total.valueBlockedRowCount,
    quantityBlockedRowCount: total.quantityBlockedRowCount,
  };
}

function normalizeStaffName(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\s+/g, "")
    .replace(/^(?:พี่|น้อง|คุณ|เจ๊|ป้า|ลุง)/u, "")
    .trim();
}

function previousIsoDate(value: string, days = 1): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function compactSettlement(result: DailyFinancialSettlementResult) {
  return {
    status: result.status,
    market: result.marketLabelNormalized,
    businessDate: result.businessDate,
    whiteSheetSalesBaht: result.whiteSheetSales,
    transferTotalBaht: result.transferTotal,
    ownerCashBaht: result.ownerCash,
    expensesTotalBaht: result.expensesTotal,
    wagesTotalBaht: result.wagesTotal,
    expectedCashBaht: result.expectedCash,
    actualCashBaht: result.actualCash,
    cashDifferenceBaht: result.difference,
    missingInputs: result.missingInputs,
    uncertainty: result.uncertainty,
  };
}

function marketSetFromProduceRows(rows: readonly ProduceTransactionRow[]): Set<string> {
  return new Set(
    rows
      .map((row) => canonicalMarketLabel(row.market_name))
      .filter((value) => value.length > 0),
  );
}

async function sourceByRawMessageId(
  supabase: Supabase,
  rawMessageIds: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = [...new Set(rawMessageIds)].filter(Boolean);
  const chunkSize = 400;

  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const ids = unique.slice(offset, offset + chunkSize);
    const { data, error } = await supabase
      .from("raw_messages")
      .select("id, source_id")
      .in("id", ids);

    if (error) {
      throw new Error(`analyst raw-message source lookup failed: ${error.message}`);
    }
    for (const row of data ?? []) result.set(row.id, row.source_id);
  }

  return result;
}

type ProduceSettlementIdentity = {
  sourceId: string;
  market: string;
  accountabilityRoundId: string | null;
  staff: string;
};

async function produceSettlementIdentitiesForStaff(
  supabase: Supabase,
  businessDate: string,
  staffQuery: string,
): Promise<{
  identities: ProduceSettlementIdentity[];
  matchedRows: number;
  unresolvedSourceRows: number;
  knownMarkets: Set<string>;
}> {
  const rows = await fetchSalesProduceRows(supabase, businessDate);
  const target = normalizeStaffName(staffQuery);
  const matches = rows.filter((row) => normalizeStaffName(row.staff_name) === target);
  const sourceMap = await sourceByRawMessageId(
    supabase,
    matches.map((row) => row.raw_message_id),
  );
  const dedupe = new Map<string, ProduceSettlementIdentity>();
  let unresolvedSourceRows = 0;

  for (const row of matches) {
    const market = canonicalMarketLabel(row.market_name);
    const sourceId = sourceMap.get(row.raw_message_id);
    if (!market || !sourceId) {
      unresolvedSourceRows += 1;
      continue;
    }
    const roundId = row.accountability_round_id ?? null;
    const key = `${sourceId}\u0001${market}\u0001${roundId ?? ""}`;
    if (!dedupe.has(key)) {
      dedupe.set(key, {
        sourceId,
        market,
        accountabilityRoundId: roundId,
        staff: row.staff_name,
      });
    }
  }

  return {
    identities: [...dedupe.values()],
    matchedRows: matches.length,
    unresolvedSourceRows,
    knownMarkets: marketSetFromProduceRows(rows),
  };
}

async function staffByMarketForDate(
  supabase: Supabase,
  businessDate: string,
): Promise<Map<string, string[]>> {
  const rows = await fetchSalesProduceRows(supabase, businessDate);
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const market = canonicalMarketLabel(row.market_name);
    if (!market) continue;
    const names = map.get(market) ?? new Set<string>();
    names.add(row.staff_name);
    map.set(market, names);
  }
  return new Map([...map.entries()].map(([market, names]) => [market, [...names]]));
}

export async function getDailySummaryTool(
  supabase: Supabase,
  businessDate: string,
) {
  const report = await loadSalesReport(supabase, businessDate);
  return {
    tool: "get_daily_summary" as const,
    businessDate,
    total: compactTotal(report.allMarkets),
    markets: report.markets.map((market) => ({
      market: market.marketLabel,
      ...compactTotal(market.total),
    })),
    blockedIdentityCount: report.blocked.length,
    scopeBlockers: report.scopeBlockers,
  };
}

export async function getMarketSummaryTool(
  supabase: Supabase,
  businessDate: string,
  marketName: string,
) {
  const report = await loadSalesReport(supabase, businessDate);
  const target = canonicalMarketLabel(marketName);
  const matches = report.markets.filter(
    (market) => canonicalMarketLabel(market.marketLabel) === target,
  );

  return {
    tool: "get_market_summary" as const,
    businessDate,
    requestedMarket: marketName,
    canonicalMarket: target,
    found: matches.length > 0,
    matches: matches.map((market) => ({
      market: market.marketLabel,
      total: compactTotal(market.total),
      rows: market.rows.map((row) => ({
        product: row.productName,
        unit: row.unit,
        withdrawnQuantity: row.withdrawnQuantity,
        goodReturnQuantity: row.goodReturnQuantity,
        damagedReturnQuantity: row.damagedReturnQuantity,
        soldQuantity: row.soldQuantity,
        valueStatus: row.valueStatus,
        status: row.status,
        reasons: row.reasons,
      })),
    })),
  };
}

export async function getStockSummaryTool(
  supabase: Supabase,
  businessDate: string,
) {
  const summary = await loadStockSummary(supabase, businessDate);
  return {
    tool: "get_stock_summary" as const,
    businessDate,
    semantics: "daily_good_returns_sellable_stock_not_perpetual_inventory",
    isComplete: summary.isComplete,
    categories: summary.categories,
    incompleteCount: summary.incomplete.length,
    incomplete: summary.incomplete.slice(0, 40),
    unidentified: summary.unidentified,
    markets: summary.detail.markets.map((market) => ({
      market: market.marketName,
      items: market.items
        .filter((item) => item.hasReturnGoodData)
        .map((item) => ({
          product: item.fruitName,
          unit: item.unit,
          remainingForResaleQuantity: item.remainingForResaleQuantity,
          damagedQuantity: item.damagedQuantity,
        })),
    })),
  };
}

export async function getMarketStockTool(
  supabase: Supabase,
  businessDate: string,
  marketName: string,
) {
  const summary = await loadStockSummary(supabase, businessDate);
  const target = canonicalMarketLabel(marketName);
  const markets = summary.detail.markets.filter(
    (market) => canonicalMarketLabel(market.marketName) === target,
  );
  const incomplete = summary.incomplete.filter(
    (item) => canonicalMarketLabel(item.marketName) === target,
  );

  return {
    tool: "get_market_stock" as const,
    businessDate,
    semantics: "daily_good_returns_sellable_stock_not_perpetual_inventory",
    requestedMarket: marketName,
    canonicalMarket: target,
    found: markets.length > 0,
    isComplete: incomplete.length === 0,
    incomplete,
    markets: markets.map((market) => ({
      market: market.marketName,
      items: market.items.map((item) => ({
        product: item.fruitName,
        unit: item.unit,
        withdrawnQuantity: item.withdrawnQuantity,
        goodReturnQuantity: item.returnGoodQuantity,
        damagedQuantity: item.damagedQuantity,
        remainingForResaleQuantity: item.remainingForResaleQuantity,
        hasReturnGoodData: item.hasReturnGoodData,
      })),
    })),
  };
}

export async function getPendingItemsTool(
  supabase: Supabase,
  businessDate: string,
) {
  const scan = await loadProduceFailureScan(supabase, businessDate);
  const classificationById = new Map(
    scan.classifications.map((row) => [row.attemptId, row]),
  );

  const active = scan.attempts
    .filter((attempt) => scan.activeIds.has(attempt.attemptId))
    .map((attempt) => {
      const classification = classificationById.get(attempt.attemptId);
      return {
        attemptId: attempt.attemptId,
        origin: attempt.origin,
        businessDate: attempt.businessDate,
        staff: attempt.staffLabel,
        market: attempt.marketLabel,
        transactionKind: attempt.transactionKind,
        accountabilityRoundId: attempt.accountabilityRoundId,
        ambiguousSuccessor: classification?.ambiguousSuccessor ?? false,
      };
    });

  return {
    tool: "get_pending_items" as const,
    businessDate,
    activeCount: active.length,
    items: active,
  };
}

export async function getStaffSettlementTool(
  supabase: Supabase,
  businessDate: string,
  staff: string,
) {
  const resolved = await produceSettlementIdentitiesForStaff(
    supabase,
    businessDate,
    staff,
  );

  const settlements = await Promise.all(
    resolved.identities.map(async (identity) => ({
      staff: identity.staff,
      sourceId: identity.sourceId,
      accountabilityRoundId: identity.accountabilityRoundId,
      ...(compactSettlement(await getDailyFinancialSettlement(
        supabase,
        {
          sourceId: identity.sourceId,
          marketLabelNormalized: identity.market,
          businessDate,
          accountabilityRoundId: identity.accountabilityRoundId,
        },
        { knownMarkets: resolved.knownMarkets },
      ))),
    })),
  );

  return {
    tool: "get_staff_settlement" as const,
    businessDate,
    requestedStaff: staff,
    found: resolved.matchedRows > 0,
    matchedProduceRows: resolved.matchedRows,
    unresolvedSourceRows: resolved.unresolvedSourceRows,
    settlements,
  };
}

export async function getMarketSettlementTool(
  supabase: Supabase,
  businessDate: string,
  marketName: string,
) {
  const target = canonicalMarketLabel(marketName);
  const [{ data, error }, produceRows] = await Promise.all([
    supabase
      .from("digital_white_sheet_cash_entries")
      .select("source_id, market_label_normalized, accountability_round_id")
      .eq("business_date", businessDate),
    fetchSalesProduceRows(supabase, businessDate),
  ]);
  if (error) throw new Error(`analyst market settlement lookup failed: ${error.message}`);

  const knownMarkets = marketSetFromProduceRows(produceRows);
  const identities = (data ?? []).filter(
    (row) => canonicalMarketLabel(row.market_label_normalized) === target,
  );
  const settlements = await Promise.all(
    identities.map(async (identity) => compactSettlement(
      await getDailyFinancialSettlement(
        supabase,
        {
          sourceId: identity.source_id,
          marketLabelNormalized: canonicalMarketLabel(identity.market_label_normalized),
          businessDate,
          accountabilityRoundId: identity.accountability_round_id,
        },
        { knownMarkets },
      ),
    )),
  );

  return {
    tool: "get_market_settlement" as const,
    businessDate,
    requestedMarket: marketName,
    canonicalMarket: target,
    found: identities.length > 0,
    settlements,
  };
}

export async function getSettlementOverviewTool(
  supabase: Supabase,
  businessDate: string,
) {
  const [{ data, error }, produceRows, staffByMarket] = await Promise.all([
    supabase
      .from("digital_white_sheet_cash_entries")
      .select("source_id, market_label_normalized, accountability_round_id")
      .eq("business_date", businessDate),
    fetchSalesProduceRows(supabase, businessDate),
    staffByMarketForDate(supabase, businessDate),
  ]);
  if (error) throw new Error(`analyst settlement overview lookup failed: ${error.message}`);

  const knownMarkets = marketSetFromProduceRows(produceRows);
  const settlements = await Promise.all(
    (data ?? []).map(async (identity) => {
      const market = canonicalMarketLabel(identity.market_label_normalized);
      return {
        staff: staffByMarket.get(market) ?? [],
        ...(compactSettlement(await getDailyFinancialSettlement(
          supabase,
          {
            sourceId: identity.source_id,
            marketLabelNormalized: market,
            businessDate,
            accountabilityRoundId: identity.accountability_round_id,
          },
          { knownMarkets },
        ))),
      };
    }),
  );

  return {
    tool: "get_settlement_overview" as const,
    businessDate,
    settlementCount: settlements.length,
    settlements,
  };
}

export async function compareDailySalesTool(
  supabase: Supabase,
  businessDate: string,
  requestedDays: number,
) {
  const days = Math.min(7, Math.max(2, Math.trunc(requestedDays || 2)));
  const dates = Array.from({ length: days }, (_, index) => previousIsoDate(businessDate, index));
  const reports = await Promise.all(dates.map((date) => loadSalesReport(supabase, date)));

  return {
    tool: "compare_daily_sales" as const,
    businessDate,
    days,
    dates: reports.map((report) => ({
      businessDate: report.businessDate,
      total: compactTotal(report.allMarkets),
      marketCount: report.markets.length,
      blockedIdentityCount: report.blocked.length,
      scopeBlockers: report.scopeBlockers,
    })),
  };
}

export async function executeReadonlyAnalystTool(
  supabase: Supabase,
  request: ReadonlyAnalystToolRequest,
) {
  switch (request.tool) {
    case "get_daily_summary":
      return getDailySummaryTool(supabase, request.businessDate);
    case "get_market_summary":
      return getMarketSummaryTool(supabase, request.businessDate, request.market);
    case "get_stock_summary":
      return getStockSummaryTool(supabase, request.businessDate);
    case "get_market_stock":
      return getMarketStockTool(supabase, request.businessDate, request.market);
    case "get_pending_items":
      return getPendingItemsTool(supabase, request.businessDate);
    case "get_staff_settlement":
      return getStaffSettlementTool(supabase, request.businessDate, request.staff);
    case "get_market_settlement":
      return getMarketSettlementTool(supabase, request.businessDate, request.market);
    case "get_settlement_overview":
      return getSettlementOverviewTool(supabase, request.businessDate);
    case "compare_daily_sales":
      return compareDailySalesTool(supabase, request.businessDate, request.days);
  }
}
