/**
 * Test/eval-only business data shaped like the compact read-only tool
 * outputs (readonly-tools.ts + compactToolOutput). It honours the data scope
 * exactly like the real tools — market filter at the source, staff matched
 * by normalized name — and records every
 * read, so tests can prove what a question never reached.
 *
 * These are the AUTHORITATIVE values the answer-level evaluation grades
 * against (eval/answer-eval-set.ts). Invented figures, not Production data.
 */
import { canonicalMarketLabel } from "@/lib/market";
import {
  marketInScope,
  normalizeStaffName,
  type ReadonlyAnalystToolRequest,
  type ToolDataScope,
} from "@/lib/ai/readonly-tools";
import type { ScopedDataReader } from "../authorization";

export const FIXTURE_TODAY = "2026-10-31";
export const FIXTURE_YESTERDAY = "2026-10-30";

const PASEO = canonicalMarketLabel("พาซิโอ้ผัก");
const WAT = canonicalMarketLabel("วัดตะกล่ำ");
const RATCHAPHRUEK = canonicalMarketLabel("ราชพฤกษ์");
const MARKETS = [PASEO, WAT, RATCHAPHRUEK];

type Day = typeof FIXTURE_TODAY | typeof FIXTURE_YESTERDAY;

const SALES: Record<Day, Array<{ market: string; confirmed: number; pending: number }>> = {
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

type Item = readonly [product: string, quantity: number, unit: string];
const PRODUCE: Record<Day, ReadonlyArray<{ staff: string; market: string; kind: string; items: readonly Item[] }>> = {
  [FIXTURE_TODAY]: [
    { staff: "ดำ", market: RATCHAPHRUEK, kind: "เบิก", items: [["มะม่วงน้ำดอกไม้", 30, "กก."], ["ส้มโอ", 20, "ลูก"]] },
    { staff: "ดำ", market: RATCHAPHRUEK, kind: "ชั่งคืน", items: [["มะม่วงน้ำดอกไม้", 6.5, "กก."], ["ส้มโอ", 4, "ลูก"]] },
    { staff: "ดำ", market: RATCHAPHRUEK, kind: "คืนเสีย", items: [["มะม่วงน้ำดอกไม้", 1.2, "กก."]] },
    { staff: "ขวัญ", market: PASEO, kind: "เบิก", items: [["ผักกาดขาว", 15, "กก."]] },
    { staff: "ขวัญ", market: PASEO, kind: "ชั่งคืน", items: [["ผักกาดขาว", 3, "กก."]] },
    { staff: "ปลา", market: WAT, kind: "เบิก", items: [["แตงโม", 12, "ลูก"]] },
  ],
  [FIXTURE_YESTERDAY]: [
    { staff: "ดำ", market: RATCHAPHRUEK, kind: "เบิก", items: [["มะม่วงน้ำดอกไม้", 25, "กก."]] },
    { staff: "ขวัญ", market: PASEO, kind: "เบิก", items: [["ผักกาดขาว", 12, "กก."]] },
  ],
};

/** Daily good returns available for resale (not perpetual inventory). WAT's return is still pending. */
const STOCK: Record<string, ReadonlyArray<{ product: string; unit: string; withdrawn: number; good: number; damaged: number }>> = {
  [RATCHAPHRUEK]: [
    { product: "มะม่วงน้ำดอกไม้", unit: "กก.", withdrawn: 30, good: 6.5, damaged: 1.2 },
    { product: "ส้มโอ", unit: "ลูก", withdrawn: 20, good: 4, damaged: 0 },
  ],
  [PASEO]: [{ product: "ผักกาดขาว", unit: "กก.", withdrawn: 15, good: 3, damaged: 0 }],
  [WAT]: [],
};
const STOCK_INCOMPLETE = [{ marketName: WAT, staff: "ปลา", reason: "return_pending" }];

const PENDING = [
  { staff: "ปลา", market: WAT, transactionKind: "คืน", origin: "pending_session" },
  { staff: "ขวัญ", market: PASEO, transactionKind: "เบิก", origin: "raw_message" },
] as const;

const SLIPS = [
  { seller: "เล็ก", market: PASEO, counts: { PROCESSING: 1, EXTRACTED: 5, PARTIAL_EXTRACTED: 0, NEED_REVIEW: 2, FAILED: 0, NOT_CHECKED: 0 } },
  { seller: "ดำ", market: RATCHAPHRUEK, counts: { PROCESSING: 0, EXTRACTED: 7, PARTIAL_EXTRACTED: 0, NEED_REVIEW: 0, FAILED: 1, NOT_CHECKED: 0 } },
] as const;

const SLIP_STATUS_MEANING = {
  PROCESSING: "กำลังอ่านสลิป",
  EXTRACTED: "อ่านข้อมูลจากรูปแล้ว ยังไม่ใช่การยืนยันจากธนาคาร",
  PARTIAL_EXTRACTED: "อ่านได้บางส่วน",
  NEED_REVIEW: "อ่านไม่ครบ ต้องให้แอดมินตรวจมือ",
  FAILED: "อ่านไม่สำเร็จ ต้องให้แอดมินตรวจมือ",
  NOT_CHECKED: "ยังไม่มีผลตรวจ",
};

// Shapes and enums of compactSettlement / DailyFinancialSettlementResult.
const SETTLEMENTS = [
  { staff: "ดำ", market: RATCHAPHRUEK, status: "CLOSED_DIFFERENCE", expectedCashBaht: 8000, actualCashBaht: 7880, cashDifferenceBaht: -120, missingInputs: [] as string[], uncertainty: [] as string[] },
  { staff: "ขวัญ", market: PASEO, status: "INCOMPLETE", expectedCashBaht: null, actualCashBaht: null, cashDifferenceBaht: null, missingInputs: ["actual_cash"], uncertainty: [] as string[] },
  { staff: "ปลา", market: WAT, status: "CLOSED_MATCHED", expectedCashBaht: 5000, actualCashBaht: 5000, cashDifferenceBaht: 0, missingInputs: [] as string[], uncertainty: [] as string[] },
] as const;

const WHITE_SHEETS: Record<Day, ReadonlyArray<{ market: string; finalized: boolean; entered: Record<string, boolean> }>> = {
  [FIXTURE_TODAY]: [
    { market: PASEO, finalized: false, entered: { labor: true, locationFee: true, bag: false, snack: false, other: false, actualCashSubmitted: false } },
    { market: WAT, finalized: true, entered: { labor: true, locationFee: true, bag: true, snack: true, other: false, actualCashSubmitted: true } },
    { market: RATCHAPHRUEK, finalized: true, entered: { labor: true, locationFee: true, bag: true, snack: false, other: false, actualCashSubmitted: true } },
  ],
  [FIXTURE_YESTERDAY]: MARKETS.map((market) => ({
    market, finalized: true, entered: { labor: true, locationFee: true, bag: true, snack: true, other: false, actualCashSubmitted: true },
  })),
};

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

function total(rows: ReadonlyArray<{ confirmed: number; pending: number }>) {
  // Fixture "authoritative" totals are fixed inputs, like the calculator's output.
  return money(rows.reduce((sum, row) => sum + row.confirmed, 0), rows.reduce((sum, row) => sum + row.pending, 0));
}

/** Every money value (satang, absolute) any fixture tool can return, for hallucination checks. */
export const FIXTURE_MONEY_SATANG: ReadonlySet<number> = (() => {
  const values = new Set<number>([0]);
  for (const rows of Object.values(SALES)) {
    const all = total(rows);
    values.add(all.confirmedSalesSatang).add(all.pendingReviewSalesSatang);
    for (const row of rows) {
      const one = money(row.confirmed, row.pending);
      values.add(one.confirmedSalesSatang).add(one.pendingReviewSalesSatang);
    }
  }
  for (const row of SETTLEMENTS) {
    for (const value of [row.expectedCashBaht, row.actualCashBaht, row.cashDifferenceBaht]) {
      if (typeof value === "number") values.add(Math.abs(Math.round(value * 100)));
    }
  }
  return values;
})();

function sameStaff(a: string | null | undefined, b: string): boolean {
  return Boolean(a) && normalizeStaffName(a!) === normalizeStaffName(b);
}

function isDay(date: string): date is Day {
  return date === FIXTURE_TODAY || date === FIXTURE_YESTERDAY;
}

export interface FixtureRead { request: ReadonlyAnalystToolRequest; scope: ToolDataScope }

function previousDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - 1)).toISOString().slice(0, 10);
}

