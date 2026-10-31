/**
 * Deterministic Thai rendering of authoritative financial tool outputs
 * (P1-D). When an answer used a financial tool, the money figures and cash
 * statuses that reach LINE come from here, field by field, never from model
 * text: a generic "does this number appear somewhere" check cannot tell a
 * confirmed amount from a pending one, an excess from a shortfall, or a real
 * zero from a missing value.
 *
 *   - amounts from integer satang when the tool provides it, else from baht
 *     via Math.round(baht * 100); always two decimals;
 *   - confirmed (ยืนยันแล้ว) and pending review (รอตรวจ) are never summed or swapped;
 *   - cash difference < 0 is เงินขาด, > 0 เงินเกิน, = 0 เงินปิดตรง;
 *   - INCOMPLETE or a null difference is "ยังสรุปไม่ได้" with the missing inputs;
 *   - null amounts are "ไม่มีข้อมูล", never 0.
 */
import type { ReadonlyAnalystToolName } from "@/lib/ai/readonly-tools";

export const FINANCIAL_TOOLS: ReadonlySet<ReadonlyAnalystToolName> = new Set([
  "get_daily_summary",
  "get_market_summary",
  "compare_daily_sales",
  "get_staff_settlement",
  "get_market_settlement",
  "get_settlement_overview",
]);

const MISSING_INPUT_THAI: Record<string, string> = {
  white_sheet_sales: "ยอดขายใบขาว",
  owner_cash: "เงินสดเจ้าของ",
  expenses: "ค่าใช้จ่าย",
  wages: "ค่าแรง",
  actual_cash: "เงินสดที่ส่งจริง",
};

type Row = Record<string, unknown>;

export function formatSatang(satang: number): string {
  const sign = satang < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(satang));
  const whole = Math.trunc(abs / 100).toLocaleString("en-US");
  return `${sign}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

function satangFrom(row: Row, satangKey: string, bahtKey: string): number | null {
  const satang = row[satangKey];
  if (typeof satang === "number" && Number.isInteger(satang)) return satang;
  const baht = row[bahtKey];
  return typeof baht === "number" && Number.isFinite(baht) ? Math.round(baht * 100) : null;
}

function amount(satang: number | null): string {
  return satang === null ? "ไม่มีข้อมูล" : `${formatSatang(satang)} บาท`;
}

function salesLine(label: string, total: Row): string {
  const confirmed = satangFrom(total, "confirmedSalesSatang", "confirmedSalesBaht");
  const pending = satangFrom(total, "pendingReviewSalesSatang", "pendingReviewSalesBaht");
  const notes: string[] = [];
  if (total.valueAuthoritative === false || Number(total.valueBlockedRowCount ?? 0) > 0) {
    notes.push(`มูลค่ายังยืนยันไม่ได้ ${Number(total.valueBlockedRowCount ?? 0)} แถว`);
  }
  return `• ${label}: ยืนยันแล้ว ${amount(confirmed)} · รอตรวจ ${amount(pending)}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

function scopeLabel(output: Row): string {
  return output.totalScope === "permitted_markets_only" ? "รวมเฉพาะตลาดที่มีสิทธิ์" : "รวมทุกตลาด";
}

function renderDaily(output: Row): string {
  const markets = (output.markets as Row[] | undefined) ?? [];
  const lines = [`ยอดขายวันที่ ${output.businessDate}`, salesLine(scopeLabel(output), (output.total as Row) ?? {})];
  for (const market of markets) lines.push(salesLine(String(market.market), market));
  if (Number(output.blockedIdentityCount ?? 0) > 0) {
    lines.push(`หมายเหตุ: มี ${Number(output.blockedIdentityCount)} รายการที่ยังระบุตลาด/รอบไม่ได้`);
  }
  return lines.join("\n");
}

function renderMarket(output: Row): string {
  const matches = (output.matches as Row[] | undefined) ?? [];
  if (!output.found || matches.length === 0) {
    return `ไม่พบยอดขายของตลาด ${output.requestedMarket} วันที่ ${output.businessDate}`;
  }
  return [`ยอดขายวันที่ ${output.businessDate}`, ...matches.map((match) => salesLine(String(match.market), (match.total as Row) ?? {}))].join("\n");
}

