/**
 * Test/demo-only business data shaped like the compact read-only tool
 * outputs. It honours the data scope exactly like the real tools (market
 * filter at the source, staff filter by normalized name) and records every
 * read, so tests can prove what a requester's question never reached.
 * The figures are invented fixtures, not Production data.
 */
import { canonicalMarketLabel } from "@/lib/market";
import { marketInScope, normalizeStaffName, type ReadonlyAnalystToolRequest, type ToolDataScope } from "@/lib/ai/readonly-tools";
import type { ScopedDataReader } from "../authorization";

export const FIXTURE_TODAY = "2026-10-31";
export const FIXTURE_YESTERDAY = "2026-10-30";

const PASEO = canonicalMarketLabel("พาซิโอ้ผัก");
const WAT = canonicalMarketLabel("วัดตะกล่ำ");
const RATCHAPHRUEK = canonicalMarketLabel("ราชพฤกษ์");

const SALES: Record<string, Array<{ market: string; confirmed: number; pending: number }>> = {
  [FIXTURE_TODAY]: [
    { market: PASEO, confirmed: 18450.5, pending: 1200 },
    { market: WAT, confirmed: 9320, pending: 0 },
    { market: RATCHAPHRUEK, confirmed: 12780.25, pending: 450 },
  ],
  [FIXTURE_YESTERDAY]: [
    { market: PASEO, confirmed: 15210, pending: 0 },
    { market: WAT, confirmed: 11040.75, pending: 0 },
    { market: RATCHAPHRUEK, confirmed: 10990, pending: 0 },
  ],
};

const PRODUCE = [
  { staff: "ดำ", market: RATCHAPHRUEK, kind: "เบิก", items: [["มะม่วงน้ำดอกไม้", 30, "กก."], ["ส้มโอ", 20, "ลูก"]] },
  { staff: "ดำ", market: RATCHAPHRUEK, kind: "ชั่งคืน", items: [["มะม่วงน้ำดอกไม้", 6.5, "กก."], ["ส้มโอ", 4, "ลูก"]] },
  { staff: "ดำ", market: RATCHAPHRUEK, kind: "คืนเสีย", items: [["มะม่วงน้ำดอกไม้", 1.2, "กก."]] },
  { staff: "ขวัญ", market: PASEO, kind: "เบิก", items: [["ผักกาดขาว", 15, "กก."]] },
  { staff: "ปลา", market: WAT, kind: "เบิก", items: [["แตงโม", 12, "ลูก"]] },
] as const;

const PENDING = [
  { staff: "ปลา", market: WAT, transactionKind: "คืน", origin: "pending_session" },
  { staff: "ขวัญ", market: PASEO, transactionKind: "เบิก", origin: "raw_message" },
] as const;

const SLIPS = [
  { seller: "เล็ก", market: PASEO, counts: { PROCESSING: 1, EXTRACTED: 5, PARTIAL_EXTRACTED: 0, NEED_REVIEW: 2, FAILED: 0, NOT_CHECKED: 0 } },
  { seller: "ดำ", market: RATCHAPHRUEK, counts: { PROCESSING: 0, EXTRACTED: 7, PARTIAL_EXTRACTED: 0, NEED_REVIEW: 0, FAILED: 1, NOT_CHECKED: 0 } },
] as const;

// Shapes and enums of compactSettlement / DailyFinancialSettlementResult.
const SETTLEMENTS = [
  { staff: "ดำ", market: RATCHAPHRUEK, status: "CLOSED_DIFFERENCE", expectedCashBaht: 8000, actualCashBaht: 7880, cashDifferenceBaht: -120, missingInputs: [] as string[], uncertainty: [] as string[] },
  { staff: "ขวัญ", market: PASEO, status: "INCOMPLETE", expectedCashBaht: null, actualCashBaht: null, cashDifferenceBaht: null, missingInputs: ["actual_cash"], uncertainty: [] as string[] },
] as const;

/** compactTotal shape: integer satang plus the baht the model reads. */
function money(confirmed: number, pending: number) {
  const confirmedSalesSatang = Math.round(confirmed * 100);
  const pendingReviewSalesSatang = Math.round(pending * 100);
  return {
    confirmedSalesSatang,
    pendingReviewSalesSatang,
    confirmedSalesBaht: confirmedSalesSatang / 100,
    pendingReviewSalesBaht: pendingReviewSalesSatang / 100,
    valueAuthoritative: true,
    valueBlockedRowCount: 0,
  };
}