function salesRowsFor(day: Day | null, scope: ToolDataScope) {
  return (day ? SALES[day] : []).filter((row) => marketInScope(scope, row.market));
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
    const shifted = shift(request.businessDate);
    const day = isDay(shifted) ? shifted : null;
    const businessDate = request.businessDate;
    switch (request.tool) {
      case "get_daily_summary": {
        const sales = salesRowsFor(day, scope);
        return {
          tool: request.tool, businessDate,
          totalScope: scope.markets === null ? "all_markets" : "permitted_markets_only",
          total: total(sales),
          markets: sales.map((row) => ({ market: row.market, ...money(row.confirmed, row.pending) })),
          blockedIdentityCount: 0,
        };
      }
      case "get_market_summary": {
        const target = canonicalMarketLabel(request.market);
        const matches = salesRowsFor(day, scope).filter((row) => row.market === target);
        return {
          tool: request.tool, businessDate, requestedMarket: request.market, canonicalMarket: target,
          found: matches.length > 0,
          matches: matches.map((row) => ({ market: row.market, total: money(row.confirmed, row.pending), rowCount: 3, problemRows: [] })),
        };
      }
      case "compare_daily_sales": {
        const dates = [businessDate, previousDay(businessDate)];
        return {
          tool: request.tool, businessDate, days: 2,
          totalScope: scope.markets === null ? "all_markets" : "permitted_markets_only",
          dates: dates.map((date) => {
            const shiftedDay = shift(date);
            const rows = salesRowsFor(isDay(shiftedDay) ? shiftedDay : null, scope);
            return {
              businessDate: date, total: total(rows),
              markets: rows.map((row) => ({ market: row.market, ...money(row.confirmed, row.pending) })),
            };
          }),
        };
      }
      case "get_stock_summary":
      case "get_market_stock": {
        const target = request.tool === "get_market_stock" ? canonicalMarketLabel(request.market) : null;
        const markets = day === FIXTURE_TODAY
          ? MARKETS.filter((market) => marketInScope(scope, market) && (target === null || market === target))
          : [];
        const incomplete = day === FIXTURE_TODAY
          ? STOCK_INCOMPLETE.filter((item) => markets.includes(item.marketName))
          : [];
        return {
          tool: request.tool, businessDate,
          semantics: "daily_good_returns_sellable_stock_not_perpetual_inventory",
          ...(target !== null ? { requestedMarket: request.tool === "get_market_stock" ? request.market : null, canonicalMarket: target, found: markets.length > 0 } : {}),
          isComplete: incomplete.length === 0,
          incompleteCount: incomplete.length,
          incomplete,
          markets: markets.map((market) => ({
            market,
            items: STOCK[market]!.map((item) => ({
              product: item.product, unit: item.unit,
              withdrawnQuantity: item.withdrawn, goodReturnQuantity: item.good,
              damagedQuantity: item.damaged, remainingForResaleQuantity: item.good,
            })),
            truncated: false,
          })),
        };
      }
      case "get_staff_produce": {
        const documents = (day ? PRODUCE[day] : [])
          .filter((doc) => sameStaff(doc.staff, request.staff) && marketInScope(scope, doc.market));
        return {
          tool: request.tool, businessDate, requestedStaff: request.staff, found: documents.length > 0,
          semantics: "recorded_produce_lines_per_document_quantities_not_summed",
          documentCount: documents.length,
          documents: documents.map((doc) => ({
            market: doc.market, transactionType: doc.kind,
            items: doc.items.map(([product, quantity, unit]) => ({ product, quantity, unit })),
          })),
        };
      }
      case "get_pending_items": {
        const items = day === FIXTURE_TODAY
          ? PENDING.filter((item) => marketInScope(scope, item.market)
            && (!request.staff || sameStaff(item.staff, request.staff))
            && (!request.market || canonicalMarketLabel(request.market) === item.market))
          : [];
        return {
          tool: request.tool, businessDate, requestedStaff: request.staff ?? null, requestedMarket: request.market ?? null,
          activeCount: items.length, items,
          originMeaning: {
            pending_session: "เปิดเอกสารแล้วแต่ยังปิด/บันทึกไม่สำเร็จ",
            raw_message: "ส่งข้อความแล้วแต่ระบบยังไม่ได้สร้างเอกสาร",
          },
        };
      }
      case "get_slip_status": {
        const batches = day === FIXTURE_TODAY
          ? SLIPS.filter((batch) => marketInScope(scope, batch.market)
            && (!request.staff || sameStaff(batch.seller, request.staff))
            && (!request.market || canonicalMarketLabel(request.market) === batch.market))
          : [];
        return {
          tool: request.tool, businessDate, requestedStaff: request.staff, requestedMarket: request.market,
          found: batches.length > 0, partial: false, truncated: false, statusMeaning: SLIP_STATUS_MEANING,
          batches: batches.map((batch) => ({ seller: batch.seller, market: batch.market, checkStatusCounts: batch.counts })),
        };
      }
      case "get_staff_settlement": {
        const settlements = day === FIXTURE_TODAY
          ? SETTLEMENTS.filter((row) => sameStaff(row.staff, request.staff) && marketInScope(scope, row.market))
          : [];
        return { tool: request.tool, businessDate, requestedStaff: request.staff, found: settlements.length > 0, settlements };
      }
      case "get_market_settlement": {
        const target = canonicalMarketLabel(request.market);
        const settlements = day === FIXTURE_TODAY
          ? SETTLEMENTS.filter((row) => row.market === target && marketInScope(scope, row.market))
          : [];
        return { tool: request.tool, businessDate, requestedMarket: request.market, canonicalMarket: target, found: settlements.length > 0, settlements };
      }
      case "get_settlement_overview": {
        const settlements = day === FIXTURE_TODAY
          ? SETTLEMENTS.filter((row) => marketInScope(scope, row.market)).map((row) => ({ ...row, staff: [row.staff] }))
          : [];
        return { tool: request.tool, businessDate, settlementCount: settlements.length, settlements };
      }
      case "get_white_sheet_status": {
        const target = request.market?.trim() ? canonicalMarketLabel(request.market) : null;
        const sheets = (day ? WHITE_SHEETS[day] : [])
          .filter((sheet) => marketInScope(scope, sheet.market) && (target === null || sheet.market === target));
        return {
          tool: request.tool, businessDate, requestedMarket: request.market, found: sheets.length > 0, partial: false,
          sheets: sheets.map((sheet) => ({ market: sheet.market, finalized: sheet.finalized, whiteSheetSalesEntered: sheet.finalized, entered: sheet.entered })),
        };
      }
    }
  };
}

export const FIXTURE_MARKETS = { PASEO, WAT, RATCHAPHRUEK };
