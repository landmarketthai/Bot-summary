import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { canonicalMarketLabel } from "@/lib/market";
import {
  bangkokBusinessDateWindow,
  fetchSalesProduceRows,
  loadSalesReport,
  loadProduceFailureScan,
  type SalesMarketFilter,
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
  | "compare_daily_sales"
  | "get_staff_produce"
  | "get_slip_status"
  | "get_white_sheet_status";

export type ReadonlyAnalystToolRequest =
  | { tool: "get_daily_summary"; businessDate: string }
  | { tool: "get_market_summary"; businessDate: string; market: string }
  | { tool: "get_stock_summary"; businessDate: string }
  | { tool: "get_market_stock"; businessDate: string; market: string }
  | { tool: "get_pending_items"; businessDate: string; staff?: string | null; market?: string | null }
  | { tool: "get_staff_settlement"; businessDate: string; staff: string }
  | { tool: "get_market_settlement"; businessDate: string; market: string }
  | { tool: "get_settlement_overview"; businessDate: string }
  | { tool: "compare_daily_sales"; businessDate: string; days: number }
  | { tool: "get_staff_produce"; businessDate: string; staff: string }
  | { tool: "get_slip_status"; businessDate: string; staff: string | null; market: string | null }
  | { tool: "get_white_sheet_status"; businessDate: string; market: string | null };

/**
 * Server-side data scope from the requester's authorization. `markets` holds
 * canonical market labels; null means every market. Rows outside the scope
 * are dropped at the source (sales report marketFilter, query filters) so the
 * authoritative calculators only ever see permitted markets; nothing here
 * re-derives a total from filtered rows.
 */
export interface ToolDataScope {
  markets: ReadonlySet<string> | null;
  /**
   * Set for a staff requester: only owner-scoped tools run, and always for
   * this staff label, whatever the request says. Market-level tools would
   * expose other employees' rows and are refused here, not just upstream.
   */
  ownerStaff?: string | null;
}

export const UNRESTRICTED_SCOPE: ToolDataScope = { markets: null, ownerStaff: null };

/** Tools whose rows belong to one staff member and can be filtered to them. */
export const OWNER_SCOPED_TOOLS: ReadonlySet<ReadonlyAnalystToolName> = new Set([
  "get_staff_produce",
  "get_pending_items",
  "get_slip_status",
]);

export class ToolScopeError extends Error {
  constructor(readonly tool: ReadonlyAnalystToolName) {
    super(`tool ${tool} is not permitted for an owner-scoped requester`);
    this.name = "ToolScopeError";
  }
}

/** Pin an owner-scoped request to the scope's owner; refuse every other tool. */
export function enforceOwnerScope(
  request: ReadonlyAnalystToolRequest,
  scope: ToolDataScope,
): ReadonlyAnalystToolRequest {
  const owner = scope.ownerStaff?.trim();
  if (!owner) return request;
  if (!OWNER_SCOPED_TOOLS.has(request.tool)) throw new ToolScopeError(request.tool);
  return { ...request, staff: owner } as ReadonlyAnalystToolRequest;
}

export function marketInScope(scope: ToolDataScope, marketName: string | null | undefined): boolean {
  if (scope.markets === null) return true;
  const canonical = canonicalMarketLabel(marketName);
  return canonical.length > 0 && scope.markets.has(canonical);
}

function salesMarketFilter(scope: ToolDataScope): SalesMarketFilter | undefined {
  return scope.markets === null ? undefined : (marketName) => marketInScope(scope, marketName);
}

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
    // Integer satang for exact rendering; the baht values are for the model.
    confirmedSalesSatang: total.expectedSalesSatang,
    pendingReviewSalesSatang: total.pendingReviewSalesSatang,
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

/** Comparable staff name; a polite prefix is dropped only when a name remains ("พี่" stays "พี่"). */
export function normalizeStaffName(value: string): string {
  const compact = value.normalize("NFC").replace(/[\s\u200b-\u200d\ufeff]+/gu, "");
  return compact.replace(/^(?:พี่|น้อง|คุณ|เจ๊|ป้า|ลุง|น้า|หนู)/u, "") || compact;
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
  scope: ToolDataScope = UNRESTRICTED_SCOPE,
) {
  const report = await loadSalesReport(supabase, businessDate, { marketFilter: salesMarketFilter(scope) });
  return {
    tool: "get_daily_summary" as const,
    businessDate,
    // With a market scope this is the calculator's total over permitted markets only.
    totalScope: scope.markets === null ? "all_markets" : "permitted_markets_only",
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
  scope: ToolDataScope = UNRESTRICTED_SCOPE,
) {
  const report = await loadSalesReport(supabase, businessDate, { marketFilter: salesMarketFilter(scope) });
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
  scope: ToolDataScope = UNRESTRICTED_SCOPE,
) {
  const summary = await loadStockSummary(supabase, businessDate);
  const restricted = scope.markets !== null;
  const incomplete = summary.incomplete.filter((item) => marketInScope(scope, item.marketName));
  return {
    tool: "get_stock_summary" as const,
    businessDate,
    semantics: "daily_good_returns_sellable_stock_not_perpetual_inventory",
    isComplete: restricted ? incomplete.length === 0 : summary.isComplete,
    // Cross-market category totals include markets outside a restricted
    // scope and are never re-derived, so they are withheld.
    categories: restricted ? [] : summary.categories,
    categoriesWithheldForScope: restricted,
    incompleteCount: incomplete.length,
    incomplete: incomplete.slice(0, 40),
    unidentified: restricted ? [] : summary.unidentified,
    markets: summary.detail.markets.filter((market) => marketInScope(scope, market.marketName)).map((market) => ({
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
  scope: ToolDataScope = UNRESTRICTED_SCOPE,
) {
  const summary = await loadStockSummary(supabase, businessDate);
  const target = canonicalMarketLabel(marketName);
  const markets = summary.detail.markets.filter(
    (market) => canonicalMarketLabel(market.marketName) === target && marketInScope(scope, market.marketName),
  );
  const incomplete = summary.incomplete.filter(
    (item) => canonicalMarketLabel(item.marketName) === target && marketInScope(scope, item.marketName),
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
  filters: { staff?: string | null; market?: string | null } = {},
  scope: ToolDataScope = UNRESTRICTED_SCOPE,
) {
  const scan = await loadProduceFailureScan(supabase, businessDate, salesMarketFilter(scope));
  const classificationById = new Map(
    scan.classifications.map((row) => [row.attemptId, row]),
  );
  const staffTarget = filters.staff?.trim() ? normalizeStaffName(filters.staff) : null;
  const marketTarget = filters.market?.trim() ? canonicalMarketLabel(filters.market) : null;

  const active = scan.attempts
    .filter((attempt) => scan.activeIds.has(attempt.attemptId))
    // A document without a market cannot be proven inside a restricted scope.
    .filter((attempt) => scope.markets === null || marketInScope(scope, attempt.marketLabel))
    .filter((attempt) => staffTarget === null
      || (attempt.staffLabel !== null && normalizeStaffName(attempt.staffLabel) === staffTarget))
    .filter((attempt) => marketTarget === null || canonicalMarketLabel(attempt.marketLabel) === marketTarget)
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
    requestedStaff: filters.staff ?? null,
    requestedMarket: filters.market ?? null,
    activeCount: active.length,
    items: active,
    originMeaning: {
      pending_session: "เปิดเอกสารแล้วแต่ยังปิด/บันทึกไม่สำเร็จ",
      raw_message: "ส่งข้อความแล้วแต่ระบบยังไม่ได้สร้างเอกสาร",
    },
  };
}

export async function getStaffSettlementTool(
  supabase: Supabase,
  businessDate: string,
  staff: string,
  scope: ToolDataScope = UNRESTRICTED_SCOPE,
) {
  const resolved = await produceSettlementIdentitiesForStaff(
    supabase,
    businessDate,
    staff,
  );

  const settlements = await Promise.all(
    resolved.identities.filter((identity) => marketInScope(scope, identity.market)).map(async (identity) => ({
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
  scope: ToolDataScope = UNRESTRICTED_SCOPE,
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
    (row) => canonicalMarketLabel(row.market_label_normalized) === target
      && marketInScope(scope, row.market_label_normalized),
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
  scope: ToolDataScope = UNRESTRICTED_SCOPE,
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
    (data ?? []).filter((identity) => marketInScope(scope, identity.market_label_normalized)).map(async (identity) => {
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
  scope: ToolDataScope = UNRESTRICTED_SCOPE,
) {
  const days = Math.min(7, Math.max(2, Math.trunc(requestedDays || 2)));
  const dates = Array.from({ length: days }, (_, index) => previousIsoDate(businessDate, index));
  const marketFilter = salesMarketFilter(scope);
  // Sequential on purpose: each report is many queries, and parallel days
  // multiply outstanding I/O for one question.
  const reports = [];
  for (const date of dates) reports.push(await loadSalesReport(supabase, date, { marketFilter }));

  return {
    tool: "compare_daily_sales" as const,
    businessDate,
    days,
    totalScope: scope.markets === null ? "all_markets" : "permitted_markets_only",
    dates: reports.map((report) => ({
      businessDate: report.businessDate,
      total: compactTotal(report.allMarkets),
      // Per-market totals from the same calculator, for "ตลาดไหนขายดีกว่า".
      markets: report.markets.map((market) => ({
        market: market.marketLabel,
        ...compactTotal(market.total),
      })),
      marketCount: report.markets.length,
      blockedIdentityCount: report.blocked.length,
      scopeBlockers: report.scopeBlockers,
    })),
  };
}

const SLIP_CHECK_STATUSES = ["PROCESSING", "EXTRACTED", "PARTIAL_EXTRACTED", "NEED_REVIEW", "FAILED"] as const;
const MAX_STAFF_DOCUMENTS = 20;
const MAX_DOCUMENT_ITEMS = 40;
const MAX_SLIP_BATCHES = 50;

/**
 * Withdrawals and returns recorded for one staff member: the produce lines as
 * stored, grouped by document. Quantities are listed, never summed here.
 */
export async function getStaffProduceTool(
  supabase: Supabase,
  businessDate: string,
  staff: string,
  scope: ToolDataScope = UNRESTRICTED_SCOPE,
) {
  const rows = await fetchSalesProduceRows(supabase, businessDate);
  const target = normalizeStaffName(staff);
  const matches = rows.filter((row) => normalizeStaffName(row.staff_name) === target
    && marketInScope(scope, row.market_name));
  const documents = new Map<string, {
    market: string;
    transactionType: string;
    sessionKind: string;
    items: Array<{ product: string; quantity: number | null; unit: string | null }>;
    itemCount: number;
  }>();
  for (const row of matches) {
    const document = documents.get(row.session_id) ?? {
      market: canonicalMarketLabel(row.market_name) || (row.market_name ?? ""),
      transactionType: (row.base_transaction_type ?? row.transaction_type ?? "").trim(),
      sessionKind: row.session_kind,
      items: [],
      itemCount: 0,
    };
    document.itemCount += 1;
    if (document.items.length < MAX_DOCUMENT_ITEMS) {
      document.items.push({ product: row.product_name, quantity: row.quantity, unit: row.unit });
    }
    documents.set(row.session_id, document);
  }
  const list = [...documents.values()];
  return {
    tool: "get_staff_produce" as const,
    businessDate,
    requestedStaff: staff,
    found: list.length > 0,
    semantics: "recorded_produce_lines_per_document_quantities_not_summed",
    documentCount: list.length,
    documents: list.slice(0, MAX_STAFF_DOCUMENTS).map((document) => ({
      ...document,
      itemsTruncated: document.itemCount > document.items.length,
    })),
    truncated: list.length > MAX_STAFF_DOCUMENTS,
  };
}

/**
 * Slip batches of the day with their stored counters and the OCR check
 * status of every slip image. "รอตรวจ" means NEED_REVIEW/FAILED (an admin must
 * check by hand) or PROCESSING; EXTRACTED is read from the image only, not
 * bank-verified.
 */
export async function getSlipStatusTool(
  supabase: Supabase,
  businessDate: string,
  filters: { staff: string | null; market: string | null },
  scope: ToolDataScope = UNRESTRICTED_SCOPE,
) {
  const window = bangkokBusinessDateWindow(businessDate);
  const columns = "id, seller_name, market_name, slip_date, status, image_count, success_count, failed_count, first_image_at" as const;
  const [dated, undated] = await Promise.all([
    supabase.from("slip_batches").select(columns).eq("slip_date", businessDate).limit(MAX_SLIP_BATCHES),
    supabase.from("slip_batches").select(columns).is("slip_date", null)
      .gte("first_image_at", window.start).lt("first_image_at", window.end).limit(MAX_SLIP_BATCHES),
  ]);
  if (dated.error || undated.error) throw new Error("analyst slip batch lookup failed");

  const staffTarget = filters.staff?.trim() ? normalizeStaffName(filters.staff) : null;
  const marketTarget = filters.market?.trim() ? canonicalMarketLabel(filters.market) : null;
  const batches = [...(dated.data ?? []), ...(undated.data ?? [])]
    .filter((batch) => marketInScope(scope, batch.market_name))
    .filter((batch) => staffTarget === null
      || (batch.seller_name !== null && normalizeStaffName(batch.seller_name) === staffTarget))
    .filter((batch) => marketTarget === null || canonicalMarketLabel(batch.market_name) === marketTarget);

  const checkCounts = new Map<string, Record<string, number>>();
  const batchIds = batches.map((batch) => batch.id);
  if (batchIds.length > 0) {
    const { data: evidences, error: evidenceError } = await supabase
      .from("slip_evidences").select("id, batch_id").in("batch_id", batchIds).limit(1000);
    if (evidenceError) throw new Error("analyst slip evidence lookup failed");
    const batchByEvidence = new Map((evidences ?? []).map((row) => [row.id, row.batch_id ?? ""]));
    const evidenceIds = [...batchByEvidence.keys()];
    const statusByEvidence = new Map<string, string>();
    for (let offset = 0; offset < evidenceIds.length; offset += 200) {
      const { data: checks, error: checkError } = await supabase
        .from("slip_checks").select("evidence_id, status").in("evidence_id", evidenceIds.slice(offset, offset + 200));
      if (checkError) throw new Error("analyst slip check lookup failed");
      for (const check of checks ?? []) statusByEvidence.set(check.evidence_id, check.status);
    }
    for (const [evidenceId, batchId] of batchByEvidence) {
      const counts = checkCounts.get(batchId)
        ?? Object.fromEntries([...SLIP_CHECK_STATUSES, "NOT_CHECKED"].map((status) => [status, 0]));
      const status = statusByEvidence.get(evidenceId) ?? "NOT_CHECKED";
      counts[status] = (counts[status] ?? 0) + 1;
      checkCounts.set(batchId, counts);
    }
  }

  return {
    tool: "get_slip_status" as const,
    businessDate,
    requestedStaff: filters.staff,
    requestedMarket: filters.market,
    found: batches.length > 0,
    statusMeaning: {
      PROCESSING: "กำลังอ่านสลิป",
      EXTRACTED: "อ่านข้อมูลจากรูปแล้ว ยังไม่ใช่การยืนยันจากธนาคาร",
      PARTIAL_EXTRACTED: "อ่านได้บางส่วน",
      NEED_REVIEW: "อ่านไม่ครบ ต้องให้แอดมินตรวจมือ",
      FAILED: "อ่านไม่สำเร็จ ต้องให้แอดมินตรวจมือ",
      NOT_CHECKED: "ยังไม่มีผลตรวจ",
    },
    batches: batches.map((batch) => ({
      seller: batch.seller_name,
      market: canonicalMarketLabel(batch.market_name) || batch.market_name,
      batchStatus: batch.status,
      imageCount: batch.image_count,
      successCount: batch.success_count,
      failedCount: batch.failed_count,
      checkStatusCounts: checkCounts.get(batch.id)
        ?? Object.fromEntries([...SLIP_CHECK_STATUSES, "NOT_CHECKED"].map((status) => [status, 0])),
    })),
  };
}

/** Whether each market's white sheet exists, is finalized and which inputs were entered. No amounts. */
export async function getWhiteSheetStatusTool(
  supabase: Supabase,
  businessDate: string,
  market: string | null,
  scope: ToolDataScope = UNRESTRICTED_SCOPE,
) {
  const { data, error } = await supabase
    .from("digital_white_sheet_cash_entries")
    .select("market_label_normalized, finalized_at, white_sheet_sales, labor_entered, location_fee_entered, bag_entered, snack_entered, other_entered, actual_cash_submitted_entered")
    .eq("business_date", businessDate)
    .limit(100);
  if (error) throw new Error("analyst white sheet lookup failed");
  const target = market?.trim() ? canonicalMarketLabel(market) : null;
  const entries = (data ?? [])
    .filter((row) => marketInScope(scope, row.market_label_normalized))
    .filter((row) => target === null || canonicalMarketLabel(row.market_label_normalized) === target);
  return {
    tool: "get_white_sheet_status" as const,
    businessDate,
    requestedMarket: market,
    found: entries.length > 0,
    sheets: entries.map((row) => ({
      market: canonicalMarketLabel(row.market_label_normalized),
      finalized: row.finalized_at !== null,
      whiteSheetSalesEntered: row.white_sheet_sales !== null,
      entered: {
        labor: row.labor_entered,
        locationFee: row.location_fee_entered,
        bag: row.bag_entered,
        snack: row.snack_entered,
        other: row.other_entered,
        actualCashSubmitted: row.actual_cash_submitted_entered,
      },
    })),
  };
}

export async function executeReadonlyAnalystTool(
  supabase: Supabase,
  requested: ReadonlyAnalystToolRequest,
  scope: ToolDataScope = UNRESTRICTED_SCOPE,
) {
  const request = enforceOwnerScope(requested, scope);
  switch (request.tool) {
    case "get_daily_summary":
      return getDailySummaryTool(supabase, request.businessDate, scope);
    case "get_market_summary":
      return getMarketSummaryTool(supabase, request.businessDate, request.market, scope);
    case "get_stock_summary":
      return getStockSummaryTool(supabase, request.businessDate, scope);
    case "get_market_stock":
      return getMarketStockTool(supabase, request.businessDate, request.market, scope);
    case "get_pending_items":
      return getPendingItemsTool(
        supabase,
        request.businessDate,
        { staff: request.staff ?? null, market: request.market ?? null },
        scope,
      );
    case "get_staff_settlement":
      return getStaffSettlementTool(supabase, request.businessDate, request.staff, scope);
    case "get_market_settlement":
      return getMarketSettlementTool(supabase, request.businessDate, request.market, scope);
    case "get_settlement_overview":
      return getSettlementOverviewTool(supabase, request.businessDate, scope);
    case "compare_daily_sales":
      return compareDailySalesTool(supabase, request.businessDate, request.days, scope);
    case "get_staff_produce":
      return getStaffProduceTool(supabase, request.businessDate, request.staff, scope);
    case "get_slip_status":
      return getSlipStatusTool(
        supabase,
        request.businessDate,
        { staff: request.staff, market: request.market },
        scope,
      );
    case "get_white_sheet_status":
      return getWhiteSheetStatusTool(supabase, request.businessDate, request.market, scope);
  }
}