function total(rows: Array<{ confirmed: number; pending: number }>) {
  // Fixture "authoritative" totals are fixed inputs, like the calculator's output.
  return money(rows.reduce((sum, row) => sum + row.confirmed, 0), rows.reduce((sum, row) => sum + row.pending, 0));
}

function sameStaff(a: string | null | undefined, b: string): boolean {
  return Boolean(a) && normalizeStaffName(a!) === normalizeStaffName(b);
}

export interface FixtureRead { request: ReadonlyAnalystToolRequest; scope: ToolDataScope }

function previousDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - 1)).toISOString().slice(0, 10);
}

/**
 * `today` re-anchors the fixture (default FIXTURE_TODAY) so a test that uses
 * the real clock still finds "today" and "yesterday" data.
 */
export function createFixtureDataReader(reads: FixtureRead[] = [], options: { today?: string } = {}): ScopedDataReader {
  const today = options.today ?? FIXTURE_TODAY;
  const shift = (date: string) => date === today ? FIXTURE_TODAY : date === previousDay(today) ? FIXTURE_YESTERDAY : date;
  return async (request, scope) => {
    reads.push({ request, scope });
    const date = shift(request.businessDate);
    const sales = (SALES[date] ?? []).filter((row) => marketInScope(scope, row.market));
    switch (request.tool) {
      case "get_daily_summary":
        return {
          tool: request.tool, businessDate: request.businessDate,
          totalScope: scope.markets === null ? "all_markets" : "permitted_markets_only",
          total: total(sales),
          markets: sales.map((row) => ({ market: row.market, ...money(row.confirmed, row.pending) })),
        };
      case "compare_daily_sales": {
        const dates = [request.businessDate, previousDay(request.businessDate)];
        return {
          tool: request.tool, businessDate: request.businessDate, days: 2,
          dates: dates.map((day) => {
            const rows = (SALES[shift(day)] ?? []).filter((row) => marketInScope(scope, row.market));
            return {
              businessDate: day, total: total(rows),
              markets: rows.map((row) => ({ market: row.market, ...money(row.confirmed, row.pending) })),
            };
          }),
        };
      }
      case "get_staff_produce": {
        const documents = date === FIXTURE_TODAY
          ? PRODUCE.filter((doc) => sameStaff(doc.staff, request.staff) && marketInScope(scope, doc.market))
          : [];
        return {
          tool: request.tool, businessDate: request.businessDate, requestedStaff: request.staff, found: documents.length > 0,
          documents: documents.map((doc) => ({
            market: doc.market, transactionType: doc.kind,
            items: doc.items.map(([product, quantity, unit]) => ({ product, quantity, unit })),
          })),
        };
      }
      case "get_pending_items": {
        const items = date === FIXTURE_TODAY
          ? PENDING.filter((item) => marketInScope(scope, item.market)
            && (!request.staff || sameStaff(item.staff, request.staff))
            && (!request.market || canonicalMarketLabel(request.market) === item.market))
          : [];
        return { tool: request.tool, businessDate: request.businessDate, requestedStaff: request.staff ?? null, activeCount: items.length, items };
      }
      case "get_slip_status": {
        const batches = date === FIXTURE_TODAY
          ? SLIPS.filter((batch) => marketInScope(scope, batch.market) && (!request.staff || sameStaff(batch.seller, request.staff)))
          : [];
        return {
          tool: request.tool, businessDate: request.businessDate, requestedStaff: request.staff, requestedMarket: request.market,
          batches: batches.map((batch) => ({ seller: batch.seller, market: batch.market, checkStatusCounts: batch.counts })),
        };
      }
      case "get_staff_settlement": {
        const settlements = date === FIXTURE_TODAY
          ? SETTLEMENTS.filter((row) => sameStaff(row.staff, request.staff) && marketInScope(scope, row.market))
          : [];
        return { tool: request.tool, businessDate: request.businessDate, requestedStaff: request.staff, settlements };
      }
      case "get_white_sheet_status":
        return {
          tool: request.tool, businessDate: request.businessDate, requestedMarket: request.market,
          sheets: [PASEO, WAT, RATCHAPHRUEK].filter((market) => marketInScope(scope, market))
            .map((market) => ({ market, finalized: market !== PASEO })),
        };
      default:
        return { tool: request.tool, businessDate: request.businessDate, found: false };
    }
  };
}

export const FIXTURE_MARKETS = { PASEO, WAT, RATCHAPHRUEK };