function renderCompare(output: Row): string {
  const dates = (output.dates as Row[] | undefined) ?? [];
  const lines = [`เทียบยอดขาย (${scopeLabel(output)})`];
  for (const day of dates) {
    lines.push(`วันที่ ${day.businessDate}`, salesLine("รวม", (day.total as Row) ?? {}));
    const markets = (day.markets as Row[] | undefined) ?? [];
    for (const market of markets) lines.push(salesLine(String(market.market), market));
    const ranked = markets
      .map((market) => ({ market: String(market.market), satang: satangFrom(market, "confirmedSalesSatang", "confirmedSalesBaht") }))
      .filter((entry): entry is { market: string; satang: number } => entry.satang !== null)
      .sort((a, b) => b.satang - a.satang);
    if (ranked[0]) lines.push(`  ยอดยืนยันสูงสุด: ${ranked[0].market} ${amount(ranked[0].satang)}`);
  }
  return lines.join("\n");
}

function settlementLine(settlement: Row): string {
  const who = Array.isArray(settlement.staff)
    ? (settlement.staff as unknown[]).join(", ")
    : typeof settlement.staff === "string" ? settlement.staff : "";
  const head = `• ${settlement.market}${who ? ` (${who})` : ""}`;
  const difference = satangFrom(settlement, "cashDifferenceSatang", "cashDifferenceBaht");
  if (settlement.status === "INCOMPLETE" || difference === null) {
    const missing = ((settlement.missingInputs as string[] | undefined) ?? [])
      .map((key) => MISSING_INPUT_THAI[key] ?? key);
    return `${head}: ยังสรุปเงินขาด/เกินไม่ได้ ข้อมูลที่ขาด: ${missing.length ? missing.join(", ") : "ไม่ระบุ"}`;
  }
  const verdict = difference < 0
    ? `เงินขาด ${amount(-difference)}`
    : difference > 0 ? `เงินเกิน ${amount(difference)}` : "เงินปิดตรง";
  const expected = satangFrom(settlement, "expectedCashSatang", "expectedCashBaht");
  const actual = satangFrom(settlement, "actualCashSatang", "actualCashBaht");
  const uncertainty = ((settlement.uncertainty as unknown[] | undefined) ?? []).length;
  return `${head}: ${verdict} (ต้องได้ ${amount(expected)} · ส่งจริง ${amount(actual)})`
    + (uncertainty ? ` หมายเหตุความไม่แน่นอน ${uncertainty} ข้อ` : "");
}

function renderSettlements(output: Row): string {
  const settlements = (output.settlements as Row[] | undefined) ?? [];
  const subject = output.requestedStaff ?? output.requestedMarket ?? "ทุกตลาด";
  if (settlements.length === 0) return `ไม่พบข้อมูลปิดเงินของ ${subject} วันที่ ${output.businessDate}`;
  return [`ผลปิดเงิน ${subject} วันที่ ${output.businessDate}`, ...settlements.map(settlementLine)].join("\n");
}

/** One financial tool output as authoritative Thai text. */
export function renderFinancialOutput(output: Row): string {
  if (output.status === "forbidden") return "ไม่มีสิทธิ์ดูข้อมูลการเงินส่วนนี้ครับ";
  if (typeof output.error === "string") return "อ่านข้อมูลการเงินส่วนนี้ไม่สำเร็จครับ";
  switch (output.tool) {
    case "get_daily_summary": return renderDaily(output);
    case "get_market_summary": return renderMarket(output);
    case "compare_daily_sales": return renderCompare(output);
    case "get_staff_settlement":
    case "get_market_settlement":
    case "get_settlement_overview":
      return renderSettlements(output);
    default:
      return "";
  }
}

const FINANCIAL_CLAIM = /\d[\d,]*(?:\.\d+)?\s*บาท|เงิน\s*(?:ขาด|เกิน)|ปิด\s*ตรง|ยอด\s*(?:ขาย|ยืนยัน|รอตรวจ|รวม)[^\n]{0,20}?\d|ยืนยัน(?:แล้ว)?\s*\d/u;

/** True when text states money or a cash result (must then come from the renderer). */
export function containsFinancialClaim(text: string): boolean {
  return FINANCIAL_CLAIM.test(text.normalize("NFC").replace(/[๐-๙]/gu, (digit) => String("๐๑๒๓๔๕๖๗๘๙".indexOf(digit))));
}
